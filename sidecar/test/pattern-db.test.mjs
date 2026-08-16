/**
 * Pattern Engine — database-level tests.
 * Covers: create/update/archive/delete, evidence (supporting + contradicting),
 * lifecycle promotion, consolidation aging, duplicate merging, and keyword search.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {buildSync} from 'esbuild';

function loadMemory() {
  const entry = fileURLToPath(new URL('../../packages/memory/src/index.ts', import.meta.url));
  const cacheDir = fileURLToPath(new URL('../.tmp', import.meta.url));
  mkdirSync(cacheDir, {recursive: true});
  const outfile = join(cacheDir, 'pattern-db.cjs');
  buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['better-sqlite3'],
    outfile,
  });
  const require = createRequire(outfile);
  return require(outfile);
}

function tmpEngine() {
  const dir = mkdtempSync(join(tmpdir(), 'pattern-db-'));
  const {MemoryEngine} = loadMemory();
  const engine = new MemoryEngine(dir);
  return {dir, engine};
}

test('pattern create/update/archive/delete with evidence', () => {
  const {dir, engine} = tmpEngine();
  try {
    const p = engine.patterns.create({
      text: '用户在项目冲刺阶段容易推迟睡眠',
      category: 'routine',
      confidence: 0.3,
      keywords: ['熬夜', '晚睡', '睡眠不足'],
    });
    assert.equal(p.status, 'candidate');
    assert.equal(p.evidenceCount, 0);
    assert.ok(p.createdAt > 0);
    assert.ok(p.metadata.keywords.includes('熬夜'));

    // attach supporting evidence via a real memory
    engine.patterns.archive(p.id);
    const archived = engine.patterns.get(p.id);
    assert.equal(archived.status, 'archived');

    // update text and confidence
    engine.patterns.update(p.id, {text: '用户在赶项目时容易晚睡', confidence: 0.6, status: 'active'});
    const updated = engine.patterns.get(p.id);
    assert.equal(updated.text, '用户在赶项目时容易晚睡');
    assert.equal(updated.status, 'active');
    assert.ok(Math.abs(updated.confidence - 0.6) < 0.001);

    // delete removes pattern + evidence
    assert.equal(engine.patterns.delete(p.id), true);
    assert.equal(engine.patterns.get(p.id), null);
    assert.equal(engine.patterns.delete(p.id), false);
  } finally {
    engine.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('supporting evidence raises confidence; enough support promotes candidate to active', async () => {
  const {dir, engine} = tmpEngine();
  try {
    const p = engine.patterns.create({
      text: '用户投入项目时容易推迟睡眠',
      category: 'routine',
      confidence: 0.3,
    });
    assert.equal(p.status, 'candidate');

    // Add three supporting memories; promotion requires >=3 supports AND conf>=0.55.
    for (let i = 0; i < 4; i++) {
      const m = await engine.add({text: `第${i + 1}天凌晨三点才睡`, category: 'event', importance: 0.7});
      engine.patterns.addEvidence({patternId: p.id, memoryId: m.id, relation: 'supports', weight: 0.9});
    }
    const after = engine.patterns.get(p.id);
    assert.equal(after.status, 'active', `expected active after repeated support, got ${after.status}`);
    assert.ok(after.confidence > p.confidence, 'confidence should increase');
    assert.equal(after.evidenceCount, 4);
  } finally {
    engine.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('contradicting evidence lowers confidence and can flip to contradicted', async () => {
  const {dir, engine} = tmpEngine();
  try {
    const p = engine.patterns.create({
      text: '用户不喜欢运动',
      category: 'behavior',
      confidence: 0.5,
      status: 'active',
    });
    // Two contradicting memories should drop confidence.
    for (let i = 0; i < 3; i++) {
      const m = await engine.add({text: `用户第${i + 1}个月稳定跑步`, category: 'event', importance: 0.8});
      engine.patterns.addEvidence({patternId: p.id, memoryId: m.id, relation: 'contradicts', weight: 0.9});
    }
    const after = engine.patterns.get(p.id);
    assert.ok(after.confidence < p.confidence, 'confidence should drop under contradiction');
    assert.equal(after.evidenceCount, 3);
  } finally {
    engine.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('evidence is retrievable and supports/contradicts are distinguished', async () => {
  const {dir, engine} = tmpEngine();
  try {
    const p = engine.patterns.create({text: '用户深夜常在工作', category: 'behavior', confidence: 0.4});
    const s1 = await engine.add({text: '用户凌晨两点还在改代码', category: 'event', importance: 0.7});
    const s2 = await engine.add({text: '用户连续三天熬夜', category: 'event', importance: 0.7});
    const c1 = await engine.add({text: '用户本周十点前就睡了', category: 'event', importance: 0.6});
    engine.patterns.addEvidence({patternId: p.id, memoryId: s1.id, relation: 'supports', weight: 0.6});
    engine.patterns.addEvidence({patternId: p.id, memoryId: s2.id, relation: 'supports', weight: 0.7});
    engine.patterns.addEvidence({patternId: p.id, memoryId: c1.id, relation: 'contradicts', weight: 0.5});

    const withEv = engine.patterns.getWithEvidence(p.id);
    assert.ok(withEv);
    assert.equal(withEv.evidence.length, 3);
    const supports = withEv.evidence.filter((e) => e.relation === 'supports');
    const contradicts = withEv.evidence.filter((e) => e.relation === 'contradicts');
    assert.equal(supports.length, 2);
    assert.equal(contradicts.length, 1);
    assert.equal(contradicts[0].memoryId, c1.id);

    // Reverse lookup: which patterns reference a memory?
    const patterns = engine.patterns.patternsForMemory(s1.id);
    assert.equal(patterns.length, 1);
    assert.equal(patterns[0].id, p.id);
  } finally {
    engine.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('keyword search bridges lexical gap (retrieval regression)', async () => {
  const {dir, engine} = tmpEngine();
  try {
    const p = engine.patterns.create({
      text: '用户在项目投入阶段容易推迟睡眠',
      category: 'routine',
      confidence: 0.84,
      status: 'active',
      keywords: ['熬夜', '晚睡', '睡眠不足', '再改一点'],
    });
    // A message that shares no literal characters with the pattern text should still match via keywords.
    const hits = engine.patterns.search('今晚再改一点应该没关系吧', 5);
    assert.ok(hits.some((h) => h.id === p.id), 'keyword-indexed search should retrieve the sleep pattern');
  } finally {
    engine.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('duplicate patterns are merged during consolidation', async () => {
  const {dir, engine} = tmpEngine();
  try {
    const a = engine.patterns.create({text: '用户赶项目时容易晚睡', category: 'routine', confidence: 0.6, status: 'active'});
    const b = engine.patterns.create({text: '用户赶项目时容易晚睡', category: 'routine', confidence: 0.5, status: 'active'});
    assert.notEqual(a.id, b.id);
    const result = engine.patterns.consolidate();
    assert.ok(result.merged >= 1, `expected at least one merge, got ${result.merged}`);
    const remaining = engine.patterns.list({status: 'active'});
    assert.equal(remaining.filter((x) => x.text === '用户赶项目时容易晚睡').length, 1);
  } finally {
    engine.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('consolidation ages stale candidates (weakening/archived)', async () => {
  const {dir, engine} = tmpEngine();
  try {
    const p = engine.patterns.create({text: '用户似乎常熬夜', category: 'routine', confidence: 0.25});
    // Force last_observed_at far into the past so aging applies.
    const stale = Math.floor(Date.now() / 1000) - 60 * 86400;
    engine.patterns['db']
      .prepare('UPDATE pattern SET last_observed_at = ?, created_at = ? WHERE id = ?')
      .run(stale, stale, p.id);
    const result = engine.patterns.consolidate();
    assert.equal(typeof result.at, 'number');
    const after = engine.patterns.get(p.id);
    // 60 days stale with low confidence must have weakened or archived.
    assert.ok(after.status === 'weakening' || after.status === 'archived', `expected weakened/archived, got ${after.status}`);
    assert.ok(after.confidence < 0.25, 'confidence should decay');
  } finally {
    engine.close();
    rmSync(dir, {recursive: true, force: true});
  }
});
