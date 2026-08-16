import Database from 'better-sqlite3';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import type {MemoryCategory, MemoryRecord} from '@pattern/protocol';
import {PatternEngine} from './pattern';

export type {MemoryCategory, MemoryRecord};
export {PatternEngine} from './pattern';
export type {
  PatternCategory,
  PatternEvidenceRecord,
  PatternEvidenceRelation,
  PatternRecord,
  PatternStatus,
  PatternWithEvidence,
  PatternSearchHit,
  PatternConsolidateResult,
} from './pattern';
export {
  normalizePatternCategory,
  patternCategoryLabel,
  normalizePatternStatus,
  normalizeEvidenceRelation,
  sanitizeKeywords,
} from './pattern';

export interface SearchHit extends MemoryRecord {
  score: number;
}

export interface ConsolidateResult {
  at: number;
  semanticAdded: number;
  decayed: number;
  evicted: number;
}

const CATEGORY_MAP: Record<string, MemoryCategory> = {
  fact: 'fact',
  preference: 'preference',
  event: 'event',
  feedback: 'feedback',
  reference: 'reference',
  事实: 'fact',
  偏好: 'preference',
  事件: 'event',
  反馈: 'feedback',
  参考: 'reference',
};

export function normalizeCategory(value: string): MemoryCategory {
  return CATEGORY_MAP[value] ?? CATEGORY_MAP[value.toLowerCase()] ?? 'fact';
}

export function categoryLabel(category: MemoryCategory): string {
  return ({fact: '事实', preference: '偏好', event: '事件', feedback: '反馈', reference: '参考'} as const)[category];
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function clampImportance(value: number) {
  if (!Number.isFinite(value)) return 0.5;
  if (value > 1) return Math.min(1, value / 3);
  return Math.max(0, Math.min(1, value));
}

export type EmbedProvider = 'hash' | 'api' | 'local-model';

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 1);
}

/** Expand CJK runs into unigrams/bigrams so FTS5 unicode61 can substring-match Chinese. */
export function ftsIndexText(text: string): string {
  const parts: string[] = [text];
  for (const token of tokenize(text)) {
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

/** Build a safe FTS5 MATCH query from user text (CJK bigrams + latin tokens). */
export function buildFtsMatchQuery(query: string): string {
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

  for (const token of tokenize(query)) {
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

/** Lightweight bag-of-chars embedding for offline similarity (dim 256). Default provider: hash. */
export function localEmbed(text: string): Float32Array {
  const vec = new Float32Array(256);
  const tokens = tokenize(text);
  if (!tokens.length) return vec;
  for (const token of tokens) {
    const h = createHash('sha256').update(token).digest();
    for (let i = 0; i < 32; i++) {
      const idx = h[i] % 256;
      const sign = h[(i + 1) % 32] & 1 ? 1 : -1;
      vec[idx] += sign * (1 + token.length / 8);
    }
    for (const ch of token) {
      const code = ch.codePointAt(0) ?? 0;
      vec[code % 256] += 0.35;
    }
  }
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

function lexicalOverlap(queryTokens: string[], text: string): number {
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

function hybridScore(cos: number, bm25: number, importance: number, updatedAt: number, accessCount: number) {
  return (
    0.55 * Math.max(0, cos) +
    0.25 * bm25 +
    0.1 * importance +
    0.06 * recency(updatedAt) +
    0.04 * Math.log10(accessCount + 1)
  );
}

function cosine(a: Float32Array, b: Float32Array) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function blobFromVec(vec: Float32Array) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

function vecFromBlob(blob: Buffer | Uint8Array | null): Float32Array | null {
  if (!blob) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buf.byteLength < 4) return null;
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

export class MemoryEngine {
  private db: Database.Database;
  private indexCache = '';
  private lastConsolidateAt: number | null = null;
  private embedFn: ((text: string) => Promise<Float32Array>) | null = null;
  /** Derived cognitive layer sharing the same SQLite database. */
  readonly patterns: PatternEngine;

  constructor(private dataDir: string) {
    mkdirSync(dataDir, {recursive: true});
    this.db = new Database(join(dataDir, 'memory.db'));
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.patterns = new PatternEngine(this.db);
    this.migrate();
    this.refreshIndex();
    this.loadMeta();
  }

  setEmbedder(fn: ((text: string) => Promise<Float32Array>) | null) {
    this.embedFn = fn;
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        category TEXT NOT NULL,
        importance REAL NOT NULL DEFAULT 0.5,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0,
        source_conv TEXT,
        expired INTEGER NOT NULL DEFAULT 0,
        replaces_id TEXT,
        embedding BLOB
      );
      CREATE TABLE IF NOT EXISTS memory_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        id UNINDEXED,
        text,
        tokenize = 'unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
        DELETE FROM memory_fts WHERE id = old.id;
      END;
    `);
    // App-managed FTS documents (CJK expansion). Drop legacy raw-text triggers if present.
    this.db.exec(`DROP TRIGGER IF EXISTS memory_ai;`);
    this.db.exec(`DROP TRIGGER IF EXISTS memory_au;`);
    this.ensureColumns();
    this.importLegacyJson();
    this.importLegacyImportance();
    this.ensureFtsV2();
    // Derived cognitive layer: pattern tables share the same database.
    this.patterns.migrate();
  }

  private ftsUpsert(id: string, text: string) {
    this.db.prepare(`DELETE FROM memory_fts WHERE id = ?`).run(id);
    this.db.prepare(`INSERT INTO memory_fts(id, text) VALUES (?, ?)`).run(id, ftsIndexText(text));
  }

  private ensureFtsV2() {
    const row = this.db.prepare(`SELECT value FROM memory_meta WHERE key = 'fts_version'`).get() as
      | {value: string}
      | undefined;
    if (row?.value === '2') {
      const mem = this.db.prepare(`SELECT COUNT(*) AS c FROM memory`).get() as {c: number};
      const fts = this.db.prepare(`SELECT COUNT(*) AS c FROM memory_fts`).get() as {c: number};
      if (Number(mem.c) > 0 && Number(fts.c) === 0) this.rebuildFts();
      return;
    }
    this.rebuildFts();
    this.setMeta('fts_version', '2');
  }

  rebuildFts() {
    this.db.exec(`DELETE FROM memory_fts`);
    const rows = this.db.prepare(`SELECT id, text FROM memory`).all() as Array<{id: string; text: string}>;
    const ins = this.db.prepare(`INSERT INTO memory_fts(id, text) VALUES (?, ?)`);
    for (const r of rows) ins.run(r.id, ftsIndexText(r.text));
  }

  private ensureColumns() {
    const cols = (this.db.prepare(`PRAGMA table_info(memory)`).all() as Array<{name: string}>).map((c) => c.name);
    const add = (name: string, ddl: string) => {
      if (!cols.includes(name)) this.db.exec(`ALTER TABLE memory ADD COLUMN ${ddl}`);
    };
    add('replaces_id', 'replaces_id TEXT');
    add('embedding', 'embedding BLOB');
    // importance may still be integer affinity; values normalized elsewhere
  }

  private importLegacyJson() {
    const legacy = join(this.dataDir, 'memories.json');
    if (!existsSync(legacy)) return;
    const count = this.db.prepare('SELECT COUNT(*) AS c FROM memory').get() as {c: number};
    if (count.c > 0) return;
    try {
      const items = JSON.parse(readFileSync(legacy, 'utf8')) as Array<{
        id: string;
        category: string;
        text: string;
        importance?: number;
        expired?: boolean;
      }>;
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO memory(id,text,category,importance,created_at,updated_at,expired,embedding)
         VALUES (?,?,?,?,?,?,?,?)`,
      );
      const ts = now();
      for (const item of items) {
        const emb = localEmbed(item.text);
        insert.run(
          item.id,
          item.text,
          normalizeCategory(item.category),
          clampImportance(item.importance ?? 0.5),
          ts,
          ts,
          item.expired ? 1 : 0,
          blobFromVec(emb),
        );
      }
      renameSync(legacy, legacy + '.migrated');
    } catch {
      /* ignore broken legacy */
    }
  }

  private importLegacyImportance() {
    // Old Rust schema used INTEGER 1..3; convert rows still looking like that.
    this.db.prepare(`UPDATE memory SET importance = importance / 3.0 WHERE importance > 1`).run();
  }

  private loadMeta() {
    const row = this.db.prepare(`SELECT value FROM memory_meta WHERE key = 'last_consolidate_at'`).get() as
      | {value: string}
      | undefined;
    if (row) this.lastConsolidateAt = Number(row.value) || null;
  }

  private setMeta(key: string, value: string) {
    this.db.prepare(`INSERT INTO memory_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(
      key,
      value,
    );
  }

  private mapRow(row: Record<string, unknown>): MemoryRecord {
    const category = normalizeCategory(String(row.category ?? 'fact'));
    const access = Number(row.access_count ?? 0);
    return {
      id: String(row.id),
      text: String(row.text),
      category,
      importance: Number(row.importance ?? 0.5),
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
      accessCount: access,
      sourceConv: row.source_conv == null ? null : String(row.source_conv),
      expired: Number(row.expired ?? 0) !== 0,
      replacesId: row.replaces_id == null ? null : String(row.replaces_id),
      meta: `${categoryLabel(category)} · 访问 ${access}`,
    };
  }

  async embed(text: string): Promise<Float32Array> {
    if (this.embedFn) {
      try {
        return await this.embedFn(text);
      } catch {
        /* fall through */
      }
    }
    return localEmbed(text);
  }

  /**
   * Stage1 candidate retrieval: FTS5 MATCH (CJK-expanded docs) ∪ LIKE, capped.
   * Falls back to importance-ranked scan when both miss.
   */
  private candidateRows(query: string, category: MemoryCategory | null, limit = 250): Array<Record<string, unknown>> {
    const byId = new Map<string, Record<string, unknown>>();
    const selectByIds = (ids: string[]) => {
      if (!ids.length) return;
      for (let i = 0; i < ids.length; i += 200) {
        const chunk = ids.slice(i, i + 200);
        const placeholders = chunk.map(() => '?').join(',');
        const rows = this.db
          .prepare(
            `SELECT id,text,category,importance,created_at,updated_at,access_count,source_conv,expired,replaces_id,embedding
             FROM memory WHERE expired = 0 AND id IN (${placeholders}) AND (? IS NULL OR category = ?)`,
          )
          .all(...chunk, category, category) as Array<Record<string, unknown>>;
        for (const row of rows) byId.set(String(row.id), row);
      }
    };

    const ftsQ = buildFtsMatchQuery(query);
    if (ftsQ) {
      try {
        const ftsIds = (
          this.db
            .prepare(`SELECT id FROM memory_fts WHERE memory_fts MATCH ? LIMIT ?`)
            .all(ftsQ, limit) as Array<{id: string}>
        ).map((r) => r.id);
        selectByIds(ftsIds);
      } catch {
        /* bad MATCH query — ignore */
      }
    }

    try {
      const likeRows = this.db
        .prepare(
          `SELECT id,text,category,importance,created_at,updated_at,access_count,source_conv,expired,replaces_id,embedding
           FROM memory WHERE expired = 0 AND text LIKE ? AND (? IS NULL OR category = ?) LIMIT ?`,
        )
        .all(`%${query}%`, category, category, limit) as Array<Record<string, unknown>>;
      for (const row of likeRows) byId.set(String(row.id), row);
    } catch {
      /* ignore */
    }

    if (byId.size === 0) {
      const total = this.count();
      const scanLimit = total <= 2000 ? 2000 : limit;
      const rows = this.db
        .prepare(
          `SELECT id,text,category,importance,created_at,updated_at,access_count,source_conv,expired,replaces_id,embedding
           FROM memory WHERE expired = 0 AND (? IS NULL OR category = ?)
           ORDER BY importance DESC, updated_at DESC LIMIT ?`,
        )
        .all(category, category, scanLimit) as Array<Record<string, unknown>>;
      for (const row of rows) byId.set(String(row.id), row);
    }

    return [...byId.values()];
  }

  private scoreRows(query: string, rows: Array<Record<string, unknown>>, qEmb: Float32Array): SearchHit[] {
    const tokens = tokenize(query);
    const hits: SearchHit[] = [];
    for (const row of rows) {
      const text = String(row.text);
      let emb = vecFromBlob(row.embedding as Buffer);
      if (!emb) {
        emb = localEmbed(text);
        try {
          this.db.prepare(`UPDATE memory SET embedding = ? WHERE id = ?`).run(blobFromVec(emb), row.id);
        } catch {
          /* ignore */
        }
      }
      const a = qEmb.length === emb.length ? qEmb : localEmbed(query);
      const b = qEmb.length === emb.length ? emb : localEmbed(text);
      const cos = cosine(a, b);
      const bm25 = lexicalOverlap(tokens, text);
      const score = hybridScore(cos, bm25, Number(row.importance), Number(row.updated_at), Number(row.access_count));
      if (score < 0.12 && !text.includes(query) && bm25 === 0) continue;
      hits.push({...this.mapRow(row), score});
    }
    hits.sort((x, y) => y.score - x.score);
    return hits;
  }

  list(query?: string | null, category?: string | null, limit = 200): MemoryRecord[] {
    const cat = category && category !== 'all' ? normalizeCategory(category) : null;
    const q = query?.trim() || '';
    if (q) {
      const rows = this.candidateRows(q, cat, Math.max(limit * 4, 250));
      const hits = this.scoreRows(q, rows, localEmbed(q));
      return hits.slice(0, limit).map(({score: _s, ...item}) => item);
    }
    const rows = this.db
      .prepare(
        `SELECT id,text,category,importance,created_at,updated_at,access_count,source_conv,expired,replaces_id
         FROM memory WHERE expired = 0 AND (?1 IS NULL OR category = ?1)
         ORDER BY importance DESC, updated_at DESC LIMIT ?2`,
      )
      .all(cat, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  async search(query: string, k = 5): Promise<SearchHit[]> {
    const q = query.trim();
    if (!q) return [];
    const qEmb = await this.embed(q);
    // Stage1: FTS/LIKE candidates. Stage2: hybrid rerank with embedder.
    const rows = this.candidateRows(q, null, 300);
    return this.scoreRows(q, rows, qEmb).slice(0, k);
  }

  touch(ids: string[]) {
    const stmt = this.db.prepare(`UPDATE memory SET access_count = access_count + 1 WHERE id = ?`);
    for (const id of ids) stmt.run(id);
  }

  async add(input: {
    id?: string;
    text: string;
    category: string;
    importance?: number;
    sourceConv?: string | null;
    replacesId?: string | null;
  }): Promise<MemoryRecord> {
    const id = input.id ?? randomUUID();
    const ts = now();
    const category = normalizeCategory(input.category);
    const importance = clampImportance(input.importance ?? 0.5);
    const emb = await this.embed(input.text);
    this.db
      .prepare(
        `INSERT INTO memory(id,text,category,importance,created_at,updated_at,access_count,source_conv,expired,replaces_id,embedding)
         VALUES (?,?,?,?,?,?,0,?,0,?,?)`,
      )
      .run(id, input.text, category, importance, ts, ts, input.sourceConv ?? null, input.replacesId ?? null, blobFromVec(emb));
    this.ftsUpsert(id, input.text);
    this.refreshIndex();
    return this.get(id)!;
  }

  async upsertSimilar(candidate: {
    text: string;
    category: string;
    importance?: number;
    sourceConv?: string | null;
  }): Promise<{item: MemoryRecord; action: 'insert' | 'update' | 'skip'}> {
    const hits = await this.search(candidate.text, 3);
    const best = hits[0];
    if (best && best.score >= 0.92) {
      const importance = Math.max(best.importance, clampImportance(candidate.importance ?? best.importance));
      const emb = await this.embed(candidate.text);
      this.db
        .prepare(
          `UPDATE memory SET text = ?, importance = ?, updated_at = ?, embedding = ?, source_conv = COALESCE(?, source_conv) WHERE id = ?`,
        )
        .run(candidate.text, importance, now(), blobFromVec(emb), candidate.sourceConv ?? null, best.id);
      this.ftsUpsert(best.id, candidate.text);
      this.refreshIndex();
      return {item: this.get(best.id)!, action: 'update'};
    }
    // crude conflict: same category short fact with different content and medium similarity
    if (best && best.score >= 0.75 && best.category === normalizeCategory(candidate.category) && best.category === 'fact') {
      this.expire(best.id);
      const item = await this.add({...candidate, replacesId: best.id});
      return {item, action: 'insert'};
    }
    const item = await this.add(candidate);
    return {item, action: 'insert'};
  }

  expire(id: string) {
    this.db.prepare(`UPDATE memory SET expired = 1, updated_at = ? WHERE id = ?`).run(now(), id);
    this.refreshIndex();
  }

  update(id: string, patch: {text?: string; category?: string; importance?: number}): MemoryRecord | null {
    const current = this.get(id);
    if (!current || current.expired) return null;
    const text = patch.text?.trim() || current.text;
    const category = patch.category ? normalizeCategory(patch.category) : current.category;
    const importance = typeof patch.importance === 'number' ? Math.min(1, Math.max(0, patch.importance)) : current.importance;
    this.db
      .prepare(`UPDATE memory SET text = ?, category = ?, importance = ?, updated_at = ? WHERE id = ?`)
      .run(text, category, importance, now(), id);
    this.refreshIndex();
    return this.get(id);
  }

  get(id: string): MemoryRecord | null {
    const row = this.db
      .prepare(
        `SELECT id,text,category,importance,created_at,updated_at,access_count,source_conv,expired,replaces_id
         FROM memory WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM memory WHERE expired = 0`).get() as {c: number};
    return Number(row.c);
  }

  getLastConsolidateAt() {
    return this.lastConsolidateAt;
  }

  buildIndex(): string {
    return this.indexCache;
  }

  refreshIndex() {
    const rows = this.db
      .prepare(
        `SELECT id, category, text, importance FROM memory WHERE expired = 0
         ORDER BY importance DESC, updated_at DESC LIMIT 500`,
      )
      .all() as Array<{id: string; category: string; text: string; importance: number}>;
    this.indexCache = rows
      .map((r) => `- [${categoryLabel(normalizeCategory(r.category))}|${r.importance.toFixed(2)}] ${r.text.slice(0, 120)}`)
      .join('\n');
    if (!this.indexCache) this.indexCache = '(暂无长期记忆)';
  }

  consolidate(dayKey?: string): ConsolidateResult {
    const ts = now();
    // Decay low importance rarely accessed items slightly.
    const decayed = this.db
      .prepare(
        `UPDATE memory SET importance = MAX(0.05, importance * 0.98), updated_at = ?
         WHERE expired = 0 AND access_count < 2 AND importance < 0.4 AND (? - created_at) > 7*86400`,
      )
      .run(ts, ts);
    // Evict beyond capacity
    let evicted = 0;
    const count = this.count();
    if (count > 10000) {
      const overflow = count - 10000;
      const victims = this.db
        .prepare(
          `SELECT id, importance, access_count FROM memory WHERE expired = 0
           ORDER BY (importance * (1 + (access_count + 1))) ASC LIMIT ?`,
        )
        .all(overflow) as Array<{id: string}>;
      const del = this.db.prepare(`UPDATE memory SET expired = 1, updated_at = ? WHERE id = ?`);
      for (const v of victims) {
        del.run(ts, v.id);
        evicted++;
      }
    }
    // Mark consolidate meta; semantic compression of sessions is handled by sidecar with LLM.
    this.lastConsolidateAt = ts;
    this.setMeta('last_consolidate_at', String(ts));
    if (dayKey) this.setMeta('last_consolidate_day', dayKey);
    this.refreshIndex();
    return {at: ts, semanticAdded: 0, decayed: Number(decayed.changes ?? 0), evicted};
  }

  close() {
    this.db.close();
  }
}

function recency(updatedAt: number) {
  if (!updatedAt) return 0;
  const ageDays = Math.max(0, (now() - updatedAt) / 86400);
  return Math.exp(-ageDays / 30);
}

export function ensureDataDir(dir: string) {
  mkdirSync(dir, {recursive: true});
  mkdirSync(join(dir, 'personas'), {recursive: true});
  mkdirSync(join(dir, 'sessions'), {recursive: true});
  mkdirSync(join(dir, 'journal'), {recursive: true});
  mkdirSync(join(dir, 'logs'), {recursive: true});
  return dir;
}

export function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, JSON.stringify(value, null, 2));
}
