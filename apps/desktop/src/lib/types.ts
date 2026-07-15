export type ViewId = 'chat' | 'conversations' | 'project' | 'memory' | 'tasks' | 'proactive' | 'workflows' | 'mcp' | 'channels' | 'settings';
export type MemoryCategory = '事实' | '偏好' | '事件' | '反馈' | '参考';
export type ConversationScope = 'global' | 'project';

export interface ChatMessageEvent {
  id: string;
  kind: 'status' | 'workspace' | 'tool' | 'task' | 'mcp' | 'memory' | 'agent' | 'error' | string;
  text: string;
  ts?: number;
  status?: 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'awaiting_approval' | string;
  action?: string;
  tier?: number;
  receipt?: string;
  taskId?: string;
  stepId?: string;
}

export interface TaskCardInfo {
  taskId: string;
  title: string;
  status: string;
  detail?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  time: string;
  proactive?: string;
  events?: ChatMessageEvent[];
  error?: string;
  streaming?: boolean;
  taskCard?: TaskCardInfo;
}

export interface MemoryItem {
  id: string;
  category: MemoryCategory | string;
  text: string;
  meta: string;
  importance: number;
  expired?: boolean;
  accessCount?: number;
  sourceConv?: string | null;
}

export interface Persona {
  name: string;
  userName: string;
  description: string;
  proactive: 'free' | 'quiet';
}

export interface SlotBindings {
  mode: 'shared' | 'split';
  companionName: string;
  executorName: string;
}

export interface ModelSetup {
  provider: string;
  endpoint: string;
  model: string;
  apiKey: string;
}

export interface TaskItem {
  id: string;
  title: string;
  detail: string;
  status: 'scheduled' | 'queued' | 'running' | 'paused' | 'awaiting_approval' | 'cancelled' | 'done' | 'failed';
  createdAt: string;
  riskTier?: number;
  error?: string;
  schedule?: {kind: 'daily' | 'weekly' | 'interval' | 'once'; time?: string; days?: number[]; intervalMinutes?: number; at?: number; enabled: boolean};
  plan?: Array<{id:string; title:string; detail:string; enabled:boolean}>;
  runCount?: number;
  lastRunAt?: number;
  nextRunAt?: number;
  runs?: Array<{id:string;startedAt:number;finishedAt?:number;status:'running'|'done'|'failed'|'cancelled';error?:string}>;
  workflow?: {id:string;name:string;stepCount:number;currentStep?:number;workspace?:string;agents?:number};
  agentResults?: Array<{skillId:string;output:string;status:'done'|'failed';ts:number}>;
  steps?: Array<{
    id: string;
    action: string;
    detail: string;
    tier: number;
    status: string;
    screenshotPath?: string;
    receipt?: string;
    ts: number;
  }>;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  archived?: boolean;
  scope: ConversationScope;
  projectId?: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  updatedAt: number;
}

export interface FileNode {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  children?: FileNode[];
}

export const categoryToWire: Record<string, string> = {
  事实: 'fact',
  偏好: 'preference',
  事件: 'event',
  反馈: 'feedback',
  参考: 'reference',
  fact: 'fact',
  preference: 'preference',
  event: 'event',
  feedback: 'feedback',
  reference: 'reference',
};

export const categoryFromWire: Record<string, MemoryCategory> = {
  fact: '事实',
  preference: '偏好',
  event: '事件',
  feedback: '反馈',
  reference: '参考',
  事实: '事实',
  偏好: '偏好',
  事件: '事件',
  反馈: '反馈',
  参考: '参考',
};

export function importanceStars(value: number): 1 | 2 | 3 {
  if (value >= 0.75) return 3;
  if (value >= 0.4) return 2;
  return 1;
}

export function normalizeConversation(item: Partial<Conversation> & Pick<Conversation, 'id' | 'title' | 'createdAt' | 'updatedAt' | 'messages'>): Conversation {
  return {
    ...item,
    messages: Array.isArray(item.messages) ? item.messages : [],
    archived: !!item.archived,
    scope: item.scope === 'project' && item.projectId ? 'project' : 'global',
    projectId: item.scope === 'project' ? item.projectId : undefined,
  };
}

export function normalizeProject(item: Partial<Project> & Pick<Project, 'id' | 'name' | 'path'>): Project {
  const now = Date.now();
  return {
    id: item.id,
    name: item.name,
    path: item.path,
    createdAt: item.createdAt ?? now,
    updatedAt: item.updatedAt ?? now,
  };
}
