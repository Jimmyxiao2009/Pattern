<script lang="ts">
  import {onMount} from 'svelte';
  import {Moon, Sun, Save} from 'lucide-svelte';
  import PageHeader from './PageHeader.svelte';
  import SettingRow from './SettingRow.svelte';
  import Toggle from './Toggle.svelte';
  import UsageCard from './UsageCard.svelte';
  import type {Persona, SlotBindings} from './types';
  import {runtime} from './runtime';

  let {
    persona,
    theme,
    onTheme,
    onRedefine,
    onPersonaChange,
  }: {
    persona: Persona | null;
    theme: 'night' | 'day';
    onTheme: (value: 'night' | 'day') => void;
    onRedefine: () => void;
    onPersonaChange: (persona: Persona) => void;
  } = $props();

  let tab = $state<'general' | 'persona' | 'model' | 'privacy' | 'shortcuts' | 'proactive' | 'filewatch' | 'journal'>('general');
  let modelPanel = $state<'usage' | 'connections'>('usage');
  let provider = $state('OpenAI Compatible');
  let endpoint = $state('https://api.openai.com/v1');
  let model = $state('gpt-4.1-mini');
  let apiKey = $state('');
  let executorProvider = $state('OpenAI Compatible');
  let executorEndpoint = $state('https://api.openai.com/v1');
  let executorModel = $state('');
  let executorApiKey = $state('');
  let agentProvider = $state('OpenAI Compatible');
  let agentEndpoint = $state('https://api.openai.com/v1');
  let agentModel = $state('gpt-5.4-mini');
  let agentApiKey = $state('');
  let executorVision = $state(true);
  let localEmbedding = $state(false);
  let plaaUrl = $state('');
  let saved = $state('');
  let autostartEnabled = $state(false);
  let autostartReady = $state(false);
  let proactiveEnabled = $state(false);
  let bedtimeHour = $state(23);
  let proactivePaused = $state(false);
  let proactiveLog = $state<Array<{id: string; reason: string; body: string; ts: number; type: string}>>([]);
  let healthChecksText = $state('');
  let cronTriggersText = $state('');
  let personaCards = $state<Persona[]>([]);
  let slotMode = $state<'shared' | 'split'>('shared');
  let companionSlotName = $state('');
  let executorSlotName = $state('');
  let journalItems = $state<Array<{ts: number; line: string; tier?: number; kind?: string; taskId?: string; decision?: string}>>([]);
  let journalQuery = $state('');
  let enforceWorkspace = $state(true);
  let autoApproveBelow = $state(2);
  let hardDenyAt = $state(3);
  let workspaceRoot = $state('');
  let tierGuide = $state<Array<{tier: number; label: string; meaning: string}>>([]);
  let watchEnabled = $state(false);
  let watchPaths = $state('');
  let watchExtensions = $state('.md, .txt, .json, .ts, .js, .svelte, .rs, .py');
  let watchMaxKb = $state(64);
  let watchEvents = $state<Array<{id:string;path:string;decision:string;reason:string;ts:number}>>([]);
  let quickShortcut = $state('alt-space');
  let activeQuickShortcut = $state('alt-space');
  type ModelProfile = {id:string; name:string; provider:string; endpoint:string; model:string; executorProvider:string; executorEndpoint:string; executorModel:string; executorVision:boolean};
  let profiles = $state<ModelProfile[]>([]);
  let activeProfileId = $state('default');
  let modelMetrics = $state<Array<{model:string;provider:string;inputTokens:number;outputTokens:number;cachedTokens:number;requests:number;contextWindow?:number;balance?:string;cost?:number;costCurrency?:string;lastRequest?:{inputTokens:number;outputTokens:number;cachedTokens:number;durationMs?:number;cost?:number;costCurrency?:string;at:number};updatedAt:number}>>([]);
  let availableModels = $state<string[]>(['gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.4-pro', 'gpt-5.4-mini', 'gpt-5.4-nano']);
  let modelCatalogSource = $state<'provider' | 'preset'>('preset');
  const isDemo = new URLSearchParams(location.search).has('demo');

  const tabs = [
    ['general', '常规'],
    ['persona', '人格与角色'],
    ['model', '模型'],
    ['filewatch', '文件感知'],
    ['journal', '执行日志'],
    ['privacy', '隐私与权限'],
    ['shortcuts', '快捷键'],
  ] as const;

  function persistProfiles() { localStorage.setItem('pattern-model-profiles', JSON.stringify({activeProfileId, profiles})); }
  function snapshotProfile(): ModelProfile { return {id:activeProfileId, name: profiles.find((item)=>item.id===activeProfileId)?.name || `${provider} · ${model}`, provider, endpoint, model, executorProvider, executorEndpoint, executorModel, executorVision}; }
  function syncActiveProfile() { const profile = snapshotProfile(); const index = profiles.findIndex((item)=>item.id===profile.id); profiles = index < 0 ? [...profiles, profile] : profiles.map((item, i)=>i===index ? profile : item); persistProfiles(); }
  async function activateProfile(id: string) {
    const profile = profiles.find((item)=>item.id===id); if (!profile) return;
    activeProfileId = id; provider = profile.provider; endpoint = profile.endpoint; model = profile.model;
    executorProvider = profile.executorProvider; executorEndpoint = profile.executorEndpoint; executorModel = profile.executorModel; executorVision = profile.executorVision;
    await saveModel(); saved = `已切换到 ${profile.name}`;
  }
  function addProfile() {
    syncActiveProfile(); const id = crypto.randomUUID(); activeProfileId = id;
    profiles = [...profiles, {id, name:`新配置 ${profiles.length + 1}`, provider:'OpenAI Compatible', endpoint:'https://api.openai.com/v1', model:'gpt-4.1-mini', executorProvider:'OpenAI Compatible', executorEndpoint:'https://api.openai.com/v1', executorModel:'', executorVision:true}];
    void activateProfile(id);
  }
  function presetForProvider(value: string) {
    const key=value.toLowerCase();
    if(key.includes('anthropic')) return ['claude-fable-5','claude-opus-4-8','claude-sonnet-5','claude-haiku-4-5'];
    if(key.includes('deepseek')) return ['deepseek-v4-pro','deepseek-v4-flash'];
    if(key.includes('qwen') || key.includes('百炼')) return ['qwen3.7-max','qwen3.7-plus','qwen3.6-flash','qwen3.5-plus','qwen3.5-flash'];
    if(key.includes('智谱') || key.includes('zhipu')) return ['glm-5.1','glm-5v-turbo','glm-4.7'];
    return ['gpt-5.6','gpt-5.6-terra','gpt-5.6-luna','gpt-5.5','gpt-5.5-pro','gpt-5.4','gpt-5.4-pro','gpt-5.4-mini','gpt-5.4-nano'];
  }
  function modelChoices(current = '') { return Array.from(new Set([current, ...availableModels].filter(Boolean))); }
  async function refreshModelCatalog() {
    availableModels = presetForProvider(provider); modelCatalogSource = 'preset';
    try {
      const response = await runtime.request<any>({type:'model.catalog.get', id:crypto.randomUUID()});
      if (response.type === 'model.catalog') { availableModels=response.models; modelCatalogSource=response.source; }
    } catch { /* presets remain usable before a key/runtime is available */ }
  }

  onMount(async () => {
    try {
      const directory = JSON.parse(localStorage.getItem('pattern-model-profiles') || '{}');
      if (Array.isArray(directory.profiles)) profiles = directory.profiles;
      if (typeof directory.activeProfileId === 'string') activeProfileId = directory.activeProfileId;
    } catch { /* profiles are optional local metadata */ }
    if ((window as any).__TAURI_INTERNALS__) {
      try {
        const {isEnabled} = await import('@tauri-apps/plugin-autostart');
        autostartEnabled = await isEnabled();
        autostartReady = true;
        const {invoke} = await import('@tauri-apps/api/core');
        const config = await invoke<{provider: string; endpoint: string; model: string; profileId?: string; agentProvider?: string; agentEndpoint?: string; agentModel?: string; executorProvider?: string; executorEndpoint?: string; executorModel?: string; executorVision?:boolean; localEmbedding?: boolean;plaaUrl?:string} | null>('load_model_config');
        if (config) {
          provider = config.provider;
          endpoint = config.endpoint;
          model = config.model;
          agentProvider = config.agentProvider || config.provider;
          agentEndpoint = config.agentEndpoint || config.endpoint;
          agentModel = config.agentModel || 'gpt-5.4-mini';
          executorProvider = config.executorProvider || config.provider;
          executorEndpoint = config.executorEndpoint || config.endpoint;
          executorModel = config.executorModel || '';
          executorVision = config.executorVision !== false;
          localEmbedding = !!config.localEmbedding;
          plaaUrl = config.plaaUrl || '';
          if (!profiles.length) {
            activeProfileId = config.profileId || 'default';
            profiles = [{id:activeProfileId, name:`${config.provider} · ${config.model}`, provider:config.provider, endpoint:config.endpoint, model:config.model, executorProvider:config.executorProvider || config.provider, executorEndpoint:config.executorEndpoint || config.endpoint, executorModel:config.executorModel || '', executorVision:config.executorVision !== false}];
            persistProfiles();
          } else if (profiles.some((item)=>item.id===activeProfileId)) {
            const profile = profiles.find((item)=>item.id===activeProfileId)!;
            provider=profile.provider; endpoint=profile.endpoint; model=profile.model; executorProvider=profile.executorProvider; executorEndpoint=profile.executorEndpoint; executorModel=profile.executorModel; executorVision=profile.executorVision;
          }
        }
        const proactive = await invoke<{enabled: boolean; bedtimeHour: number; paused?: boolean}>('load_proactive_config');
        proactiveEnabled = proactive.enabled;
        bedtimeHour = proactive.bedtimeHour;
        proactivePaused = !!proactive.paused;
        personaCards = await invoke<Persona[]>('list_personas');
        const slots = await invoke<SlotBindings>('load_slot_bindings');
        slotMode = slots.mode === 'split' ? 'split' : 'shared';
        companionSlotName = slots.companionName || persona?.name || '';
        executorSlotName = slots.executorName || slots.companionName || persona?.name || '';
        const shortcuts = await invoke<{quickShortcut:string;activeQuickShortcut:string}>('load_shortcut_config');
        quickShortcut = shortcuts.quickShortcut;
        activeQuickShortcut = shortcuts.activeQuickShortcut;
      } catch (error) {
        saved = `读取失败：${error}`;
      }
    }
    if (await runtime.connect()) {
      runtime.on((message:any) => {
        if (message.type === 'filewatch.event') {
          const index = watchEvents.findIndex((item)=>item.id===message.item.id);
          if (index >= 0) watchEvents[index] = message.item;
          else watchEvents = [message.item, ...watchEvents].slice(0,30);
        }
        if (message.type === 'model.metrics') modelMetrics = message.metrics;
      });
      const res = await runtime.request<any>({type: 'proactive.list', id: crypto.randomUUID(), limit: 30});
      if (res.type === 'proactive.list.result') proactiveLog = res.items;
      const cfg = await runtime.request<any>({type: 'proactive.getConfig', id: crypto.randomUUID()});
      if (cfg.type === 'proactive.config') {
        proactiveEnabled = cfg.enabled;
        bedtimeHour = cfg.bedtimeHour;
        proactivePaused = cfg.paused;
      }
      const health = await runtime.request<any>({type:'healthcheck.getConfig', id:crypto.randomUUID()});
      if (health.type === 'healthcheck.config') healthChecksText = health.checks.map((check:any)=>check.label ? `${check.label} | ${check.url}` : check.url).join('\n');
      const cron = await runtime.request<any>({type:'cron.getConfig', id:crypto.randomUUID()});
      if (cron.type === 'cron.config') cronTriggersText = cron.triggers.map((trigger:any)=>`${trigger.time} | ${trigger.message}`).join('\n');
      const watchCfg = await runtime.request<any>({type:'filewatch.getConfig', id:crypto.randomUUID()});
      if (watchCfg.type === 'filewatch.config') {
        watchEnabled = watchCfg.config.enabled;
        watchPaths = watchCfg.config.paths.join('\n');
        watchExtensions = watchCfg.config.extensions.join(', ');
        watchMaxKb = Math.round(watchCfg.config.maxBytes / 1024);
      }
      const watchList = await runtime.request<any>({type:'filewatch.list', id:crypto.randomUUID(), limit:30});
      if (watchList.type === 'filewatch.list.result') watchEvents = watchList.items;
      const journal = await runtime.request<any>({type:'journal.list', id:crypto.randomUUID(), limit:120, query: journalQuery || null});
      if (journal.type === 'journal.list.result') journalItems = journal.items;
      await loadSecurityPolicy();
      const metrics = await runtime.request<any>({type:'model.metrics.get', id:crypto.randomUUID()});
      if (metrics.type === 'model.metrics') modelMetrics = metrics.metrics;
      await refreshModelCatalog();
    }
  });

  async function saveFileWatch() {
    try {
      if (watchEnabled && !watchPaths.trim()) { saved = '启用前请至少填写一个监视目录'; return; }
      const response = await runtime.request<any>({type:'filewatch.setConfig', id:crypto.randomUUID(), config:{
        enabled:watchEnabled,
        paths:watchPaths.split(/\r?\n/).map((x)=>x.trim()).filter(Boolean),
        extensions:watchExtensions.split(',').map((x)=>x.trim()).filter(Boolean),
        maxBytes:watchMaxKb * 1024,
      }});
      if (response.type === 'filewatch.config') saved = '文件感知设置已生效';
    } catch (error) { saved = `保存文件感知失败：${error}`; }
  }

  async function setAutostart(value: boolean) {
    if (!autostartReady) return;
    try {
      const {enable, disable, isEnabled} = await import('@tauri-apps/plugin-autostart');
      if (value) await enable();
      else await disable();
      autostartEnabled = await isEnabled();
      saved = autostartEnabled ? '已启用开机启动' : '已关闭开机启动';
    } catch (error) {
      saved = `更新开机启动失败：${error}`;
    }
  }

  async function saveProactive(enabled = proactiveEnabled, hour = bedtimeHour, paused = proactivePaused) {
    proactiveEnabled = enabled;
    bedtimeHour = hour;
    proactivePaused = paused;
    if ((window as any).__TAURI_INTERNALS__) {
      const {invoke} = await import('@tauri-apps/api/core');
      await invoke('save_proactive_config', {config: {enabled, bedtimeHour: hour, paused}});
    }
  }

  async function saveHealthChecks() {
    try {
      const checks = healthChecksText.split(/\r?\n/).map((line) => {
        const [label, ...urlParts] = line.split('|');
        const hasLabel = urlParts.length > 0;
        return {label: hasLabel ? label.trim() : undefined, url:(hasLabel ? urlParts.join('|') : label).trim()};
      }).filter((check)=>check.url);
      await runtime.request({type:'healthcheck.setConfig',id:crypto.randomUUID(),checks});
      saved = '健康检查已保存';
    } catch (error) { saved = `保存健康检查失败：${error}`; }
  }

  async function saveCronTriggers() {
    try {
      const triggers = cronTriggersText.split(/\r?\n/).map((line) => {
        const [time, ...message] = line.split('|');
        return {id:crypto.randomUUID(), time:time.trim(), message:message.join('|').trim(), enabled:true};
      }).filter((trigger)=>trigger.time && trigger.message);
      await runtime.request({type:'cron.setConfig',id:crypto.randomUUID(),triggers});
      saved = '定时提醒已保存';
    } catch (error) { saved = `保存定时提醒失败：${error}`; }
  }

  async function saveModel() {
    if (!(window as any).__TAURI_INTERNALS__) {
      saved = '浏览器预览不会保存模型配置';
      return;
    }
    try {
      // Roles select a model from the active connection; credentials and endpoints are maintained once.
      agentProvider = provider;
      agentEndpoint = endpoint;
      executorProvider = provider;
      executorEndpoint = endpoint;
      syncActiveProfile();
      const {invoke} = await import('@tauri-apps/api/core');
      await invoke('save_model_config', {
        config: {provider, endpoint, model, profileId:activeProfileId, connections: profiles.map((item) => ({id:item.id, name:item.name, provider:item.provider, endpoint:item.endpoint, enabled:true})), agentProvider, agentEndpoint, agentModel, executorProvider, executorEndpoint, executorModel, executorVision, localEmbedding,plaaUrl},
        apiKey: apiKey || null,
        executorApiKey: executorApiKey || null,
        agentApiKey: agentApiKey || null,
      });
      apiKey = '';
      executorApiKey = '';
      agentApiKey = '';
      saved = '已保存并重新配置运行时';
      await refreshModelCatalog();
    } catch (error) {
      saved = `保存失败：${error}`;
    }
  }

  async function refreshModelMetrics(balance = false) {
    try {
      const response = await runtime.request<any>({type: balance ? 'model.balance.check' : 'model.metrics.get', id:crypto.randomUUID()});
      if (response.type === 'model.metrics') { modelMetrics = response.metrics; saved = balance ? '余额信息已刷新' : '模型用量已刷新'; }
    } catch (error) { saved = `读取模型观测失败：${error}`; }
  }

  const shortcutLabel = (value:string) => value === 'ctrl-alt-space' ? 'Ctrl + Alt + Space' : value === 'ctrl-shift-space' ? 'Ctrl + Shift + Space' : 'Alt + Space';
  async function saveShortcuts() {
    if (!(window as any).__TAURI_INTERNALS__) { saved = '浏览器预览不会注册全局快捷键'; return; }
    try {
      const {invoke} = await import('@tauri-apps/api/core');
      const result = await invoke<{activeQuickShortcut:string;fallback:boolean}>('save_shortcut_config', {config:{quickShortcut}});
      activeQuickShortcut = result.activeQuickShortcut;
      saved = result.fallback ? `首选已被占用，当前使用 ${shortcutLabel(activeQuickShortcut)}` : `已启用 ${shortcutLabel(activeQuickShortcut)}`;
    } catch (error) { saved = `更新快捷键失败：${error}`; }
  }


  async function saveSlotBindings() {
    if (!(window as any).__TAURI_INTERNALS__) {
      saved = '浏览器预览不会保存槽绑定';
      return;
    }
    try {
      const {invoke} = await import('@tauri-apps/api/core');
      const companionName = companionSlotName || persona?.name || '';
      const executorName = slotMode === 'split' ? (executorSlotName || companionName) : companionName;
      await invoke('save_slot_bindings', {
        bindings: {
          mode: slotMode,
          companionName,
          executorName,
        },
      });
      saved = slotMode === 'split' ? `已拆分：陪伴=${companionName} · 执行=${executorName}` : `双槽共用 ${companionName || '当前人格'}`;
    } catch (error) {
      saved = `保存槽绑定失败：${error}`;
    }
  }

  async function refreshJournal() {
    try {
      if (!(await runtime.connect())) { saved = '运行时未连接'; return; }
      const journal = await runtime.request<any>({type:'journal.list', id:crypto.randomUUID(), limit:120, query: journalQuery || null});
      if (journal.type === 'journal.list.result') {
        journalItems = journal.items;
        saved = `已刷新 ${journalItems.length} 条审计`;
      }
    } catch (error) {
      saved = `刷新审计失败：${error}`;
    }
  }

  
  async function loadSecurityPolicy() {
    try {
      if (!(await runtime.connect())) return;
      const res = await runtime.request<any>({type:'security.policy.get', id:crypto.randomUUID()});
      if (res.type === 'security.policy') {
        enforceWorkspace = res.policy.enforceWorkspace !== false;
        autoApproveBelow = Number(res.policy.autoApproveBelow ?? 2);
        hardDenyAt = Number(res.policy.hardDenyAt ?? 3);
        workspaceRoot = res.policy.workspaceRoot || '';
        tierGuide = res.policy.tierGuide || [];
      }
    } catch { /* optional */ }
  }
  async function saveSecurityPolicy() {
    try {
      if (!(await runtime.connect())) { saved = '运行时未连接'; return; }
      const res = await runtime.request<any>({
        type:'security.policy.set',
        id:crypto.randomUUID(),
        policy:{
          enforceWorkspace,
          autoApproveBelow,
          hardDenyAt,
          workspaceRoot: workspaceRoot.trim() || null,
        },
      });
      if (res.type === 'security.policy') {
        enforceWorkspace = res.policy.enforceWorkspace;
        autoApproveBelow = res.policy.autoApproveBelow;
        hardDenyAt = res.policy.hardDenyAt;
        workspaceRoot = res.policy.workspaceRoot || '';
        tierGuide = res.policy.tierGuide || [];
        saved = '安全策略已保存';
      }
    } catch (error) { saved = `保存安全策略失败：${error}`; }
  }
async function activatePersonaCard(card: Persona) {
    if (!(window as any).__TAURI_INTERNALS__) { onPersonaChange(card); return; }
    try {
      const {invoke} = await import('@tauri-apps/api/core');
      await invoke('activate_persona', {persona: card});
      // quiet personas keep proactive enabled=false; free keeps previous hour but ensures enabled
      await invoke('save_proactive_config', {
        config: {
          enabled: card.proactive !== 'quiet',
          bedtimeHour,
          paused: proactivePaused,
        },
      });
      proactiveEnabled = card.proactive !== 'quiet';
      onPersonaChange(card);
      saved = `已切换为 ${card.name}`;
    } catch (error) { saved = `切换人格失败：${error}`; }
  }
</script>

<section class="view">
  <PageHeader eyebrow="Pattern" title="设置" subtitle="控制人格、模型与常驻行为。" />
  <div class="settings-layout">
    <aside>
      {#each tabs as item}
        <button class:active={tab === item[0]} onclick={() => (tab = item[0])}>{item[1]}</button>
      {/each}
    </aside>
    <div class="settings-panel">
      {#if tab === 'general'}
        <h2>外观</h2>
        <SettingRow title="主题" desc="切换界面的明暗外观">
          <div class="segmented">
            <button class:active={theme === 'night'} onclick={() => onTheme('night')}><Moon size={13} />夜</button>
            <button class:active={theme === 'day'} onclick={() => onTheme('day')}><Sun size={13} />昼</button>
          </div>
        </SettingRow>
        <h2>常驻行为</h2>
        <SettingRow title="主动消息策略" desc="空闲时按此策略投递；忙碌（回复中/任务执行/项目页专注）会静默接收，不抢焦点">
          <div class="segmented">
            <button type="button" class:active={(localStorage.getItem('pattern-proactive-mode')||'new_chat')!=='inline'} onclick={() => { localStorage.setItem('pattern-proactive-mode','new_chat'); saved='主动消息：新建对话'; }}>新对话</button>
            <button type="button" class:active={localStorage.getItem('pattern-proactive-mode')==='inline'} onclick={() => { localStorage.setItem('pattern-proactive-mode','inline'); saved='主动消息：轻插当前'; }}>轻插</button>
          </div>
        </SettingRow>
        <SettingRow title="忙碌时静默" desc="执行任务、生成回复或在项目页专注时，主动消息不抢窗"><span class="badge green">已启用</span></SettingRow>
        <SettingRow title="关闭到托盘" desc="关闭主窗口时隐藏到系统托盘，不退出进程"><span class="badge green">已启用</span></SettingRow>
        <SettingRow title="快捷窗" desc="始终置顶，Esc 或关闭按钮隐藏"><span class="badge green">已启用</span></SettingRow>
        <SettingRow title="单实例运行" desc="重复启动会唤起已有窗口，避免多个 sidecar"><span class="badge green">已启用</span></SettingRow>
        <SettingRow title="开机启动" desc="登录系统后自动启动 Pattern">
          {#if autostartReady}
            <Toggle checked={autostartEnabled} onChange={setAutostart} />
          {:else}
            <span class="badge dim">不可用</span>
          {/if}
        </SettingRow>
      {:else if tab === 'persona'}
        <h2>当前人格</h2>
        <SettingRow title={persona?.name || '未定义'} desc={persona?.description || '尚未完成人格定义'}>
          <button class="quiet-button" onclick={onRedefine}>重新定义</button>
        </SettingRow>
        <h2>Agent 角色</h2>
        <SettingRow title="主 Agent" desc={`${persona?.name || '当前人格'} · 统一承载聊天、记忆、主动消息和工作决策`}><span class="badge green">当前</span></SettingRow>
        <SettingRow title="子代理" desc="只有明确要求执行时才派生；独立处理 Computer Use，完成后只回传结果摘要"><span class="badge amber">按需启动</span></SettingRow>
        <p class="settings-note">主 Agent 与子代理共享人格和必要上下文，但子代理的执行细节不会污染主对话。</p>
        <h2>人格卡</h2>
        {#each personaCards as card}
          <SettingRow title={card.name} desc={card.description}>
            {#if persona?.name === card.name}
              <span class="badge green">当前</span>
            {:else}
              <button class="quiet-button" onclick={() => activatePersonaCard(card)}>切换</button>
            {/if}
          </SettingRow>
        {:else}
          <p class="settings-note">还没有人格卡。可以重新定义创建新的人格。</p>
        {/each}
      {:else if tab === 'model'}
        <div class="model-subtabs" role="tablist" aria-label="模型设置">
          <button class:active={modelPanel === 'usage'} role="tab" aria-selected={modelPanel === 'usage'} onclick={() => (modelPanel = 'usage')}>使用</button>
          <button class:active={modelPanel === 'connections'} role="tab" aria-selected={modelPanel === 'connections'} onclick={() => (modelPanel = 'connections')}>接入</button>
        </div>
        {#if modelPanel === 'usage'}
          <h2>使用模型</h2>
          <p class="settings-note">这里维护“谁负责什么”，不用为主 Agent 和子代理重复填写地址、密钥。所有角色都从当前接入的模型列表中选择。</p>
          <div class="model-usage-list">
            <div class="model-usage-row"><div><strong>默认模型</strong><small>用于新对话、主 Agent 和最终回复</small></div><select bind:value={model}>{#each modelChoices(model) as item}<option value={item}>{item}</option>{/each}</select></div>
            <div class="model-usage-row"><div><strong>独立规划模型</strong><small>用于拆解、路由和需要低成本判断的步骤</small></div><select bind:value={agentModel}><option value="">使用默认模型</option>{#each modelChoices(agentModel) as item}<option value={item}>{item}</option>{/each}</select></div>
            <div class="model-usage-row"><div><strong>子代理模型</strong><small>明确要求干活时使用；留空则自动复用默认模型</small></div><select bind:value={executorModel}><option value="">使用默认模型</option>{#each modelChoices(executorModel) as item}<option value={item}>{item}</option>{/each}</select></div>
            <SettingRow title="执行模型支持图像" desc="关闭后只向模型发送 UIA/AX 无障碍树和动作回执，不发送截图。"><Toggle checked={executorVision} onChange={(value)=>executorVision=value}/></SettingRow>
          </div>
          <div class="model-use-actions"><button class="primary-button" onclick={saveModel}><Save size={14} />保存使用设置</button>{#if saved}<span class="save-result">{saved}</span>{/if}</div>
          <h2>模型用量</h2>
          <p class="settings-note">数值来自模型响应中的 usage 字段；上下文窗口为模型系列标称值。余额仅在服务商公开兼容接口可用时显示。</p>
          <div class="model-metrics-actions"><button class="quiet-button" onclick={() => refreshModelMetrics(false)}>刷新用量</button><button class="quiet-button" onclick={() => refreshModelMetrics(true)}>查询余额</button></div>
          <div class="model-metrics">
            {#if modelMetrics.length}{#each modelMetrics as metric}<UsageCard {metric} />{/each}{:else}<UsageCard metric={null} demo={isDemo} />{/if}
          </div>
        {:else}
          <h2>供应商接入</h2>
          <p class="settings-note">每个接入只填写一次地址和密钥；完成后到“使用”列表选择默认模型、规划模型和子代理模型。</p>
          <div class="model-profiles">
            {#each profiles as profile}
              <button class:active={profile.id === activeProfileId} onclick={() => activateProfile(profile.id)}><strong>{profile.name}</strong><span>{profile.provider} · {profile.model}</span></button>
            {/each}
            <button class="add-profile" onclick={addProfile}>＋ 添加模型服务</button>
          </div>
          {#if profiles.length}
            <div class="settings-form compact-model-form"><label>接入名称<input value={profiles.find((item)=>item.id===activeProfileId)?.name || ''} oninput={(event) => { const name=(event.currentTarget as HTMLInputElement).value; profiles=profiles.map((item)=>item.id===activeProfileId ? {...item,name} : item); persistProfiles(); }} /></label></div>
          {/if}
          <div class="provider-card">
            <div class="provider-card-head"><div><strong>{provider}</strong><span>{apiKey ? '待保存的新密钥' : '密钥保存在系统凭据库'}</span></div><span class="badge" class:green={!!apiKey}>接入配置</span></div>
            <div class="settings-form"><label>服务商<select bind:value={provider} onchange={() => { availableModels=presetForProvider(provider); modelCatalogSource='preset'; }}><option>OpenAI Compatible</option><option>OpenAI</option><option>Anthropic</option><option>OpenRouter</option><option>DeepSeek</option><option>阿里云百炼 / Qwen</option><option>智谱 AI</option></select></label><label>API 地址<input bind:value={endpoint} /></label><label>更新 API Key<input type="password" bind:value={apiKey} placeholder="留空则保持现有密钥" /></label><div><button class="quiet-button" onclick={refreshModelCatalog}>刷新可用模型</button></div></div>
            <datalist id="available-models">{#each availableModels as item}<option value={item}></option>{/each}</datalist>
            <div class="enabled-models"><small>{modelCatalogSource === 'provider' ? '已发现模型' : '内置候选模型'}</small>{#each availableModels.slice(0, 12) as item}<span>{item}</span>{/each}</div>
            <button class="primary-button" onclick={saveModel}><Save size={14} />保存接入</button>{#if saved}<span class="save-result">{saved}</span>{/if}
          </div>
        {/if}
        <h2>本地语义记忆</h2>
        <SettingRow title="BGE Small 中文向量" desc="首次使用会下载约 60MB 本地模型；已有记忆会在新写入时逐步使用新向量。">
          <Toggle checked={localEmbedding} onChange={(value) => localEmbedding = value} />
        </SettingRow>
        <button class="quiet-button" onclick={saveModel}><Save size={14}/>保存本地向量设置</button>
        <h2>PLAA 情感状态</h2>
        <p class="settings-note">可选挂载点。填写本地 PLAA 服务地址后，当前情感状态会加入主 Agent 上下文；留空完全禁用。</p>
        <div class="settings-form"><label>PLAA 服务地址<input bind:value={plaaUrl} placeholder="http://127.0.0.1:8765" /></label><button class="quiet-button" onclick={saveModel}><Save size={14}/>保存挂载点</button></div>
      {:else if tab === 'proactive'}
        <h2>主动性</h2>
        <SettingRow title="深夜主动提醒" desc="达到设定时间后，同话题当天最多一次">
          <Toggle checked={proactiveEnabled} onChange={(value) => saveProactive(value, bedtimeHour, proactivePaused)} />
        </SettingRow>
        <SettingRow title="暂停主动性" desc="托盘也可切换；暂停后不发起新的主动消息">
          <Toggle checked={proactivePaused} onChange={(value) => saveProactive(proactiveEnabled, bedtimeHour, value)} />
        </SettingRow>
        <SettingRow title="提醒时间" desc="本地时间到达该小时后触发">
          <select class="compact-select" bind:value={bedtimeHour} onchange={() => saveProactive(proactiveEnabled, bedtimeHour, proactivePaused)}>
            {#each [21, 22, 23, 0, 1, 2] as hour}
              <option value={hour}>{String(hour).padStart(2, '0')}:00</option>
            {/each}
          </select>
        </SettingRow>
        <SettingRow title="立即试一次" desc="唤醒一次 AI；AI 会通过工具决定是否发消息及是否安排下一次唤醒。">
          <button class="quiet-button" onclick={async () => {
            if (!(await runtime.connect())) return;
            await runtime.request({type:'proactive.trigger', id: crypto.randomUUID(), kind:'manual', reason:'设置页手动触发'});
            const res = await runtime.request({type:'proactive.list', id: crypto.randomUUID(), limit:30});
            if ((res as any).type==='proactive.list.result') proactiveLog = (res as any).items;
          }}>触发</button>
        </SettingRow>
        <h2>定时触发</h2>
        <p class="settings-note">每行写「HH:MM | 提醒内容」。这是可靠的系统提醒：即使模型不可用也会送达，并在收件箱中明确标注为系统消息。</p>
        <div class="settings-form">
          <label>触发列表<textarea bind:value={cronTriggersText} rows="4" placeholder="09:30 | 该准备日会了\n23:30 | 今天就到这里吧"></textarea></label>
          <div><button class="quiet-button" onclick={saveCronTriggers}><Save size={14}/>保存定时触发</button>{#if saved}<span class="save-result">{saved}</span>{/if}</div>
        </div>
        <h2>服务健康检查</h2>
        <p class="settings-note">每分钟请求一次；仅在可用/不可用状态变化时主动提醒。每行写 URL，或「名称 | URL」。</p>
        <div class="settings-form">
          <label>检查列表<textarea bind:value={healthChecksText} rows="4" placeholder="Production API | https://api.example.com/health"></textarea></label>
          <div><button class="quiet-button" onclick={saveHealthChecks}><Save size={14}/>保存健康检查</button>{#if saved}<span class="save-result">{saved}</span>{/if}</div>
        </div>
        <h2>TA 今天为什么找我</h2>
        {#each proactiveLog as item}
          <SettingRow title={item.type} desc={`${new Date(item.ts * 1000).toLocaleString('zh-CN')} · ${item.reason} · ${item.body}`}>
            <span class="badge dim">日志</span>
          </SettingRow>
        {:else}
          <p class="settings-note">还没有主动记录。</p>
        {/each}
      {:else if tab === 'filewatch'}
        <h2>文件系统感知</h2>
        <p class="settings-note">只把路径和变化类型先发给 AI 判断；AI 认为有助于了解你时才读取文件。不监视未列出的目录。</p>
        <SettingRow title="启用感知" desc="监视下方目录的新建与修改"><Toggle checked={watchEnabled} onChange={(v)=>watchEnabled=v}/></SettingRow>
        <div class="settings-form">
          <label>监视目录（每行一个绝对路径）<textarea bind:value={watchPaths} rows="5" placeholder="C:\\Users\\you\\Documents\\Notes"></textarea></label>
          <label>允许读取的扩展名<input bind:value={watchExtensions} /></label>
          <label>单文件读取上限（KB）<input type="number" min="1" max="1024" bind:value={watchMaxKb} /></label>
          <div><button class="primary-button" onclick={saveFileWatch}><Save size={14}/>保存并开始监视</button>{#if saved}<span class="save-result">{saved}</span>{/if}</div>
        </div>
        <h2>最近判断</h2>
        {#if watchEvents.length}
          {#each watchEvents as item}<SettingRow title={item.path} desc={item.reason}><span class="badge" class:green={item.decision==='read'} class:dim={item.decision==='ignored'}>{item.decision}</span></SettingRow>{/each}
        {:else}<p class="settings-note">还没有文件变化记录。</p>{/if}
      {:else if tab === 'journal'}
        <h2>执行审计</h2>
        <p class="settings-note">动作日志来自本地 journal/actions.jsonl。可按关键词、T2、denied、boundary 筛选回看。</p>
        <div class="settings-form">
          <label>筛选
            <div class="path-row">
              <input aria-label="审计筛选" bind:value={journalQuery} placeholder="例如 denied / T2 / boundary / taskId" />
              <button class="quiet-button" type="button" onclick={refreshJournal}>刷新</button>
            </div>
          </label>
          {#if saved}<span class="save-result">{saved}</span>{/if}
        </div>
        {#if journalItems.length}
          {#each journalItems as item}
            <SettingRow title={item.line} desc={item.ts ? new Date((item.ts > 1e12 ? item.ts : item.ts * 1000)).toLocaleString('zh-CN') : '无时间戳'}>
              {#if item.tier != null}<span class="badge" class:amber={item.tier >= 2} class:green={item.tier === 0}>T{item.tier}</span>{/if}
              {#if item.decision}<span class="badge" class:green={item.decision === 'allowed' || item.decision === 'approved'} class:amber={item.decision === 'info'} class:dim={item.decision === 'denied'}>{item.decision}</span>{/if}
              {#if item.kind}<span class="badge dim">{item.kind}</span>{:else}<span class="badge dim">journal</span>{/if}
            </SettingRow>
          {/each}
        {:else}
          <p class="settings-note">还没有执行日志。完成一次任务或触发隔离/审批后会出现在这里。</p>
        {/if}
      {:else if tab === 'privacy'}
        <h2>执行安全（约束层）</h2>
        <p class="settings-note">学自网安向管家的方法论：默认不信任越界执行。这是底层约束，不替代陪伴/编码体验。</p>
        <SettingRow title="工作区隔离" desc="开启后，项目路径外的写/执行类访问会被拒绝">
          <Toggle checked={enforceWorkspace} onChange={(v) => enforceWorkspace = v} />
        </SettingRow>
        <div class="settings-form">
          <label>当前信任根（可空；打开项目聊天时会自动绑定）
            <input aria-label="工作区信任根" bind:value={workspaceRoot} placeholder="E:\path	o\project" />
          </label>
          <label>自动放行低于此等级（默认 2 = T0/T1 自动）
            <input type="number" min="0" max="3" bind:value={autoApproveBelow} />
          </label>
          <label>硬拒绝不低于此等级（默认 3 = T3 直接拒绝并冻结）
            <input type="number" min="1" max="3" bind:value={hardDenyAt} />
          </label>
          <div><button class="primary-button" type="button" onclick={saveSecurityPolicy}><Save size={14}/>保存安全策略</button>{#if saved}<span class="save-result">{saved}</span>{/if}</div>
        </div>
        {#if tierGuide.length}
          <h2>风险等级词典</h2>
          {#each tierGuide as item}
            <SettingRow title={item.label} desc={item.meaning}><span class="badge" class:green={item.tier===0} class:amber={item.tier>=2}>T{item.tier}</span></SettingRow>
          {/each}
        {/if}
        <h2>数据位置</h2>
        <SettingRow title="本地数据" desc="%LOCALAPPDATA%/pattern · 人格、记忆、会话、journal"><span class="badge green">仅本机</span></SettingRow>
        <SettingRow title="API Key" desc="Windows Credential Manager · 不写入配置文件"><span class="badge green">系统保护</span></SettingRow>
        <h2>感知权限</h2>
        <SettingRow title="前台应用感知" desc="读取前台窗口标题，用于忙碌判断与主动消息静默（不上传）"><span class="badge green">已启用（忙闲）</span></SettingRow>
        <SettingRow title="Computer Use" desc="截屏与键鼠注入由 OS Bridge 提供；急停 Ctrl+Alt+Esc，审查窗可继续"><span class="badge amber">已接入</span></SettingRow>
        <SettingRow title="权限引导" desc="macOS 请在系统设置中授予辅助功能与屏幕录制；Windows 首次执行任务时会使用 UIA"><span class="badge green">OOBE 已说明</span></SettingRow>
      {:else}
        <h2>全局快捷键</h2>
        <SettingRow title="唤起快捷窗" desc="显示或隐藏始终置顶的快捷输入窗口"><select class="compact-select" aria-label="唤起快捷窗快捷键" bind:value={quickShortcut}><option value="alt-space">Alt + Space</option><option value="ctrl-alt-space">Ctrl + Alt + Space</option><option value="ctrl-shift-space">Ctrl + Shift + Space</option></select></SettingRow>
        <SettingRow title="当前生效" desc="若首选被占用，会自动选择其他安全组合"><kbd>{shortcutLabel(activeQuickShortcut)}</kbd></SettingRow>
        <SettingRow title="急停 Computer Use" desc="冻结所有键鼠注入并保留任务状态"><kbd>Ctrl + Alt + Esc</kbd></SettingRow>
        <div><button class="primary-button" onclick={saveShortcuts}><Save size={14}/>应用快捷键</button>{#if saved}<span class="save-result">{saved}</span>{/if}</div>
        <p class="settings-note">快捷键冲突不会阻止 Pattern 启动；应用会依次尝试其余组合，并在系统通知中说明实际生效的快捷键。</p>
      {/if}
    </div>
  </div>
</section>
