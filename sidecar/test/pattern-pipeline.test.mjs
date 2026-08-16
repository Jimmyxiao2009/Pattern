/**
 * Pattern pipeline — structured-output parsing, bounds validation and safety
 * guardrails. Model JSON must survive schema validation, bounds checks and
 * the unsafe-label blocklist; anything malformed must be a safe no-op.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {createRequire} from 'node:module';
import {buildSync} from 'esbuild';

const cacheDir = fileURLToPath(new URL('../.tmp', import.meta.url));
mkdirSync(cacheDir, {recursive: true});

function bundle(entryRel, outName) {
  const entry = fileURLToPath(new URL(entryRel, import.meta.url));
  const outfile = join(cacheDir, outName);
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

const pipelineMod = bundle('../src/pattern-pipeline.ts', 'pattern-pipeline.cjs');
const {parsePatternDecision, clampConfidenceDelta, findUnsafePatternLabel, formatPatternsForPrompt} = pipelineMod;

test('parsePatternDecision: valid support/contradict/create decisions', () => {
  const ids = new Set(['p1', 'p2']);
  const support = parsePatternDecision('{"action":"support","pattern_id":"p1","confidence_delta":0.08,"reason":"r"}', ids);
  assert.equal(support.decision?.action, 'support');
  assert.equal(support.decision?.pattern_id, 'p1');

  const contradict = parsePatternDecision('{"action":"contradict","pattern_id":"p2","confidence_delta":-0.1}', ids);
  assert.equal(contradict.decision?.action, 'contradict');

  const create = parsePatternDecision(
    '{"action":"create","text":"用户在项目冲刺阶段容易推迟睡眠","category":"routine","keywords":["熬夜","晚睡"]}',
    ids,
  );
  assert.equal(create.decision?.action, 'create');
  assert.deepEqual(create.decision?.keywords, ['熬夜', '晚睡']);

  const ignore = parsePatternDecision('{"action":"ignore"}', ids);
  assert.equal(ignore.decision?.action, 'ignore');
});

test('parsePatternDecision: JSON embedded in prose is still extracted', () => {
  const ids = new Set(['p1']);
  const raw = 'Sure! Here is my decision: {"action":"support","pattern_id":"p1","confidence_delta":0.05} hope that helps.';
  const {decision} = parsePatternDecision(raw, ids);
  assert.equal(decision?.action, 'support');
});

test('parsePatternDecision: malformed output is a safe no-op', () => {
  const ids = new Set(['p1']);
  assert.equal(parsePatternDecision('not json at all', ids).decision, null);
  assert.equal(parsePatternDecision('[1,2,3]', ids).decision, null);
  assert.equal(parsePatternDecision('{"action":"support","pattern_id":"invented-id","confidence_delta":0.1}', ids).decision, null);
  assert.equal(parsePatternDecision('{"action":"support","pattern_id":123,"confidence_delta":0.1}', ids).decision, null);
  assert.equal(parsePatternDecision('{"action":"banana","pattern_id":"p1"}', ids).decision, null);
  assert.equal(parsePatternDecision('{"action":"update","pattern_id":"p1","text":""}', ids).decision, null);
});

test('confidence_delta is always bounds-checked', () => {
  const ids = new Set(['p1']);
  const huge = parsePatternDecision('{"action":"support","pattern_id":"p1","confidence_delta":5}', ids);
  assert.equal(huge.decision?.confidence_delta, 0.3);
  const negative = parsePatternDecision('{"action":"contradict","pattern_id":"p1","confidence_delta":-9}', ids);
  assert.equal(negative.decision?.confidence_delta, -0.3);
  assert.equal(clampConfidenceDelta(Number.NaN), 0);
  assert.equal(clampConfidenceDelta('nope'), 0);
  assert.equal(clampConfidenceDelta(0.11), 0.11);
});

test('unsafe diagnostic labels are rejected at create/update', () => {
  const ids = new Set(['p1']);
  const dep = parsePatternDecision('{"action":"create","text":"用户患有抑郁症","category":"state"}', ids);
  assert.equal(dep.decision, null);
  assert.ok(dep.error?.startsWith('unsafe-label'));

  const addict = parsePatternDecision('{"action":"create","text":"用户具有工作成瘾","category":"behavior"}', ids);
  assert.equal(addict.decision, null);

  const upd = parsePatternDecision('{"action":"update","pattern_id":"p1","text":"用户是自恋型人格"}', ids);
  assert.equal(upd.decision, null);

  assert.ok(findUnsafePatternLabel('用户可能有焦虑障碍'));
  assert.equal(findUnsafePatternLabel('用户在项目冲刺时容易推迟睡眠'), null);
});

test('formatPatternsForPrompt filters low-confidence and archived patterns', () => {
  const hits = [
    {id: 'a', text: 'active pattern', status: 'active', confidence: 0.8, evidenceCount: 5},
    {id: 'b', text: 'weak candidate', status: 'candidate', confidence: 0.3, evidenceCount: 1},
    {id: 'c', text: 'archived', status: 'archived', confidence: 0.9, evidenceCount: 9},
    {id: 'd', text: 'contradicted', status: 'contradicted', confidence: 0.9, evidenceCount: 9},
  ];
  const block = formatPatternsForPrompt(hits);
  assert.ok(block.includes('active pattern'));
  assert.ok(!block.includes('weak candidate'));
  assert.ok(!block.includes('archived'));
  assert.ok(!block.includes('contradicted'));
  assert.ok(block.includes('confidence'));
  assert.equal(formatPatternsForPrompt([]), '');
});
