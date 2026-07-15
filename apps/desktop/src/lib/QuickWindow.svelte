<script lang="ts">
  import {onMount} from 'svelte';
  import {ArrowUp, ExternalLink, Minus, Sparkles, X, Zap} from 'lucide-svelte';
  import StatusDot from './StatusDot.svelte';
  import {formatRuntimeError, runtime} from './runtime';
  import {shouldTransferToExecutor, taskTitleFromText, routeUserMessage} from '@pattern/core';

  let draft = $state('');
  let answer = $state('');
  let busy = $state(false);
  let slot = $state<'companion' | 'executor'>('companion');
  let input: HTMLTextAreaElement;
  let quickHistory = $state<Array<{role: 'user' | 'assistant'; content: string}>>([]);
  let quickConversationId = $state('');
  let proactiveArrival = $state<{id: string; body: string; origin?: 'ai' | 'system'; chainId?: string} | null>(null);

  type StoredConversation = {id: string; title: string; createdAt: number; updatedAt: number; scope: 'global' | 'project'; messages: Array<{id: string; role: 'user' | 'assistant'; text: string; time: string}>; archived?: boolean};

  onMount(() => {
    input.focus();
    try {
      const stored = JSON.parse(localStorage.getItem('pattern-conversations') || '[]') as StoredConversation[];
      const global = [...stored].filter((item) => item.scope !== 'project' && !item.archived).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
      quickConversationId = global?.id || '';
      quickHistory = (global?.messages || []).slice(-8).map((m) => ({role: m.role as 'user' | 'assistant', content: m.text}));
    } catch { quickHistory = []; }
    void runtime.connect();
    return runtime.on((message) => {
      if (message.type === 'runtime.agent_state' && message.state === 'idle' && !busy) slot = 'companion';
      if (message.type === 'proactive.impulse') {
        proactiveArrival = message.item;
        answer = '';
        busy = false;
        setTimeout(() => input?.focus(), 40);
      }
    });
  });

  async function hide() {
    if ((window as any).__TAURI_INTERNALS__) {
      const {getCurrentWindow} = await import('@tauri-apps/api/window');
      await getCurrentWindow().hide();
    }
  }

  async function openMain(view?: 'tasks' | 'chat') {
    if ((window as any).__TAURI_INTERNALS__) {
      const {invoke} = await import('@tauri-apps/api/core');
      await invoke('show_main');
    } else {
      location.href = view === 'tasks' ? '/?demo=1' : '/?demo=1';
    }
  }

  function persistQuickTurn(userText: string, assistantText: string) {
    if (!assistantText.trim()) return;
    const now = Date.now();
    const time = new Date(now).toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'});
    let conversations: StoredConversation[] = [];
    try { conversations = JSON.parse(localStorage.getItem('pattern-conversations') || '[]'); } catch { /* start lazily */ }
    let conversation = conversations.find((item) => item.id === quickConversationId);
    if (!conversation) {
      conversation = {id: crypto.randomUUID(), title: userText.replace(/\s+/g, ' ').slice(0, 36) || '快捷对话', createdAt: now, updatedAt: now, scope: 'global', messages: []};
      quickConversationId = conversation.id;
      conversations = [conversation, ...conversations];
    }
    conversation.messages = [...conversation.messages,
      {id: crypto.randomUUID(), role: 'user', text: userText, time},
      {id: crypto.randomUUID(), role: 'assistant', text: assistantText, time},
    ];
    conversation.updatedAt = now;
    localStorage.setItem('pattern-conversations', JSON.stringify(conversations));
    try { new BroadcastChannel('pattern-conversations').postMessage({type:'updated'}); } catch { /* optional same-device refresh signal */ }
  }

  async function transfer(text: string) {
    const title = taskTitleFromText(text);
    if (!(await runtime.connect())) {
      answer = '运行时未连接，请打开主窗口后再试。';
      return;
    }
    slot = 'executor';
    await runtime.request({
      type: 'task.create',
      id: crypto.randomUUID(),
      title,
      detail: text,
    });
    answer = `已交给子代理：${title}\n任务已创建。主对话只保留结果摘要，可打开主窗口任务页或审查窗查看。`;
    if ((window as any).__TAURI_INTERNALS__) {
      const {invoke} = await import('@tauri-apps/api/core');
      await invoke('show_review');
    }
  }

  async function send() {
    const value = draft.trim();
    if (!value || busy) return;
    busy = true;
    answer = '';
    const decision = routeUserMessage(value);
    slot = decision.slot;
    draft = '';
    try {
      if (proactiveArrival && await runtime.connect()) {
        void runtime.request({type:'proactive.inbox.mark', id:crypto.randomUUID(), itemId:proactiveArrival.id, state:'replied'});
        if (proactiveArrival.origin === 'ai' && proactiveArrival.chainId) {
          void runtime.request({type:'proactive.chain.cancel', id:crypto.randomUUID(), chainId:proactiveArrival.chainId});
        }
        proactiveArrival = null;
      }
      if (shouldTransferToExecutor(value)) {
        await transfer(value);
        busy = false;
        return;
      }
      if (!(await runtime.ensureConnected())) {
        answer = formatRuntimeError(new Error('Agent 运行时未连接'), {isTauri: !!(window as any).__TAURI_INTERNALS__});
        busy = false;
        return;
      }
      const id = crypto.randomUUID();
      await runtime.chat(
        {type: 'chat.send', id, text: value, history: quickHistory, sessionId: quickConversationId || id, slot: 'companion'},
        {
          onDelta: (delta) => (answer += delta),
          onDone: () => {
            busy = false;
            slot = 'companion';
            quickHistory = [...quickHistory, {role: 'user' as const, content: value}, {role: 'assistant' as const, content: answer}].slice(-8);
            persistQuickTurn(value, answer);
          },
          onError: (error) => {
            answer = formatRuntimeError(error, {isTauri: true});
            busy = false;
          },
        },
      );
    } catch (error) {
      answer = formatRuntimeError(error, {isTauri: !!(window as any).__TAURI_INTERNALS__});
      busy = false;
    }
  }

  async function handoff() {
    const value = draft.trim() || answer.trim();
    if (!value || busy) return;
    busy = true;
    try {
      await transfer(value);
    } catch (error) {
      answer = `转交失败：${error}`;
    } finally {
      busy = false;
    }
  }

  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape') hide();
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  }
</script>

<main class="quick-window">
  <header data-tauri-drag-region>
    <span class="pet-orb"><Sparkles size={13} /></span>
    <StatusDot active={busy || slot === 'executor'} />
    <strong>Pattern</strong><span>随叫随到</span>
    <button aria-label="最小化" title="隐藏" onclick={hide}><Minus size={15} /></button>
    <button aria-label="关闭" onclick={hide}><X size={15} /></button>
  </header>
  {#if quickHistory.length}
    <section class="quick-history" aria-label="最近对话">
      {#each quickHistory.slice(-4) as message, index (`${message.role}-${index}-${message.content.slice(0, 16)}`)}
        <p class:user={message.role === 'user'}>{message.content}</p>
      {/each}
    </section>
  {:else}
    <p class="quick-greeting">嗨，我在。想聊聊、记一件事，或者交给我执行？</p>
  {/if}
  {#if proactiveArrival}
    <section class="quick-proactive" aria-live="polite">
      <span class="badge amber"><Sparkles size={11} />{proactiveArrival.origin === 'system' ? '系统提醒' : 'AI 来找你'}</span>
      <p>{proactiveArrival.body}</p>
    </section>
  {/if}
  <div class="quick-input">
    <textarea aria-label="消息" bind:this={input} bind:value={draft} onkeydown={keydown} rows="2" placeholder="有什么事？"></textarea>
    <button class="send-button" aria-label="发送" onclick={send} disabled={!draft.trim() || busy}><ArrowUp size={18} /></button>
  </div>
  {#if answer || busy}
    <section class="quick-answer">
      <div>
        <span class="badge amber"><Zap size={11} />{slot === 'executor' ? '子代理' : '主 Agent'}</span>
        {#if busy}<span class="thinking">正在想</span>{/if}
      </div>
      {#if answer}<p>{answer}</p>{:else}<p class="thinking">正在组织回答…</p>{/if}
    </section>
  {/if}
  <footer>
    <button onclick={() => openMain()}><ExternalLink size={13} />打开主窗口</button>
    <button onclick={handoff} disabled={busy || (!draft.trim() && !answer.trim())}>转交执行</button>
    <span>Enter 发送 · Esc 隐藏</span>
  </footer>
</main>
