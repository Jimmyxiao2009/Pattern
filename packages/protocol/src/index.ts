/** Shared wire types: frontend ↔ sidecar WS, Rust ↔ sidecar configure/bridge. */

export interface RuntimeConnection {
  port: number;
  token: string;
}

/** Hard safety ceiling for one delegated workflow. */
export const MAX_AGENT_COUNT = 384;

export interface ModelEndpoint {
  provider: string;
  endpoint: string;
  model: string;
  apiKey?: string;
  vision?: boolean;
}

export interface SlotPersona {
  name: string;
  description: string;
  userName?: string;
}

export interface SlotBindings {
  mode: 'shared' | 'split';
  companionName: string;
  executorName: string;
}

/** Non-secret configuration for a locally installed channel plugin. Secrets stay
 * in the plugin's own credential store rather than in Pattern configuration. */
export interface ChannelPluginConfig {
  id: string;
  enabled: boolean;
  config?: unknown;
}

export interface RuntimeConfigure {
  provider: string;
  endpoint: string;
  model: string;
  apiKey: string;
  persona: string;
  personaName?: string;
  userName?: string;
  /** Optional separate persona for the executor slot when mode=split. */
  executorPersona?: SlotPersona;
  slots?: SlotBindings;
  /** Optional model dedicated to Computer Use and task execution. */
  executor?: ModelEndpoint;
  utility?: ModelEndpoint;
  /** Optional low-cost model used for delegated sub-agents. */
  agent?: ModelEndpoint;
  embedding?: ModelEndpoint;
  webdav?: {
    url: string;
    username: string;
    /** password stays in keyring; Rust bridge may inject when syncing */
    password?: string;
  };
  telegram?: {
    enabled: boolean;
    chatId: string;
    token?: string;
  };
  email?: {
    enabled: boolean;
    host: string;
    port: number;
    secure: boolean;
    username: string;
    recipient: string;
    password?: string;
    imapEnabled?: boolean;
    imapHost?: string;
    imapPort?: number;
    imapSecure?: boolean;
  };
  plugins?: ChannelPluginConfig[];
  proactive?: {
    enabled: boolean;
    paused?: boolean;
    bedtimeHour: number;
  };
  /** Rust OS/notify bridge base URL, e.g. http://127.0.0.1:PORT */
  bridgeUrl?: string;
  bridgeToken?: string;
  dataDir?: string;
  deviceId?: string;
  channelKey?: string;
  plaa?: { url: string };
}

export type MemoryCategory = 'fact' | 'preference' | 'event' | 'feedback' | 'reference';

export interface MemoryRecord {
  id: string;
  text: string;
  category: MemoryCategory;
  importance: number;
  createdAt: number;
  updatedAt: number;
  accessCount: number;
  sourceConv?: string | null;
  expired: boolean;
  replacesId?: string | null;
  meta?: string;
}

export interface ProactiveLogItem {
  id: string;
  type: string;
  topicKey: string;
  reason: string;
  body: string;
  channel: string;
  ts: number;
  delivered: boolean;
  /** Whether this is model-authored companionship or a clearly labeled system reminder. */
  origin?: 'ai' | 'system';
  state?: 'unread' | 'read' | 'replied' | 'dismissed' | 'failed';
  chainId?: string;
}

export type ProactiveChainKind = 'autonomous' | 'required_reminder';
export type ProactiveChainStatus = 'active' | 'running' | 'completed' | 'cancelled' | 'failed';

/** One self-scheduling proactive objective.  A chain owns at most one next wake-up. */
export interface ProactiveChain {
  id: string;
  kind: ProactiveChainKind;
  status: ProactiveChainStatus;
  purpose: string;
  context?: string;
  nextRunAt: number | null;
  timezone: string;
  sourceConversationId?: string | null;
  recurrence?: { kind: 'daily'; time: string } | null;
  consecutiveSilentRuns: number;
  failureCount: number;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number | null;
}

export interface RelayStatus {
  configured: boolean;
  online: boolean;
  lastSyncAt: number | null;
  outboxCount: number;
  error?: string | null;
}

export interface TaskRecord {
  id: string;
  title: string;
  detail: string;
  status: 'scheduled' | 'queued' | 'running' | 'paused' | 'awaiting_approval' | 'cancelled' | 'done' | 'failed';
  createdAt: string;
  steps?: TaskStep[];
  riskTier?: number;
  error?: string;
  /** Local schedules are persisted and run through the normal approval pipeline. */
  schedule?: TaskSchedule;
  /** Optional user-authored ordered automation steps for scheduled runs. */
  plan?: TaskPlanStep[];
  runCount?: number;
  lastRunAt?: number;
  nextRunAt?: number;
  runs?: TaskRun[];
  activeRunId?: string;
  workflow?: {id: string; name: string; stepCount: number; currentStep?: number; workspace?: string; agents?: number};
  agentResults?: Array<{skillId:string; output:string; status:'done'|'failed'; ts:number}>;
}

export interface TaskPlanStep {
  id: string;
  title: string;
  detail: string;
  enabled: boolean;
}

export interface TaskSchedule {
  kind: 'daily' | 'weekly' | 'interval' | 'once';
  time?: string;
  /** JavaScript weekday values: 0 Sunday … 6 Saturday. */
  days?: number[];
  intervalMinutes?: number;
  at?: number;
  enabled: boolean;
}

export interface TaskRun {
  id: string;
  startedAt: number;
  finishedAt?: number;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  error?: string;
}

export interface ModelUsageMetrics {
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  requests: number;
  contextWindow?: number;
  balance?: string;
  cost?: number;
  costCurrency?: string;
  lastRequest?: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    durationMs?: number;
    cost?: number;
    costCurrency?: string;
    at: number;
  };
  updatedAt: number;
}

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  kind: 'coding' | 'research' | 'desktop';
  permissions: string[];
  prompt: string;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  skillIds: string[];
  mode: 'serial' | 'parallel-read' | 'peer-discussion';
  maxAgents: number;
  /** Number of independent/rebuttal rounds for peer discussion workflows. */
  discussionRounds?: number;
}

export interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
  permissions: string[];
  tools?: string[];
  toolSchemas?: Array<{name:string; description?:string; inputSchema?:unknown}>;
  lastDiscoveredAt?: number;
  error?: string;
}

export interface TaskStep {
  id: string;
  action: string;
  detail: string;
  tier: number;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'awaiting_approval';
  screenshotPath?: string;
  receipt?: string;
  ts: number;
}

export interface FileWatchConfig {
  enabled: boolean;
  paths: string[];
  extensions: string[];
  maxBytes: number;
}

export interface FileWatchEvent {
  id: string;
  path: string;
  kind: string;
  ts: number;
  decision: 'pending' | 'ignored' | 'read' | 'failed';
  reason: string;
}

export interface HealthCheckConfig {
  url: string;
  label?: string;
}

export interface CronTriggerConfig {
  id: string;
  time: string;
  message: string;
  enabled: boolean;
}

export type AgentSlot = 'companion' | 'executor';

export interface SecurityPolicy {
  /** When set, file/tool writes should stay under this root. */
  workspaceRoot?: string | null;
  /** Enforce workspace root for MCP write / process tools when true. */
  enforceWorkspace: boolean;
  /** Auto-approve tiers below this number (default 2 => T0/T1 auto). */
  autoApproveBelow: number;
  /** Hard-deny tiers at or above this number (default 3). */
  hardDenyAt: number;
  /** Human-readable tier glossary for UI. */
  tierGuide: Array<{tier: number; label: string; meaning: string}>;
}

export interface AuditEntry {
  ts: number;
  line: string;
  tier?: number;
  kind?: string;
  taskId?: string;
  decision?: 'allowed' | 'approved' | 'denied' | 'info';
}

export type ClientMessage =
  | {
      type: 'chat.send';
      id: string;
      text: string;
      history: Array<{ role: 'user' | 'assistant'; content: string }>;
      sessionId?: string;
      /** Preferred slot after local/frontend routing. Executor usually becomes a task. */
      slot?: AgentSlot;
      /** Absolute project root when the chat is project-scoped. */
      workspace?: string;
      projectName?: string;
      /** Optional file paths the user attached for this turn. */
      attachments?: string[];
    }
  | { type: 'memory.list'; id: string; query?: string | null; category?: string | null }
  | { type: 'memory.add'; id: string; item: Partial<MemoryRecord> & { text: string; category: MemoryCategory | string } }
  | { type: 'memory.update'; id: string; memoryId: string; item: Partial<MemoryRecord> & { text?: string; category?: MemoryCategory | string; importance?: number } }
  | { type: 'memory.expire'; id: string; memoryId: string }
  | { type: 'memory.stats'; id: string }
  | { type: 'proactive.list'; id: string; limit?: number }
  | { type: 'proactive.chain.list'; id: string; limit?: number }
  | { type: 'proactive.chain.cancel'; id: string; chainId: string }
  | { type: 'proactive.chain.runNow'; id: string; chainId: string }
  | { type: 'proactive.inbox.mark'; id: string; itemId: string; state: 'read' | 'dismissed' | 'replied' }
  | { type: 'proactive.setPaused'; id: string; paused: boolean }
  | { type: 'proactive.getConfig'; id: string }
  | { type: 'healthcheck.getConfig'; id: string }
  | { type: 'healthcheck.setConfig'; id: string; checks: HealthCheckConfig[] }
  | { type: 'cron.getConfig'; id: string }
  | { type: 'cron.setConfig'; id: string; triggers: CronTriggerConfig[] }
  | { type: 'proactive.trigger'; id: string; kind?: string; reason?: string }
  | { type: 'relay.status'; id: string }
  | { type: 'relay.syncNow'; id: string }
  | { type: 'task.list'; id: string }
  | { type: 'task.create'; id: string; title: string; detail?: string; schedule?: TaskSchedule; plan?: TaskPlanStep[] }
  | { type: 'task.update'; id: string; taskId: string; title: string; detail?: string; schedule: TaskSchedule; plan?: TaskPlanStep[] }
  | { type: 'task.control'; id: string; taskId: string; action: 'pause' | 'resume' | 'cancel' | 'approve' | 'reject' }
  | { type: 'task.delete'; id: string; taskId: string }
  | { type: 'model.metrics.get'; id: string }
  | { type: 'model.catalog.get'; id: string }
  | { type: 'model.balance.check'; id: string }
  | { type: 'skill.list'; id: string }
  | { type: 'skill.install'; id: string; skill: SkillDefinition }
  | { type: 'skill.remove'; id: string; skillId: string }
  | { type: 'workflow.list'; id: string }
  | { type: 'workflow.run'; id: string; workflowId: string; input: string; workspace?: string; isolatedWorktree?: boolean; agentCount?: number }
  | { type: 'mcp.list'; id: string }
  | { type: 'mcp.set'; id: string; servers: McpServerConfig[] }
  | { type: 'mcp.discover'; id: string; serverId: string }
  | { type: 'mcp.call'; id: string; serverId: string; tool: string; arguments?: Record<string, unknown> }
  | { type: 'workspace.worktree.create'; id: string; root: string; name?: string }
  | { type: 'workspace.diff'; id: string; root: string }
  | { type: 'filewatch.getConfig'; id: string }
  | { type: 'filewatch.setConfig'; id: string; config: FileWatchConfig }
  | { type: 'filewatch.list'; id: string; limit?: number }
  | { type: 'memory.consolidate'; id: string }
  | { type: 'memory.propose.list'; id: string }
  | { type: 'memory.propose.accept'; id: string; proposalId: string }
  | { type: 'memory.propose.reject'; id: string; proposalId: string }
  | { type: 'journal.list'; id: string; limit?: number; query?: string | null }
  | { type: 'security.policy.get'; id: string }
  | { type: 'security.policy.set'; id: string; policy: Partial<SecurityPolicy> }
  | { type: 'runtime.ping'; id: string }
  | { type: 'runtime.foreground'; id: string };

export type ServerMessage =
  | { type: 'runtime.ready' }
  | { type: 'runtime.status'; sidecar: string; memory: string; proactive: string; relay: string; version: string }
  | { type: 'runtime.agent_state'; state: 'idle' | 'thinking' | 'executing' | 'paused' | 'approval' }
  | { type: 'chat.started'; id: string; slot?: AgentSlot }
  | { type: 'chat.delta'; id: string; delta: string }
  | { type: 'chat.done'; id: string; slot?: AgentSlot }
  | { type: 'chat.error'; id: string; message: string }
  | { type: 'chat.event'; id: string; event: {kind: string; text: string; ts?: number} }
  | { type: 'memory.list.result'; id: string; items: MemoryRecord[] }
  | { type: 'memory.add.result'; id: string; item: MemoryRecord }
  | { type: 'memory.update.result'; id: string; item: MemoryRecord }
  | { type: 'memory.expire.result'; id: string; ok: boolean }
  | { type: 'memory.stats.result'; id: string; count: number; lastConsolidateAt: number | null }
  | { type: 'memory.consolidate.result'; id: string; at: number; decayed: number; evicted: number }
  | { type: 'memory.changed' }
  | { type: 'memory.proposed'; items: Array<{id: string; text: string; category: string; importance: number; sourceConv?: string | null; reason?: string}> }
  | { type: 'memory.propose.list.result'; id: string; items: Array<{id: string; text: string; category: string; importance: number; sourceConv?: string | null; reason?: string}> }
  | { type: 'memory.propose.accept.result'; id: string; item?: MemoryRecord; ok: boolean }
  | { type: 'memory.propose.reject.result'; id: string; ok: boolean }
  | { type: 'proactive.list.result'; id: string; items: ProactiveLogItem[] }
  | { type: 'proactive.chain.list.result'; id: string; chains: ProactiveChain[] }
  | { type: 'proactive.chain.updated'; chain: ProactiveChain }
  | { type: 'proactive.inbox.updated'; item: ProactiveLogItem }
  | { type: 'proactive.config'; id: string; enabled: boolean; paused: boolean; bedtimeHour: number }
  | { type: 'healthcheck.config'; id: string; checks: HealthCheckConfig[] }
  | { type: 'cron.config'; id: string; triggers: CronTriggerConfig[] }
  | { type: 'proactive.impulse'; item: ProactiveLogItem }
  | { type: 'relay.status.result'; id: string; status: RelayStatus }
  | { type: 'task.list.result'; id: string; tasks: TaskRecord[] }
  | { type: 'task.updated'; task: TaskRecord }
  | { type: 'task.approval_required'; taskId: string; step: TaskStep; screenshotBase64?: string }
  | { type: 'task.screenshot'; taskId: string; screenshotBase64: string; screenshotPath?: string }
  | { type: 'model.metrics'; id: string; metrics: ModelUsageMetrics[] }
  | { type: 'model.catalog'; id: string; models: string[]; source: 'provider' | 'preset' }
  | { type: 'skill.list.result'; id: string; skills: SkillDefinition[] }
  | { type: 'skill.updated'; id: string; skills: SkillDefinition[] }
  | { type: 'workflow.list.result'; id: string; workflows: WorkflowDefinition[] }
  | { type: 'workflow.started'; id: string; workflowId: string; taskId: string; workspace?: string }
  | { type: 'mcp.list.result'; id: string; servers: McpServerConfig[] }
  | { type: 'mcp.updated'; id: string; servers: McpServerConfig[] }
  | { type: 'mcp.call.result'; id: string; serverId: string; tool: string; result: unknown }
  | { type: 'workspace.worktree.created'; id: string; path: string; branch: string }
  | { type: 'workspace.diff.result'; id: string; root: string; status: string; diff: string }
  | { type: 'filewatch.config'; id: string; config: FileWatchConfig }
  | { type: 'filewatch.list.result'; id: string; items: FileWatchEvent[] }
  | { type: 'filewatch.event'; item: FileWatchEvent }
  | { type: 'journal.list.result'; id: string; items: AuditEntry[] }
  | { type: 'security.policy'; id: string; policy: SecurityPolicy }
  | { type: 'runtime.foreground.result'; id: string; title: string; busyHint?: boolean }
  | { type: 'error'; id: string; message: string };
