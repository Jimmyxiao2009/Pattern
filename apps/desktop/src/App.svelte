<script lang="ts">
  import {onMount, tick} from 'svelte';
  import {BellRing, MessageCircleMore, Layers3, Send, Settings, Plus, Paperclip, ArrowUp, ArrowRight, Search, Minus, Maximize2, X, Trash2, MessagesSquare, Workflow, Wrench, FolderGit2, Target, ListTodo, ShieldCheck, ChevronDown, Sparkles} from 'lucide-svelte';
  import StatusDot from './lib/StatusDot.svelte';
  import Oobe from './lib/Oobe.svelte';
  import QuickWindow from './lib/QuickWindow.svelte';
  import ReviewWindow from './lib/ReviewWindow.svelte';
  import CompanionWidget from './lib/CompanionWidget.svelte';
  import PageHeader from './lib/PageHeader.svelte';
  import SettingsView from './lib/SettingsView.svelte';
  import MemoryEditor from './lib/MemoryEditor.svelte';
  import PatternsView from './lib/PatternsView.svelte';
  import GoalsView from './lib/GoalsView.svelte';
  import SessionAgentDocks from './lib/SessionAgentDocks.svelte';
  import ProactiveView from './lib/ProactiveView.svelte';
  import ChannelsView from './lib/ChannelsView.svelte';
  import ConversationsView from './lib/ConversationsView.svelte';
  import WorkflowsView from './lib/WorkflowsView.svelte';
  import McpView from './lib/McpView.svelte';
  import RecentsSidebar from './lib/RecentsSidebar.svelte';
  import ProjectWorkspace from './lib/ProjectWorkspace.svelte';
  import MessageContent from './lib/MessageContent.svelte';
  import {getPersonaAsset, applyCompanionWindow, presenceStore} from './lib/presence';
  import type {ChatMessage, Conversation, FileNode, MemoryCategory, MemoryItem, ModelSetup, Persona, Project, Theme, ViewId} from './lib/types';
  import {categoryFromWire, categoryToWire, importanceStars, normalizeConversation, normalizeProject} from './lib/types';
  import {formatRuntimeError, runtime} from './lib/runtime';
  import {bindProactiveNotificationActions, showProactiveSystemNotification} from './lib/proactiveNotify';
  import SlashMenu from './lib/SlashMenu.svelte';
  import {routeUserMessage, shouldTransferToExecutor, taskTitleFromText} from '@pattern/core';

  const nav = [
    {id: 'chat', label: '对话', icon: MessageCircleMore},
    {id: 'project', label: '项目', icon: FolderGit2},
    {id: 'conversations', label: '管理', icon: MessagesSquare},
    {id: 'memory', label: '记忆', icon: Layers3},
    {id: 'patterns', label: '认识', icon: Sparkles},
    {id: 'goals', label: '目标', icon: Target},
    {id: 'proactive', label: '主动', icon: BellRing},
    {id: 'workflows', label: '技能', icon: Workflow},
    {id: 'mcp', label: '工具', icon: Wrench},
    {id: 'channels', label: '通道', icon: Send},
    {id: 'settings', label: '设置', icon: Settings},
  ] as const;

  const params = new URLSearchParams(location.search);
  const isQuick = params.get('window') === 'quick';
  const isReview = params.get('window') === 'review';
  const isCompanion = params.get('window') === 'companion';
  const isDemo = params.has('demo');

  // Presence layer: persona avatar shown in the titlebar when enabled.
  let presenceCfg = $state(presenceStore.config);
  const titleAvatar = $derived.by(() => {
    if (!persona || (!presenceCfg.enabled || presenceCfg.mode === 'off')) return undefined;
    return getPersonaAsset(persona.name, 'idle');
  });

  let activeView = $state<ViewId>('chat');
  let ready = $state(false);
  let persona = $state<Persona | null>(null);
  let messages = $state<ChatMessage[]>([]);
  let conversations = $state<Conversation[]>([]);
  let projects = $state<Project[]>([]);
  let activeConversationId = $state('');
  let activeProjectId = $state('');
  let draft = $state('');
  let replying = $state(false);
  let stream = $state<HTMLDivElement>();
  let query = $state('');
  let category = $state<'all' | MemoryCategory>('all');
  let theme = $state<Theme>('night');
  let toast = $state('');
  let runtimeConnected = $state(false);
  let memoryItems = $state<MemoryItem[]>([]);
  let editingMemory = $state(false);
  let memoryCount = $state(0);
  let proactiveCount = $state(0);
  let proactiveInbox = $state<Array<{id: string; body: string; type?: string; reason?: string; origin?: 'ai' | 'system'; state?: string; chainId?: string; ts?: number}>>([]);
  let proactivePreview = $state<{id: string; body: string; type?: string; reason?: string; origin?: 'ai' | 'system'; chainId?: string} | null>(null);
  let lastConsolidateAt = $state<number | null>(null);
  let memorySearchTimer: ReturnType<typeof setTimeout>;
  let taskDraft = $state<{title: string; detail: string; nonce: number} | null>(null);
  let sessionPlanCollapsed = $state(false);
  let sessionGoalCollapsed = $state(false);
  let sessionLoopCollapsed = $state(false);
  let sessionRemindCollapsed = $state(false);
  let attachmentInput = $state<HTMLInputElement>();
  let composerDragOver = $state(false);
  let agentState = $state<'idle' | 'thinking' | 'executing' | 'paused' | 'approval'>('idle');
  let activeSlot = $state<'companion' | 'executor'>('companion');
  // When enabled, desktop-action turns may spawn/internalize a sub-agent worker.
  // When disabled, primary agent still acts (tools/desktop) but does not spawn sub-agents.
  let allowSubAgents = $state(typeof localStorage === 'undefined' ? true : localStorage.getItem('pattern-allow-sub-agents') !== '0');
  type ComposerMode = 'goal' | 'plan' | null;
  type ApprovalPreset = 'all' | 'changes' | 'sensitive' | 'unrestricted';
  type SkillOption = {id: string; name: string; description: string};
  type ModelProfile = {id: string; name: string; provider: string; endpoint: string; model: string; models?: string[]; executorProvider?: string; executorEndpoint?: string; executorModel?: string; executorVision?: boolean};
  type ModelMetric = {model: string; provider: string; inputTokens: number; outputTokens: number; cachedTokens: number; requests: number; contextWindow?: number; lastRequest?: {inputTokens: number; outputTokens: number; cachedTokens: number; durationMs?: number; at: number}};
  const approvalOptions: Array<{id: ApprovalPreset; label: string; detail: string; autoApproveBelow: number; hardDenyAt: number}> = [
    {id: 'all', label: '全部需要审批', detail: '每一步都先询问', autoApproveBelow: 0, hardDenyAt: 4},
    {id: 'changes', label: '自动接收修改', detail: '常规修改直接执行', autoApproveBelow: 3, hardDenyAt: 4},
    {id: 'sensitive', label: '只审批敏感命令', detail: '外发、安装和破坏性操作确认', autoApproveBelow: 2, hardDenyAt: 3},
    {id: 'unrestricted', label: '完全放行', detail: '不弹审批，仍保留审计', autoApproveBelow: 4, hardDenyAt: 4},
  ];
  let composerMode = $state<ComposerMode>(null);
  let showModePicker = $state(false);
  let selectedSkillIds = $state<string[]>([]);
  let availableSkills = $state<SkillOption[]>([]);
  let showSkillPicker = $state(false);
  let approvalPreset = $state<ApprovalPreset>(typeof localStorage === 'undefined' ? 'sensitive' : (localStorage.getItem('pattern-approval-preset') as ApprovalPreset) || 'sensitive');
  let showApprovalPicker = $state(false);
  let modelProfiles = $state<ModelProfile[]>([]);
  let activeModelProfileId = $state('');
  let activeModel = $state('');
  let showModelPicker = $state(false);
  let modelSearch = $state('');
  let modelMetrics = $state<ModelMetric[]>([]);
  let showProjectDialog = $state(false);
  let projectNameDraft = $state('');
  let projectPathDraft = $state('');
  let fileNodes = $state<FileNode[]>([]);
  let fileLoading = $state(false);
  let fileError = $state('');
  let selectedFilePath = $state('');
  let filePreview = $state('');
  let streamingId = $state('');
  let lastUserText = $state('');
  let attachedPaths = $state<string[]>([]);
  let editingMemoryItem = $state<MemoryItem | null>(null);
  let memoryProposals = $state<Array<{id: string; text: string; category: string; importance: number; sourceConv?: string | null; reason?: string}>>([]);
  let foregroundTitle = $state('');
  let foregroundBusy = $state(false);
  let projectDiff = $state<{status: string; diff: string} | null>(null);
  let clock = $state(Date.now());
  let redefiningPersona = $state(false);
  let personaEditorMode = $state<'redefine' | 'new'>('redefine');
  let editingMessageId = $state('');

  const activeConversation = $derived(conversations.find((item) => item.id === activeConversationId) || null);
  const activeProject = $derived(projects.find((item) => item.id === activeProjectId) || null);
  const selectedSkills = $derived(availableSkills.filter((skill) => selectedSkillIds.includes(skill.id)));
  const approvalLabel = $derived(approvalOptions.find((item) => item.id === approvalPreset)?.label || '只审批敏感命令');
  const activeMetric = $derived(modelMetrics.find((item) => item.model === activeModel) || modelMetrics[0] || null);
  const activeContextRatio = $derived(activeMetric?.contextWindow ? Math.min(100, Math.round(((activeMetric.inputTokens + activeMetric.outputTokens) / activeMetric.contextWindow) * 100)) : 0);
  const activeModelProfile = $derived(modelProfiles.find((profile) => profile.id === activeModelProfileId) || null);
  const composerModeLabel = $derived(composerMode === 'goal' ? '目标' : composerMode === 'plan' ? '计划' : '常规');
  const quickModelEntries = $derived(modelProfiles.flatMap((profile) => {
    if (!profile.provider?.trim() || !profile.endpoint?.trim()) return [];
    const models = [...new Set([...(profile.models || []), profile.model].filter((item): item is string => !!item?.trim()))];
    return models.map((model) => ({profile, model}));
  }).filter((item) => `${item.profile.name} ${modelProviderLabel(item.profile)} ${item.model}`.toLowerCase().includes(modelSearch.trim().toLowerCase())));
  const showRecents = $derived(activeView === 'chat' || activeView === 'conversations');
  const homeGreeting = $derived.by(() => {
    const hour = new Date(clock).getHours();
    const salutation = hour < 5 ? '夜深了' : hour < 12 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : hour < 23 ? '晚上好' : '夜深了';
    const name = persona?.userName?.trim();
    return name ? `${salutation}，${name}` : salutation;
  });
  const homeContext = $derived.by(() => {
    const date = new Date(clock);
    const weekday = '日一二三四五六'[date.getDay()];
    const unread = proactiveInbox.filter((item) => item.state !== 'read' && item.state !== 'dismissed').length;
    const extra = unread ? ` · ${unread} 条主动消息待处理` : conversations.length ? ` · ${conversations.length} 个对话在本地` : '';
    return `${date.getMonth() + 1}月${date.getDate()}日 · 星期${weekday} · 全局对话${extra}`;
  });

  async function pushTrayState(state: typeof agentState) {
    if (!(window as any).__TAURI_INTERNALS__) return;
    try {
      const {invoke} = await import('@tauri-apps/api/core');
      await invoke('set_tray_state', {state});
    } catch {
      /* tray optional */
    }
  }

  function mapMemory(item: any): MemoryItem {
    const cat = categoryFromWire[item.category] || item.category || '事实';
    const importance = Number(item.importance ?? 0.5);
    const sourceConv = item.sourceConv || item.source_conv || null;
    return {
      id: item.id,
      category: cat,
      text: item.text,
      importance: importance > 1 ? importance / 3 : importance,
      expired: !!item.expired,
      accessCount: item.accessCount,
      sourceConv,
      meta: item.meta || (sourceConv ? `来源对话 · 访问 ${item.accessCount ?? 0}` : `访问 ${item.accessCount ?? 0}`),
    };
  }

  function persistConversations() {
    localStorage.setItem('pattern-conversations', JSON.stringify(conversations));
    persistWorkspaceState();
  }

  function persistProjects() {
    localStorage.setItem('pattern-projects', JSON.stringify(projects));
    persistWorkspaceState();
    void syncProjectsToSidecar();
  }

  async function syncProjectsToSidecar() {
    try {
      if (!(await runtime.connect())) return;
      await runtime.request({
        type: 'projects.sync',
        id: crypto.randomUUID(),
        projects: projects.map((item) => ({id: item.id, name: item.name, path: item.path})),
      } as any);
    } catch (error) {
      console.error('[pattern] projects.sync failed', error);
    }
  }

  function persistWorkspaceState() {
    if (!(window as any).__TAURI_INTERNALS__) return;
    void import('@tauri-apps/api/core')
      .then(({invoke}) => invoke('save_workspace_state', {conversations, projects}))
      .catch((error) => console.error('[pattern] workspace persistence failed', error));
  }

  function pushMessageEvent(
    messageId: string,
    kind: string,
    eventText: string,
    extra: Partial<import('./lib/types').ChatMessageEvent> = {},
    conversationId = activeConversationId,
  ) {
    const conversation = conversationId && conversationId !== activeConversationId
      ? conversations.find((item) => item.id === conversationId)
      : null;
    const messageList = conversation ? conversation.messages : messages;
    const target = messageList.find((message) => message.id === messageId);
    if (!target) return;
    const event = {
      id: extra.id || crypto.randomUUID(),
      kind,
      text: eventText,
      ts: extra.ts || Date.now(),
      status: extra.status,
      action: extra.action,
      tier: extra.tier,
      receipt: extra.receipt,
      taskId: extra.taskId,
      stepId: extra.stepId,
    };
    // Dedupe by stepId when present so task step updates replace instead of stacking forever.
    if (event.stepId) {
      const existing = (target.events || []).findIndex((item) => item.stepId === event.stepId);
      if (existing >= 0) {
        const next = [...(target.events || [])];
        next[existing] = {...next[existing], ...event};
        target.events = next;
        if (conversation) {
          conversation.messages = [...messageList];
          conversation.updatedAt = Date.now();
          conversations = [...conversations];
          persistConversations();
        } else messages = [...messages];
        return;
      }
    }
    // Also collapse identical trailing status lines.
    const last = target.events?.at(-1);
    if (last && !event.stepId && last.kind === event.kind && last.text === event.text && last.status === event.status) {
      last.ts = event.ts;
      if (conversation) {
        conversation.messages = [...messageList];
        conversation.updatedAt = Date.now();
        conversations = [...conversations];
        persistConversations();
      } else messages = [...messages];
      return;
    }
    target.events = [...(target.events || []), event];
    if (conversation) {
      conversation.messages = [...messageList];
      conversation.updatedAt = Date.now();
      conversations = [...conversations];
      persistConversations();
    } else messages = [...messages];
  }

  function settleMessageEvents(messageId: string, status: 'done' | 'failed' | 'skipped') {
    const target = messages.find((message) => message.id === messageId);
    if (!target?.events?.length) return;
    // Leave task-bound live steps alone — syncTaskTimeline owns those.
    target.events = target.events.map((event) => {
      if (event.taskId && (event.status === 'running' || event.status === 'pending' || event.status === 'awaiting_approval')) {
        return event;
      }
      if (event.status === 'running' || event.status === 'pending' || !event.status) {
        return {...event, status};
      }
      return event;
    });
    messages = [...messages];
  }

  function taskStepKind(action?: string): string {
    const a = String(action || '').toLowerCase();
    if (a === 'mcp') return 'mcp';
    if (['key', 'type', 'click', 'scroll', 'launch', 'focus', 'screenshot', 'foreground', 'uiainvoke', 'uiasetvalue', 'computer_use', 'wait', 'done', 'fail'].includes(a) || a.startsWith('uia')) return 'tool';
    return 'task';
  }

  function attachTaskCardToMessage(message: any, task: any) {
    message.taskCard = {
      taskId: task.id,
      title: task.title || message.taskCard?.title || '桌面执行',
      status: task.status || message.taskCard?.status || 'running',
      detail: task.detail || message.taskCard?.detail || '',
    };
  }

  function syncTaskTimeline(task: any) {
    const conversationId = task.conversationId || activeConversationId;
    const taskConversation = conversationId && conversationId !== activeConversationId
      ? conversations.find((item) => item.id === conversationId)
      : null;
    const messageList = taskConversation ? taskConversation.messages : messages;
    let target = [...messageList].reverse().find((m) => m.role === 'assistant' && m.taskCard?.taskId === task.id);
    // Fallback: latest assistant bubble linked by computer_use receipt/event (often no pre-bound taskCard).
    if (!target) {
      target = [...messageList].reverse().find((m) =>
        m.role === 'assistant' && (
          !m.taskCard ||
          m.taskCard.taskId === task.id ||
          (m.events || []).some((event: any) =>
            event.taskId === task.id ||
            String(event.action || '').includes('computer_use') ||
            String(event.receipt || '').includes(task.id),
          )
        ),
      );
    }
    if (!target) return;
    attachTaskCardToMessage(target, task);
    const steps = Array.isArray(task.steps) ? task.steps : [];
    for (const step of steps) {
      pushMessageEvent(target.id, taskStepKind(step.action), step.detail || step.action || '步骤', {
        id: step.id,
        stepId: step.id,
        taskId: task.id,
        action: step.action,
        status: step.status,
        tier: step.tier,
        receipt: step.receipt,
        ts: step.ts ? (step.ts < 10_000_000_000 ? step.ts * 1000 : step.ts) : Date.now(),
      }, conversationId);
    }
    // Task-level status pulse
    pushMessageEvent(target.id, 'task', `任务状态 · ${task.status}: ${task.title}`, {
      stepId: `task:${task.id}:status`,
      taskId: task.id,
      status: ['done', 'failed', 'cancelled'].includes(task.status)
        ? task.status === 'done'
          ? 'done'
          : task.status === 'failed'
            ? 'failed'
            : 'skipped'
        : task.status === 'awaiting_approval'
          ? 'awaiting_approval'
          : task.status === 'running'
            ? 'running'
            : 'pending',
      ts: Date.now(),
    }, conversationId);
    // Agent results if present
    for (const result of task.agentResults || []) {
      pushMessageEvent(target.id, 'agent', `${result.skillId || 'agent'}: ${(result.output || '').slice(0, 180)}`, {
        stepId: `task:${task.id}:agent:${result.skillId || 'agent'}`,
        status: result.status === 'failed' ? 'failed' : 'done',
        taskId: task.id,
        receipt: result.output,
        ts: result.ts || Date.now(),
      }, conversationId);
    }
    if (['done', 'failed', 'cancelled'].includes(task.status)) {
      const lastReceipt = [...steps].reverse().find((step: any) => step.receipt)?.receipt;
      target.text = task.status === 'done'
        ? `已完成：${task.title}${lastReceipt ? `\n\n${lastReceipt}` : ''}`
        : task.status === 'failed'
          ? `执行失败：${task.title}\n\n${task.error || '没有可用的错误详情'}`
          : `已终止：${task.title}`;
    }
    if (taskConversation) {
      taskConversation.messages = [...messageList];
      taskConversation.updatedAt = Date.now();
      conversations = [...conversations];
      persistConversations();
    } else {
      messages = [...messages];
      void persistSession();
    }
  }

  async function expandDirectory(node: FileNode) {
    if (node.kind !== 'directory') return;
    let children: FileNode[] = [];
    if ((window as any).__TAURI_INTERNALS__) {
      try {
        const {invoke} = await import('@tauri-apps/api/core');
        children = await invoke<FileNode[]>('list_directory', {path: node.path, depth: 1});
      } catch (error) {
        fileError = String(error);
        return;
      }
    } else {
      fileError = '浏览器预览无法展开本地目录';
      return;
    }
    const patch = (items: FileNode[]): FileNode[] =>
      items.map((item) => {
        if (item.path === node.path) return {...item, children};
        if (item.children?.length) return {...item, children: patch(item.children)};
        return item;
      });
    fileNodes = patch(fileNodes);
  }

  async function openProjectFile(node: FileNode) {
    selectedFilePath = node.path;
    if ((window as any).__TAURI_INTERNALS__) {
      try {
        const {invoke} = await import('@tauri-apps/api/core');
        filePreview = await invoke<string>('read_text_file', {path: node.path, maxBytes: 120000});
      } catch (error) {
        filePreview = String(error);
      }
    } else {
      filePreview = '浏览器预览无法读取本地文件内容。';
    }
  }

  async function attachProjectPath(node: FileNode) {
    if (node.kind !== 'file') return;
    if (!(window as any).__TAURI_INTERNALS__) {
      notify('浏览器预览无法读取该文件');
      return;
    }
    try {
      const {invoke} = await import('@tauri-apps/api/core');
      const content = await invoke<string>('read_text_file', {path: node.path, maxBytes: 64_000});
      if (!attachedPaths.includes(node.path)) attachedPaths = [...attachedPaths, node.path];
      draft = `${draft ? `${draft}\n\n` : ''}[已附加项目文件：${node.name}]\n${content}`;
      notify(`已读取并附加 ${node.name}`);
    } catch (error) {
      notify(`附加失败：${error}`);
    }
  }

  async function inspectProjectDiff() {
    const root = activeProject?.path;
    if (!root) {
      notify('请先打开项目');
      return;
    }
    if (!(await runtime.connect())) {
      notify('运行时未连接，无法读取 Diff');
      return;
    }
    try {
      const result = await runtime.request<any>({type: 'workspace.diff', id: crypto.randomUUID(), root});
      if (result.type === 'workspace.diff.result') {
        projectDiff = {status: result.status, diff: result.diff};
        notify('已刷新项目 Diff');
      }
    } catch (error) {
      notify(`读取 Diff 失败：${error}`);
    }
  }

  async function createProjectWorktree() {
    const root = activeProject?.path;
    if (!root) {
      notify('请先打开项目');
      return;
    }
    if (!(await runtime.connect())) {
      notify('运行时未连接，无法创建 Worktree');
      return;
    }
    try {
      const result = await runtime.request<any>({
        type: 'workspace.worktree.create',
        id: crypto.randomUUID(),
        root,
        name: `pattern-${Date.now().toString(36)}`,
      });
      if (result.type === 'workspace.worktree.created') {
        notify(`Worktree 已创建：${result.path}`);
        draft = `${draft ? `${draft}
` : ''}[worktree] ${result.path} (branch ${result.branch})`;
      }
    } catch (error) {
      notify(`创建 Worktree 失败：${error}`);
    }
  }

  async function openTaskReview(taskId: string) {
    if ((window as any).__TAURI_INTERNALS__) {
      const {invoke} = await import('@tauri-apps/api/core');
      try {
        await invoke('show_review', {taskId});
        return;
      } catch {
        await invoke('show_review');
      }
    } else {
      notify(`审查任务 ${taskId.slice(0, 8)}…（桌面端可打开审查窗）`);
    }
  }

  async function pickProjectFolder() {
    if ((window as any).__TAURI_INTERNALS__) {
      try {
        const {invoke} = await import('@tauri-apps/api/core');
        const selected = await invoke<string | null>('pick_directory');
        if (selected) {
          projectPathDraft = selected;
          if (!projectNameDraft.trim()) {
            projectNameDraft = selected.split(/[\/]/).filter(Boolean).at(-1) || '';
          }
        }
        return;
      } catch (error) {
        notify(`选择文件夹失败：${error}`);
      }
    }
    const fallback = window.prompt('请输入项目绝对路径', projectPathDraft || '');
    if (fallback) projectPathDraft = fallback;
  }


  async function stopGeneration() {
    const id = streamingId;
    if (id) runtime.abortChat(id);
    replying = false;
    agentState = 'idle';
    if (id) {
      const target = messages.find((message) => message.id === id);
      if (target) {
        target.streaming = false;
        if (!target.text?.trim() && !target.error) target.text = '（已停止）';
      }
      settleMessageEvents(id, 'skipped');
      pushMessageEvent(id, 'status', '已停止生成', {status: 'skipped', stepId: `chat:${id}:status`});
    }
    streamingId = '';
    attachedPaths = [];
    await persistSession();
  }

  async function retryAssistant(messageId: string) {
    const idx = messages.findIndex((message) => message.id === messageId);
    if (idx < 0) return;
    let userText = '';
    let userIndex = -1;
    for (let i = idx - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        userText = messages[i].text;
        userIndex = i;
        break;
      }
    }
    if (!userText || userIndex < 0) return;
    messages = messages.slice(0, userIndex);
    draft = userText;
    await sendMessage();
  }

  async function copyMessage(message: ChatMessage) {
    try {
      await navigator.clipboard.writeText(message.text);
      notify('已复制消息');
    } catch {
      notify('复制失败，请手动选择文本');
    }
  }

  function editUserMessage(message: ChatMessage) {
    if (replying || message.role !== 'user') return;
    editingMessageId = message.id;
    draft = message.text;
    notify('修改后发送，将从这条消息继续对话');
  }

  function cancelMessageEdit() {
    editingMessageId = '';
    draft = '';
  }

  function isUserBusy() {
    if (replying || agentState === 'thinking' || agentState === 'executing' || agentState === 'approval') return true;
    if (document.visibilityState === 'visible' && activeView === 'project') return true;
    if (foregroundBusy) return true;
    return false;
  }

  async function refreshForeground() {
    try {
      if ((window as any).__TAURI_INTERNALS__) {
        const {invoke} = await import('@tauri-apps/api/core');
        const info = await invoke<{title?: string}>('get_foreground_window');
        foregroundTitle = info?.title || '';
      } else if (await runtime.connect()) {
        const res = await runtime.request<any>({type: 'runtime.foreground', id: crypto.randomUUID()});
        if (res.type === 'runtime.foreground.result') {
          foregroundTitle = res.title || '';
          foregroundBusy = !!res.busyHint;
          return;
        }
      }
      foregroundBusy = /Visual Studio Code|Code -|IntelliJ|PyCharm|terminal|Windows Terminal|cmd\.exe|powershell|Chrome|Edge|Firefox|Slack|Zoom|会议|Excel|Word|PowerPoint/i.test(foregroundTitle);
    } catch {
      /* optional */
    }
  }

  async function refreshMemoryProposals() {
    if (!(await runtime.connect())) return;
    const res = await runtime.request<any>({type: 'memory.propose.list', id: crypto.randomUUID()});
    if (res.type === 'memory.propose.list.result') memoryProposals = res.items || [];
  }

  async function acceptMemoryProposal(id: string) {
    if (!(await runtime.connect())) {
      notify('运行时未连接');
      return;
    }
    const res = await runtime.request<any>({type: 'memory.propose.accept', id: crypto.randomUUID(), proposalId: id});
    if (res.type === 'memory.propose.accept.result' && res.ok) {
      memoryProposals = memoryProposals.filter((item) => item.id !== id);
      await refreshMemories();
      notify('记忆已确认保存');
    } else {
      notify('确认失败');
    }
  }

  async function rejectMemoryProposal(id: string) {
    if (!(await runtime.connect())) {
      notify('运行时未连接');
      return;
    }
    await runtime.request<any>({type: 'memory.propose.reject', id: crypto.randomUUID(), proposalId: id});
    memoryProposals = memoryProposals.filter((item) => item.id !== id);
    notify('已忽略该候选记忆');
  }

  function openMemorySource(memory: MemoryItem) {
    const source = memory.sourceConv?.trim();
    if (!source) {
      notify('这条记忆没有可跳转的来源对话');
      return;
    }
    if (source.startsWith('filewatch:')) {
      notify('来源是文件监视事件，不是聊天对话');
      return;
    }
    const conversation = conversations.find((item) => item.id === source);
    if (!conversation) {
      notify('来源对话已不在本地列表中');
      return;
    }
    void openConversation(conversation.id);
    notify('已跳转到来源对话');
  }

  function createConversation(scope: 'global' | 'project', projectId?: string): Conversation {
    return {
      id: crypto.randomUUID(),
      title: scope === 'project' ? '项目对话' : '新对话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      scope,
      projectId: scope === 'project' ? projectId : undefined,
    };
  }

  function conversationTitleFromText(text: string, fallback = '新对话') {
    const value = text.replace(/\s+/g, ' ').trim();
    return (value || fallback).slice(0, 36);
  }

  function ingestProactiveImpulse(item: {id: string; body: string; type?: string; reason?: string; origin?: 'ai' | 'system'; state?: string; chainId?: string; ts?: number}) {
    const exists = proactiveInbox.some((entry) => entry.id === item.id);
    proactiveInbox = [item, ...proactiveInbox.filter((entry) => entry.id !== item.id)].slice(0, 100);
    if (!exists) proactiveCount += 1;
    // Prefer OS notification (no quick-window popup). Toast click / action opens main chat to reply.
    void showProactiveSystemNotification(item).then((ok) => {
      if (!ok) notify(`${item.origin === 'system' ? '系统提醒' : 'AI 主动消息'}已进入收件箱`);
    });
  }

  /** Reply to a proactive impulse from a system-notification action (or after opening it). */
  async function replyToProactiveFromNotification(
    item: {id: string; body: string; type?: string; reason?: string; origin?: 'ai' | 'system'; chainId?: string},
    text: string,
  ) {
    const value = text.trim();
    if (!value) {
      await openProactiveInboxItem(item);
      return;
    }
    await openProactiveInboxItem(item);
    await tick();
    draft = value;
    await tick();
    await sendMessage();
  }

  function proactiveTitle(item: {body: string; type?: string; reason?: string; origin?: 'ai' | 'system'}) {
    return conversationTitleFromText(item.reason || item.type || item.body, item.origin === 'system' ? '提醒' : '主动消息');
  }

  async function markProactiveState(itemId: string, state: 'read' | 'dismissed' | 'replied') {
    if (state === 'dismissed') {
      proactiveInbox = proactiveInbox.filter((entry) => entry.id !== itemId);
      if (proactivePreview?.id === itemId) proactivePreview = null;
    } else {
      proactiveInbox = proactiveInbox.map((entry) => entry.id === itemId ? {...entry, state} : entry);
    }
    if (await runtime.connect()) {
      void runtime.request({type: 'proactive.inbox.mark', id: crypto.randomUUID(), itemId, state});
    }
  }

  async function dismissProactiveInboxItem(item: {id: string; chainId?: string; origin?: 'ai' | 'system'}, options: {quiet?: boolean} = {}) {
    if (item.origin === 'ai' && item.chainId && await runtime.connect()) {
      void runtime.request({type: 'proactive.chain.cancel', id: crypto.randomUUID(), chainId: item.chainId});
    }
    await markProactiveState(item.id, 'dismissed');
    const orphan = conversations.find((conversation) =>
      conversation.messages.length === 1 && conversation.messages[0]?.id === item.id,
    );
    if (orphan) {
      conversations = conversations.filter((conversation) => conversation.id !== orphan.id);
      if (activeConversationId === orphan.id) {
        activeConversationId = '';
        messages = [];
      }
      persistConversations();
    }
    if (!options.quiet) notify('已忽略这条主动消息');
  }

  async function dismissAllProactiveInbox() {
    const items = proactiveInbox.filter((item) => item.state !== 'dismissed' && item.state !== 'replied');
    if (!items.length) {
      notify('收件箱已经是空的');
      return;
    }
    for (const item of items) {
      await dismissProactiveInboxItem(item, {quiet: true});
    }
    if (proactivePreview && items.some((item) => item.id === proactivePreview?.id)) {
      proactivePreview = null;
    }
    notify(items.length === 1 ? '已忽略 1 条主动消息' : `已全部忽略 ${items.length} 条主动消息`);
  }

  async function openProactiveInboxItem(item: {id: string; body: string; type?: string; reason?: string; origin?: 'ai' | 'system'; chainId?: string}) {
    // Only reopen a real conversation if the user already replied there.
    const existing = conversations.find((conversation) =>
      conversation.messages.some((message) => message.id === item.id) &&
      conversation.messages.some((message) => message.role === 'user'),
    );
    if (existing) {
      proactivePreview = null;
      await openConversation(existing.id);
      await markProactiveState(item.id, 'read');
      return;
    }

    const mode = (localStorage.getItem('pattern-proactive-mode') || 'new_chat') as 'new_chat' | 'inline';
    const proactiveMessage = {
      id: item.id || crypto.randomUUID(),
      role: 'assistant' as const,
      text: item.body,
      time: new Date().toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'}),
      proactive: item.type || '主动',
    };

    // 轻插：插入当前/最近全局对话，不新建会话。
    if (mode === 'inline') {
      let conversation = activeConversationId
        ? conversations.find((entry) => entry.id === activeConversationId && !entry.archived)
        : undefined;
      if (!conversation) conversation = conversations.find((entry) => !entry.archived && entry.scope === 'global');
      if (conversation) {
        if (replying) await stopGeneration();
        if (!conversation.messages.some((message) => message.id === item.id)) {
          conversation.messages = [...conversation.messages, proactiveMessage];
        }
        conversation.updatedAt = Date.now();
        if (!conversation.title || conversation.title === '新对话') conversation.title = proactiveTitle(item);
        conversations = [...conversations];
        proactivePreview = null;
        activeConversationId = conversation.id;
        messages = [...conversation.messages];
        activeView = 'chat';
        persistConversations();
        await markProactiveState(item.id, 'read');
        await scrollConversationToEnd();
        return;
      }
    }

    // 新对话（默认）：懒预览，回复后才真正创建对话。
    if (replying) await stopGeneration();
    proactivePreview = item;
    activeConversationId = '';
    messages = [proactiveMessage];
    activeView = 'chat';
    await markProactiveState(item.id, 'read');
    await scrollConversationToEnd();
  }

  async function refreshMemories() {
    if (!(await runtime.connect())) {
      // Keep current list empty/offline — never inject prefabricated memories.
      return;
    }
    const res = await runtime.request<any>({
      type: 'memory.list',
      id: crypto.randomUUID(),
      query: query || null,
      category: category === 'all' ? null : categoryToWire[category] || category,
    });
    if (res.type === 'memory.list.result') memoryItems = res.items.map(mapMemory);
    const stats = await runtime.request<any>({type: 'memory.stats', id: crypto.randomUUID()});
    if (stats.type === 'memory.stats.result') {
      memoryCount = stats.count;
      lastConsolidateAt = stats.lastConsolidateAt;
    }
    const proactive = await runtime.request<any>({type: 'proactive.list', id: crypto.randomUUID(), limit: 100});
    if (proactive.type === 'proactive.list.result') {
      const key = new Date().toDateString();
      proactiveCount = proactive.items.filter((item: any) => new Date(item.ts * 1000).toDateString() === key && item.delivered).length;
      proactiveInbox = proactive.items.filter((item: any) => item.state !== 'dismissed').slice(0, 100);
    }
  }

  async function loadDirectoryTree(path: string) {
    fileLoading = true;
    fileError = '';
    fileNodes = [];
    if (!path.trim()) {
      fileLoading = false;
      fileError = '请先为项目设置本地路径';
      return;
    }
    if (!(window as any).__TAURI_INTERNALS__) {
      fileNodes = [];
      fileError = '浏览器预览无法读取本地文件夹；请使用桌面端打开项目。';
      fileLoading = false;
      return;
    }
    try {
      const {invoke} = await import('@tauri-apps/api/core');
      fileNodes = await invoke<FileNode[]>('list_directory', {path, depth: 1});
    } catch (error) {
      fileError = String(error);
      fileNodes = [];
    } finally {
      fileLoading = false;
    }
  }

  onMount(async () => {
    try {
      const channel = new BroadcastChannel('pattern-conversations');
      channel.onmessage = () => {
        try {
          const stored = JSON.parse(localStorage.getItem('pattern-conversations') || '[]') as Conversation[];
          conversations = stored.map((item) => normalizeConversation(item));
          if (!replying) {
            const current = conversations.find((item) => item.id === activeConversationId);
            if (current) messages = [...current.messages];
          }
        } catch { /* malformed local state is ignored */ }
      };
      (window as any).__patternConversationChannel?.close?.();
      (window as any).__patternConversationChannel = channel;
    } catch { /* BroadcastChannel is optional */ }
    const saved = localStorage.getItem('pattern-persona');
    try {
      const stored = JSON.parse(localStorage.getItem('pattern-conversations') || '[]') as Conversation[];
      if (Array.isArray(stored) && stored.length) {
        // Migrate empty conversations created by the pre-lazy-create startup path.
        const normalized = stored.map((item) => normalizeConversation(item));
        conversations = normalized.filter((item) => item.messages.some((message) => message.text.trim()));
        if (conversations.length !== normalized.length) persistConversations();
      }
    } catch { /* start with a clean local conversation list */ }
    try {
      const storedProjects = JSON.parse(localStorage.getItem('pattern-projects') || '[]') as Project[];
      if (Array.isArray(storedProjects) && storedProjects.length) {
        projects = storedProjects.map((item) => normalizeProject(item));
        activeProjectId = projects[0]?.id || '';
      }
    } catch { /* start with no projects */ }
    void syncProjectsToSidecar();

    if ((window as any).__TAURI_INTERNALS__) {
      void bindProactiveNotificationActions({
        onOpen: (item) => openProactiveInboxItem(item),
        onReply: (item, text) => replyToProactiveFromNotification(item, text),
        onDismiss: (item) => dismissProactiveInboxItem(item),
      });
      try {
        const {invoke} = await import('@tauri-apps/api/core');
        persona = await invoke<Persona | null>('load_persona');
        const modelConfig = await invoke<(ModelSetup & {profileId?: string; connections?: Array<{id: string; name?: string; provider: string; endpoint: string; models?: string[]}>}) | null>('load_model_config');
        try {
          const storedProfiles = JSON.parse(localStorage.getItem('pattern-model-profiles') || '{}');
          if (Array.isArray(storedProfiles.profiles)) modelProfiles = storedProfiles.profiles.map((profile: ModelProfile) => ({...profile, provider: modelProviderLabel(profile), models: [...new Set([...(profile.models || []), profile.model].filter(Boolean))]}));
          if (typeof storedProfiles.activeProfileId === 'string') activeModelProfileId = storedProfiles.activeProfileId;
        } catch { /* optional profile directory */ }
        if (modelConfig) {
          activeModel = modelConfig.model;
          activeModelProfileId = modelConfig.profileId || activeModelProfileId || 'default';
          if (!modelProfiles.length) {
            const connections = (modelConfig.connections || []).filter((item) => item.provider?.trim() && item.endpoint?.trim());
            modelProfiles = connections.length
              ? connections.map((connection) => {
                  const models = [...new Set((connection.models || []).concat(connection.id === activeModelProfileId ? [modelConfig.model] : []).filter(Boolean))];
                  return {id: connection.id, name: connection.name || `${modelProviderLabel(connection)} · ${models[0] || '模型服务'}`, provider: modelProviderLabel(connection), endpoint: connection.endpoint, model: connection.id === activeModelProfileId ? modelConfig.model : models[0] || '', models};
                })
              : [{id: activeModelProfileId, name: `${modelProviderLabel(modelConfig)} · ${modelConfig.model}`, provider: modelProviderLabel(modelConfig), endpoint: modelConfig.endpoint, model: modelConfig.model, models: [modelConfig.model]}];
          }
        }
        const workspaceState = await invoke<{conversations?: Conversation[]; projects?: Project[]} | null>('load_workspace_state');
        if (workspaceState?.conversations?.length) {
          conversations = workspaceState.conversations.map((item) => normalizeConversation(item));
          localStorage.setItem('pattern-conversations', JSON.stringify(conversations));
        }
        if (workspaceState?.projects?.length) {
          projects = workspaceState.projects.map((item) => normalizeProject(item));
          activeProjectId = projects[0]?.id || '';
          localStorage.setItem('pattern-projects', JSON.stringify(projects));
        }
        const session = await invoke<ChatMessage[] | null>('load_session');
        if (session?.length && !conversations.length) {
          const conversation = createConversation('global');
          conversation.messages = session;
          conversation.updatedAt = Date.now();
          const firstUser = session.find((item) => item.role === 'user')?.text.trim();
          if (firstUser) conversation.title = firstUser.replace(/\s+/g, ' ').slice(0, 36);
          conversations = [conversation];
        }
      } catch (error) {
        console.error(error);
      }
      runtimeConnected = await runtime.connect();
      void refreshModelStatus();
      runtime.onStatus((connected) => {
        runtimeConnected = connected;
        if (connected) void refreshModelStatus();
      });
      runtime.on((message) => {
        if (message.type === 'memory.changed') void refreshMemories();
        if (message.type === 'memory.proposed') memoryProposals = message.items || [];
        if (message.type === 'skill.updated' && Array.isArray(message.skills)) availableSkills = message.skills;
        if (message.type === 'model.metrics' && Array.isArray(message.metrics)) modelMetrics = message.metrics;
        if (message.type === 'runtime.agent_state') agentState = message.state;
        if (message.type === 'task.updated') {
          if (message.task.status === 'running') agentState = 'executing';
          else if (message.task.status === 'paused') agentState = 'paused';
          else if (message.task.status === 'awaiting_approval') agentState = 'approval';
          else if (['done', 'failed', 'cancelled'].includes(message.task.status)) agentState = 'idle';
          syncTaskTimeline(message.task);
        }
        if (message.type === 'task.approval_required') {
          const last = [...messages].reverse().find((m) => m.role === 'assistant' && (!m.taskCard || m.taskCard.taskId === message.taskId));
          if (last) {
            pushMessageEvent(last.id, 'task', message.step?.detail || '需要审批', {
              taskId: message.taskId,
              stepId: message.step?.id,
              action: message.step?.action || 'approval',
              status: 'awaiting_approval',
              tier: message.step?.tier,
              ts: Date.now(),
            });
            void persistSession();
          }
        }
        if (message.type === 'proactive.impulse') {
          // System notification only — do not open the quick window for proactive messages.
          ingestProactiveImpulse(message.item);
        }
        if (message.type === 'proactive.inbox.updated') {
          proactiveInbox = [message.item, ...proactiveInbox.filter((item) => item.id !== message.item.id)].slice(0, 100);
        }
      });
      await refreshMemories();
    } else {
      runtimeConnected = await runtime.connect();
      void refreshModelStatus();
      runtime.onStatus((connected) => {
        runtimeConnected = connected;
        if (connected) void refreshModelStatus();
      });
      runtime.on((message) => {
        if (message.type === 'proactive.impulse') ingestProactiveImpulse(message.item);
        if (message.type === 'proactive.inbox.updated') proactiveInbox = [message.item, ...proactiveInbox.filter((item) => item.id !== message.item.id)].slice(0, 100);
      });
      // No prefabricated demo memories.
    }

    if (conversations.length) {
      const preferred = conversations.find((item) => !item.archived && item.scope === 'global')
        || conversations.find((item) => !item.archived)
        || conversations[0];
      activeConversationId = preferred.id;
      messages = [...preferred.messages];
      if (preferred.scope === 'project' && preferred.projectId) {
        activeProjectId = preferred.projectId;
        activeView = 'project';
      }
      void scrollConversationToEnd();
    }

    if (!persona && saved) persona = JSON.parse(saved);
    else if (!persona && isDemo)
      persona = {name: 'Pattern', userName: '你', description: '说话直接，但知道分寸。', proactive: 'free'};
    const storedTheme = localStorage.getItem('pattern-theme') as Theme | null;
    theme = storedTheme && ['night', 'day', 'ocean', 'forest', 'paper'].includes(storedTheme) ? storedTheme : 'night';
    document.documentElement.dataset.theme = theme;
    if (activeProject) void loadDirectoryTree(activeProject.path);
    if (isDemo) {
      (window as any).__patternTest = {
        ingestProactive: (item: {id: string; body: string; type?: string; reason?: string}) => ingestProactiveImpulse(item),
      };
    }
    ready = true;
    void refreshForeground();
    void refreshMemoryProposals();
    // Presence layer: restore the desktop companion window when pet mode is on.
    // Main window only — never runs in quick/review/companion windows.
    if (!isQuick && !isReview && !isCompanion && (window as any).__TAURI_INTERNALS__) {
      void presenceStore.refreshFromRuntime().then(() => {
        presenceCfg = presenceStore.config;
        void applyCompanionWindow(presenceStore.config);
      });
      presenceStore.subscribe(() => {
        presenceCfg = presenceStore.config;
        void applyCompanionWindow(presenceStore.config);
      });
    }
    (window as any).__patternClockTimer && clearInterval((window as any).__patternClockTimer);
    (window as any).__patternClockTimer = setInterval(() => { clock = Date.now(); }, 60_000);
    const fgTimer = setInterval(() => { void refreshForeground(); }, 4000);
    // Store on window so we can clear if hot-reloaded; onMount async cannot return cleanup.
    (window as any).__patternFgTimer && clearInterval((window as any).__patternFgTimer);
    (window as any).__patternFgTimer = fgTimer;
  });

  $effect(() => {
    void pushTrayState(agentState);
  });

  $effect(() => {
    const search = query;
    const filter = category;
    if (ready && (window as any).__TAURI_INTERNALS__) {
      clearTimeout(memorySearchTimer);
      memorySearchTimer = setTimeout(() => {
        void refreshMemories();
      }, 180);
      void search;
      void filter;
    }
  });

  async function savePersona(value: Persona, model: ModelSetup) {
    const isRedefinition = redefiningPersona;
    if ((window as any).__TAURI_INTERNALS__) {
      const {invoke} = await import('@tauri-apps/api/core');
      await invoke('save_persona', {persona: value});
      if (!isRedefinition) await invoke('save_model_config', {
          config: {provider: model.provider, endpoint: model.endpoint, model: model.model},
          apiKey: model.apiKey || null,
        });
      runtimeConnected = await runtime.connect();
    }
    persona = value;
    localStorage.setItem('pattern-persona', JSON.stringify(value));
    if (isRedefinition) redefiningPersona = false;
    notify(`${value.name} 已启用`);
  }

  function setTheme(value: Theme) {
    theme = value;
    document.documentElement.dataset.theme = value;
    localStorage.setItem('pattern-theme', value);
  }

  function notify(text: string) {
    toast = text;
    setTimeout(() => {
      if (toast === text) toast = '';
    }, 2200);
  }

  function setAllowSubAgents(next: boolean) {
    allowSubAgents = next;
    try {
      localStorage.setItem('pattern-allow-sub-agents', next ? '1' : '0');
    } catch {
      /* ignore */
    }
    notify(next ? '已启用子 Agent：主 Agent 可派生子代理处理复杂工作' : '已关闭子 Agent：主 Agent 自己调用工具并执行');
  }

  function setComposerMode(next: ComposerMode) {
    composerMode = composerMode === next ? null : next;
    showModePicker = false;
    if (composerMode) showSkillPicker = false;
  }

  function toggleModePicker() {
    showModePicker = !showModePicker;
    showSkillPicker = false;
    showApprovalPicker = false;
    showModelPicker = false;
  }

  function normalizeComposerSlash() {
    const match = draft.match(/^\/(goal|plan|skill)\b\s*/i);
    if (!match) return;
    const command = match[1].toLowerCase();
    draft = draft.slice(match[0].length);
    if (command === 'skill') void toggleSkillPicker(true);
    else setComposerMode(command as Exclude<ComposerMode, null>);
  }

  async function toggleSkillPicker(forceOpen = false) {
    showSkillPicker = forceOpen || !showSkillPicker;
    showApprovalPicker = false;
    if (!showSkillPicker || availableSkills.length || !(await runtime.connect())) return;
    try {
      const result = await runtime.request<any>({type: 'skill.list', id: crypto.randomUUID()});
      if (result.type === 'skill.list.result') availableSkills = result.skills || [];
    } catch (error) {
      notify(`读取技能失败：${formatRuntimeError(error)}`);
    }
  }

  function toggleSkill(id: string) {
    selectedSkillIds = selectedSkillIds.includes(id)
      ? selectedSkillIds.filter((item) => item !== id)
      : [...selectedSkillIds, id];
  }

  function buildComposerMessage(value: string) {
    const skillMentions = selectedSkills.map((skill) => `@skill:${skill.id}`).join(' ');
    const body = [skillMentions, value].filter(Boolean).join(' ').trim();
    if (composerMode === 'goal') return `/goal ${body}`;
    if (composerMode === 'plan') return `/plan ${body}`;
    return body;
  }

  async function setApprovalPreset(next: ApprovalPreset) {
    const option = approvalOptions.find((item) => item.id === next);
    if (!option) return;
    approvalPreset = next;
    showApprovalPicker = false;
    try {
      localStorage.setItem('pattern-approval-preset', next);
      if (await runtime.connect()) {
        await runtime.request<any>({
          type: 'security.policy.set',
          id: crypto.randomUUID(),
          policy: {autoApproveBelow: option.autoApproveBelow, hardDenyAt: option.hardDenyAt},
        } as any);
      }
      notify(`审批策略：${option.label}`);
    } catch (error) {
      notify(`保存审批策略失败：${formatRuntimeError(error)}`);
    }
  }

  function modelChoicesForProvider(provider: string, current = '') {
    const value = provider.toLowerCase();
    const presets = value.includes('anthropic')
      ? ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5']
      : value.includes('deepseek')
        ? ['deepseek-v4-pro', 'deepseek-v4-flash']
        : value.includes('qwen') || value.includes('百炼')
          ? ['qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-flash']
          : value.includes('智谱') || value.includes('zhipu')
            ? ['glm-5.1', 'glm-5v-turbo', 'glm-4.7']
            : ['gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'];
    return [...new Set([current, ...presets].filter(Boolean))];
  }

  function modelProviderLabel(profile: Pick<ModelProfile, 'provider' | 'endpoint'>) {
    const endpoint = profile.endpoint.toLowerCase();
    if (['OpenAI Compatible', 'OpenAI'].includes(profile.provider)) {
      if (endpoint.includes('deepseek')) return 'DeepSeek';
      if (endpoint.includes('anthropic')) return 'Anthropic Compatible';
      if (endpoint.includes('openrouter')) return 'OpenRouter';
      if (endpoint.includes('dashscope') || endpoint.includes('aliyuncs') || endpoint.includes('bailian')) return '阿里云百炼 / Qwen';
      if (endpoint.includes('bigmodel') || endpoint.includes('zhipu')) return '智谱 AI';
    }
    return profile.provider;
  }

  function formatTokenCount(value?: number) {
    const amount = Number(value || 0);
    if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    if (amount >= 1_000) return `${(amount / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
    return amount.toLocaleString('en-US');
  }

  async function refreshModelStatus() {
    if (!(await runtime.connect())) return;
    try {
      const result = await runtime.request<any>({type: 'model.metrics.get', id: crypto.randomUUID()});
      if (result.type === 'model.metrics') modelMetrics = result.metrics || [];
    } catch {
      /* The status indicator remains quiet while the runtime is reconnecting. */
    }
  }

  async function switchQuickModel(profile: ModelProfile, model: string) {
    activeModelProfileId = profile.id;
    activeModel = model;
    showModelPicker = false;
    const nextProfiles = modelProfiles.map((item) => item.id === profile.id ? {...item, model, models: [...new Set([...(item.models || []), model])]} : item);
    modelProfiles = nextProfiles;
    localStorage.setItem('pattern-model-profiles', JSON.stringify({activeProfileId: profile.id, profiles: nextProfiles}));
    if (!(window as any).__TAURI_INTERNALS__) {
      notify(`已切换模型：${model}`);
      return;
    }
    try {
      const {invoke} = await import('@tauri-apps/api/core');
      await invoke('save_model_config', {
        config: {
          provider: modelProviderLabel(profile),
          endpoint: profile.endpoint,
          model,
          profileId: profile.id,
          connections: nextProfiles.map((item) => ({id: item.id, name: item.name, provider: modelProviderLabel(item), endpoint: item.endpoint, models: [...new Set([...(item.models || []), item.model].filter(Boolean))], enabled: true})),
          agentProvider: modelProviderLabel(profile),
          agentEndpoint: profile.endpoint,
          agentModel: model,
          executorProvider: profile.executorProvider || modelProviderLabel(profile),
          executorEndpoint: profile.executorEndpoint || profile.endpoint,
          executorModel: profile.executorModel || '',
          executorVision: profile.executorVision !== false,
        },
        apiKey: null,
        executorApiKey: null,
        agentApiKey: null,
      });
      await refreshModelStatus();
      notify(`已切换到 ${profile.name} · ${model}`);
    } catch (error) {
      notify(`切换模型失败：${formatRuntimeError(error)}`);
    }
  }

  function scrollToBottom(behavior: ScrollBehavior = 'smooth') {
    const el = stream;
    if (!el) return;
    const top = el.scrollHeight;
    if (behavior === 'smooth') el.scrollTo({top, behavior: 'smooth'});
    else el.scrollTop = top;
    // Fallback when the outer view is still the scroller (legacy layout / intermediate paint).
    const parent = el.parentElement;
    if (parent && parent.scrollHeight > parent.clientHeight + 8) {
      if (behavior === 'smooth') parent.scrollTo({top: parent.scrollHeight, behavior: 'smooth'});
      else parent.scrollTop = parent.scrollHeight;
    }
  }

  async function scrollConversationToEnd() {
    // Wait for messages + the active chat-stream bind:this to settle after view/conversation switches.
    await tick();
    scrollToBottom('auto');
    requestAnimationFrame(() => {
      scrollToBottom('auto');
      requestAnimationFrame(() => scrollToBottom('auto'));
    });
  }

  async function persistSession() {
    const now = Date.now();
    const current = conversations.find((item) => item.id === activeConversationId);
    if (current) {
      current.messages = [...messages];
      current.updatedAt = now;
      const firstUser = messages.find((item) => item.role === 'user')?.text.trim();
      if (firstUser) current.title = firstUser.replace(/\s+/g, ' ').slice(0, 36);
      conversations = [...conversations];
      persistConversations();
    }
    if (current?.scope === 'project' && current.projectId) {
      const project = projects.find((item) => item.id === current.projectId);
      if (project) {
        project.updatedAt = now;
        projects = [...projects];
        persistProjects();
      }
    }
    if ((window as any).__TAURI_INTERNALS__) {
      const {invoke} = await import('@tauri-apps/api/core');
      await invoke('save_session', {messages});
    }
  }

  async function newChat(scope: 'global' | 'project' = 'global', projectId?: string) {
    if (scope === 'project' && !projectId) {
      notify('请先选择一个项目');
      return;
    }
    if (replying) await stopGeneration();
    proactivePreview = null;
    activeConversationId = '';
    messages = [];
    if (scope === 'project' && projectId) {
      activeProjectId = projectId;
      activeView = 'project';
      const project = projects.find((item) => item.id === projectId);
      if (project) {
        project.updatedAt = Date.now();
        projects = [...projects];
        persistProjects();
      }
    } else {
      activeView = 'chat';
    }
    await persistSession();
    notify(scope === 'project' ? '项目对话会在你发出第一条消息时创建' : '对话会在你发出第一条消息时创建');
  }

  async function openConversation(id: string) {
    if (id === activeConversationId && !proactivePreview) return;
    if (replying) await stopGeneration();
    const conversation = conversations.find((item) => item.id === id);
    if (!conversation) return;
    proactivePreview = null;
    activeConversationId = id;
    messages = [...conversation.messages];
    if (conversation.scope === 'project' && conversation.projectId) {
      activeProjectId = conversation.projectId;
      activeView = 'project';
      const project = projects.find((item) => item.id === conversation.projectId);
      if (project) void loadDirectoryTree(project.path);
    } else {
      activeView = 'chat';
    }
    await persistSession();
    await scrollConversationToEnd();
  }

  async function openProject(id: string) {
    if (replying) await stopGeneration();
    const project = projects.find((item) => item.id === id);
    if (!project) return;
    activeProjectId = id;
    project.updatedAt = Date.now();
    projects = [...projects];
    persistProjects();
    activeView = 'project';
    const conversation = conversations.find((item) => item.scope === 'project' && item.projectId === id && !item.archived);
    activeConversationId = conversation?.id || '';
    messages = conversation ? [...conversation.messages] : [];
    await loadDirectoryTree(project.path);
    await scrollConversationToEnd();
  }

  function openNewProjectDialog() {
    projectNameDraft = '';
    projectPathDraft = '';
    showProjectDialog = true;
  }

  function createProject() {
    const name = projectNameDraft.trim();
    const path = projectPathDraft.trim();
    if (!name || !path) {
      notify('请填写项目名称和路径');
      return;
    }
    const project = normalizeProject({
      id: crypto.randomUUID(),
      name,
      path,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    projects = [project, ...projects];
    persistProjects();
    showProjectDialog = false;
    void openProject(project.id);
    notify(`项目 ${name} 已创建`);
  }

  function archiveConversation(id: string) {
    const conversation = conversations.find((item) => item.id === id);
    if (!conversation) return;
    conversation.archived = !conversation.archived;
    conversations = [...conversations];
    persistConversations();
  }

  async function deleteConversation(id: string) {
    conversations = conversations.filter((item) => item.id !== id);
    if (activeConversationId === id) {
      const next = conversations.find((item) => !item.archived && item.scope === 'global')
        || conversations.find((item) => !item.archived);
      if (next) {
        activeConversationId = next.id;
        messages = [...next.messages];
        if (next.scope === 'project' && next.projectId) {
          activeProjectId = next.projectId;
          activeView = 'project';
        } else {
          activeView = 'chat';
        }
      } else {
        proactivePreview = null;
        activeConversationId = '';
        messages = [];
        activeView = 'chat';
      }
    }
    persistConversations();
    await persistSession();
    await scrollConversationToEnd();
    notify('对话已删除');
  }

  async function addMemory(item: MemoryItem) {
    if (!(await runtime.connect())) { notify('运行时未连接，记忆尚未保存'); return; }
    {
      const res = await runtime.request<any>({
        type: 'memory.add',
        id: crypto.randomUUID(),
        item: {
          text: item.text,
          category: (categoryToWire[item.category] || item.category) as any,
          importance: typeof item.importance === 'number' && item.importance > 1 ? item.importance / 3 : item.importance,
        },
      });
      if (res.type !== 'memory.add.result') { notify('记忆保存失败'); return; }
      item = mapMemory(res.item);
    }
    memoryItems = [item, ...memoryItems];
    editingMemory = false;
    memoryCount += 1;
    notify('记忆已保存');
  }

  async function updateMemory(id: string, item: MemoryItem) {
    if (!(await runtime.connect())) { notify('运行时未连接，记忆尚未更新'); return; }
    {
      const res = await runtime.request<any>({
        type: 'memory.update',
        id: crypto.randomUUID(),
        memoryId: id,
        item: {
          text: item.text,
          category: (categoryToWire[item.category] || item.category) as any,
          importance: typeof item.importance === 'number' && item.importance > 1 ? item.importance / 3 : item.importance,
        },
      });
      if (res.type !== 'memory.update.result') { notify('记忆更新失败'); return; }
      item = mapMemory(res.item);
    }
    memoryItems = memoryItems.map((entry) => (entry.id === id ? {...item, id} : entry));
    editingMemory = false;
    notify('记忆已更新');
  }

  async function deleteMemory(id: string) {
    if (!(await runtime.connect())) { notify('运行时未连接，记忆尚未删除'); return; }
    const result = await runtime.request<any>({type: 'memory.expire', id: crypto.randomUUID(), memoryId: id});
    if (result.type !== 'memory.expire.result' || !result.ok) { notify('删除记忆失败'); return; }
    memoryItems = memoryItems.filter((item) => item.id !== id);
    memoryCount = Math.max(0, memoryCount - 1);
    notify('记忆已移入历史');
  }

  async function createExecutorTask(text: string, options: {announce?: boolean; openTasks?: boolean; openReview?: boolean} = {}) {
    const title = taskTitleFromText(text);
    const detail = text;
    if (options.announce !== false && !activeConversationId) {
      const scope: 'global' | 'project' = activeView === 'project' && activeProject ? 'project' : 'global';
      const conversation = createConversation(scope, scope === 'project' ? activeProject?.id : undefined);
      conversations = [conversation, ...conversations];
      activeConversationId = conversation.id;
      persistConversations();
    }
    if (!(await runtime.connect())) {
      notify('运行时未连接，主 Agent 暂时无法执行桌面操作');
      draft = text;
      return null;
    }
    // Primary agent owns the turn; executor worker runs underneath, without forcing a page switch.
    activeSlot = 'executor';
    agentState = 'executing';
    let created: any;
    try {
      created = await runtime.request<any>({
        type: 'task.create',
        id: crypto.randomUUID(),
        title,
        detail,
        conversationId: activeConversationId || undefined,
        workspace: activeConversation?.scope === 'project' ? activeProject?.path : undefined,
        projectName: activeConversation?.scope === 'project' ? activeProject?.name : undefined,
      });
    } catch (error) {
      agentState = 'idle';
      draft = text;
      notify(`主 Agent 启动执行失败：${formatRuntimeError(error, {isTauri: !!(window as any).__TAURI_INTERNALS__})}`);
      return null;
    }
    const tasks = created?.type === 'task.list.result' ? created.tasks : [];
    const createdTask = created?.createdTask || tasks.find((item: any) => item.conversationId === activeConversationId && item.title === title);
    const taskId = createdTask?.id || crypto.randomUUID();
    const status = createdTask?.status || 'queued';
    if (options.announce !== false) {
      const time = new Date().toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'});
      messages.push({id: crypto.randomUUID(), role: 'user', text, time});
      messages.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        text: ['done', 'failed', 'cancelled'].includes(status)
          ? status === 'done' ? `已完成：${title}` : status === 'failed' ? `执行失败：${title}\n\n${createdTask?.error || '没有可用的错误详情'}` : `已终止：${title}`
          : `好的，我来处理：${title}\n已进入 computer-use 模式（每步自动注入 UIA 控件树 + 截图）。进度会同步在这条对话里。`,
        time,
        taskCard: {taskId, title, status, detail},
        events: [{id: crypto.randomUUID(), stepId: `task:${taskId}:status`, kind: 'task', text: `执行状态 · ${status}`, ts: Date.now(), status: status === 'running' ? 'running' : status === 'done' ? 'done' : status === 'failed' ? 'failed' : 'pending', taskId}],
      });
      await persistSession();
    }
    // Stay in chat by default. Tasks page is only for inspection/management.
    if (options.openTasks) activeView = 'tasks';
    notify('已进入 computer-use 模式');
    if (options.openReview && (window as any).__TAURI_INTERNALS__) {
      const {invoke} = await import('@tauri-apps/api/core');
      try {
        await invoke('show_review', {taskId});
      } catch {
        await invoke('show_review');
      }
    }
    return true;
  }

  async function finishLocalAssistant(id: string, textValue: string, isError = false) {
    const target = messages.find((message) => message.id === id);
    if (target) {
      if (isError) {
        target.error = textValue;
        if (!target.text) target.text = '';
      } else {
        target.text = textValue;
        target.error = undefined;
      }
      target.streaming = false;
    }
    settleMessageEvents(id, isError ? 'failed' : 'done');
    replying = false;
    agentState = 'idle';
    streamingId = '';
    attachedPaths = [];
    await persistSession();
  }

  async function sendMessage() {
    const displayText = draft.trim();
    const textValue = buildComposerMessage(displayText);
    if (!displayText || replying) return;
    if (editingMessageId) {
      const editIndex = messages.findIndex((message) => message.id === editingMessageId && message.role === 'user');
      if (editIndex >= 0) messages = messages.slice(0, editIndex);
      editingMessageId = '';
    }
    // Multi-step desktop work enters Computer Use mode (primary agent owns it).
    // allowSubAgents must NOT block mode entry — it only affects worker-model preference.
    if (shouldTransferToExecutor(textValue)) {
      draft = '';
      await createExecutorTask(textValue);
      return;
    }
    if (!activeConversationId) {
      const scope: 'global' | 'project' = activeView === 'project' && activeProject ? 'project' : 'global';
      const conversation = createConversation(scope, scope === 'project' ? activeProject?.id : undefined);
      if (proactivePreview) {
        conversation.title = proactiveTitle(proactivePreview);
        conversation.messages = [...messages];
      }
      conversations = [conversation, ...conversations];
      activeConversationId = conversation.id;
      persistConversations();
    }
    const previewItem = proactivePreview;
    if (previewItem) proactivePreview = null;
    const repliedTo = proactiveInbox.find((item) => item.id === messages.at(-1)?.id && item.state !== 'replied') || previewItem;
    if (repliedTo && await runtime.connect()) {
      void runtime.request({type:'proactive.inbox.mark', id:crypto.randomUUID(), itemId:repliedTo.id, state:'replied'});
      // A user reply becomes the new context; don't let the old autonomous objective wake again.
      if (repliedTo.origin === 'ai' && repliedTo.chainId) void runtime.request({type:'proactive.chain.cancel', id:crypto.randomUUID(), chainId:repliedTo.chainId});
      proactiveInbox = proactiveInbox.map((item) => item.id === repliedTo.id ? {...item, state:'replied'} : item);
    }
    const decision = routeUserMessage(textValue);
    activeSlot = decision.slot;
    const history = messages.map((message) => ({role: message.role, content: message.text}));
    const time = new Date().toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'});
    lastUserText = textValue;
    // Keep slash transport syntax out of the visible conversation. The active mode is
    // represented by the composer chip instead of a raw /goal or /plan message.
    messages.push({id: crypto.randomUUID(), role: 'user', text: displayText, time});
    draft = '';
    replying = true;
    agentState = 'thinking';
    await tick();
    scrollToBottom();
    const id = crypto.randomUUID();
    streamingId = id;
    messages.push({id, role: 'assistant', text: '', time, streaming: true, events: []});
    const isTauri = !!(window as any).__TAURI_INTERNALS__;
    const workspace = activeConversation?.scope === 'project' ? activeProject?.path : undefined;
    const projectName = activeConversation?.scope === 'project' ? activeProject?.name : undefined;
    const attachments = attachedPaths.slice();
    if (workspace) pushMessageEvent(id, 'workspace', `工作区 ${projectName || ''} · ${workspace}`.replace(/\s+·/, ' ·').trim(), {status: 'done'});
    if (attachments.length) pushMessageEvent(id, 'status', `附加 ${attachments.length} 个路径`, {status: 'done'});
    try {
      const connected = await runtime.ensureConnected();
      runtimeConnected = connected;
      if (!connected) {
        const fallback = isDemo
          ? `已记下：「${textValue.slice(0, 80)}${textValue.length > 80 ? '…' : ''}」\n\n演示模式不会调用模型。启动桌面端并配置模型后，可获得完整回复。`
          : formatRuntimeError(new Error('Agent 运行时未连接'), {isDemo, isTauri});
        pushMessageEvent(id, 'status', isDemo ? '演示模式本地记录' : '运行时未连接', {status: isDemo ? 'done' : 'failed'});
        if (isDemo) await finishLocalAssistant(id, fallback, false);
        else await finishLocalAssistant(id, fallback, true);
        return;
      }
      await runtime.chat(
        {
          type: 'chat.send',
          id,
          text: textValue,
          history,
          sessionId: activeConversationId || 'current',
          // Let sidecar re-classify; still pass decision hint for desktop multi-step.
          slot: decision.slot,
          allowSubAgents,
          workspace,
          projectName,
          attachments: attachments.length ? attachments : undefined,
        },
        {
          onDelta: (delta) => {
            if (streamingId !== id) return;
            const index = messages.findIndex((message) => message.id === id);
            if (index >= 0) {
              const current = messages[index];
              // Immutable update so MessageContent markdown $derived always sees new text.
              messages[index] = {...current, text: (current.text || '') + delta};
              messages = messages;
            }
            tick().then(() => scrollToBottom());
          },
          onEvent: (event) => {
            // Stream-local events while active; also accept late computer-use/task linkage for this bubble.
            const lateTask = !!(event as any).taskId || /computer_use|taskId/i.test(String((event as any).receipt || '') + String((event as any).action || ''));
            if (streamingId !== id && !lateTask) return;
            const kind = event.kind || 'status';
            const status =
              event.status ||
              (kind === 'error' ? 'failed' : kind === 'memory' || kind === 'workspace' || kind === 'status' ? 'done' : 'running');
            const receipt = (event as any).receipt as string | undefined;
            const action = (event as any).action as string | undefined;
            let taskId = (event as any).taskId as string | undefined;
            if (!taskId && receipt) {
              try {
                const parsed = JSON.parse(receipt);
                if (parsed?.taskId) taskId = String(parsed.taskId);
                if (parsed?.mode === 'computer_use' || action === 'desktop.computer_use' || action === 'computer_use') {
                  const target = messages.find((message) => message.id === id);
                  if (target && parsed?.taskId) {
                    target.taskCard = {
                      taskId: String(parsed.taskId),
                      title: String(parsed.title || '桌面执行'),
                      status: String(parsed.status || 'queued'),
                      detail: String(parsed.message || parsed.goal || ''),
                    };
                    messages = messages;
                  }
                }
              } catch {
                /* non-JSON receipt */
              }
            }
            pushMessageEvent(id, kind === 'status' && action ? 'tool' : kind, event.text, {
              id: event.id,
              stepId: event.id,
              status,
              action,
              receipt,
              taskId,
              ts: event.ts || Date.now(),
            });
          },
          onDone: () => {
            // Even if the user already stopped (streamingId cleared), still finalize the bubble.
            const target = messages.find((message) => message.id === id);
            if (target) {
              target.streaming = false;
              messages = messages;
            }
            settleMessageEvents(id, 'done');
            if (streamingId === id) {
              replying = false;
              agentState = 'idle';
              runtimeConnected = true;
              streamingId = '';
              attachedPaths = [];
            }
            void persistSession();
            setTimeout(() => void refreshMemories(), 1200);
          },
          onError: (error) => {
            const target = messages.find((message) => message.id === id);
            const msg = formatRuntimeError(error, {isDemo, isTauri: true});
            if (target) {
              if (streamingId === id || !target.text?.trim()) {
                target.error = msg;
              }
              target.streaming = false;
              messages = messages;
            }
            settleMessageEvents(id, 'failed');
            if (streamingId === id) {
              replying = false;
              agentState = 'idle';
              runtimeConnected = runtime.connected;
              streamingId = '';
              attachedPaths = [];
            }
            void persistSession();
          },
          onCancelled: () => {
            const target = messages.find((message) => message.id === id);
            if (target) {
              target.streaming = false;
              if (!target.text?.trim() && !target.error) target.text = '（已停止）';
              messages = messages;
            }
            settleMessageEvents(id, 'skipped');
            if (streamingId === id) {
              replying = false;
              agentState = 'idle';
              streamingId = '';
              attachedPaths = [];
            }
            void persistSession();
          },
        },
      );
    } catch (error) {
      await finishLocalAssistant(id, formatRuntimeError(error, {isDemo, isTauri}), true);
      runtimeConnected = runtime.connected;
    }
  }

  function keydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  }

  async function attachBrowserFile(file: File) {
    if (file.size > 64 * 1024) {
      notify(`附件 ${file.name} 大于 64KB，请通过「文件感知」监视该目录或附加项目路径`);
      return false;
    }
    try {
      const content = await file.text();
      draft = `${draft ? `${draft}

` : ''}[用户主动附上文件：${file.name}]
${content.slice(0, 60_000)}`;
      notify(`已附加 ${file.name}`);
      return true;
    } catch {
      notify(`该文件无法以文本读取：${file.name}`);
      return false;
    }
  }

  async function attachPathFromDisk(path: string) {
    const clean = path.trim().replace(/^file:\/\//i, '');
    if (!clean) return false;
    const name = clean.split(/[/\\]/).pop() || clean;
    if (!(window as any).__TAURI_INTERNALS__) {
      notify('浏览器预览无法读取本地路径，请使用点选附加');
      return false;
    }
    try {
      const {invoke} = await import('@tauri-apps/api/core');
      const content = await invoke<string>('read_text_file', {path: clean, maxBytes: 64_000});
      if (!attachedPaths.includes(clean)) attachedPaths = [...attachedPaths, clean];
      draft = `${draft ? `${draft}

` : ''}[已附加文件：${name}]
${content}`;
      notify(`已读取并附加 ${name}`);
      return true;
    } catch (error) {
      notify(`附加失败：${name} · ${error}`);
      return false;
    }
  }

  async function attachFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const files = input.files ? Array.from(input.files) : [];
    for (const file of files.slice(0, 5)) {
      await attachBrowserFile(file);
    }
    input.value = '';
  }

  function extractDroppedPaths(event: DragEvent): string[] {
    const dt = event.dataTransfer;
    if (!dt) return [];
    const paths: string[] = [];
    // Tauri / Chromium may expose absolute paths on File
    if (dt.files?.length) {
      for (const file of Array.from(dt.files)) {
        const anyFile = file as File & {path?: string};
        if (anyFile.path) paths.push(anyFile.path);
      }
    }
    // Fallback: text/uri-list or plain path text
    const uriList = dt.getData('text/uri-list') || dt.getData('text/plain') || '';
    for (const line of uriList.split(/\r?\n/)) {
      const item = line.trim();
      if (!item || item.startsWith('#')) continue;
      if (item.startsWith('file:')) {
        try {
          paths.push(decodeURIComponent(item.replace(/^file:\/\//i, '').replace(/^\/([A-Za-z]:)/, '$1')));
        } catch {
          paths.push(item);
        }
      } else if (/^[A-Za-z]:[\\/]/.test(item) || item.startsWith('/')) {
        paths.push(item);
      }
    }
    return [...new Set(paths)];
  }

  async function onComposerDragOver(event: DragEvent) {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    composerDragOver = true;
  }

  function onComposerDragLeave(event: DragEvent) {
    const current = event.currentTarget as HTMLElement;
    const related = event.relatedTarget as Node | null;
    if (related && current.contains(related)) return;
    composerDragOver = false;
  }

  async function onComposerDrop(event: DragEvent) {
    event.preventDefault();
    composerDragOver = false;
    const paths = extractDroppedPaths(event);
    if (paths.length) {
      let ok = 0;
      for (const path of paths.slice(0, 8)) {
        if (await attachPathFromDisk(path)) ok += 1;
      }
      if (ok) return;
    }
    const files = event.dataTransfer?.files ? Array.from(event.dataTransfer.files) : [];
    if (!files.length) {
      notify('未能识别拖入的文件');
      return;
    }
    for (const file of files.slice(0, 5)) {
      await attachBrowserFile(file);
    }
  }

  async function windowAction(action: 'minimize' | 'maximize' | 'close') {
    if (!(window as any).__TAURI_INTERNALS__) {
      notify('桌面窗口操作将在 Tauri 中生效');
      return;
    }
    try {
      const {getCurrentWindow} = await import('@tauri-apps/api/window');
      const win = getCurrentWindow();
      if (action === 'maximize') {
        // Custom titlebar: toggleMaximize is the correct API.
        await win.toggleMaximize();
        return;
      }
      if (action === 'minimize') {
        await win.minimize();
        return;
      }
      if (action === 'close') {
        await win.close();
      }
    } catch (error) {
      notify(`窗口操作失败：${error}`);
    }
  }

  async function goToView(id: ViewId) {
    if (replying && id !== activeView) await stopGeneration();
    activeView = id;
    if (id === 'project') {
      if (activeProjectId) void openProject(activeProjectId);
      else if (projects[0]) void openProject(projects[0].id);
      else openNewProjectDialog();
    }
  }

  const filtered = $derived(
    memoryItems.filter(
      (m) => (category === 'all' || m.category === category) && m.text.toLowerCase().includes(query.toLowerCase()),
    ),
  );
</script>

{#if isQuick}
  <QuickWindow />
{:else if isReview}
  <ReviewWindow />
{:else if isCompanion}
  <CompanionWidget />
{:else}
  {#if ready && !persona}<Oobe onComplete={savePersona} />{/if}
  {#if ready && redefiningPersona}<Oobe mode={personaEditorMode} initialPersona={personaEditorMode === 'redefine' ? persona : null} onComplete={savePersona} onCancel={() => (redefiningPersona = false)} />{/if}
  <main class="app-shell" inert={ready && !persona} aria-hidden={ready && !persona ? 'true' : undefined}>
    <header class="titlebar" data-tauri-drag-region>
      <div class="brand" data-tauri-drag-region>
        {#if titleAvatar}<img class="brand-avatar" src={titleAvatar} alt="" data-tauri-drag-region />{/if}
        <StatusDot active={agentState !== 'idle'} />
        <strong data-tauri-drag-region>{persona?.name || 'Pattern'}</strong>
        <span data-tauri-drag-region>{nav.find((n) => n.id === activeView)?.label}</span>
      </div>
      <div class="window-actions">
        <button aria-label="最小化" onclick={() => windowAction('minimize')}><Minus size={15} /></button>
        <button aria-label="最大化" onclick={() => windowAction('maximize')}><Maximize2 size={14} /></button>
        <button class="close" aria-label="关闭" onclick={() => windowAction('close')}><X size={15} /></button>
      </div>
    </header>
    <div class="workspace">
      <nav class="rail" aria-label="主导航">
        {#each nav as item}
          <button class:active={activeView === item.id} class:bottom={item.id === 'settings'} aria-label={item.label} title={item.label} onclick={() => goToView(item.id)}>
            <item.icon size={19} />
            <small>{item.label}</small>
          </button>
        {/each}
      </nav>
      {#if showRecents}
        <RecentsSidebar
          {conversations}
          {projects}
          {proactiveInbox}
          {activeConversationId}
          {activeProjectId}
          activeProactiveId={proactivePreview?.id || ''}
          onOpenConversation={openConversation}
          onOpenProject={openProject}
          onNewChat={() => newChat('global')}
          onNewProject={openNewProjectDialog}
          onOpenProactive={openProactiveInboxItem}
          onDismissProactive={dismissProactiveInboxItem}
          onDismissAllProactive={dismissAllProactiveInbox}
          onDeleteConversation={deleteConversation}
          onArchiveConversation={archiveConversation}
        />
      {/if}
      {#if activeView === 'chat'}
        <section class="view">
          <div class="conversation-head">
            <div class="conversation-head-copy">
              <p class="eyebrow">主 Agent · 全局</p>
              <h1>{activeConversation?.title || (proactivePreview ? proactiveTitle(proactivePreview) : homeGreeting)}</h1>
              {#if proactivePreview && !activeConversation}
                <p class="conversation-context">主动消息预览 · 回复后才会创建对话 · 可忽略</p>
              {:else if !activeConversation}
                <p class="conversation-context">{homeContext}</p>
              {/if}
            </div>
            <div class="conversation-head-actions">
              {#if proactivePreview}
                <button class="quiet-button" onclick={() => proactivePreview && dismissProactiveInboxItem(proactivePreview)}><Trash2 size={14} />忽略</button>
              {/if}
              <button class="quiet-button" onclick={() => newChat('global')}><Plus size={14} />新对话</button>
            </div>
          </div>
          <SessionAgentDocks
            conversationId={activeConversationId}
            planCollapsed={sessionPlanCollapsed}
            goalCollapsed={sessionGoalCollapsed}
            loopCollapsed={sessionLoopCollapsed}
            remindCollapsed={sessionRemindCollapsed}
            onTogglePlan={() => (sessionPlanCollapsed = !sessionPlanCollapsed)}
            onToggleGoal={() => (sessionGoalCollapsed = !sessionGoalCollapsed)}
            onToggleLoop={() => (sessionLoopCollapsed = !sessionLoopCollapsed)}
            onToggleRemind={() => (sessionRemindCollapsed = !sessionRemindCollapsed)}
            onOpenGoals={() => goToView('goals')}
            onOpenTasks={() => goToView('chat')}
            onOpenProactive={() => goToView('proactive')}
          />
          <div class="chat-stream" bind:this={stream}>
            <div class="day-divider"><span>{new Date().toLocaleDateString('zh-CN', {month: 'long', day: 'numeric', weekday: 'short'})}</span></div>
            {#if !messages.length}
              <div class="blank-state compact">
                <div class="blank-mark">⌁</div>
                <h3>开始一段全局对话</h3>
                <p>这里是跨项目的主 Agent 上下文，不会绑定某个工作区。</p>
              </div>
            {/if}
            {#each messages as message (message.id)}
              <article class="message" class:user={message.role === 'user'} class:assistant={message.role === 'assistant'} class:proactive={!!message.proactive}>
                {#if message.role === 'assistant'}
                  <div class="message-meta">
                    <StatusDot size="small" active={!!message.streaming} />
                    <strong>{persona?.name || 'Pattern'}</strong>
                    {#if message.proactive}<span class="badge amber">主动 · {message.proactive}</span>{/if}
                    {#if message.streaming && !message.text}
                      <span>正在想</span>
                    {:else}
                      <time>{message.time}</time>
                    {/if}
                  </div>
                {/if}
                <MessageContent {message} onOpenTask={openTaskReview} />
                {#if message.role === 'user'}<time>{message.time}</time>{/if}
                {#if !message.streaming}
                  <div class="message-actions">
                    <button type="button" onclick={() => copyMessage(message)}>复制</button>
                    {#if message.role === 'user'}<button type="button" disabled={replying} onclick={() => editUserMessage(message)}>编辑</button>{/if}
                    {#if message.role === 'assistant' && !message.proactive}<button type="button" disabled={replying} onclick={() => retryAssistant(message.id)}>{message.error ? '重试' : '重新生成'}</button>{/if}
                  </div>
                {/if}
              </article>
            {/each}
          </div>
          <form
            class="composer"
            class:drag-over={composerDragOver}
            onsubmit={(e) => {
              e.preventDefault();
              sendMessage();
            }}
            ondragenter={onComposerDragOver}
            ondragover={onComposerDragOver}
            ondragleave={onComposerDragLeave}
            ondrop={onComposerDrop}
          >
            {#if composerDragOver}
              <div class="composer-drop-hint" aria-hidden="true">松开以附加文件到对话</div>
            {/if}
            {#if editingMessageId}
              <div class="composer-editing"><span>正在编辑较早的消息，发送后将从这里继续。</span><button type="button" onclick={cancelMessageEdit}>取消</button></div>
            {/if}
            {#if attachedPaths.length}
              <div class="composer-attachments" aria-label="已附加路径">
                {#each attachedPaths as path (path)}
                  <span class="composer-chip" title={path}>
                    {path.split(/[/\\]/).pop() || path}
                    <button type="button" aria-label={`移除 ${path}`} onclick={() => (attachedPaths = attachedPaths.filter((item) => item !== path))}>×</button>
                  </span>
                {/each}
              </div>
            {/if}
            {#if draft.startsWith('/') && !draft.includes('\n')}
              <SlashMenu
                query={draft}
                onPick={(command) => {
                  draft = command.startsWith('/') ? command : `/${command}`;
                }}
              />
            {:else if /(?:^|\s)@[\w\u4e00-\u9fff:-]*$/.test(draft)}
              <div class="at-menu" aria-label="@ 引用建议">
                {#each ['@skill:', '@workflow:', '@task:', '@project:'] as hint}
                  <button
                    type="button"
                    class="at-chip"
                    onclick={() => {
                      draft = draft.replace(/(^|\s)@[\w\u4e00-\u9fff:-]*$/, `$1${hint}`);
                    }}
                  >{hint}</button>
                {/each}
              </div>
            {/if}
            {#if composerMode}
              <div class="composer-mode-hint" class:plan={composerMode === 'plan'}>
                {#if composerMode === 'goal'}<Target size={14} />{:else}<ListTodo size={14} />{/if}
                <strong>{composerMode === 'goal' ? '目标模式' : '计划模式'}</strong>
                <span>{composerMode === 'goal' ? '描述一个可验证的结果；发送后会持续显示在本对话。' : '用换行列出步骤；发送后会成为本对话待办。'}</span>
                <button type="button" aria-label="退出模式" title="退出模式" onclick={() => (composerMode = null)}><X size={13} /></button>
              </div>
            {/if}
            <textarea aria-label="消息" bind:value={draft} oninput={normalizeComposerSlash} onkeydown={keydown} rows="2" placeholder={composerMode === 'goal' ? '例如：完成登录页改造并验证关键流程' : composerMode === 'plan' ? '每行一个步骤，例如：\n分析当前代码\n实现界面\n运行验证' : `和 ${persona?.name || 'Pattern'} 说点什么…… 输入 / 可唤起指令`}></textarea>
            <div class="composer-actions">
              <input aria-label="添加文件" bind:this={attachmentInput} class="file-input" type="file" onchange={attachFile} />
              <button type="button" class="icon-action" title="添加文件（最大 64KB）" aria-label="添加文件" onclick={() => attachmentInput?.click()}><Paperclip size={14} /></button>
              <i class="composer-divider" aria-hidden="true"></i>
              <button
                type="button"
                class="text-action subagent-toggle"
                class:active={allowSubAgents}
                aria-pressed={allowSubAgents}
                title={allowSubAgents ? '子 Agent 已启用：复杂任务可派生子代理' : '子 Agent 已关闭：主 Agent 自己调用工具'}
                onclick={() => setAllowSubAgents(!allowSubAgents)}
              >
                {allowSubAgents ? '子 Agent · 开' : '子 Agent · 关'}
              </button>
              <div class="composer-popover-anchor mode-picker-anchor">
                <button type="button" class="composer-mode-button" class:active={showModePicker || composerMode !== null} onclick={toggleModePicker} aria-haspopup="dialog" aria-expanded={showModePicker}>
                  {#if composerMode === 'goal'}<Target size={13} />{:else if composerMode === 'plan'}<ListTodo size={13} />{:else}<ArrowRight size={13} />{/if}
                  <span>{composerModeLabel}</span><ChevronDown size={12} />
                </button>
                {#if showModePicker}
                  <div class="composer-popover mode-picker" role="dialog" aria-label="执行方式">
                    <header><strong>执行方式</strong><button type="button" aria-label="关闭" onclick={() => (showModePicker = false)}><X size={13} /></button></header>
                    <button type="button" class:chosen={composerMode === null} onclick={() => setComposerMode(null)}>
                      <span class="mode-option-icon"><ArrowRight size={16} /></span>
                      <span><strong>常规 · 边做边推进</strong><small>边分析边执行，适合明确的日常任务。</small></span>
                      {#if composerMode === null}<span class="skill-check">✓</span>{/if}
                    </button>
                    <button type="button" class:chosen={composerMode === 'plan'} onclick={() => setComposerMode('plan')}>
                      <span class="mode-option-icon"><ListTodo size={16} /></span>
                      <span><strong>计划 · 确认后执行</strong><small>先只读产出计划，确认后再执行。</small></span>
                      {#if composerMode === 'plan'}<span class="skill-check">✓</span>{/if}
                    </button>
                    <button type="button" class:chosen={composerMode === 'goal'} onclick={() => setComposerMode('goal')}>
                      <span class="mode-option-icon"><Target size={16} /></span>
                      <span><strong>目标 · 持续推进</strong><small>输入目标后持续工作，直到完成或阻塞。</small></span>
                      {#if composerMode === 'goal'}<span class="skill-check">✓</span>{/if}
                    </button>
                  </div>
                {/if}
              </div>
              <div class="composer-popover-anchor">
                <button type="button" class="composer-mode-button" class:active={showSkillPicker || selectedSkillIds.length > 0} onclick={() => toggleSkillPicker()}>
                  <Workflow size={13} />技能{#if selectedSkillIds.length}<b>{selectedSkillIds.length}</b>{/if}
                </button>
                {#if showSkillPicker}
                  <div class="composer-popover skill-picker" role="dialog" aria-label="调用技能">
                    <header><strong>调用技能</strong><button type="button" aria-label="关闭" onclick={() => (showSkillPicker = false)}><X size={13} /></button></header>
                    {#if availableSkills.length}
                      {#each availableSkills as skill (skill.id)}
                        <button type="button" class:chosen={selectedSkillIds.includes(skill.id)} onclick={() => toggleSkill(skill.id)}>
                          <span><strong>{skill.name}</strong><small>{skill.description}</small></span>
                          {#if selectedSkillIds.includes(skill.id)}<span class="skill-check">✓</span>{/if}
                        </button>
                      {/each}
                    {:else}
                      <p>还没有可用技能，或运行时尚未连接。</p>
                    {/if}
                  </div>
                {/if}
              </div>
              <span class="composer-presence">{selectedSkills.length ? `已调用 ${selectedSkills.map((skill) => skill.name).join('、')}` : allowSubAgents ? '主 Agent · 可派生子代理' : '主 Agent · 直接工具'}</span>
              {#if replying}<button type="button" class="quiet-button" aria-label="停止生成" onclick={stopGeneration}>停止</button>{/if}
              <div class="composer-popover-anchor model-switch-anchor">
                <button type="button" class="model-switch-button" title="快速切换模型" onclick={() => { showModelPicker = !showModelPicker; showSkillPicker = false; showApprovalPicker = false; }}>
                  <span>{activeModel ? `${activeModelProfile ? modelProviderLabel(activeModelProfile) : '已配置'} · ${activeModel}` : '选择模型'}</span><ChevronDown size={12} />
                </button>
                {#if showModelPicker}
                  <div class="composer-popover model-picker" role="dialog" aria-label="快速切换模型">
                    <header><strong>快速切换模型</strong><button type="button" aria-label="关闭" onclick={() => (showModelPicker = false)}><X size={13} /></button></header>
                    <label class="model-picker-search"><Search size={13} /><input bind:value={modelSearch} placeholder="搜索模型或供应商" /></label>
                    {#each quickModelEntries as entry (`${entry.profile.id}:${entry.model}`)}
                      <button type="button" class:chosen={entry.profile.id === activeModelProfileId && entry.model === activeModel} onclick={() => switchQuickModel(entry.profile, entry.model)}>
                        <span><strong>{entry.model}</strong><small>{entry.profile.name} · {modelProviderLabel(entry.profile)}</small></span>
                        {#if entry.profile.id === activeModelProfileId && entry.model === activeModel}<span class="skill-check">✓</span>{/if}
                      </button>
                    {:else}
                      <p>还没有可切换的模型。请先在设置中添加模型服务。</p>
                    {/each}
                  </div>
                {/if}
              </div>
              <button class="send-button" aria-label="发送" disabled={!draft.trim() || replying}><ArrowUp size={18} /></button>
              <div class="composer-popover-anchor approval-anchor">
                <button type="button" class="approval-button" title={`权限审批：${approvalLabel}`} aria-label="权限审批" onclick={() => { showApprovalPicker = !showApprovalPicker; showSkillPicker = false; }}><ShieldCheck size={14} /><ChevronDown size={12} /></button>
                {#if showApprovalPicker}
                  <div class="composer-popover approval-picker" role="dialog" aria-label="权限审批策略">
                    <header><strong>权限审批</strong><button type="button" aria-label="关闭" onclick={() => (showApprovalPicker = false)}><X size={13} /></button></header>
                    {#each approvalOptions as option (option.id)}
                      <button type="button" class:chosen={approvalPreset === option.id} onclick={() => setApprovalPreset(option.id)}>
                        <span><strong>{option.label}</strong><small>{option.detail}</small></span>
                        {#if approvalPreset === option.id}<span class="skill-check">✓</span>{/if}
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>
            </div>
          </form>
        </section>
      {:else if activeView === 'project'}
        {#if activeProject}
          <ProjectWorkspace
            project={activeProject}
            {conversations}
            {activeConversationId}
            {messages}
            bind:draft
            {replying}
            personaName={persona?.name || 'Pattern'}
            {activeSlot}
            {allowSubAgents}
            onToggleSubAgents={setAllowSubAgents}
            {fileNodes}
            {fileLoading}
            {fileError}
            {selectedFilePath}
            {filePreview}
            bind:stream
            onSelectConversation={openConversation}
            onNewConversation={() => newChat('project', activeProject.id)}
            onSend={sendMessage}
            onStop={stopGeneration}
            onRetry={retryAssistant}
            onCopy={copyMessage}
            onEdit={editUserMessage}
            editingMessageId={editingMessageId}
            onCancelEdit={cancelMessageEdit}
            onKeydown={keydown}
            onAttach={attachFile}
            onRefreshFiles={() => loadDirectoryTree(activeProject.path)}
            onOpenFile={openProjectFile}
            onAttachPath={attachProjectPath}
            onExpandDir={expandDirectory}
            projectDiff={projectDiff}
            onInspectDiff={inspectProjectDiff}
            onCreateWorktree={createProjectWorktree}
            onOpenTask={openTaskReview}
            sessionPlanCollapsed={sessionPlanCollapsed}
            sessionGoalCollapsed={sessionGoalCollapsed}
            sessionLoopCollapsed={sessionLoopCollapsed}
            sessionRemindCollapsed={sessionRemindCollapsed}
            onToggleSessionPlan={() => (sessionPlanCollapsed = !sessionPlanCollapsed)}
            onToggleSessionGoal={() => (sessionGoalCollapsed = !sessionGoalCollapsed)}
            onToggleSessionLoop={() => (sessionLoopCollapsed = !sessionLoopCollapsed)}
            onToggleSessionRemind={() => (sessionRemindCollapsed = !sessionRemindCollapsed)}
            onOpenGoals={() => goToView('goals')}
            onOpenTasks={() => goToView('chat')}
            onOpenProactive={() => goToView('proactive')}
          />
        {:else}
          <section class="view">
            <div class="blank-state">
              <div class="blank-mark">⌁</div>
              <h3>还没有项目</h3>
              <p>创建一个项目工作区，即可在左侧对话、中间聊天、右侧浏览文件夹。</p>
              <button class="primary-button" type="button" onclick={openNewProjectDialog}><Plus size={14} />新建项目</button>
            </div>
          </section>
        {/if}
      {:else if activeView === 'memory'}
        <section class="view">
          <PageHeader eyebrow="长期记忆" title="记得的事" subtitle="检索命中会提升访问计数；对话结束后自动提取候选记忆。">
            <button class="quiet-button" onclick={async () => { if(await runtime.connect()){ await runtime.request({type:'memory.consolidate', id:crypto.randomUUID()}); await refreshMemories(); notify('已执行记忆固化'); } }}>固化</button>
            <button class="primary-button" onclick={() => (editingMemory = true)}><Plus size={14} />添加记忆</button>
          </PageHeader>
          <div class="toolbar">
            <label class="search-box"><Search size={15} /><input bind:value={query} placeholder="搜索记忆" /></label>
            <div class="filters">
              {#each ['all', '事实', '偏好', '事件', '反馈'] as item}
                <button class:active={category === item} onclick={() => (category = item as typeof category)}>{item === 'all' ? '全部' : item}</button>
              {/each}
            </div>
          </div>
          <div class="consolidation">
            <span>✦</span>
            <div>
              <strong>{lastConsolidateAt ? '最近固化' : '尚未固化'}</strong>
              <p>
                {#if lastConsolidateAt}
                  {new Date(lastConsolidateAt * 1000).toLocaleString('zh-CN')} 完成衰减与容量整理。当前有效记忆 {memoryCount} 条。
                {:else}
                  系统会在凌晨自动整理；你也可以继续对话让她记住新事实。当前有效记忆 {memoryCount} 条。
                {/if}
              </p>
            </div>
            <time>{lastConsolidateAt ? new Date(lastConsolidateAt * 1000).toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'}) : '--'}</time>
          </div>
          {#if memoryProposals.length}
            <div class="memory-proposals" aria-label="待确认记忆">
              <div class="memory-proposals-head">
                <strong>待确认记忆</strong>
                <span class="badge amber">{memoryProposals.length}</span>
              </div>
              {#each memoryProposals as proposal}
                <article class="memory-card proposal">
                  <div>
                    <span class="badge blue">{categoryFromWire[proposal.category] || proposal.category}</span>
                    <span class="badge dim">{proposal.reason || '提取'}</span>
                  </div>
                  <p>{proposal.text}</p>
                  <footer>
                    <button class="primary-button" type="button" onclick={() => acceptMemoryProposal(proposal.id)}>确认记住</button>
                    <button class="quiet-button" type="button" onclick={() => rejectMemoryProposal(proposal.id)}>忽略</button>
                  </footer>
                </article>
              {/each}
            </div>
          {/if}
          <div class="memory-grid">
            {#each filtered as memory}
              <article class="memory-card" class:expired={memory.expired}>
                <div>
                  <span class="badge" class:amber={memory.category === '事件'} class:blue={memory.category === '事实'} class:green={memory.category === '反馈'} class:dim={memory.category === '偏好'}>
                    {memory.category}{memory.expired ? ' · 已取代' : ''}
                  </span>
                  <span class="importance">{'● '.repeat(importanceStars(memory.importance))}{'○ '.repeat(3 - importanceStars(memory.importance))}</span>
                </div>
                <p>{memory.text}</p>
                <footer>
                  <span>{memory.meta}</span>
                  {#if memory.sourceConv}<button aria-label="查看来源对话" title="查看来源对话" class="text-action" onclick={() => openMemorySource(memory)}>来源</button>{/if}
                  <button aria-label="编辑记忆" title="编辑记忆" class="text-action" onclick={() => { editingMemoryItem = memory; editingMemory = true; }}>编辑</button>
                  <button aria-label="删除记忆" title="删除记忆" onclick={() => deleteMemory(memory.id)}><Trash2 size={13} /></button>
                </footer>
              </article>
            {:else}
              <div class="empty-state">没有找到匹配的记忆</div>
            {/each}
          </div>
        </section>
      {:else if activeView === 'patterns'}
        <PatternsView {notify} />
      {:else if activeView === 'conversations'}
        <ConversationsView
          {conversations}
          activeId={activeConversationId}
          onOpen={openConversation}
          onCreate={() => newChat('global')}
          onArchive={archiveConversation}
          onDelete={deleteConversation}
        />
      {:else if activeView === 'goals'}
        <GoalsView {notify} />
      {:else if activeView === 'proactive'}
        <ProactiveView {notify} onOpenTasks={() => goToView('chat')} />
      {:else if activeView === 'workflows'}
        <WorkflowsView {notify} defaultWorkspace={activeProject?.path || projects[0]?.path || ''} />
      {:else if activeView === 'mcp'}
        <McpView {notify} />
      {:else if activeView === 'channels'}
        <ChannelsView {notify} />
      {:else}
        <SettingsView {persona} {theme} onTheme={setTheme} onRedefine={(mode = 'redefine') => { personaEditorMode = mode; redefiningPersona = true; }} onPersonaChange={(value) => { persona = value; localStorage.setItem('pattern-persona', JSON.stringify(value)); notify(`已切换为 ${value.name}`); }} />
      {/if}
    </div>
    <footer class="statusbar">
      <span title={runtimeConnected ? 'Node Sidecar 已连接' : isDemo ? '当前是浏览器演示预览，不会启动 Node Sidecar' : '桌面端未能连接 Node Sidecar'}>
        <StatusDot size="tiny" active={runtimeConnected} />
        {runtimeConnected ? '运行时已连接' : isDemo ? '演示模式 · 不连接运行时' : '运行时未连接'}
      </span>
      <span>今日主动 <code>{proactiveCount}</code> 次</span>
      {#if foregroundTitle}<span title={foregroundTitle}>前台 <code>{foregroundTitle.slice(0, 24)}{foregroundTitle.length > 24 ? '…' : ''}</code>{foregroundBusy ? ' · 忙' : ''}</span>{/if}
      <span>记忆 <code>{memoryCount}</code> 条</span>
      <i></i>
      <code>{activeConversation?.scope || 'global'} · primary · {agentState}</code>
      <div class="model-status-indicator" aria-label="模型上下文与用量">
        <span class="model-status-dot"></span>
        <span>{activeModel || '未配置模型'}</span>
        <b>{activeMetric?.contextWindow ? `${activeContextRatio}%` : '—'}</b>
        <div class="model-status-popover">
          <header><strong>上下文窗口</strong><span>{activeMetric?.contextWindow ? `${formatTokenCount((activeMetric.inputTokens || 0) + (activeMetric.outputTokens || 0))} / ${formatTokenCount(activeMetric.contextWindow)}` : '等待首个请求'}</span></header>
          <div class="model-status-track"><i style={`width:${activeContextRatio}%`}></i><em style="left:80%"></em></div>
          <dl>
            <div><dt>已用</dt><dd>{formatTokenCount((activeMetric?.inputTokens || 0) + (activeMetric?.outputTokens || 0))}</dd></div>
            <div><dt>距压缩</dt><dd>{activeMetric?.contextWindow ? formatTokenCount(Math.max(0, activeMetric.contextWindow - (activeMetric.inputTokens + activeMetric.outputTokens))) : '—'}</dd></div>
            <div><dt>请求数</dt><dd>{activeMetric?.requests?.toLocaleString('en-US') || '0'}</dd></div>
            <div><dt>缓存命中</dt><dd>{activeMetric?.inputTokens ? `${Math.round((activeMetric.cachedTokens / activeMetric.inputTokens) * 100)}%` : '—'}</dd></div>
          </dl>
          <footer>{activeMetric ? `${activeMetric.provider} · ${activeMetric.model}` : '模型用量会在首次响应后显示'}</footer>
        </div>
      </div>
    </footer>
  </main>
  {#if toast}<div class="toast show" role="status" aria-live="polite">{toast}</div>{/if}
  {#if editingMemory}<MemoryEditor initial={editingMemoryItem || undefined} onClose={() => { editingMemory = false; editingMemoryItem = null; }} onSave={async (item) => { if (editingMemoryItem) await updateMemory(editingMemoryItem.id, item); else await addMemory(item); editingMemoryItem = null; }} />{/if}
  {#if showProjectDialog}
    <div class="modal-backdrop" role="presentation">
      <form
        class="memory-editor project-editor"
        aria-label="新建项目"
        onsubmit={(event) => {
          event.preventDefault();
          createProject();
        }}
      >
        <header>
          <div>
            <p class="eyebrow">工作区</p>
            <h2>新建项目</h2>
          </div>
          <button type="button" aria-label="关闭" onclick={() => (showProjectDialog = false)}><X size={15} /></button>
        </header>
        <label>项目名称
          <input aria-label="项目名称" bind:value={projectNameDraft} placeholder="Pattern" required />
        </label>
        <label>本地路径
          <div class="path-row">
            <input aria-label="项目路径" bind:value={projectPathDraft} placeholder="E:\Desktop\项目\CrossPlatform\Pattern" required />
            <button type="button" class="quiet-button" onclick={pickProjectFolder}>浏览文件夹</button>
          </div>
        </label>
        <p class="field-help">项目对话会绑定该工作区；右侧文件树读取此路径。可浏览选择或手动粘贴绝对路径。</p>
        <footer>
          <button type="button" class="quiet-button" onclick={() => (showProjectDialog = false)}>取消</button>
          <button type="submit" class="primary-button">创建项目</button>
        </footer>
      </form>
    </div>
  {/if}
{/if}
