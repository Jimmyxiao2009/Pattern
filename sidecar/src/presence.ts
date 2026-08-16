/**
 * Presence layer (spec §二十五/§二十六) — derives a lightweight PresenceState for
 * the desktop companion and emits proactive bubbles.
 *
 * The presence layer is presentation only: it never changes agent behavior.
 * Signals flow one way:
 *   agent state / time / proactive events  →  PresenceState  →  broadcast
 *   proactive delivery                     →  presence.bubble →  companion window
 */
import {readFileSync, writeFileSync, existsSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import type {PresenceConfig, PresenceState} from '@pattern/protocol';

export type {PresenceConfig, PresenceState};

export interface PresenceDeps {
  dataDir: string;
  broadcast: (message: Record<string, unknown>) => void;
  log?: (message: string, error?: unknown) => void;
}

export const DEFAULT_PRESENCE_CONFIG: PresenceConfig = {
  enabled: true,
  mode: 'off',
  alwaysOnTop: true,
  clickThroughWhenIdle: false,
  position: {x: null, y: null},
  scale: 1,
  opacity: 0.95,
  bubbleEnabled: true,
  proactiveBubbleEnabled: true,
  autoHideWhenFullscreen: false,
};

function clamp01(value: unknown, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
}

/** Validate and normalize an untrusted config object — bad values never crash startup. */
export function normalizePresenceConfig(raw: unknown): PresenceConfig {
  const base = {...DEFAULT_PRESENCE_CONFIG, position: {...DEFAULT_PRESENCE_CONFIG.position}};
  if (!raw || typeof raw !== 'object') return base;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.enabled === 'boolean') base.enabled = obj.enabled;
  if (obj.mode === 'off' || obj.mode === 'avatar' || obj.mode === 'pet') base.mode = obj.mode;
  if (typeof obj.alwaysOnTop === 'boolean') base.alwaysOnTop = obj.alwaysOnTop;
  if (typeof obj.clickThroughWhenIdle === 'boolean') base.clickThroughWhenIdle = obj.clickThroughWhenIdle;
  const pos = obj.position as {x?: unknown; y?: unknown} | undefined;
  if (pos && typeof pos === 'object') {
    base.position.x = typeof pos.x === 'number' && Number.isFinite(pos.x) ? pos.x : null;
    base.position.y = typeof pos.y === 'number' && Number.isFinite(pos.y) ? pos.y : null;
  }
  base.scale = Math.max(0.5, Math.min(2, Number(obj.scale) || 1));
  base.opacity = clamp01(obj.opacity, DEFAULT_PRESENCE_CONFIG.opacity);
  if (typeof obj.bubbleEnabled === 'boolean') base.bubbleEnabled = obj.bubbleEnabled;
  if (typeof obj.proactiveBubbleEnabled === 'boolean') base.proactiveBubbleEnabled = obj.proactiveBubbleEnabled;
  if (typeof obj.autoHideWhenFullscreen === 'boolean') base.autoHideWhenFullscreen = obj.autoHideWhenFullscreen;
  return base;
}

export class PresenceService {
  private config: PresenceConfig;
  private lastState: PresenceState = 'idle';
  private readonly configPath: string;

  constructor(private deps: PresenceDeps) {
    mkdirSync(deps.dataDir, {recursive: true});
    this.configPath = join(deps.dataDir, 'presence.json');
    this.config = this.load();
  }

  private load(): PresenceConfig {
    try {
      if (!existsSync(this.configPath)) return {...DEFAULT_PRESENCE_CONFIG};
      return normalizePresenceConfig(JSON.parse(readFileSync(this.configPath, 'utf8')));
    } catch (error) {
      this.deps.log?.('[presence] failed to load config, using defaults', error);
      return {...DEFAULT_PRESENCE_CONFIG};
    }
  }

  private persist() {
    try {
      writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    } catch (error) {
      this.deps.log?.('[presence] failed to persist config', error);
    }
  }

  getConfig(): PresenceConfig {
    return JSON.parse(JSON.stringify(this.config)) as PresenceConfig;
  }

  /** Merge a partial update (bounded), persist, and return the resulting config. */
  setConfig(patch: Partial<PresenceConfig>): PresenceConfig {
    const merged = normalizePresenceConfig({
      ...this.config,
      ...patch,
      position: {...this.config.position, ...(patch.position || {})},
    });
    this.config = merged;
    this.persist();
    return this.getConfig();
  }

  getState(): PresenceState {
    return this.lastState;
  }

  /** Broadcast a state change when it differs from the last published state. */
  setState(state: PresenceState, reason?: string) {
    if (!this.config.enabled || this.config.mode === 'off') return;
    if (state === this.lastState) return;
    this.lastState = state;
    this.deps.broadcast({type: 'presence.state', state, reason});
  }

  /**
   * Derive presence state from runtime signals (spec §二十五): agent state is the
   * primary reliable signal; late-night idleness biases sleepy; proactive arrival
   * shows notification. No sentiment analysis.
   */
  deriveState(input: {agentState: string; hour: number; idleSeconds: number; lastProactiveAt: number | null; now: number}): PresenceState {
    if (input.agentState === 'thinking') return 'thinking';
    if (input.agentState === 'executing' || input.agentState === 'approval') return 'busy';
    if (input.lastProactiveAt && input.now - input.lastProactiveAt < 30_000) return 'notification';
    // Long silence → away regardless of time of day.
    if (input.idleSeconds > 30 * 60) return 'away';
    // Late night while the user is still active → they are up late.
    const lateNight = input.hour >= 23 || input.hour < 5;
    if (lateNight) return 'sleepy';
    return 'idle';
  }

  /** Push one bubble (proactive delivery or system nudge) when enabled. */
  emitBubble(text: string, state?: PresenceState) {
    if (!this.config.enabled || this.config.mode === 'off') return;
    if (!this.config.bubbleEnabled) return;
    const body = String(text || '').trim();
    if (!body) return;
    this.deps.broadcast({type: 'presence.bubble', text: body.slice(0, 400), state, ts: Date.now()});
  }

  /** Proactive deliveries become bubbles only when explicitly allowed. */
  emitProactiveBubble(text: string, state?: PresenceState) {
    if (!this.config.proactiveBubbleEnabled) return;
    this.emitBubble(text, state);
  }
}
