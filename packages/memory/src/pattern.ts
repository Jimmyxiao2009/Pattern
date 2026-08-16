import type {Database} from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import type {
  PatternCategory,
  PatternEvidenceRecord,
  PatternEvidenceRelation,
  PatternRecord,
  PatternStatus,
  PatternWithEvidence,
} from '@pattern/protocol';

export type {
  PatternCategory,
  PatternEvidenceRecord,
  PatternEvidenceRelation,
  PatternRecord,
  PatternStatus,
  PatternWithEvidence,
};

/** Search hit with relevance score for pattern retrieval. */
export interface PatternSearchHit extends PatternRecord {
  score: number;
}

/** Result of a pattern consolidation pass. */
export interface PatternConsolidateResult {
  at: number;
  promoted: number;
  weakened: number;
  contradicted: number;
  archived: number;
  merged: number;
}

const CATEGORY_MAP: Record<string, PatternCategory> = {
  behavior: 'behavior',
  preference: 'preference',
  relationship: 'relationship',
  state: 'state',
  work_style: 'work_style',
  communication: 'communication',
  routine: 'routine',
  other: 'other',
  行为: 'behavior',
  偏好: 'preference',
  关系: 'relationship',
  状态: 'state',
  工作方式: 'work_style',
  交流方式: 'communication',
  习惯: 'routine',
  其他: 'other',
};

export function normalizePatternCategory(value: string): PatternCategory {
  return CATEGORY_MAP[value] ?? CATEGORY_MAP[value.toLowerCase()] ?? 'other';
}

export function patternCategoryLabel(category: PatternCategory): string {
  return (
    {
      behavior: '行为',
      preference: '偏好',
      relationship: '关系',
      state: '状态',
      work_style: '工作方式',
      communication: '交流方式',
      routine: '习惯',
      other: '其他',
    } as const
  )[category];
}

const STATUS_SET = new Set<PatternStatus>(['candidate', 'active', 'weakening', 'contradicted', 'archived']);

export function normalizePatternStatus(value: string): PatternStatus {
  return STATUS_SET.has(value as PatternStatus) ? (value as PatternStatus) : 'candidate';
}

const RELATION_SET = new Set<PatternEvidenceRelation>(['supports', 'contradicts']);

export function normalizeEvidenceRelation(value: string): PatternEvidenceRelation {
  return RELATION_SET.has(value as PatternEvidenceRelation) ? (value as PatternEvidenceRelation) : 'supports';
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function clampWeight(value: number) {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

/** Normalize model/user-supplied keywords: trimmed, deduped, bounded. */
export function sanitizeKeywords(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out = new Set<string>();
  for (const raw of input) {
    const clean = String(raw ?? '').trim().slice(0, 40);
    if (clean) out.add(clean);
    if (out.size >= 16) break;
  }
  return [...out];
}

/**
 * PatternEngine — derived cognitive layer over the existing memory system.
 *
 * Patterns are long-term inferences about the user formed from multiple memories.
 * They are NOT memories themselves: a memory is a fact ("user slept at 3am last
 * night"), a pattern is an inference ("user tends to delay sleep during project
 * sprints"). Patterns carry evidence links back to source memories so they can
 * always answer "why do you think this?".
 *
 * The engine lives in the same SQLite database as MemoryEngine (memory.db) but
 * uses its own tables. It is designed for future multi-observer support via the
 * metadata.observerId field — the schema is not hardcoded to a single observer.
 */
export class PatternEngine {
  constructor(private db: Database.Database) {}

  /** Create tables if they don't exist. Called once during MemoryEngine migration. */
  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pattern (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'other',
        confidence REAL NOT NULL DEFAULT 0.3,
        status TEXT NOT NULL DEFAULT 'candidate',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_observed_at INTEGER NOT NULL,
        evidence_count INTEGER NOT NULL DEFAULT 0,
        metadata TEXT,
        embedding BLOB
      );
      CREATE TABLE IF NOT EXISTS pattern_evidence (
        id TEXT PRIMARY KEY,
        pattern_id TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        relation TEXT NOT NULL DEFAULT 'supports',
        weight REAL NOT NULL DEFAULT 0.5,
        created_at INTEGER NOT NULL,
        reason TEXT,
        FOREIGN KEY (pattern_id) REFERENCES pattern(id) ON DELETE CASCADE,
        FOREIGN KEY (memory_id) REFERENCES memory(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_pattern_evidence_pattern ON pattern_evidence(pattern_id);
      CREATE INDEX IF NOT EXISTS idx_pattern_evidence_memory ON pattern_evidence(memory_id);
      CREATE INDEX IF NOT EXISTS idx_pattern_status ON pattern(status);
      CREATE INDEX IF NOT EXISTS idx_pattern_category ON pattern(category);
      CREATE INDEX IF NOT EXISTS idx_pattern_confidence ON pattern(confidence DESC);
      CREATE INDEX IF NOT EXISTS idx_pattern_last_observed ON pattern(last_observed_at DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS pattern_fts USING fts5(
        id UNINDEXED,
        text,
        tokenize = 'unicode61'
      );
      CREATE TABLE IF NOT EXISTS pattern_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS pattern_ad AFTER DELETE ON pattern BEGIN
        DELETE FROM pattern_fts WHERE id = old.id;
      END;
    `);
    this.ensurePatternColumns();
  }

  private ensurePatternColumns() {
    const cols = (this.db.prepare(`PRAGMA table_info(pattern)`).all() as Array<{name: string}>).map((c) => c.name);
    const add = (name: string, ddl: string) => {
      if (!cols.includes(name)) this.db.exec(`ALTER TABLE pattern ADD COLUMN ${ddl}`);
    };
    add('metadata', 'metadata TEXT');
    add('embedding', 'embedding BLOB');
  }

  private ftsUpsert(id: string, text: string, keywords?: string[] | null) {
    const expanded = keywords?.length ? `${text} ${keywords.join(' ')}` : text;
    this.db.prepare(`DELETE FROM pattern_fts WHERE id = ?`).run(id);
    this.db.prepare(`INSERT INTO pattern_fts(id, text) VALUES (?, ?)`).run(id, ftsPatternText(expanded));
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM pattern_meta WHERE key = ?`).get(key) as {value: string} | undefined;
    return row ? row.value : null;
  }

  setMeta(key: string, value: string) {
    this.db
      .prepare(`INSERT INTO pattern_meta(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }

  private mapRow(row: Record<string, unknown>): PatternRecord {
    let metadata: Record<string, unknown> | null = null;
    if (row.metadata) {
      try {
        metadata = JSON.parse(String(row.metadata));
      } catch {
        metadata = null;
      }
    }
    return {
      id: String(row.id),
      text: String(row.text),
      category: normalizePatternCategory(String(row.category ?? 'other')),
      confidence: clamp01(Number(row.confidence ?? 0.3)),
      status: normalizePatternStatus(String(row.status ?? 'candidate')),
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
      lastObservedAt: Number(row.last_observed_at ?? 0),
      evidenceCount: Number(row.evidence_count ?? 0),
      metadata,
    };
  }

  private mapEvidenceRow(row: Record<string, unknown>): PatternEvidenceRecord {
    return {
      id: String(row.id),
      patternId: String(row.pattern_id),
      memoryId: String(row.memory_id),
      relation: normalizeEvidenceRelation(String(row.relation ?? 'supports')),
      weight: clampWeight(Number(row.weight ?? 0.5)),
      createdAt: Number(row.created_at ?? 0),
      reason: row.reason == null ? null : String(row.reason),
    };
  }

  private recomputeEvidenceCount(patternId: string) {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM pattern_evidence WHERE pattern_id = ?`)
      .get(patternId) as {c: number};
    this.db.prepare(`UPDATE pattern SET evidence_count = ? WHERE id = ?`).run(Number(row.c), patternId);
  }

  create(input: {
    text: string;
    category?: string;
    confidence?: number;
    status?: PatternStatus;
    metadata?: Record<string, unknown> | null;
    /** Retrieval keywords indexed into pattern FTS (bridges lexical gaps, e.g. 晚睡/熬夜). */
    keywords?: string[] | null;
    embedding?: Buffer | null;
  }): PatternRecord {
    const id = randomUUID();
    const ts = now();
    const category = normalizePatternCategory(input.category ?? 'other');
    const confidence = clamp01(input.confidence ?? 0.3);
    const status = input.status ?? 'candidate';
    const keywords = sanitizeKeywords(input.keywords);
    const metadata = {...(input.metadata ?? {}), ...(keywords.length ? {keywords} : {})};
    const metadataStr = Object.keys(metadata).length ? JSON.stringify(metadata) : null;
    this.db
      .prepare(
        `INSERT INTO pattern(id, text, category, confidence, status, created_at, updated_at, last_observed_at, evidence_count, metadata, embedding)
         VALUES (?,?,?,?,?,?,?,?,0,?,?)`,
      )
      .run(id, input.text, category, confidence, status, ts, ts, ts, metadataStr, input.embedding ?? null);
    this.ftsUpsert(id, input.text, keywords);
    return this.get(id)!;
  }

  get(id: string): PatternRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, text, category, confidence, status, created_at, updated_at, last_observed_at, evidence_count, metadata
         FROM pattern WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  getWithEvidence(id: string): PatternWithEvidence | null {
    const pattern = this.get(id);
    if (!pattern) return null;
    const evidence = this.listEvidence(id);
    return {...pattern, evidence};
  }

  update(
    id: string,
    patch: {text?: string; category?: string | null; confidence?: number; status?: PatternStatus; metadata?: Record<string, unknown> | null; keywords?: string[] | null},
  ): PatternRecord | null {
    const current = this.get(id);
    if (!current) return null;
    const text = patch.text?.trim() || current.text;
    const category = patch.category ? normalizePatternCategory(patch.category) : current.category;
    const confidence = typeof patch.confidence === 'number' ? clamp01(patch.confidence) : current.confidence;
    const status = patch.status ?? current.status;
    // Preserve existing keywords unless explicitly replaced.
    const keywords =
      patch.keywords !== undefined
        ? sanitizeKeywords(patch.keywords)
        : sanitizeKeywords((current.metadata?.keywords as string[] | undefined) ?? []);
    let metadataStr: string | null | undefined;
    if (patch.metadata !== undefined || patch.keywords !== undefined || (patch.text && patch.text.trim() !== current.text)) {
      const metadata = {...(current.metadata ?? {}), ...(patch.metadata ?? {}), ...(keywords.length ? {keywords} : {})};
      metadataStr = Object.keys(metadata).length ? JSON.stringify(metadata) : null;
    }
    const ts = now();
    if (metadataStr !== undefined) {
      this.db
        .prepare(`UPDATE pattern SET text = ?, category = ?, confidence = ?, status = ?, updated_at = ?, last_observed_at = ?, metadata = ? WHERE id = ?`)
        .run(text, category, confidence, status, ts, ts, metadataStr, id);
    } else {
      this.db
        .prepare(`UPDATE pattern SET text = ?, category = ?, confidence = ?, status = ?, updated_at = ?, last_observed_at = ? WHERE id = ?`)
        .run(text, category, confidence, status, ts, ts, id);
    }
    if (patch.text && patch.text.trim() !== current.text) this.ftsUpsert(id, text, keywords);
    return this.get(id);
  }

  /** Adjust confidence by a delta, clamped to [0,1]. */
  adjustConfidence(id: string, delta: number): PatternRecord | null {
    const current = this.get(id);
    if (!current) return null;
    return this.update(id, {confidence: current.confidence + delta});
  }

  archive(id: string): boolean {
    const current = this.get(id);
    if (!current) return false;
    this.update(id, {status: 'archived'});
    return true;
  }

  delete(id: string): boolean {
    // pattern_evidence has ON DELETE CASCADE, but better-sqlite3 needs PRAGMA foreign_keys=ON
    this.db.prepare(`DELETE FROM pattern_evidence WHERE pattern_id = ?`).run(id);
    const result = this.db.prepare(`DELETE FROM pattern WHERE id = ?`).run(id);
    return Number(result.changes) > 0;
  }

  list(opts?: {
    query?: string | null;
    category?: string | null;
    status?: string | null;
    limit?: number;
  }): PatternRecord[] {
    const limit = Math.min(500, opts?.limit ?? 200);
    const cat = opts?.category && opts.category !== 'all' ? normalizePatternCategory(opts.category) : null;
    const st = opts?.status && opts.status !== 'all' ? normalizePatternStatus(opts.status) : null;
    const q = opts?.query?.trim() || '';

    if (q) {
      const rows = this.candidateRows(q, cat, st, limit);
      return rows.map((r) => this.mapRow(r));
    }

    const rows = this.db
      .prepare(
        `SELECT id, text, category, confidence, status, created_at, updated_at, last_observed_at, evidence_count, metadata
         FROM pattern
         WHERE (? IS NULL OR category = ?) AND (? IS NULL OR status = ?)
         ORDER BY
           CASE status WHEN 'active' THEN 0 WHEN 'candidate' THEN 1 WHEN 'weakening' THEN 2 WHEN 'contradicted' THEN 3 WHEN 'archived' THEN 4 END,
           confidence DESC, last_observed_at DESC
         LIMIT ?`,
      )
      .all(cat, cat, st, st, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  private candidateRows(
    query: string,
    category: PatternCategory | null,
    status: PatternStatus | null,
    limit: number,
  ): Array<Record<string, unknown>> {
    const byId = new Map<string, Record<string, unknown>>();
    const ftsQ = buildPatternFtsQuery(query);
    if (ftsQ) {
      try {
        const ftsIds = (
          this.db.prepare(`SELECT id FROM pattern_fts WHERE pattern_fts MATCH ? LIMIT ?`).all(ftsQ, limit) as Array<{
            id: string;
          }>
        ).map((r) => r.id);
        if (ftsIds.length) {
          const placeholders = ftsIds.map(() => '?').join(',');
          const rows = this.db
            .prepare(
              `SELECT id, text, category, confidence, status, created_at, updated_at, last_observed_at, evidence_count, metadata
               FROM pattern WHERE id IN (${placeholders}) AND (? IS NULL OR category = ?) AND (? IS NULL OR status = ?)`,
            )
            .all(...ftsIds, category, category, status, status) as Array<Record<string, unknown>>;
          for (const row of rows) byId.set(String(row.id), row);
        }
      } catch {
        /* bad MATCH query */
      }
    }
    // LIKE fallback
    try {
      const likeRows = this.db
        .prepare(
          `SELECT id, text, category, confidence, status, created_at, updated_at, last_observed_at, evidence_count, metadata
           FROM pattern WHERE text LIKE ? AND (? IS NULL OR category = ?) AND (? IS NULL OR status = ?) LIMIT ?`,
        )
        .all(`%${query}%`, category, category, status, status, limit) as Array<Record<string, unknown>>;
      for (const row of likeRows) byId.set(String(row.id), row);
    } catch {
      /* ignore */
    }
    return [...byId.values()];
  }

  /** Semantic-ish search: FTS + lexical overlap scoring. Returns top-K relevant patterns. */
  search(query: string, k = 5): PatternSearchHit[] {
    const q = query.trim();
    if (!q) return [];
    const rows = this.candidateRows(q, null, null, Math.max(k * 4, 20));
    const tokens = tokenizePattern(q);
    const hits: PatternSearchHit[] = [];
    for (const row of rows) {
      const mapped = this.mapRow(row);
      const keywords = sanitizeKeywords((mapped.metadata?.keywords as string[] | undefined) ?? []);
      const haystack = keywords.length ? `${mapped.text} ${keywords.join(' ')}` : mapped.text;
      const overlap = lexicalPatternOverlap(tokens, haystack);
      // Status and confidence factor into relevance: active > candidate > weakening > contradicted > archived
      const statusBoost =
        row.status === 'active'
          ? 1
          : row.status === 'candidate'
            ? 0.7
            : row.status === 'weakening'
              ? 0.5
              : row.status === 'contradicted'
                ? 0.2
                : 0.1;
      const score = overlap * 0.6 + clamp01(Number(row.confidence ?? 0)) * 0.25 * statusBoost + statusBoost * 0.15;
      if (score < 0.08 && !haystack.includes(q)) continue;
      hits.push({...mapped, score});
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }

  /** Attach evidence linking a pattern to a source memory. */
  addEvidence(input: {
    patternId: string;
    memoryId: string;
    relation?: PatternEvidenceRelation;
    weight?: number;
    reason?: string | null;
  }): PatternEvidenceRecord | null {
    const pattern = this.get(input.patternId);
    if (!pattern) return null;
    const id = randomUUID();
    const ts = now();
    const relation = normalizeEvidenceRelation(input.relation ?? 'supports');
    const weight = clampWeight(input.weight ?? 0.5);
    this.db
      .prepare(
        `INSERT INTO pattern_evidence(id, pattern_id, memory_id, relation, weight, created_at, reason)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(id, input.patternId, input.memoryId, relation, weight, ts, input.reason ?? null);
    this.recomputeEvidenceCount(input.patternId);
    // Update lastObservedAt and confidence based on evidence
    this.applyEvidenceImpact(input.patternId, relation, weight);
    return this.listEvidence(input.patternId).find((e) => e.id === id) ?? null;
  }

  listEvidence(patternId: string): PatternEvidenceRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, pattern_id, memory_id, relation, weight, created_at, reason
         FROM pattern_evidence WHERE pattern_id = ? ORDER BY created_at DESC`,
      )
      .all(patternId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapEvidenceRow(r));
  }

  /** Find patterns that have evidence pointing to a specific memory. */
  patternsForMemory(memoryId: string): PatternRecord[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT p.id, p.text, p.category, p.confidence, p.status, p.created_at, p.updated_at, p.last_observed_at, p.evidence_count, p.metadata
         FROM pattern p
         JOIN pattern_evidence e ON e.pattern_id = p.id
         WHERE e.memory_id = ?`,
      )
      .all(memoryId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  /** Adjust confidence and lastObservedAt when new evidence arrives. */
  private applyEvidenceImpact(patternId: string, relation: PatternEvidenceRelation, weight: number) {
    const current = this.get(patternId);
    if (!current) return;
    const ts = now();
    if (relation === 'supports') {
      // Supporting evidence increases confidence, scaled by weight.
      const delta = weight * 0.08;
      const newConfidence = clamp01(current.confidence + delta);
      // Promote candidate → active when enough supporting evidence accumulates
      const supportCount = this.db
        .prepare(`SELECT COUNT(*) AS c FROM pattern_evidence WHERE pattern_id = ? AND relation = 'supports'`)
        .get(patternId) as {c: number};
      const newStatus: PatternStatus =
        current.status === 'candidate' && supportCount.c >= 3 && newConfidence >= 0.55
          ? 'active'
          : current.status === 'archived'
            ? 'active'
            : current.status;
      this.db
        .prepare(`UPDATE pattern SET confidence = ?, status = ?, last_observed_at = ?, updated_at = ? WHERE id = ?`)
        .run(newConfidence, newStatus, ts, ts, patternId);
    } else {
      // Contradicting evidence decreases confidence.
      const delta = -weight * 0.12;
      const newConfidence = clamp01(current.confidence + delta);
      this.db
        .prepare(`UPDATE pattern SET confidence = ?, last_observed_at = ?, updated_at = ? WHERE id = ?`)
        .run(newConfidence, ts, ts, patternId);
    }
  }

  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM pattern`).get() as {c: number};
    return Number(row.c);
  }

  /**
   * Consolidation pass: age patterns based on evidence recency, find contradictions,
   * merge duplicates. Called alongside memory.consolidate() in the nightly dreaming job.
   */
  consolidate(): PatternConsolidateResult {
    const ts = now();
    let promoted = 0;
    let weakened = 0;
    let contradicted = 0;
    let archived = 0;
    let merged = 0;

    const activeOrCandidate = this.db
      .prepare(
        `SELECT id, confidence, status, last_observed_at,
           (SELECT COUNT(*) FROM pattern_evidence WHERE pattern_id = pattern.id AND relation = 'supports') AS support,
           (SELECT COUNT(*) FROM pattern_evidence WHERE pattern_id = pattern.id AND relation = 'contradicts') AS contra
         FROM pattern WHERE status IN ('active', 'candidate', 'weakening')`,
      )
      .all() as Array<{
        id: string;
        confidence: number;
        status: PatternStatus;
        last_observed_at: number;
        support: number;
        contra: number;
      }>;

    for (const p of activeOrCandidate) {
      const ageDays = (ts - p.last_observed_at) / 86400;
      // Contradicted: contra evidence outweighs support and confidence is low
      if (p.contra >= 2 && p.contra >= p.support && p.confidence < 0.35) {
        this.update(p.id, {status: 'contradicted'});
        contradicted++;
        continue;
      }
      // Promote candidate → active when enough support and confidence
      if (p.status === 'candidate' && p.support >= 3 && p.confidence >= 0.55) {
        this.update(p.id, {status: 'active'});
        promoted++;
        continue;
      }
      // Weakening: no new evidence for 14+ days, gradually decay confidence
      if (ageDays > 14 && p.status !== 'weakening') {
        const decay = Math.min(0.15, ageDays / 90 * 0.15);
        const newConfidence = clamp01(p.confidence - decay);
        if (newConfidence < 0.2 && p.status !== 'archived') {
          this.update(p.id, {status: 'archived', confidence: newConfidence});
          archived++;
        } else if (newConfidence < 0.4) {
          this.update(p.id, {status: 'weakening', confidence: newConfidence});
          weakened++;
        } else {
          this.update(p.id, {confidence: newConfidence});
        }
        continue;
      }
      // Already weakening: continue to decay, archive if confidence too low
      if (p.status === 'weakening') {
        const decay = Math.min(0.1, ageDays / 90 * 0.1);
        const newConfidence = clamp01(p.confidence - decay);
        if (newConfidence < 0.15) {
          this.update(p.id, {status: 'archived', confidence: newConfidence});
          archived++;
        } else {
          this.update(p.id, {confidence: newConfidence});
        }
      }
    }

    // Merge near-duplicate patterns: same category, high text similarity
    merged = this.mergeDuplicates();

    return {at: ts, promoted, weakened, contradicted, archived, merged};
  }

  /** Merge patterns with near-identical text (simple normalized equality). */
  private mergeDuplicates(): number {
    const patterns = this.list({limit: 500});
    let merged = 0;
    const seen = new Set<string>();
    for (const p of patterns) {
      if (seen.has(p.id) || p.status === 'archived') continue;
      const normalized = normalizePatternText(p.text);
      for (const other of patterns) {
        if (other.id === p.id || seen.has(other.id) || other.status === 'archived') continue;
        if (other.category !== p.category) continue;
        if (normalizePatternText(other.text) === normalized || textSimilarity(p.text, other.text) > 0.85) {
          // Merge other into p: move evidence, combine confidence
          this.db.prepare(`UPDATE pattern_evidence SET pattern_id = ? WHERE pattern_id = ?`).run(p.id, other.id);
          const otherEvidence = this.listEvidence(p.id);
          // Deduplicate evidence by memory_id (keep highest weight)
          const byMemory = new Map<string, PatternEvidenceRecord>();
          for (const e of otherEvidence) {
            const existing = byMemory.get(e.memoryId);
            if (!existing || e.weight > existing.weight) byMemory.set(e.memoryId, e);
          }
          // Remove duplicates
          const keepIds = new Set([...byMemory.values()].map((e) => e.id));
          for (const e of otherEvidence) {
            if (!keepIds.has(e.id)) {
              this.db.prepare(`DELETE FROM pattern_evidence WHERE id = ?`).run(e.id);
            }
          }
          const newConfidence = clamp01(Math.max(p.confidence, other.confidence));
          this.update(p.id, {confidence: newConfidence});
          this.recomputeEvidenceCount(p.id);
          // Delete the merged-away pattern
          this.db.prepare(`DELETE FROM pattern WHERE id = ?`).run(other.id);
          seen.add(other.id);
          merged++;
        }
      }
    }
    return merged;
  }
}

// --- Text processing helpers (parallel to memory's FTS utilities) ---

function tokenizePattern(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 1);
}

/** Expand CJK runs for FTS5 indexing, mirroring memory's ftsIndexText. */
function ftsPatternText(text: string): string {
  const parts: string[] = [text];
  for (const token of tokenizePattern(text)) {
    parts.push(token);
    if (/[\u4e00-\u9fff]/.test(token)) {
      for (const ch of token) parts.push(ch);
      for (let i = 0; i < token.length - 1; i++) parts.push(token.slice(i, i + 2));
      if (token.length >= 3) {
        for (let i = 0; i < token.length - 2; i++) parts.push(token.slice(i, i + 3));
      }
    }
  }
  return parts.join(' ');
}

/** Build a safe FTS5 MATCH query from user text. */
function buildPatternFtsQuery(query: string): string {
  const terms = new Set<string>();
  const push = (raw: string, prefix = false) => {
    const clean = raw.replace(/["*():^]/g, ' ').trim();
    if (!clean) return;
    if (prefix && /^[a-z0-9_-]+$/i.test(clean) && clean.length >= 2) {
      terms.add(`${clean}*`);
    } else {
      terms.add(`"${clean.replace(/"/g, '')}"`);
    }
  };
  for (const token of tokenizePattern(query)) {
    if (/[\u4e00-\u9fff]/.test(token)) {
      push(token);
      if (token.length >= 2) {
        for (let i = 0; i < token.length - 1; i++) push(token.slice(i, i + 2));
      } else {
        push(token);
      }
    } else {
      push(token, true);
    }
  }
  const cjkRuns = query.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjkRuns) {
    push(run);
    for (let i = 0; i < run.length - 1; i++) push(run.slice(i, i + 2));
  }
  return [...terms].join(' OR ');
}

function lexicalPatternOverlap(queryTokens: string[], text: string): number {
  if (!queryTokens.length) return 0;
  const lower = text.toLowerCase();
  let bm = 0;
  for (const t of queryTokens) if (lower.includes(t)) bm += 1;
  const cjk = queryTokens.join('');
  if (/[\u4e00-\u9fff]/.test(cjk)) {
    for (let i = 0; i < cjk.length - 1; i++) {
      if (lower.includes(cjk.slice(i, i + 2))) bm += 0.5;
    }
  }
  return Math.min(1, bm / Math.max(1, queryTokens.length));
}

function normalizePatternText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Simple character-bigram Jaccard similarity for duplicate detection. */
function textSimilarity(a: string, b: string): number {
  const bigramsA = new Set<string>();
  const na = normalizePatternText(a);
  for (let i = 0; i < na.length - 1; i++) bigramsA.add(na.slice(i, i + 2));
  const bigramsB = new Set<string>();
  const nb = normalizePatternText(b);
  for (let i = 0; i < nb.length - 1; i++) bigramsB.add(nb.slice(i, i + 2));
  if (!bigramsA.size || !bigramsB.size) return 0;
  let intersection = 0;
  for (const bg of bigramsA) if (bigramsB.has(bg)) intersection++;
  return intersection / (bigramsA.size + bigramsB.size - intersection);
}
