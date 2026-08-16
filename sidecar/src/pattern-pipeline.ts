/**
 * Pattern pipeline — incremental extraction/update of the derived cognitive layer.
 *
 * Flow (spec §七): new important memories → retrieve nearby existing patterns →
 * model decides SUPPORT / CONTRADICT / UPDATE / CREATE / IGNORE → validated,
 * bounds-checked application. Malformed model output is always a safe no-op.
 *
 * Evidence constraint (spec §八): a single conversation turn never produces a
 * strong pattern — new patterns start as low-confidence candidates, and clinical
 * or moral judgments are rejected outright.
 */
import type {MemoryEngine, MemoryRecord, PatternRecord} from '@pattern/memory';
import {sanitizeKeywords} from '@pattern/memory';

export interface UtilityModelRef {
  provider: string;
  endpoint: string;
  model: string;
  apiKey: string;
}

export interface PatternPipelineDeps {
  memory: MemoryEngine;
  /** Returns the utility/companion model to use for extraction, or null when unconfigured. */
  getModel: () => UtilityModelRef | null;
  recordUsage?: (provider: string, model: string, usage: unknown, durationMs?: number) => void;
  log?: (message: string, error?: unknown) => void;
}

/** Structured decision schema the model must return. */
type PatternDecision =
  | {action: 'support'; pattern_id: string; confidence_delta: number; reason?: string}
  | {action: 'contradict'; pattern_id: string; confidence_delta: number; reason?: string}
  | {action: 'update'; pattern_id: string; text: string; keywords?: string[]; reason?: string}
  | {
      action: 'create';
      text: string;
      category: string;
      keywords?: string[];
      confidence_delta?: number;
      reason?: string;
    }
  | {action: 'ignore'; reason?: string};

export interface PatternUpdateOutcome {
  processed: number;
  supported: string[];
  contradicted: string[];
  updated: string[];
  created: string[];
  ignored: number;
  rejected: number;
}

/** Max absolute confidence change one piece of evidence may cause. */
const MAX_CONFIDENCE_DELTA = 0.3;
/** Candidate starting confidence — never strong from a single observation. */
const CANDIDATE_CONFIDENCE = 0.25;

/**
 * Clinical / moral-label blocklist. Patterns must describe observable behavior,
 * habits and preferences — never diagnoses or character judgments (spec §八).
 */
const UNSAFE_LABELS = [
  '抑郁症', '抑郁', '焦虑症', '焦虑障碍', '双相', '躁郁', '人格障碍', '自闭症', '自闭倾向',
  '强迫症', '创伤后应激', 'PTSD', 'ADHD', '注意力缺陷', '精神分裂',
  '成瘾', '上瘾', '依赖症', 'addiction', 'addictive', 'depression', 'depressed',
  'anxiety disorder', 'bipolar', 'ocd', 'narcissist', '自恋型', '边缘型',
  '自我牺牲型人格', '回避型人格', '讨好型人格', '心理疾病', '精神疾病', '有心理问题',
  'lazy', '懒惰成性', '没有自制力', '自制力差', '道德', '人品有问题',
];

/** Returns a matched unsafe label, or null when the text is acceptable. */
export function findUnsafePatternLabel(text: string): string | null {
  const lower = text.toLowerCase();
  for (const label of UNSAFE_LABELS) {
    if (lower.includes(label.toLowerCase())) return label;
  }
  return null;
}

/** Confidence delta bounds validation — the DB is never exposed to out-of-range model output. */
export function clampConfidenceDelta(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(-MAX_CONFIDENCE_DELTA, Math.min(MAX_CONFIDENCE_DELTA, num));
}

/**
 * Parse and validate one model decision. Returns null for malformed output
 * (schema violation, unknown pattern id, unsafe text) — callers treat null as IGNORE.
 */
export function parsePatternDecision(
  raw: string,
  validPatternIds: Set<string>,
): {decision: PatternDecision | null; error?: string} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return {decision: null, error: 'not-json'};
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return {decision: null, error: 'not-json'};
    }
  }
  if (!parsed || typeof parsed !== 'object') return {decision: null, error: 'not-object'};
  const obj = parsed as Record<string, unknown>;
  const action = String(obj.action ?? '').toLowerCase();
  const reason = typeof obj.reason === 'string' ? obj.reason.slice(0, 300) : undefined;
  const patternId = typeof obj.pattern_id === 'string' ? obj.pattern_id : typeof obj.patternId === 'string' ? obj.patternId : '';

  switch (action) {
    case 'support':
    case 'contradict': {
      if (!patternId || !validPatternIds.has(patternId)) {
        return {decision: null, error: 'unknown-pattern-id'};
      }
      return {decision: {action, pattern_id: patternId, confidence_delta: clampConfidenceDelta(obj.confidence_delta), reason}};
    }
    case 'update': {
      if (!patternId || !validPatternIds.has(patternId)) return {decision: null, error: 'unknown-pattern-id'};
      const text = String(obj.text ?? '').trim().slice(0, 400);
      if (!text) return {decision: null, error: 'empty-text'};
      if (findUnsafePatternLabel(text)) return {decision: null, error: 'unsafe-label'};
      return {decision: {action: 'update', pattern_id: patternId, text, keywords: sanitizeKeywords(obj.keywords), reason}};
    }
    case 'create': {
      const text = String(obj.text ?? '').trim().slice(0, 400);
      if (!text) return {decision: null, error: 'empty-text'};
      const unsafe = findUnsafePatternLabel(text);
      if (unsafe) return {decision: null, error: `unsafe-label:${unsafe}`};
      return {
        decision: {
          action: 'create',
          text,
          category: String(obj.category ?? 'behavior'),
          keywords: sanitizeKeywords(obj.keywords),
          confidence_delta: clampConfidenceDelta(obj.confidence_delta ?? 0),
          reason,
        },
      };
    }
    case 'ignore':
    case 'none':
      return {decision: {action: 'ignore', reason}};
    default:
      return {decision: null, error: `unknown-action:${action}`};
  }
}

function joinEndpoint(base: string, path: string): string {
  const root = base.replace(/\/+$/, '');
  return `${root}${path.startsWith('/') ? path : `/${path}`}`;
}

async function callUtilityJson(deps: PatternPipelineDeps, system: string, user: string): Promise<string | null> {
  const ref = deps.getModel();
  if (!ref) return null;
  const anthropic = ref.provider.toLowerCase().includes('anthropic');
  const started = Date.now();
  try {
    const response = await fetch(
      joinEndpoint(ref.endpoint, anthropic ? '/messages' : '/chat/completions'),
      anthropic
        ? {
            method: 'POST',
            headers: {'content-type': 'application/json', 'x-api-key': ref.apiKey, 'anthropic-version': '2023-06-01'},
            body: JSON.stringify({
              model: ref.model,
              max_tokens: 700,
              temperature: 0,
              stream: false,
              system,
              messages: [{role: 'user', content: user}],
            }),
          }
        : {
            method: 'POST',
            headers: {'content-type': 'application/json', authorization: `Bearer ${ref.apiKey}`},
            body: JSON.stringify({
              model: ref.model,
              temperature: 0,
              stream: false,
              messages: [
                {role: 'system', content: system},
                {role: 'user', content: user},
              ],
            }),
          },
    );
    if (!response.ok) {
      deps.log?.(`[pattern] model returned ${response.status}`);
      return null;
    }
    const ctype = response.headers.get('content-type') || '';
    const rawText = await response.text();
    if (ctype.includes('text/event-stream') || rawText.trimStart().startsWith('data:')) return null;
    let json: any;
    try {
      json = JSON.parse(rawText);
    } catch {
      return null;
    }
    deps.recordUsage?.(ref.provider, ref.model, json.usage, Date.now() - started);
    const text = anthropic
      ? (json.content || []).map((c: any) => c.text).join('')
      : json.choices?.[0]?.message?.content || '';
    return String(text);
  } catch (error) {
    deps.log?.('[pattern] model call failed', error);
    return null;
  }
}

const DECISION_SYSTEM_PROMPT = `You maintain long-term behavioral patterns inferred from a user's memories.
A pattern describes OBSERVABLE, REPEATING behavior only: habits, preferences, routines, work style, communication style, relationship dynamics.
Never output diagnoses, clinical labels, personality-disorder claims, moral judgments or identity speculation.
One or two occurrences are NOT a stable pattern.

You receive one new memory and the currently relevant patterns. Reply with ONE JSON object, nothing else:
- If the memory supports an existing pattern:
  {"action":"support","pattern_id":"<id>","confidence_delta":0.02,"reason":"..."}
  confidence_delta in [0.02, 0.15]; keep small — each single memory is weak evidence.
- If the memory conflicts with an existing pattern:
  {"action":"contradict","pattern_id":"<id>","confidence_delta":-0.08,"reason":"..."}
  confidence_delta in [-0.2, -0.03].
- If an existing pattern's wording should be generalized/refined (only when clearly the same underlying pattern):
  {"action":"update","pattern_id":"<id>","text":"...","keywords":["..."],"reason":"..."}
- If the memory hints at a NEW repeating behavior not covered by any listed pattern:
  {"action":"create","text":"用户…的稳定行为描述","category":"behavior|preference|relationship|state|work_style|communication|routine","keywords":["检索关键词"],"reason":"..."}
  Only create for behavior that plausibly repeats (sleep, meals, exercise, work habits, spending, social habits).
  A single emotional remark or one-off event must NOT create a pattern.
- Otherwise: {"action":"ignore","reason":"..."}

Rules:
- pattern_id must be one of the ids listed in the input; never invent ids.
- "keywords" are 2-6 short retrieval keywords for the pattern (synonyms of its key concepts, e.g. 熬夜/晚睡/睡眠不足).
- Prefer support/ignore over create. Output JSON only.`;

/**
 * Incremental pattern update for a batch of newly saved memories.
 * Safe to call with missing config or model failures — returns a no-op outcome.
 */
export async function updatePatternsFromMemories(
  deps: PatternPipelineDeps,
  memoryIds: string[],
  opts?: {observerId?: string},
): Promise<PatternUpdateOutcome> {
  const outcome: PatternUpdateOutcome = {
    processed: 0,
    supported: [],
    contradicted: [],
    updated: [],
    created: [],
    ignored: 0,
    rejected: 0,
  };
  const {memory} = deps;
  const engine = memory.patterns;
  const model = deps.getModel();

  for (const memoryId of memoryIds.slice(0, 8)) {
    const record = memory.get(memoryId);
    if (!record || record.expired) continue;
    outcome.processed++;

    // Retrieve nearby existing patterns (keyword-indexed FTS bridges lexical gaps).
    const nearby = engine.search(record.text, 5).filter((p) => p.status !== 'archived');
    const patternBlock = nearby.length
      ? nearby
          .map((p) => `- id=${p.id} [${p.status}, conf=${p.confidence.toFixed(2)}, evidence=${p.evidenceCount}] ${p.text}`)
          .join('\n')
      : '(none)';

    if (!model) {
      // No model configured: deterministic fallback only — skip silently.
      outcome.ignored++;
      continue;
    }

    const user = `New memory (${record.category}): ${record.text}\n\nExisting relevant patterns:\n${patternBlock}`;
    const raw = await callUtilityJson(deps, DECISION_SYSTEM_PROMPT, user);
    if (raw == null) {
      outcome.rejected++;
      continue;
    }
    const {decision, error} = parsePatternDecision(raw, new Set(nearby.map((p) => p.id)));
    if (!decision) {
      outcome.rejected++;
      deps.log?.(`[pattern] invalid model decision ignored: ${error}`);
      continue;
    }

    switch (decision.action) {
      case 'ignore': {
        outcome.ignored++;
        break;
      }
      case 'support': {
        // Back-solve evidence weight so impact ≈ requested delta (supports: delta = w*0.08).
        const weight = Math.max(0.15, Math.min(1, Math.abs(decision.confidence_delta) / 0.08));
        engine.addEvidence({
          patternId: decision.pattern_id,
          memoryId,
          relation: 'supports',
          weight,
          reason: decision.reason ?? null,
        });
        outcome.supported.push(decision.pattern_id);
        break;
      }
      case 'contradict': {
        const weight = Math.max(0.15, Math.min(1, Math.abs(decision.confidence_delta) / 0.12));
        engine.addEvidence({
          patternId: decision.pattern_id,
          memoryId,
          relation: 'contradicts',
          weight,
          reason: decision.reason ?? null,
        });
        outcome.contradicted.push(decision.pattern_id);
        break;
      }
      case 'update': {
        engine.update(decision.pattern_id, {text: decision.text, keywords: decision.keywords});
        const weight = 0.4;
        engine.addEvidence({
          patternId: decision.pattern_id,
          memoryId,
          relation: 'supports',
          weight,
          reason: decision.reason ?? 'update',
        });
        outcome.updated.push(decision.pattern_id);
        break;
      }
      case 'create': {
        // Duplicate guard: if a near-duplicate already exists, support it instead.
        const dup = findNearDuplicate(engine, decision.text);
        if (dup) {
          engine.addEvidence({
            patternId: dup.id,
            memoryId,
            relation: 'supports',
            weight: 0.5,
            reason: decision.reason ?? 'duplicate-create-merged',
          });
          outcome.supported.push(dup.id);
          break;
        }
        const created = engine.create({
          text: decision.text,
          category: decision.category,
          confidence: Math.min(0.45, Math.max(0.1, CANDIDATE_CONFIDENCE + clampConfidenceDelta(decision.confidence_delta ?? 0))),
          status: 'candidate',
          keywords: decision.keywords,
          metadata: opts?.observerId ? {observerId: opts.observerId} : null,
        });
        engine.addEvidence({
          patternId: created.id,
          memoryId,
          relation: 'supports',
          weight: 0.5,
          reason: decision.reason ?? 'initial evidence',
        });
        outcome.created.push(created.id);
        break;
      }
    }
  }
  return outcome;
}

/** Character-bigram similarity guard used before creating a new pattern. */
function findNearDuplicate(engine: MemoryEngine['patterns'], text: string): PatternRecord | null {
  const hits = engine.search(text, 3);
  for (const hit of hits) {
    if (similarity(hit.text, text) > 0.6) return hit;
  }
  return null;
}

function similarity(a: string, b: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  const grams = (s: string) => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    if (!set.size) set.add(s);
    return set;
  };
  const ga = grams(na);
  const gb = grams(nb);
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / (ga.size + gb.size - inter);
}

/**
 * Render a small context block of relevant patterns for chat/proactive prompts.
 * Context augmentation only — never a full dump of the pattern DB.
 */
export function formatPatternsForPrompt(hits: Array<PatternRecord & {score?: number}>): string {
  const usable = hits
    .filter((p) => (p.status === 'active' || p.status === 'candidate' || p.status === 'weakening') && p.confidence >= 0.45)
    .slice(0, 4);
  if (!usable.length) return '';
  const lines = usable.map((p) => `- [${p.status}, conf=${p.confidence.toFixed(2)}] ${p.text}`);
  return `[Relevant long-term patterns · long-standing observations about the user]
${lines.join('\n')}
Use these as background understanding only: weave them in naturally when truly relevant.
Never recite them mechanically ("根据数据库…"), and never treat them as more certain than their confidence suggests.
If the user's latest words contradict a pattern, prefer the latest words.`;
}
