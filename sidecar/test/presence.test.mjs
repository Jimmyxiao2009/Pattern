/**
 * Presence layer — unit tests for config normalization and state derivation.
 * Bad config values must never crash startup; state derivation follows the
 * reliable-signal priority from spec §二十五.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {buildSync} from 'esbuild';

const cacheDir = fileURLToPath(new URL('../.tmp', import.meta.url));
mkdirSync(cacheDir, {recursive: true});

function loadPresence() {
  const entry = fileURLToPath(new URL('../src/presence.ts', import.meta.url));
  const outfile = join(cacheDir, 'presence.cjs');
  buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile,
  });
  const require = createRequire(outfile);
  return require(outfile);
}

test('normalizePresenceConfig: bad values fall back to safe defaults', () => {
  const {normalizePresenceConfig, DEFAULT_PRESENCE_CONFIG} = loadPresence();
  // Null/garbage input never throws and yields the default config.
  assert.deepEqual(normalizePresenceConfig(null), DEFAULT_PRESENCE_CONFIG);
  assert.deepEqual(normalizePresenceConfig('garbage'), DEFAULT_PRESENCE_CONFIG);

  const bounded = normalizePresenceConfig({
    mode: 'pet',
    scale: 99,
    opacity: -5,
    position: {x: Number.NaN, y: 'nope'},
    enabled: 'yes',
  });
  assert.equal(bounded.mode, 'pet');
  assert.equal(bounded.scale, 2); // clamped to max
  assert.equal(bounded.opacity, 0); // clamped to min
  assert.equal(bounded.position.x, null);
  assert.equal(bounded.position.y, null);
  assert.equal(bounded.enabled, true); // invalid boolean kept default
});

test('normalizePresenceConfig: valid values pass through', () => {
  const {normalizePresenceConfig} = loadPresence();
  const cfg = normalizePresenceConfig({
    mode: 'pet',
    enabled: false,
    scale: 1.2,
    opacity: 0.7,
    bubbleEnabled: false,
    position: {x: 120, y: 80},
  });
  assert.equal(cfg.mode, 'pet');
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.scale, 1.2);
  assert.equal(cfg.opacity, 0.7);
  assert.equal(cfg.bubbleEnabled, false);
  assert.deepEqual(cfg.position, {x: 120, y: 80});
});

test('PresenceService: config persists across restarts and survives corruption', () => {
  const {PresenceService} = loadPresence();
  const dir = mkdtempSync(join(tmpdir(), 'pattern-presence-'));
  try {
    const broadcast = [];
    const service = new PresenceService({dataDir: dir, broadcast: (m) => broadcast.push(m)});
    service.setConfig({mode: 'pet', opacity: 0.8});
    assert.equal(service.getConfig().mode, 'pet');
    assert.equal(service.getConfig().opacity, 0.8);

    // Restart: values come back from disk.
    const again = new PresenceService({dataDir: dir, broadcast: () => {}});
    assert.equal(again.getConfig().mode, 'pet');
    assert.equal(again.getConfig().opacity, 0.8);

    // Corrupt file: defaults are used, no crash.
    writeFileSync(join(dir, 'presence.json'), '{not json');
    const corrupted = new PresenceService({dataDir: dir, broadcast: () => {}});
    assert.equal(corrupted.getConfig().mode, 'off');
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('deriveState: reliable signals drive the state', () => {
  const {PresenceService} = loadPresence();
  const dir = mkdtempSync(join(tmpdir(), 'pattern-presence-'));
  try {
    const service = new PresenceService({dataDir: dir, broadcast: () => {}});
    const now = Date.now();
    const base = {idleSeconds: 0, lastProactiveAt: null, now};

    assert.equal(service.deriveState({...base, agentState: 'thinking', hour: 10}), 'thinking');
    assert.equal(service.deriveState({...base, agentState: 'executing', hour: 10}), 'busy');
    // Recent proactive delivery → notification even while thinking is gone.
    assert.equal(
      service.deriveState({...base, agentState: 'idle', hour: 10, lastProactiveAt: now - 5000}),
      'notification',
    );
    // Long idle → away (any time of day).
    assert.equal(service.deriveState({...base, agentState: 'idle', hour: 10, idleSeconds: 40 * 60}), 'away');
    // Late night, user active → sleepy.
    assert.equal(service.deriveState({...base, agentState: 'idle', hour: 2}), 'sleepy');
    assert.equal(service.deriveState({...base, agentState: 'idle', hour: 23}), 'sleepy');
    // Normal hours → idle.
    assert.equal(service.deriveState({...base, agentState: 'idle', hour: 15}), 'idle');
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('emitBubble: respects bubbleEnabled and proactiveBubbleEnabled', () => {
  const {PresenceService} = loadPresence();
  const dir = mkdtempSync(join(tmpdir(), 'pattern-presence-'));
  try {
    const messages = [];
    const service = new PresenceService({dataDir: dir, broadcast: (m) => messages.push(m)});
    service.setConfig({mode: 'pet', enabled: true});

    service.emitBubble('你好');
    assert.equal(messages.filter((m) => m.type === 'presence.bubble').length, 1);

    // Proactive bubbles need their own switch.
    service.emitProactiveBubble('该休息了');
    assert.equal(messages.filter((m) => m.type === 'presence.bubble').length, 2);

    service.setConfig({proactiveBubbleEnabled: false});
    service.emitProactiveBubble('被静音的提醒');
    assert.equal(messages.filter((m) => m.type === 'presence.bubble').length, 2);

    // mode off → no bubbles at all.
    service.setConfig({mode: 'off'});
    service.emitBubble('安静模式');
    assert.equal(messages.filter((m) => m.type === 'presence.bubble').length, 2);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
