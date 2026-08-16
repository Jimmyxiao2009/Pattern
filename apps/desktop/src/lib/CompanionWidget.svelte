<script lang="ts">
  import {onMount} from 'svelte';
  import {MessageCircleMore, X} from 'lucide-svelte';
  import {runtime} from './runtime';
  import {presenceStore, getPersonaAsset} from './presence';
  import type {Persona} from './types';
  import ContextMenu, {type ContextMenuItem} from './ContextMenu.svelte';

  let persona = $state<Persona | null>(null);
  let presenceState = $state(presenceStore.state);
  let bubble = $state(presenceStore.bubble);
  let config = $state(presenceStore.config);
  let menu = $state({open: false, x: 0, y: 0});

  const stateLabel: Record<string, string> = {
    idle: '在的',
    speaking: '正在说话',
    thinking: '思考中',
    happy: '开心',
    concerned: '有点担心',
    sleepy: '有点困',
    busy: '忙着呢',
    notification: '有消息',
    away: '暂时离开',
  };

  const asset = $derived(persona ? getPersonaAsset(persona.name, presenceState) : undefined);

  onMount(() => {
    try {
      const stored = localStorage.getItem('pattern-persona');
      persona = stored ? JSON.parse(stored) : null;
      const storedTheme = localStorage.getItem('pattern-theme');
      if (storedTheme) document.documentElement.dataset.theme = storedTheme;
      // Transparent canvas requirement for the Tauri transparent window.
      document.documentElement.classList.add('companion-bg');
    } catch {
      persona = null;
    }
    void presenceStore.refreshFromRuntime();
    const unsubscribe = presenceStore.subscribe(() => {
      presenceState = presenceStore.state;
      bubble = presenceStore.bubble;
      config = presenceStore.config;
    });
    void runtime.connect();
    // Keep persona + config synced across windows.
    try {
      const personaChannel = new BroadcastChannel('pattern-persona');
      personaChannel.onmessage = (event) => {
        if (event.data?.type === 'updated' && event.data.persona) persona = event.data.persona;
      };
      return () => {
        unsubscribe();
        personaChannel.close();
      };
    } catch {
      return unsubscribe;
    }
  });

  async function openQuick() {
    if ((window as any).__TAURI_INTERNALS__) {
      const {invoke} = await import('@tauri-apps/api/core');
      await invoke('show_quick');
    }
  }

  async function openMain() {
    if ((window as any).__TAURI_INTERNALS__) {
      const {invoke} = await import('@tauri-apps/api/core');
      await invoke('show_main');
    }
  }

  async function hideCompanion() {
    await presenceStore.update({mode: 'off'});
    if ((window as any).__TAURI_INTERNALS__) {
      const {getCurrentWindow} = await import('@tauri-apps/api/window');
      await getCurrentWindow().hide();
    }
  }

  // Drag vs click: move threshold keeps single-click from triggering window moves.
  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;

  function onPointerDown(event: PointerEvent) {
    if (event.button === 2) return;
    dragging = true;
    moved = false;
    startX = event.screenX;
    startY = event.screenY;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  async function onPointerMove(event: PointerEvent) {
    if (!dragging) return;
    if (!moved && Math.hypot(event.screenX - startX, event.screenY - startY) > 4) moved = true;
    if (!moved || !(window as any).__TAURI_INTERNALS__) return;
    const {getCurrentWindow, LogicalPosition} = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    const position = await win.outerPosition();
    const scale = await win.scaleFactor();
    const dx = (event.screenX - startX) * scale;
    const dy = (event.screenY - startY) * scale;
    startX = event.screenX;
    startY = event.screenY;
    await win.setPosition(new LogicalPosition(position.x + dx, position.y + dy));
    // Persist position (debounced fire-and-forget; cheap enough per move event).
    const newPos = await win.outerPosition();
    void presenceStore.update({position: {x: Math.round(newPos.x / scale), y: Math.round(newPos.y / scale)}});
  }

  function onPointerUp(event: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    if (!moved) void openQuick();
  }

  function onContextMenu(event: MouseEvent) {
    event.preventDefault();
    menu = {open: true, x: event.clientX, y: event.clientY};
  }

  const menuItems: ContextMenuItem[] = $derived([
    {id: 'quick', label: '打开快捷窗'},
    {id: 'main', label: '打开主窗口'},
    {id: 'hide', label: '暂时隐藏'},
  ]);

  async function onMenuSelect(id: string) {
    if (id === 'quick') await openQuick();
    if (id === 'main') await openMain();
    if (id === 'hide') await hideCompanion();
  }
</script>

<main class="companion-widget" style={`opacity:${config.opacity};transform:scale(${config.scale})`}>
  {#if bubble}
    <section class="companion-bubble" role="status" aria-live="polite">
      <p>{bubble.text}</p>
      <button aria-label="关闭气泡" title="关闭" onclick={() => presenceStore.dismissBubble()}><X size={12} /></button>
    </section>
  {/if}
  <button
    class="companion-body"
    class:has-image={!!asset}
    title={`${persona?.name || 'Pattern'} · ${stateLabel[presenceState] || presenceState}`}
    aria-label={`${persona?.name || 'Pattern'}，${stateLabel[presenceState] || presenceState}。单击打开快捷窗，右键更多`}
    data-state={presenceState}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    oncontextmenu={onContextMenu}
    ondblclick={() => openMain()}
  >
    {#if asset}
      <img src={asset} alt="" />
    {:else}
      <span class="companion-orb" aria-hidden="true"><MessageCircleMore size={15} /></span>
    {/if}
  </button>
</main>

<ContextMenu
  open={menu.open}
  x={menu.x}
  y={menu.y}
  items={menuItems}
  onSelect={(id) => void onMenuSelect(id)}
  onClose={() => (menu.open = false)}
/>

<style>
  main.companion-widget{height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:8px;padding:8px;transition:opacity .2s ease;transform-origin:center bottom}
  .companion-body{display:grid;place-items:center;width:64px;height:64px;padding:0;border:1px solid color-mix(in srgb,var(--line-strong) 70%,transparent);border-radius:50%;background:color-mix(in srgb,var(--surface) 88%,transparent);backdrop-filter:blur(14px);box-shadow:0 10px 30px rgba(0,0,0,.35);cursor:pointer;touch-action:none;transition:transform .18s ease,box-shadow .18s ease}
  .companion-body:hover{transform:translateY(-2px);box-shadow:0 14px 34px rgba(0,0,0,.42)}
  .companion-body:active{transform:scale(.96)}
  .companion-orb{display:grid;place-items:center;width:38px;height:38px;border-radius:50%;color:var(--amber);background:var(--amber-wash);box-shadow:0 0 18px var(--amber-wash)}
  .companion-body.has-image{padding:0;overflow:hidden;border-radius:18px;width:72px;height:72px}
  .companion-body.has-image img{width:100%;height:100%;object-fit:cover;display:block}
  .companion-body[data-state='thinking'] .companion-orb{animation:companion-pulse 1.6s ease-in-out infinite}
  .companion-body[data-state='sleepy'] .companion-orb{opacity:.6}
  .companion-body[data-state='busy'] .companion-orb{animation:companion-pulse 1s ease-in-out infinite}
  .companion-body[data-state='concerned'] .companion-orb{color:var(--danger);background:rgba(224,91,80,.12)}
  .companion-body[data-state='happy'] .companion-orb{color:var(--green);background:var(--green-wash)}
  .companion-bubble{max-width:220px;display:flex;align-items:flex-start;gap:6px;padding:9px 10px;border:1px solid var(--amber-line);border-radius:12px;background:color-mix(in srgb,var(--surface) 94%,transparent);backdrop-filter:blur(14px);box-shadow:0 8px 24px rgba(0,0,0,.28)}
  .companion-bubble p{margin:0;font-size:12px;line-height:1.5;color:var(--text);white-space:pre-wrap}
  .companion-bubble button{flex:none;display:grid;place-items:center;width:18px;height:18px;padding:0;border:0;color:var(--faint)}
  .companion-bubble button:hover{color:var(--text)}
  @keyframes companion-pulse{0%,100%{box-shadow:0 0 0 3px var(--amber-wash)}50%{box-shadow:0 0 0 7px var(--amber-wash)}}
  @media (prefers-reduced-motion: reduce){
    .companion-body[data-state='thinking'] .companion-orb,.companion-body[data-state='busy'] .companion-orb{animation:none}
    .companion-body,.companion-body:hover,.companion-body:active{transition:none;transform:none}
  }
</style>
