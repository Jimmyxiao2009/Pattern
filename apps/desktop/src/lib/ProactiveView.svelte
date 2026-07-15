<script lang="ts">
  import {onMount} from 'svelte';
  import {BellRing, Clock3, Pause, Play, Plus, RefreshCw, Save, Sparkles, Trash2, Zap} from 'lucide-svelte';
  import PageHeader from './PageHeader.svelte';
  import SettingRow from './SettingRow.svelte';
  import Toggle from './Toggle.svelte';
  import {runtime} from './runtime';

  type Trigger = {id: string; time: string; message: string; enabled: boolean};
  type Chain = {id: string; purpose: string; status: string; nextRunAt: number | null; recurrence?: {kind: 'daily'; time: string} | null};
  type Connection = {id: string; name?: string; provider: string; endpoint: string; enabled?: boolean};

  let {notify}: {notify: (message: string) => void} = $props();
  let tab = $state<'triggers' | 'settings'>('triggers');
  let triggers = $state<Trigger[]>([]);
  let chains = $state<Chain[]>([]);
  let log = $state<Array<{id: string; body: string; reason: string; type: string; ts: number; origin?: 'ai' | 'system'; state?: string}>>([]);
  let connections = $state<Connection[]>([]);
  let proactiveEnabled = $state(true);
  let paused = $state(false);
  let bedtimeHour = $state(23);
  let editingId = $state<string | null>(null);
  let formOpen = $state(false);
  let time = $state('09:00');
  let message = $state('');
  let error = $state('');
  let saved = $state('');
  let offline = $state(false);

  function readConnections() {
    try {
      const value = JSON.parse(localStorage.getItem('pattern-model-profiles') || '{}');
      connections = Array.isArray(value.profiles)
        ? value.profiles.filter((item: any) => item?.provider && item?.endpoint).map((item: any) => ({id:String(item.id), name:item.name, provider:String(item.provider), endpoint:String(item.endpoint), enabled:true}))
        : [];
    } catch { connections = []; }
  }

  async function refresh() {
    readConnections();
    const connected = await runtime.connect();
    offline = !connected;
    if (!connected) return;
    const [cron, proactive, chain] = await Promise.all([
      runtime.request<any>({type:'cron.getConfig', id:crypto.randomUUID()}),
      runtime.request<any>({type:'proactive.getConfig', id:crypto.randomUUID()}),
      runtime.request<any>({type:'proactive.chain.list', id:crypto.randomUUID(), limit:30}),
    ]);
    if (cron.type === 'cron.config') triggers = cron.triggers;
    if (proactive.type === 'proactive.config') { proactiveEnabled = proactive.enabled; paused = proactive.paused; bedtimeHour = proactive.bedtimeHour; }
    if (chain.type === 'proactive.chain.list.result') chains = chain.chains;
    const result = await runtime.request<any>({type:'proactive.list', id:crypto.randomUUID(), limit:30});
    if (result.type === 'proactive.list.result') log = result.items;
  }

  onMount(() => {
    void refresh();
    return runtime.on((incoming: any) => {
      if (incoming.type === 'proactive.chain.updated') {
        chains = [incoming.chain, ...chains.filter((item) => item.id !== incoming.chain.id)];
      }
      if (incoming.type === 'proactive.inbox.updated') {
        log = [incoming.item, ...log.filter((item) => item.id !== incoming.item.id)].slice(0, 30);
      }
    });
  });

  function openCreate() {
    editingId = null; time = '09:00'; message = ''; error = ''; saved = ''; formOpen = true;
  }
  function openEdit(trigger: Trigger) {
    editingId = trigger.id; time = trigger.time; message = trigger.message; error = ''; saved = ''; formOpen = true;
  }
  function closeForm() { formOpen = false; editingId = null; error = ''; }

  async function saveTrigger() {
    if (!message.trim()) { error = '请写下要发送的系统消息'; return; }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) { error = '请选择有效的发送时间'; return; }
    const next = editingId
      ? triggers.map((item) => item.id === editingId ? {...item, time, message:message.trim()} : item)
      : [{id:crypto.randomUUID(), time, message:message.trim(), enabled:true}, ...triggers];
    if (!(await runtime.connect())) { error = '运行时未连接，定时消息尚未保存'; return; }
    const response = await runtime.request<any>({type:'cron.setConfig', id:crypto.randomUUID(), triggers:next});
    if (response.type === 'cron.config') triggers = response.triggers;
    else { error = response.message || '保存失败'; return; }
    const wasEditing = !!editingId;
    closeForm(); saved = wasEditing ? '定时消息已更新' : '定时系统消息已添加'; notify(saved);
  }

  async function toggleTrigger(trigger: Trigger) {
    const response = await runtime.request<any>({type:'cron.setConfig', id:crypto.randomUUID(), triggers:triggers.map((item) => item.id === trigger.id ? {...item, enabled:!item.enabled} : item)});
    if (response.type === 'cron.config') triggers = response.triggers;
  }
  async function removeTrigger(id: string) {
    const response = await runtime.request<any>({type:'cron.setConfig', id:crypto.randomUUID(), triggers:triggers.filter((item) => item.id !== id)});
    if (response.type === 'cron.config') { triggers = response.triggers; notify('定时系统消息已删除'); }
  }
  async function runNow() {
    if (!(await runtime.connect())) { notify('运行时未连接'); return; }
    const response = await runtime.request<any>({type:'proactive.trigger', id:crypto.randomUUID(), kind:'manual', reason:'主动页面手动触发'});
    if (response.type === 'error') notify(response.message); else { notify('已唤醒一次主动判断'); void refresh(); }
  }
  async function saveSettings() {
    if ((window as any).__TAURI_INTERNALS__) {
      try {
        const {invoke} = await import('@tauri-apps/api/core');
        await invoke('save_proactive_config', {config:{enabled:proactiveEnabled, bedtimeHour, paused}});
      } catch (value) { saved = `保存失败：${value}`; return; }
    }
    if (await runtime.connect()) await runtime.request({type:'proactive.setPaused', id:crypto.randomUUID(), paused});
    saved = '主动设置已保存'; notify(saved);
  }
  async function runChain(id: string) {
    if (!(await runtime.connect())) return;
    await runtime.request({type:'proactive.chain.runNow', id:crypto.randomUUID(), chainId:id});
    notify('已立即唤醒该主动链');
  }
  async function cancelChain(id: string) {
    if (!(await runtime.connect())) return;
    await runtime.request({type:'proactive.chain.cancel', id:crypto.randomUUID(), chainId:id});
    notify('主动链已取消');
  }
  function endpointLabel(endpoint: string) { return endpoint.replace(/^https?:\/\//, '').replace(/\/$/, ''); }
</script>

<section class="view proactive-view">
  <PageHeader eyebrow="主动触发" title="主动" subtitle="定时系统消息和 AI 自主唤醒都集中在这里；聊天里描述的任务不需要再填写一遍。">
    <button class="quiet-button" onclick={() => { void refresh(); }}><RefreshCw size={14}/>刷新</button>
    <button class="primary-button" onclick={openCreate}><Plus size={14}/>添加定时消息</button>
  </PageHeader>

  <div class="proactive-tabs" role="tablist" aria-label="主动设置">
    <button class:active={tab === 'triggers'} role="tab" aria-selected={tab === 'triggers'} onclick={() => tab = 'triggers'}><Clock3 size={15}/>触发列表</button>
    <button class:active={tab === 'settings'} role="tab" aria-selected={tab === 'settings'} onclick={() => tab = 'settings'}><Zap size={15}/>设置</button>
  </div>

  {#if tab === 'triggers'}
    <div class="proactive-overview">
      <article><span class="overview-icon amber"><BellRing size={16}/></span><div><strong>{triggers.filter((item) => item.enabled).length}</strong><small>个定时消息</small></div></article>
      <article><span class="overview-icon blue"><Sparkles size={16}/></span><div><strong>{chains.filter((item) => item.status === 'active').length}</strong><small>条 AI 主动链</small></div></article>
      <article><span class="overview-icon green"><Play size={16}/></span><div><strong>{offline ? '预览' : proactiveEnabled && !paused ? '运行中' : '已暂停'}</strong><small>{offline ? '运行时未连接' : '主动引擎'}</small></div></article>
    </div>
    <div class="proactive-section-head"><div><h2>定时系统消息</h2><p>到点直接发送，明确标记为系统消息，不依赖 AI 是否在线。</p></div><button class="quiet-button" onclick={openCreate}><Plus size={13}/>添加</button></div>
    <div class="proactive-list">
      {#each triggers as trigger (trigger.id)}
        <article class:disabled={!trigger.enabled}>
          <div class="proactive-time"><strong>{trigger.time}</strong><span>{trigger.enabled ? '每天发送' : '已暂停'}</span></div>
          <div class="proactive-message"><strong>{trigger.message}</strong><small>系统消息 · 本地时间</small></div>
          <div class="proactive-item-actions"><button class="quiet-button" onclick={() => toggleTrigger(trigger)}>{trigger.enabled ? '暂停' : '启用'}</button><button class="quiet-button" onclick={() => openEdit(trigger)}>编辑</button><button class="icon-action danger" aria-label="删除定时消息" title="删除" onclick={() => removeTrigger(trigger.id)}><Trash2 size={14}/></button></div>
        </article>
      {:else}
        <div class="proactive-empty"><Clock3 size={24}/><h3>还没有定时消息</h3><p>用按钮添加一条每天发送的系统提醒，不需要手敲列表。</p><button class="primary-button" onclick={openCreate}><Plus size={14}/>添加第一条</button></div>
      {/each}
    </div>

    {#if chains.length}
      <div class="proactive-section-head"><div><h2>AI 主动链</h2><p>由 AI 自己决定是否发消息，以及下一次唤醒时间。</p></div></div>
      <div class="proactive-list chain-list">
        {#each chains as chain (chain.id)}
          <article>
            <div class="proactive-time"><strong><Sparkles size={15}/></strong><span>{chain.status}</span></div>
            <div class="proactive-message"><strong>{chain.purpose}</strong><small>{chain.nextRunAt ? `下次 ${new Date(chain.nextRunAt).toLocaleString('zh-CN')}` : '等待 AI 设置下一次唤醒'}</small></div>
            <div class="proactive-item-actions">{#if chain.status === 'active'}<button class="quiet-button" onclick={() => runChain(chain.id)}>现在运行</button><button class="quiet-button" onclick={() => cancelChain(chain.id)}>取消</button>{/if}</div>
          </article>
        {/each}
      </div>
    {/if}

    <div class="proactive-section-head"><div><h2>最近主动记录</h2><p>只展示真实运行时产出的消息。</p></div></div>
    <div class="proactive-log-list">
      {#each log.slice(0, 8) as item (item.id)}<article><span class="badge" class:amber={item.origin !== 'system'} class:blue={item.origin === 'system'}>{item.origin === 'system' ? '系统' : 'AI'}</span><div><strong>{item.body}</strong><small>{item.reason} · {new Date(item.ts * 1000).toLocaleString('zh-CN')}</small></div></article>{:else}<p class="settings-note">还没有主动记录。</p>{/each}
    </div>
  {:else}
    <div class="proactive-settings-grid">
      <section class="proactive-settings-card"><div class="card-heading"><div><h2>主动引擎</h2><p>控制 AI 自主唤醒和系统提醒是否运行。</p></div><Sparkles size={20}/></div>
        <SettingRow title="启用主动性" desc="关闭后不会产生新的 AI 主动消息或定时提醒"><Toggle checked={proactiveEnabled} onChange={(value) => proactiveEnabled = value}/></SettingRow>
        <SettingRow title="暂停主动消息" desc="保留配置，但暂时不发送新的主动消息"><Toggle checked={paused} onChange={(value) => paused = value}/></SettingRow>
        <SettingRow title="安静时间" desc="这个时间点之后，AI 主动提醒会更克制"><select class="compact-select" bind:value={bedtimeHour}>{#each [21,22,23,0,1,2] as hour}<option value={hour}>{String(hour).padStart(2, '0')}:00</option>{/each}</select></SettingRow>
        <div class="proactive-settings-actions"><button class="primary-button" onclick={saveSettings}><Save size={14}/>保存设置</button><button class="quiet-button" onclick={runNow}><Sparkles size={14}/>现在唤醒一次</button>{#if saved}<span class="save-result">{saved}</span>{/if}</div>
      </section>
      <section class="proactive-settings-card"><div class="card-heading"><div><h2>Heartbeat · 供应商检查</h2><p>Heartbeat 不再手填 URL，直接读取「设置 → 模型 → 接入」里的供应商列表。</p></div><RefreshCw size={20}/></div>
        {#if connections.length}
          <div class="connection-health-list">{#each connections as connection (connection.id)}<article><span class="health-dot"></span><div><strong>{connection.name || connection.provider}</strong><small>{connection.provider} · {endpointLabel(connection.endpoint)}</small></div><span class="badge dim">自动检查</span></article>{/each}</div>
          <p class="field-help">每分钟检查一次供应商端点；401/404 仍表示服务可达，只有网络或 5xx 才会判定不可用。</p>
        {:else}
          <div class="proactive-empty compact"><RefreshCw size={20}/><p>还没有可用的供应商连接。先到模型设置的「接入」页添加一次，Heartbeat 会自动跟随。</p></div>
        {/if}
      </section>
    </div>
  {/if}

  {#if formOpen}
    <div class="modal-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) closeForm(); }}>
      <div class="modal-card proactive-form" role="dialog" aria-modal="true" aria-labelledby="proactive-form-title">
        <header><div><p class="eyebrow">系统消息</p><h2 id="proactive-form-title">{editingId ? '编辑定时消息' : '添加定时消息'}</h2></div><button class="icon-action" aria-label="关闭" onclick={closeForm}>×</button></header>
        <div class="settings-form"><label>发送时间<input type="time" bind:value={time}/></label><label>消息内容<textarea bind:value={message} rows="4" maxlength="500" placeholder="例如：该休息了，明天还有重要的事"></textarea><small class="field-help">到点发送给你，显示为「系统提醒」，不会创建新的对话。</small></label></div>
        {#if error}<p class="validation-error">{error}</p>{/if}
        <footer><button class="quiet-button" onclick={closeForm}>取消</button><button class="primary-button" onclick={saveTrigger}><Save size={14}/>{editingId ? '保存修改' : '添加定时消息'}</button></footer>
      </div>
    </div>
  {/if}
</section>
