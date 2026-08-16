/**
 * Presence layer (frontend) — reactive store for the companion widget and avatar.
 * Single source of truth fed by runtime broadcasts; localStorage holds a resilient
 * fallback so settings survive even without a runtime connection.
 */
import type {PresenceConfig, PresenceState} from '@pattern/protocol';
import {runtime} from './runtime';

export type {PresenceConfig, PresenceState};

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

export function normalizePresenceConfig(raw: unknown): PresenceConfig {
  const base: PresenceConfig = JSON.parse(JSON.stringify(DEFAULT_PRESENCE_CONFIG));
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

const STORAGE_KEY = 'pattern-presence-config';

function loadLocal(): PresenceConfig {
  try {
    return normalizePresenceConfig(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'));
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_PRESENCE_CONFIG));
  }
}

function saveLocal(config: PresenceConfig) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* quota / private mode — config simply won't persist locally */
  }
}

/** Reactive presence store — import and bind from any window. */
class PresenceStore {
  private listeners = new Set<() => void>();
  private configValue: PresenceConfig = loadLocal();
  private stateValue: PresenceState = 'idle';
  private bubbleValue: {text: string; state?: PresenceState; ts: number} | null = null;
  private bubbleTimer: ReturnType<typeof setTimeout> | null = null;
  private wired = false;

  get config(): PresenceConfig {
    return this.configValue;
  }

  get state(): PresenceState {
    return this.stateValue;
  }

  get bubble(): {text: string; state?: PresenceState; ts: number} | null {
    return this.bubbleValue;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    this.wire();
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  private wire() {
    if (this.wired || typeof window === 'undefined') return;
    this.wired = true;
    runtime.on((message: any) => {
      if (message.type === 'presence.config' && message.config) {
        this.configValue = normalizePresenceConfig(message.config);
        saveLocal(this.configValue);
        this.emit();
      }
      if (message.type === 'presence.state' && typeof message.state === 'string') {
        this.stateValue = message.state;
        this.emit();
      }
      if (message.type === 'presence.bubble' && message.text) {
        this.showBubble(String(message.text), message.state, Number(message.ts) || Date.now());
      }
    });
    void this.refreshFromRuntime();
  }

  async refreshFromRuntime(): Promise<void> {
    try {
      if (!(await runtime.ensureConnected())) return;
      const res = await runtime.request<any>({type: 'presence.getConfig', id: crypto.randomUUID()});
      if (res.type === 'presence.config') {
        this.configValue = normalizePresenceConfig(res.config);
        saveLocal(this.configValue);
        this.emit();
      }
    } catch {
      /* keep local copy when runtime is unavailable */
    }
  }

  private showBubble(text: string, state?: PresenceState, ts = Date.now()) {
    if (!this.configValue.bubbleEnabled) return;
    if (this.bubbleTimer) clearTimeout(this.bubbleTimer);
    this.bubbleValue = {text: text.slice(0, 400), state, ts};
    this.emit();
    this.bubbleTimer = setTimeout(() => {
      this.bubbleValue = null;
      this.bubbleTimer = null;
      this.emit();
    }, 9000);
  }

  dismissBubble() {
    if (this.bubbleTimer) clearTimeout(this.bubbleTimer);
    this.bubbleTimer = null;
    this.bubbleValue = null;
    this.emit();
  }

  async update(patch: Partial<PresenceConfig>): Promise<void> {
    const next = normalizePresenceConfig({
      ...this.configValue,
      ...patch,
      position: {...this.configValue.position, ...(patch.position || {})},
    });
    this.configValue = next;
    saveLocal(next);
    this.emit();
    try {
      if (await runtime.ensureConnected()) {
        const res = await runtime.request<any>({
          type: 'presence.setConfig',
          id: crypto.randomUUID(),
          config: next,
        });
        if (res.type === 'presence.config') {
          this.configValue = normalizePresenceConfig(res.config);
          saveLocal(this.configValue);
          this.emit();
        }
      }
    } catch {
      /* offline: local copy stays authoritative until next connect */
    }
  }
}

export const presenceStore = new PresenceStore();

// ---- Persona visual assets (Phase A avatar mode) ----

export interface PersonaVisualAssets {
  idle?: string;
  happy?: string;
  thinking?: string;
  sleepy?: string;
  concerned?: string;
  busy?: string;
  speaking?: string;
  notification?: string;
}

const VISUALS_KEY = 'pattern-persona-visuals';

/** Persona → asset references (dataURLs). Frontend-owned like persona cards. */
export function loadPersonaVisuals(): Record<string, PersonaVisualAssets> {
  try {
    const raw = JSON.parse(localStorage.getItem(VISUALS_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export function savePersonaVisuals(visuals: Record<string, PersonaVisualAssets>) {
  try {
    localStorage.setItem(VISUALS_KEY, JSON.stringify(visuals));
  } catch {
    /* large assets may exceed quota; keep runtime working regardless */
  }
}

export function getPersonaAsset(personaName: string, state: PresenceState): string | undefined {
  const assets = loadPersonaVisuals()[personaName];
  if (!assets) return undefined;
  const fallbacks: Partial<Record<PresenceState, Array<keyof PersonaVisualAssets>>> = {
    happy: ['happy', 'idle'],
    thinking: ['thinking', 'idle'],
    sleepy: ['sleepy', 'idle'],
    concerned: ['concerned', 'idle'],
    busy: ['busy', 'thinking', 'idle'],
    speaking: ['speaking', 'happy', 'idle'],
    notification: ['notification', 'idle'],
    away: ['idle'],
    idle: ['idle'],
  };
  for (const key of fallbacks[state] || ['idle']) {
    const value = assets[key];
    if (value) return value;
  }
  return undefined;
}

/**
 * Show or hide the Tauri companion window according to the presence config.
 * Best-effort: the presence layer must never break startup or the main window.
 */
export async function applyCompanionWindow(config: PresenceConfig): Promise<void> {
  if (!(window as any).__TAURI_INTERNALS__) return;
  try {
    const {invoke} = await import('@tauri-apps/api/core');
    if (config.enabled && config.mode === 'pet') {
      await invoke('set_companion', {
        visible: true,
        x: config.position.x,
        y: config.position.y,
        alwaysOnTop: config.alwaysOnTop,
      });
    } else {
      await invoke('set_companion', {visible: false});
    }
  } catch {
    /* companion window is optional */
  }
}
