import {createServer} from 'node:http';
import {randomBytes, randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {existsSync, mkdirSync, readFileSync, writeFileSync, watch, statSync, readdirSync, unlinkSync, type FSWatcher} from 'node:fs';
import {WebSocketServer, WebSocket} from 'ws';
import {MemoryEngine, categoryLabel, ensureDataDir, localEmbed, type MemoryRecord} from '@pattern/memory';
import {ProactiveEngine} from '@pattern/proactive';
import {RelayClient, type RelayConfig} from '@pattern/relay';
import {assessSafety, normalizeCompanionToolName, routeUserMessage, shouldTransferToExecutor, taskTitleFromText} from '@pattern/core';
import {MAX_AGENT_COUNT} from '@pattern/protocol';
import {TelegramChannel, ImapChannel, createSmtpChannel, channelMessage, discoverChannelPlugins, loadChannelPlugin, type Channel, type ChannelMessage} from '@pattern/channels';
import type {
  AgentSlot,
  ClientMessage,
  RuntimeConfigure,
  ServerMessage,
  TaskRecord,
  TaskStep,
  FileWatchConfig,
  FileWatchEvent,
  HealthCheckConfig,
  CronTriggerConfig,
  ModelUsageMetrics,
  TaskSchedule,
  TaskRun,
  SkillDefinition,
  WorkflowDefinition,
  McpServerConfig,
  ProactiveChain,
  GoalState,
  SessionPlan,
  SessionPlanItem,
} from '@pattern/protocol';
import {
  clearSessionPlan,
  enrichWithMentions,
  executeSlashCommand,
  formatSessionPlan,
  getSessionPlan,
  loadCustomWorkflows,
  loadGoals,
  parseSlashCommand,
  saveCustomWorkflows,
  saveGoals,
  setSessionPlan,
  type SlashDeps,
} from './slash-handlers';
import {
  formatPatternsForPrompt,
  updatePatternsFromMemories,
  type PatternPipelineDeps,
} from './pattern-pipeline';
interface ChatRequest {
  type: 'chat.send';
  id: string;
  text: string;
  history: Array<{role: 'user' | 'assistant'; content: string}>;
  sessionId?: string;
  slot?: AgentSlot;
  allowSubAgents?: boolean;
  workspace?: string;
  projectName?: string;
  attachments?: string[];
}
let agentState: 'idle' | 'thinking' | 'executing' | 'paused' | 'approval' = 'idle';
function setAgentState(state: typeof agentState) {
  if (agentState === state) return;
  agentState = state;
  broadcast({type: 'runtime.agent_state', state});
}
let config: RuntimeConfigure | null = null;
const token = randomBytes(24).toString('base64url');
const dataDir = process.env.PATTERN_DATA_DIR || join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'pattern');
ensureDataDir(dataDir);
const memory = new MemoryEngine(dataDir);
const proactive = new ProactiveEngine(dataDir);
let relay = new RelayClient(dataDir, null);
// --- Pattern Engine pipeline (derived cognitive layer over memory) ---
const patternPipelineDeps: PatternPipelineDeps = {
  memory,
  getModel: () => {
    if (!config?.apiKey) return null;
    const utility = config.utility;
    return {
      provider: utility?.provider || config.provider,
      endpoint: utility?.endpoint || config.endpoint,
      model: utility?.model || config.model,
      apiKey: utility?.apiKey || config.apiKey,
    };
  },
  recordUsage: (provider, model, usage, durationMs) => recordUsage(provider, model, usage, durationMs),
  log: (message, error) => (error !== undefined ? console.error('[pattern-sidecar]', message, error) : console.log('[pattern-sidecar]', message)),
};
const patternMemoryQueue: string[] = [];
let patternFlushTimer: NodeJS.Timeout | null = null;
/** Queue a newly saved memory for incremental pattern extraction (debounced). */
function queuePatternUpdate(memoryId: string) {
  if (!memoryId || patternMemoryQueue.includes(memoryId)) return;
  patternMemoryQueue.push(memoryId);
  if (patternFlushTimer) return;
  patternFlushTimer = setTimeout(() => {
    patternFlushTimer = null;
    void flushPatternQueue();
  }, 5000);
}
async function flushPatternQueue() {
  if (!patternMemoryQueue.length) return;
  const batch = patternMemoryQueue.splice(0, 8);
  try {
    const outcome = await updatePatternsFromMemories(patternPipelineDeps, batch, {
      observerId: config?.personaName || null,
    });
    if (outcome.supported.length || outcome.contradicted.length || outcome.updated.length || outcome.created.length) {
      broadcast({type: 'pattern.changed'});
      console.log(
        `[pattern-sidecar] pattern pipeline: +${outcome.created.length} created, ${outcome.supported.length} supported, ${outcome.contradicted.length} contradicted, ${outcome.updated.length} updated, ${outcome.ignored} ignored, ${outcome.rejected} rejected`,
      );
    }
  } catch (error) {
    console.error('[pattern-sidecar] pattern pipeline failed', error);
  }
  // Remaining items beyond the batch size are flushed in the next cycle.
  if (patternMemoryQueue.length && !patternFlushTimer) {
    patternFlushTimer = setTimeout(() => {
      patternFlushTimer = null;
      void flushPatternQueue();
    }, 2000);
  }
}
let lastUserActivityAt = Math.floor(Date.now() / 1000);
let tasks: TaskRecord[] = loadTasks();
const queuedComputerUseTaskIds = new Set<string>();
let computerUseQueue: Promise<void> = Promise.resolve();
let recoveryReconciled = false;
let recoveryReconciliationInFlight: Promise<void> | null = null;
let modelMetrics = loadModelMetrics();
function skillsFile() {
  return join(dataDir, 'skills.json');
}
function loadCustomSkills(): SkillDefinition[] {
  try {
    if (!existsSync(skillsFile())) return [];
    const raw = JSON.parse(readFileSync(skillsFile(), 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw
      .map((item: any) => ({
        id: String(item.id || '').slice(0, 80),
        name: String(item.name || '').slice(0, 80),
        description: String(item.description || '').slice(0, 400),
        kind: (['coding', 'research', 'desktop'].includes(item.kind) ? item.kind : 'coding') as SkillDefinition['kind'],
        permissions: Array.isArray(item.permissions) ? item.permissions.map(String).slice(0, 20) : ['workspace.read'],
        prompt: String(item.prompt || '').slice(0, 4000),
        builtin: false as any,
      }))
      .filter((item: SkillDefinition) => item.id && item.name && item.prompt)
      .slice(0, 100);
  } catch {
    return [];
  }
}
function saveCustomSkills(items: SkillDefinition[]) {
  writeFileSync(skillsFile(), JSON.stringify(items, null, 2));
}
let customSkills: SkillDefinition[] = loadCustomSkills();
function allSkills(): SkillDefinition[] {
  const customIds = new Set(customSkills.map((item) => item.id));
  return [
    ...codingSkills.map((item) => ({...item, builtin: true as any})),
    ...customSkills.filter((item) => !codingSkills.some((base) => base.id === item.id)),
  ];
}
const codingSkills: SkillDefinition[] = [
  {id:'code-review', name:'代码审查', kind:'coding', description:'检查变更的正确性、风险、测试覆盖与可维护性。', permissions:['workspace.read','git.diff.read'], prompt:'审查当前工作区变更，优先指出真实缺陷、回归风险和缺失测试；不要修改文件。'},
  {id:'test-and-fix', name:'测试与修复', kind:'coding', description:'运行相关测试，定位失败原因并提出最小安全修复。', permissions:['workspace.read','workspace.write','process.test'], prompt:'运行与任务相关的测试，定位失败原因，实施最小修复并再次验证；不得删除测试或绕过失败。'},
  {id:'refactor', name:'安全重构', kind:'coding', description:'在保持行为不变的前提下改善结构，并用测试证明结果。', permissions:['workspace.read','workspace.write','process.test','git.diff.read'], prompt:'先理解现有行为，再做小步重构；每步运行相关测试，保留可审查的差异。'},
  {id:'release-check', name:'发布前检查', kind:'coding', description:'汇总测试、依赖、差异和风险，生成发布清单。', permissions:['workspace.read','process.test','git.diff.read'], prompt:'执行发布前检查，输出测试结果、依赖风险、未解决问题和回滚建议；不要执行发布。'},
];
const codingWorkflows: WorkflowDefinition[] = [
  {id:'review-and-test', name:'审查并验证', description:'先审查变更，再运行测试并汇总风险。', skillIds:['code-review','test-and-fix'], mode:'serial', maxAgents:1},
  {id:'safe-refactor', name:'安全重构', description:'以测试为约束做小步重构，完成后复核差异。', skillIds:['refactor','code-review'], mode:'serial', maxAgents:1},
  {id:'release-readiness', name:'发布准备检查', description:'并行收集只读证据，再生成发布清单。', skillIds:['code-review','release-check'], mode:'parallel-read', maxAgents:2},
  {id:'mass-parallel-review', name:'大规模并行审查', description:'将同一目标分派给最多 384 个并行只读 Agent，适合大仓库扫描与多角度证据收集。', skillIds:['code-review','release-check'], mode:'parallel-read', maxAgents:MAX_AGENT_COUNT},
  {id:'peer-review', name:'平权 Agent 研讨', description:'多个 Agent 独立论证、交叉质询，再由主模型主持汇总共识与分歧。', skillIds:['code-review','release-check'], mode:'peer-discussion', maxAgents:3, discussionRounds:2},
];
let customWorkflows: WorkflowDefinition[] = loadCustomWorkflows(dataDir);
function allWorkflows(): WorkflowDefinition[] {
  const builtinIds = new Set(codingWorkflows.map((w) => w.id));
  return [...codingWorkflows, ...customWorkflows.filter((w) => !builtinIds.has(w.id))];
}
function persistCustomWorkflows(items: WorkflowDefinition[]) {
  customWorkflows = items;
  saveCustomWorkflows(dataDir, items);
}
function makeSlashDeps(ctx?: {conversationId?: string; workspace?: string; projectName?: string}): SlashDeps {
  return {
    dataDir,
    allSkills,
    codingSkills,
    getCustomSkills: () => customSkills,
    setCustomSkills: (skills) => { customSkills = skills; },
    saveCustomSkills,
    getWorkflows: allWorkflows,
    setCustomWorkflows: (items) => { customWorkflows = items; },
    saveCustomWorkflows: (items) => saveCustomWorkflows(dataDir, items),
    getCronTriggers: () => cronTriggers,
    setCronTriggers: (items) => { cronTriggers = items; },
    saveCronTriggers,
    getTasks: () => tasks,
    createTaskFromText,
    scheduleFromText,
    setProactivePaused: (paused) => {
      if (config) {
        config.proactive = {...(config.proactive || {enabled: true, bedtimeHour: 23}), paused};
      }
    },
    triggerProactive: async (reason) => {
      try {
        // Lightweight manual impulse via proactive engine path if available
        const item = {
          id: randomUUID(),
          type: 'manual',
          body: reason,
          reason,
          origin: 'system' as const,
          state: 'unread',
          ts: Math.floor(Date.now() / 1000),
          delivered: true,
        };
        broadcast({type: 'proactive.impulse', item});
        broadcast({type: 'proactive.inbox.updated', item});
        return `已触发主动消息：${reason}`;
      } catch (error) {
        return `触发失败：${error instanceof Error ? error.message : String(error)}`;
      }
    },
    onSessionPlanUpdated: (plan) => broadcast({type: 'session_plan.updated', plan}),
    onSkillsUpdated: (skills) => broadcast({type: 'skill.updated', id: 'slash', skills}),
    onCronUpdated: (triggers) => broadcast({type: 'cron.config', id: 'slash', triggers}),
    onProactiveConfigUpdated: (paused) => {
      if (config?.proactive) {
        broadcast({
          type: 'proactive.config',
          id: 'slash',
          enabled: config.proactive.enabled !== false,
          paused,
          bedtimeHour: config.proactive.bedtimeHour ?? 23,
        });
      }
    },
    onTaskChanged: (task) => {
      saveTasks();
      announceTask(task);
    },
    conversationId: ctx?.conversationId,
    workspace: ctx?.workspace,
    projectName: ctx?.projectName,
  };
}
const execFileAsync = promisify(execFile);
let mcpServers = loadMcpServers();

/** Built-in desktop tools + enabled MCP tools. Catalog must match what runCompanionToolLoop can execute. */
type CompanionTool = {
  serverId: string;
  serverName: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  kind: 'desktop' | 'mcp' | 'pattern';
};
const PATTERN_SERVER_ID = 'pattern';

const DESKTOP_SERVER_ID = 'desktop';

function listDesktopTools(): CompanionTool[] {
  if (!bridgeReady()) return [];
  return [
    {
      serverId: DESKTOP_SERVER_ID,
      serverName: 'OS Bridge',
      name: 'launch',
      description: 'Launch a common local app. Prefer known ids: notepad, calc, calculator, explorer, cmd, powershell, browser, settings, paint, snippingtool. Or pass a shell target in {command}.',
      inputSchema: {
        type: 'object',
        properties: {
          app: {type: 'string', description: 'Known app id (notepad, calc, explorer, ...)'},
          command: {type: 'string', description: 'Fallback shell command / executable path'},
        },
      },
      kind: 'desktop',
    },
    {
      serverId: DESKTOP_SERVER_ID,
      serverName: 'OS Bridge',
      name: 'key',
      description: 'Press a key or chord. Use key=win for Start menu. Optional modifiers: ctrl, alt, shift, win.',
      inputSchema: {
        type: 'object',
        properties: {
          key: {type: 'string'},
          modifiers: {type: 'array', items: {type: 'string'}},
        },
        required: ['key'],
      },
      kind: 'desktop',
    },
    {
      serverId: DESKTOP_SERVER_ID,
      serverName: 'OS Bridge',
      name: 'type',
      description: 'Type text into the focused window.',
      inputSchema: {type: 'object', properties: {text: {type: 'string'}}, required: ['text']},
      kind: 'desktop',
    },
    {
      serverId: DESKTOP_SERVER_ID,
      serverName: 'OS Bridge',
      name: 'click',
      description: 'Click at absolute screen coordinates. Optional button: left|right|middle.',
      inputSchema: {
        type: 'object',
        properties: {
          x: {type: 'number'},
          y: {type: 'number'},
          button: {type: 'string'},
        },
        required: ['x', 'y'],
      },
      kind: 'desktop',
    },
    {
      serverId: DESKTOP_SERVER_ID,
      serverName: 'OS Bridge',
      name: 'scroll',
      description: 'Scroll. amount is signed; axis optional: vertical|horizontal.',
      inputSchema: {
        type: 'object',
        properties: {
          amount: {type: 'number'},
          axis: {type: 'string'},
        },
        required: ['amount'],
      },
      kind: 'desktop',
    },
    {
      serverId: DESKTOP_SERVER_ID,
      serverName: 'OS Bridge',
      name: 'foreground',
      description: 'Read the current foreground window title.',
      inputSchema: {type: 'object', properties: {}},
      kind: 'desktop',
    },
    {
      serverId: DESKTOP_SERVER_ID,
      serverName: 'OS Bridge',
      name: 'focus',
      description: 'Try to bring a window to the foreground by title hints (e.g. Calculator/计算器). Useful after launch when Pattern still owns focus.',
      inputSchema: {
        type: 'object',
        properties: {
          title: {type: 'string'},
          hints: {type: 'array', items: {type: 'string'}},
          app: {type: 'string'},
        },
      },
      kind: 'desktop',
    },
    {
      serverId: DESKTOP_SERVER_ID,
      serverName: 'OS Bridge',
      name: 'accessibility_tree',
      description: 'Read accessibility / UIA controls of the foreground window.',
      inputSchema: {type: 'object', properties: {}},
      kind: 'desktop',
    },
    {
      serverId: DESKTOP_SERVER_ID,
      serverName: 'OS Bridge',
      name: 'accessibility_action',
      description: 'Invoke or setValue on an accessibility control. action: invoke|setValue. Prefer ref/automationId/name from accessibility_tree.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {type: 'string'},
          ref: {type: 'string'},
          automationId: {type: 'string'},
          name: {type: 'string'},
          value: {type: 'string'},
        },
        required: ['action'],
      },
      kind: 'desktop',
    },
    {
      serverId: DESKTOP_SERVER_ID,
      serverName: 'OS Bridge',
      name: 'screenshot',
      description: 'Capture a screenshot. Returns path metadata only (not full image bytes) for receipts.',
      inputSchema: {type: 'object', properties: {}},
      kind: 'desktop',
    },
    {
      serverId: DESKTOP_SERVER_ID,
      serverName: 'OS Bridge',
      name: 'computer_use',
      description: 'REQUIRED entry point for Computer Use mode. After enter, the runtime runs a closed loop that each step auto-injects foreground + screenshot + UIA control tree and decides actions. Use for any multi-step UI goal (open app then operate, calculate, fill forms). Do NOT try to assemble multi-step UI with bare launch/foreground/accessibility_tree — enter this mode first. arguments.goal required.',
      inputSchema: {
        type: 'object',
        properties: {
          goal: {type: 'string', description: 'What to accomplish on the desktop'},
          app: {type: 'string', description: 'Optional app hint (calc, notepad, ...)'},
          title: {type: 'string', description: 'Optional task title'},
        },
        required: ['goal'],
      },
      kind: 'desktop',
    },
  ];
}

function listMcpCompanionTools(): CompanionTool[] {
  return mcpServers
    .filter((server) => server.enabled && (server.tools?.length || server.toolSchemas?.length))
    .flatMap((server) => {
      if (server.toolSchemas?.length) {
        return server.toolSchemas.map((tool) => ({
          serverId: server.id,
          serverName: server.name,
          name: tool.name,
          description: tool.description || `${server.name}/${tool.name}`,
          inputSchema: tool.inputSchema || {type: 'object', properties: {}},
          kind: 'mcp' as const,
        }));
      }
      return (server.tools || []).map((name) => ({
        serverId: server.id,
        serverName: server.name,
        name,
        description: `${server.name}/${name}`,
        inputSchema: {type: 'object', properties: {}},
        kind: 'mcp' as const,
      }));
    });
}

function listPatternTools(): CompanionTool[] {
  const str = {type: 'string'};
  const planItem = {
    type: 'object',
    properties: {
      id: str,
      content: str,
      status: {type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled']},
    },
  };
  /** Agent-callable tools mapped 1:1 onto slash commands for natural-language use. */
  return [
    // --- /goal ---
    {
      serverId: PATTERN_SERVER_ID,
      serverName: 'Pattern Runtime',
      name: 'create_goal',
      description: '创建 run-until-done 目标（/goal）。用户说「设定目标」「一直做到…完成」时调用。',
      inputSchema: {type: 'object', properties: {objective: str, goal: str, text: str}},
      kind: 'pattern',
    },
    {
      serverId: PATTERN_SERVER_ID,
      serverName: 'Pattern Runtime',
      name: 'update_goal',
      description: '更新当前目标进度：追加 progress 文案、completed=true 标记完成、blocked_reason 标记阻塞。执行多步目标时持续调用。',
      inputSchema: {
        type: 'object',
        properties: {message: str, completed: {type: 'boolean'}, blocked_reason: str, status: str},
      },
      kind: 'pattern',
    },
    {
      serverId: PATTERN_SERVER_ID,
      serverName: 'Pattern Runtime',
      name: 'control_goal',
      description: '控制当前目标：pause / resume / clear / complete（对应 /goal pause|resume|clear）。',
      inputSchema: {
        type: 'object',
        properties: {action: {type: 'string', enum: ['pause', 'resume', 'clear', 'complete', 'status']}},
        required: ['action'],
      },
      kind: 'pattern',
    },
    {
      serverId: PATTERN_SERVER_ID,
      serverName: 'Pattern Runtime',
      name: 'get_goal',
      description: '查看当前/全部目标状态（/goal status）。',
      inputSchema: {type: 'object', properties: {all: {type: 'boolean'}}},
      kind: 'pattern',
    },
    // --- /plan ---
    {
      serverId: PATTERN_SERVER_ID,
      serverName: 'Pattern Runtime',
      name: 'create_plan',
      description: '写入当前会话 plan 待办清单（/plan）。多步任务开始前拆步骤；会替换整份清单。',
      inputSchema: {
        type: 'object',
        properties: {
          text: str,
          title: str,
          items: {type: 'array', items: planItem},
          steps: {type: 'array', items: str},
        },
      },
      kind: 'pattern',
    },
    {
      serverId: PATTERN_SERVER_ID,
      serverName: 'Pattern Runtime',
      name: 'update_plan',
      description: '更新会话 plan 待办：标记 in_progress/completed。多步执行中持续调用以刷新顶栏进度。',
      inputSchema: {
        type: 'object',
        properties: {
          title: str,
          merge: {type: 'boolean', description: 'true=按 id 合并；false=整表替换'},
          items: {type: 'array', items: {...planItem, required: ['content']}},
        },
        required: ['items'],
      },
      kind: 'pattern',
    },
    {
      serverId: PATTERN_SERVER_ID,
      serverName: 'Pattern Runtime',
      name: 'get_plan',
      description: '读取当前会话 plan 待办（/plan status）。',
      inputSchema: {type: 'object', properties: {}},
      kind: 'pattern',
    },
    {
      serverId: PATTERN_SERVER_ID,
      serverName: 'Pattern Runtime',
      name: 'clear_plan',
      description: '清空当前会话 plan（/plan clear）。',
      inputSchema: {type: 'object', properties: {}},
      kind: 'pattern',
    },
    // --- /skill ---
    {
      serverId: PATTERN_SERVER_ID,
      serverName: 'Pattern Runtime',
      name: 'create_skill',
      description: '创建可复用技能（/skill 名称|描述|提示词）。用户说「做一个技能」「保存为技能」时调用。',
      inputSchema: {
        type: 'object',
        properties: {name: str, description: str, prompt: str, kind: str},
        required: ['name', 'prompt'],
      },
      kind: 'pattern',
    },
    {
      serverId: PATTERN_SERVER_ID,
      serverName: 'Pattern Runtime',
      name: 'list_skills',
      description: '列出已安装技能（/skill list）。',
      inputSchema: {type: 'object', properties: {}},
      kind: 'pattern',
    },
    {
      serverId: PATTERN_SERVER_ID,
      serverName: 'Pattern Runtime',
      name: 'run_skill',
      description: '按技能名运行一轮并创建任务（/skill run 名称 目标）。',
      inputSchema: {
        type: 'object',
        properties: {name: str, skill: str, goal: str, body: str},
        required: ['name'],
      },
      kind: 'pattern',
    },
    // --- /loop ---
    {
      serverId: PATTERN_SERVER_ID,
      serverName: 'Pattern Runtime',
      name: 'create_loop',
      description: '创建循环任务（/loop 30m …）。用户说「每隔…做一次」「定时巡检」时调用。',
      inputSchema: {
        type: 'object',
        properties: {prompt: str, text: str, intervalMinutes: {type: 'number'}, interval: str},
        required: ['prompt'],
      },
      kind: 'pattern',
    },
    {
      serverId: PATTERN_SERVER_ID,
      serverName: 'Pattern Runtime',
      name: 'list_loops',
      description: '列出循环任务与每日提醒（/loop list）。',
      inputSchema: {type: 'object', properties: {}},
      kind: 'pattern',
    },
    {
      serverId: PATTERN_SERVER_ID,
      serverName: 'Pattern Runtime',
      name: 'delete_loop',
      description: '取消循环任务（/loop delete <id>）。',
      inputSchema: {type: 'object', properties: {id: str, taskId: str}, required: ['id']},
      kind: 'pattern',
    },
    // --- /task ---
    {
      serverId: PATTERN_SERVER_ID,
      serverName: 'Pattern Runtime',
      name: 'create_task',
      description: '创建桌面执行/Computer Use 任务（/task）。用户说「帮我做」「打开…并…」时创建任务。',
      inputSchema: {type: 'object', properties: {title: str, detail: str, goal: str}, required: ['title']},
      kind: 'pattern',
    },
    {
      serverId: PATTERN_SERVER_ID,
      serverName: 'Pattern Runtime',
      name: 'list_tasks',
      description: '列出最近任务（排队/执行/定时/完成）。',
      inputSchema: {type: 'object', properties: {limit: {type: 'number'}}},
      kind: 'pattern',
    },
    // --- /remind ---
    {
      serverId: PATTERN_SERVER_ID,
      serverName: 'Pattern Runtime',
      name: 'create_reminder',
      description: '创建每日 HH:MM 系统提醒（/remind）。用户说「每天 xx:xx 提醒我…」时调用。',
      inputSchema: {
        type: 'object',
        properties: {time: str, message: str, text: str},
        required: ['time', 'message'],
      },
      kind: 'pattern',
    },
    {
      serverId: PATTERN_SERVER_ID,
      serverName: 'Pattern Runtime',
      name: 'list_reminders',
      description: '列出每日提醒（cron）。',
      inputSchema: {type: 'object', properties: {}},
      kind: 'pattern',
    },
    {
      serverId: PATTERN_SERVER_ID,
      serverName: 'Pattern Runtime',
      name: 'delete_reminder',
      description: '删除一条每日提醒（按 id 或时间+文案匹配）。',
      inputSchema: {type: 'object', properties: {id: str, time: str, message: str}},
      kind: 'pattern',
    },
    // --- /proactive ---
    {
      serverId: PATTERN_SERVER_ID,
      serverName: 'Pattern Runtime',
      name: 'trigger_proactive',
      description: '主动消息控制：action=trigger|pause|resume（/proactive）。用户说「暂停主动」「现在关心我一下」时调用。',
      inputSchema: {
        type: 'object',
        properties: {
          action: {type: 'string', enum: ['trigger', 'pause', 'resume']},
          reason: str,
        },
      },
      kind: 'pattern',
    },
    // --- /workflow ---
    {
      serverId: PATTERN_SERVER_ID,
      serverName: 'Pattern Runtime',
      name: 'create_workflow',
      description: '用技能 id 组合创建工作流。',
      inputSchema: {
        type: 'object',
        properties: {
          name: str,
          description: str,
          skillIds: {type: 'array', items: str},
          mode: {type: 'string', enum: ['serial', 'parallel-read', 'peer-discussion']},
          maxAgents: {type: 'number'},
        },
        required: ['name', 'skillIds'],
      },
      kind: 'pattern',
    },
    {
      serverId: PATTERN_SERVER_ID,
      serverName: 'Pattern Runtime',
      name: 'list_workflows',
      description: '列出工作流（/workflow list）。',
      inputSchema: {type: 'object', properties: {}},
      kind: 'pattern',
    },
    {
      serverId: PATTERN_SERVER_ID,
      serverName: 'Pattern Runtime',
      name: 'run_workflow',
      description: '按 id/名称运行工作流（/workflow run）。',
      inputSchema: {
        type: 'object',
        properties: {workflowId: str, id: str, input: str, goal: str},
        required: ['workflowId'],
      },
      kind: 'pattern',
    },
    // --- Pattern Engine (explainability: "why do you think this?") ---
    {
      serverId: PATTERN_SERVER_ID,
      serverName: 'Pattern Runtime',
      name: 'list_patterns',
      description: '列出对用户已形成的长期 Pattern（行为/习惯/偏好等长期认识），可按状态过滤。当用户问「你怎么看我」「你了解我什么」时使用。',
      inputSchema: {type: 'object', properties: {status: str, category: str, limit: {type: 'number'}}},
      kind: 'pattern',
    },
    {
      serverId: PATTERN_SERVER_ID,
      serverName: 'Pattern Runtime',
      name: 'search_patterns',
      description: '按主题检索相关 Pattern（如 睡眠/工作/饮食）。',
      inputSchema: {type: 'object', properties: {query: str}, required: ['query']},
      kind: 'pattern',
    },
    {
      serverId: PATTERN_SERVER_ID,
      serverName: 'Pattern Runtime',
      name: 'explain_pattern',
      description: '解释为什么形成某个 Pattern：返回该 Pattern 的全部证据（支持/反对的原始记忆）。当用户问「你为什么觉得我…」「凭什么这么说」时必须调用，用真实证据回答而不是笼统地说「AI 推断」。',
      inputSchema: {type: 'object', properties: {patternId: str, query: str}},
      kind: 'pattern',
    },
  ];
}

function listCompanionTools(): CompanionTool[] {
  return [...listPatternTools(), ...listDesktopTools(), ...listMcpCompanionTools()];
}

function companionToolCatalogText(tools: CompanionTool[]) {
  if (!tools.length) {
    return [
      '当前没有可用工具。',
      bridgeReady()
        ? '- OS Bridge 已连接，但桌面工具未列出（异常）；请重试。'
        : '- OS Bridge 未连接：桌面键鼠/无障碍/截屏不可用。请在桌面端启动 Pattern 并确认 Bridge。',
      '- 已启用的 MCP 工具：无。可在「工具」页添加并启用 MCP。',
      '在工具可用之前，禁止假装已经打开应用、按键或调用 MCP。',
    ].join('\n');
  }
  const pattern = tools.filter((t) => t.kind === 'pattern');
  const desktop = tools.filter((t) => t.kind === 'desktop');
  const mcp = tools.filter((t) => t.kind === 'mcp');
  const lines: string[] = [];
  if (pattern.length) {
    lines.push('Pattern runtime tools (serverId=\"pattern\") — natural language OR slash /goal /plan /skill /loop /task /remind /proactive /workflow:');
    for (const tool of pattern) {
      lines.push(`- serverId=pattern tool=${tool.name} — ${tool.description}`);
    }
  }
  if (desktop.length) {
    lines.push('Desktop tools (use serverId=\"desktop\" and tool short name only):');
    for (const tool of desktop) {
      lines.push(`- serverId=desktop tool=${tool.name} — ${tool.description} schema=${JSON.stringify(tool.inputSchema).slice(0, 400)}`);
    }
  } else {
    lines.push('Desktop tools: unavailable (OS Bridge offline).');
  }
  if (mcp.length) {
    lines.push('MCP tools (use serverId + tool short name):');
    for (const tool of mcp) {
      lines.push(`- serverId=${tool.serverId} tool=${tool.name} — ${tool.description} schema=${JSON.stringify(tool.inputSchema).slice(0, 400)}`);
    }
  } else {
    lines.push('MCP tools: none enabled.');
  }
  lines.push('Slash shortcuts: /goal /skill /loop /plan /task /remind /proactive /workflow /help — also @skill:name @workflow:id');
  return lines.join('\n');
}

type CompanionToolCall = {serverId?: string; tool: string; arguments?: Record<string, unknown>};
type CompanionToolPlan = {toolCalls: CompanionToolCall[]; final?: string; content?: string};

/** Strip markdown fences / think tags often emitted by DeepSeek and similar models. */
function stripModelJsonWrappers(raw: string): string {
  return String(raw || '')
    .replace(/```(?:json|JSON)?\s*/g, '')
    .replace(/```/g, '')
    .replace(/<\/?think>/gi, '')
    .trim();
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {value: parsed};
  } catch {
    return {raw};
  }
}

function splitToolFunctionName(name: string): {serverId?: string; tool: string} {
  const cleaned = normalizeCompanionToolName(name);
  // desktop__launch or mcpServer__tool_name
  const dbl = cleaned.match(/^([a-z0-9_-]+)__(.+)$/i);
  if (dbl) return {serverId: dbl[1] === 'desktop' ? DESKTOP_SERVER_ID : dbl[1], tool: dbl[2]};
  const single = cleaned.match(/^(desktop|osbridge)[.:/](.+)$/i);
  if (single) return {serverId: DESKTOP_SERVER_ID, tool: single[2]};
  return {tool: cleaned};
}

function toolCallsFromOpenAiMessage(message: any): CompanionToolCall[] {
  const calls = message?.tool_calls || message?.toolCalls;
  if (!Array.isArray(calls) || !calls.length) return [];
  return calls.slice(0, 4).map((call: any) => {
    const fn = call?.function || call;
    const name = String(fn?.name || call?.name || '');
    const {serverId, tool} = splitToolFunctionName(name);
    return {
      serverId: call?.serverId || serverId,
      tool,
      arguments: parseToolArguments(fn?.arguments ?? call?.arguments ?? call?.args),
    };
  }).filter((call: CompanionToolCall) => !!call.tool);
}

/**
 * Extract a tool plan from free-form model text (JSON protocol).
 * Handles DeepSeek fences, nested braces, and alternate keys (tools / tool_call).
 */
function extractCompanionToolPlan(raw: string): CompanionToolPlan | null {
  const text = stripModelJsonWrappers(raw);
  if (!text) return null;
  // Prefer fenced or whole-object JSON containing toolCalls
  const candidates: string[] = [];
  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch) candidates.push(objectMatch[0]);
  // Also try each balanced-ish JSON object substring starting at toolCalls
  const idx = text.search(/"toolCalls"\s*:|"tools"\s*:|"tool_calls"\s*:/);
  if (idx >= 0) {
    const from = text.lastIndexOf('{', idx);
    if (from >= 0) candidates.push(text.slice(from));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!parsed || typeof parsed !== 'object') continue;
      const list = (parsed as any).toolCalls || (parsed as any).tools || (parsed as any).tool_calls;
      if (!Array.isArray(list) || !list.length) continue;
      const toolCalls: CompanionToolCall[] = list.slice(0, 4).map((call: any) => {
        if (typeof call === 'string') {
          const split = splitToolFunctionName(call);
          return {serverId: split.serverId, tool: split.tool, arguments: {}};
        }
        const name = String(call.tool || call.name || call.function?.name || '');
        const split = splitToolFunctionName(name);
        return {
          serverId: call.serverId || call.server || split.serverId,
          tool: split.tool || name,
          arguments: parseToolArguments(call.arguments ?? call.args ?? call.parameters ?? call.function?.arguments),
        };
      }).filter((call: CompanionToolCall) => !!call.tool);
      if (!toolCalls.length) continue;
      return {
        toolCalls,
        final: typeof (parsed as any).final === 'string' ? (parsed as any).final : undefined,
        content: typeof (parsed as any).content === 'string' ? (parsed as any).content : undefined,
      };
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

function companionToolsAsOpenAi(tools: CompanionTool[]) {
  return tools.slice(0, 40).map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.kind === 'desktop'
        ? `desktop__${tool.name}`
        : tool.kind === 'pattern'
          ? `pattern__${tool.name}`
          : `${tool.serverId}__${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64),
      description: tool.description.slice(0, 500),
      parameters: tool.inputSchema && typeof tool.inputSchema === 'object'
        ? tool.inputSchema
        : {type: 'object', properties: {}},
    },
  }));
}

async function executePatternTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx?: {conversationId?: string; workspace?: string; projectName?: string},
): Promise<unknown> {
  const name = normalizeCompanionToolName(toolName).replace(/^pattern_/, '').replace(/^pattern\./, '');
  const deps = makeSlashDeps(ctx);
  switch (name) {
    // ── skill ──
    case 'create_skill': {
      const skillName = String(args.name || '').trim();
      const prompt = String(args.prompt || args.body || '').trim();
      if (!skillName || !prompt) throw new Error('create_skill requires name and prompt');
      const message = await executeSlashCommand({
        kind: 'skill',
        action: 'create',
        name: skillName,
        body: `${String(args.description || skillName)}\n\n${prompt}`,
      }, deps);
      return {ok: true, message, skills: allSkills()};
    }
    case 'list_skills': {
      const skills = allSkills();
      return {
        ok: true,
        skills: skills.map((s) => ({id: s.id, name: s.name, description: s.description, kind: s.kind})),
        message: await executeSlashCommand({kind: 'skill', action: 'list'}, deps),
      };
    }
    case 'run_skill': {
      const skillName = String(args.name || args.skill || '').trim();
      if (!skillName) throw new Error('run_skill requires name');
      return {
        ok: true,
        message: await executeSlashCommand({
          kind: 'skill',
          action: 'run',
          name: skillName,
          body: String(args.goal || args.body || args.detail || '').trim() || undefined,
        }, deps),
      };
    }
    // ── task ──
    case 'create_task': {
      const title = String(args.title || args.goal || '').trim();
      if (!title) throw new Error('create_task requires title');
      const detail = String(args.detail || title);
      return {
        ok: true,
        message: await executeSlashCommand({kind: 'task', text: detail}, deps),
      };
    }
    case 'list_tasks': {
      const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
      const items = tasks.slice(0, limit).map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        schedule: t.schedule,
        nextRunAt: t.nextRunAt,
        createdAt: t.createdAt,
      }));
      return {ok: true, tasks: items, count: tasks.length};
    }
    // ── goal ──
    case 'create_goal': {
      const objective = String(args.objective || args.goal || args.text || '').trim();
      if (!objective) throw new Error('create_goal requires objective');
      const message = await executeSlashCommand({kind: 'goal', action: 'set', text: objective}, deps);
      const goals = loadGoals(dataDir);
      const goal = goals.find((g: GoalState) => g.status === 'active') || goals[0];
      if (goal) broadcast({type: 'goal.updated', goal, goals});
      return {ok: true, message, goal};
    }
    case 'update_goal': {
      const goals = loadGoals(dataDir);
      const current = goals.find((g) => g.status === 'active' || g.status === 'paused' || g.status === 'blocked');
      if (!current) return {ok: false, message: 'no active goal'};
      if (args.message) current.progress = [...(current.progress || []), String(args.message)].slice(-20);
      if (args.completed === true || args.status === 'done' || args.status === 'complete') current.status = 'done';
      if (args.status === 'paused') current.status = 'paused';
      if (args.status === 'active') current.status = 'active';
      if (args.blocked_reason) {
        current.status = 'blocked';
        current.blockedReason = String(args.blocked_reason);
      }
      current.updatedAt = Date.now();
      saveGoals(dataDir, goals);
      broadcast({type: 'goal.updated', goal: current, goals});
      return {ok: true, goal: current};
    }
    case 'control_goal': {
      const action = String(args.action || 'status').toLowerCase();
      if (action === 'status') {
        return {
          ok: true,
          message: await executeSlashCommand({kind: 'goal', action: 'status'}, deps),
          goals: loadGoals(dataDir),
        };
      }
      const mapped = (['pause', 'resume', 'clear', 'complete'].includes(action) ? action : '') as
        | 'pause' | 'resume' | 'clear' | 'complete' | '';
      if (!mapped) throw new Error('control_goal action must be pause|resume|clear|complete|status');
      if (mapped === 'complete') {
        // slash goal has no complete action — use update path
        const goals = loadGoals(dataDir);
        const current = goals.find((g) => g.status === 'active' || g.status === 'paused' || g.status === 'blocked');
        if (!current) return {ok: false, message: 'no active goal'};
        current.status = 'done';
        current.progress = [...(current.progress || []), `已标记完成 · ${new Date().toLocaleString('zh-CN')}`].slice(-20);
        current.updatedAt = Date.now();
        saveGoals(dataDir, goals);
        broadcast({type: 'goal.updated', goal: current, goals});
        return {ok: true, goal: current, message: `已完成目标：${current.objective}`};
      }
      const message = await executeSlashCommand({kind: 'goal', action: mapped}, deps);
      const goals = loadGoals(dataDir);
      const goal = goals.find((g) => g.status === 'active' || g.status === 'paused' || g.status === 'blocked' || g.status === 'cleared' || g.status === 'done');
      if (goal) broadcast({type: 'goal.updated', goal, goals});
      return {ok: true, message, goals};
    }
    case 'get_goal': {
      const goals = loadGoals(dataDir);
      if (args.all) return {ok: true, goals};
      const current = goals.find((g) => g.status === 'active' || g.status === 'paused' || g.status === 'blocked') || null;
      return {
        ok: true,
        goal: current,
        message: await executeSlashCommand({kind: 'goal', action: 'status'}, deps),
      };
    }
    // ── loop ──
    case 'create_loop': {
      const prompt = String(args.prompt || args.text || '').trim();
      if (!prompt) throw new Error('create_loop requires prompt');
      let interval = String(args.interval || '').trim();
      if (!interval) {
        const minutes = Number(args.intervalMinutes || args.minutes || 60);
        interval = `${Math.max(1, minutes)}m`;
      }
      return {
        ok: true,
        message: await executeSlashCommand({kind: 'loop', action: 'create', interval, prompt}, deps),
      };
    }
    case 'list_loops': {
      return {
        ok: true,
        message: await executeSlashCommand({kind: 'loop', action: 'list'}, deps),
        loops: tasks
          .filter((t) => t.schedule?.kind === 'interval' && t.schedule.enabled !== false)
          .map((t) => ({id: t.id, title: t.title, intervalMinutes: t.schedule?.intervalMinutes, status: t.status})),
        reminders: cronTriggers.filter((c) => c.enabled),
      };
    }
    case 'delete_loop': {
      const id = String(args.id || args.taskId || '').trim();
      if (!id) throw new Error('delete_loop requires id');
      return {
        ok: true,
        message: await executeSlashCommand({kind: 'loop', action: 'delete', id}, deps),
      };
    }
    // ── reminder ──
    case 'create_reminder': {
      const time = String(args.time || '').trim();
      const message = String(args.message || args.text || '').trim();
      if (!time || !message) throw new Error('create_reminder requires time and message');
      return {ok: true, message: await executeSlashCommand({kind: 'remind', time, message}, deps)};
    }
    case 'list_reminders': {
      return {ok: true, triggers: cronTriggers, message: await executeSlashCommand({kind: 'loop', action: 'list'}, deps)};
    }
    case 'delete_reminder': {
      const id = String(args.id || '').trim();
      const time = String(args.time || '').trim();
      const message = String(args.message || '').trim();
      if (!id && !time && !message) throw new Error('delete_reminder requires id or time/message');
      const before = cronTriggers.length;
      cronTriggers = cronTriggers.filter((t) => {
        if (id) return t.id !== id && !t.id.startsWith(id);
        const matchTime = time ? t.time === time : true;
        const matchMsg = message ? t.message.includes(message) : true;
        return !(matchTime && matchMsg);
      });
      saveCronTriggers();
      broadcast({type: 'cron.config', id: 'pattern', triggers: cronTriggers});
      return {
        ok: true,
        triggers: cronTriggers,
        removed: before - cronTriggers.length,
        message: before === cronTriggers.length ? '未匹配到提醒' : `已删除 ${before - cronTriggers.length} 条提醒`,
      };
    }
    // ── workflow ──
    case 'create_workflow': {
      const wfName = String(args.name || '').trim();
      const skillIds = Array.isArray(args.skillIds) ? args.skillIds.map(String) : String(args.skillIds || '').split(/[,\s]+/).filter(Boolean);
      if (!wfName || !skillIds.length) throw new Error('create_workflow requires name and skillIds');
      const wf: WorkflowDefinition = {
        id: wfName.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-').slice(0, 48) || randomUUID().slice(0, 8),
        name: wfName.slice(0, 80),
        description: String(args.description || wfName).slice(0, 400),
        skillIds: skillIds.slice(0, 20),
        mode: (['serial', 'parallel-read', 'peer-discussion'].includes(String(args.mode))
          ? String(args.mode)
          : 'serial') as WorkflowDefinition['mode'],
        maxAgents: Math.max(1, Math.min(32, Number(args.maxAgents) || skillIds.length || 1)),
      };
      const next = [wf, ...customWorkflows.filter((item) => item.id !== wf.id)].slice(0, 50);
      persistCustomWorkflows(next);
      return {ok: true, workflow: wf, workflows: allWorkflows()};
    }
    case 'list_workflows': {
      const workflows = allWorkflows();
      return {
        ok: true,
        workflows,
        message: await executeSlashCommand({kind: 'workflow', action: 'list'}, deps),
      };
    }
    case 'run_workflow': {
      const workflowId = String(args.workflowId || args.id || '').trim();
      const input = String(args.input || args.goal || '').trim();
      if (!workflowId) throw new Error('run_workflow requires workflowId');
      return {
        ok: true,
        message: await executeSlashCommand({kind: 'workflow', action: 'run', id: workflowId, input: input || undefined}, deps),
      };
    }
    // ── proactive ──
    case 'trigger_proactive': {
      const action = String(args.action || 'trigger').toLowerCase();
      if (action === 'pause') return {ok: true, message: await executeSlashCommand({kind: 'proactive', action: 'pause'}, deps)};
      if (action === 'resume') return {ok: true, message: await executeSlashCommand({kind: 'proactive', action: 'resume'}, deps)};
      return {
        ok: true,
        message: await executeSlashCommand({
          kind: 'proactive',
          action: 'trigger',
          reason: String(args.reason || '自然语言触发'),
        }, deps),
      };
    }
    // ── plan ──
    case 'get_plan': {
      const conversationId = String(ctx?.conversationId || deps.conversationId || '').trim();
      if (!conversationId) return {ok: true, plan: null, message: '无会话，尚无 plan'};
      const plan = getSessionPlan(dataDir, conversationId);
      return {ok: true, plan, message: formatSessionPlan(plan)};
    }
    case 'clear_plan': {
      const conversationId = String(ctx?.conversationId || deps.conversationId || '').trim();
      if (!conversationId) throw new Error('clear_plan requires an active conversation');
      const plan = clearSessionPlan(dataDir, conversationId);
      broadcast({type: 'session_plan.updated', plan});
      return {ok: true, plan, message: '已清空当前会话计划'};
    }
    case 'create_plan':
    case 'update_plan': {
      const conversationId = String(ctx?.conversationId || deps.conversationId || '').trim();
      if (!conversationId) throw new Error('session plan requires an active conversation');
      const merge = name === 'update_plan' ? args.merge !== false : false;
      let items: Array<Partial<SessionPlanItem> & {content?: string}> = [];
      if (Array.isArray(args.items) && args.items.length) {
        items = args.items.map((raw: any) => ({
          id: raw?.id ? String(raw.id) : undefined,
          content: String(raw?.content || raw?.title || raw?.text || ''),
          status: raw?.status,
        }));
      } else {
        const text = String(args.text || args.plan || '').trim();
        const steps = Array.isArray(args.steps) ? args.steps.map(String) : [];
        const lines = steps.length ? steps : text.split(/\n+/);
        items = lines
          .map((line: string) => String(line).replace(/^\d+[.)、]\s*/, '').replace(/^[-*•]\s+/, '').trim())
          .filter(Boolean)
          .map((content: string) => ({content, status: 'pending' as const}));
        if (text && !steps.length && items.length <= 1) {
          items = [{content: text.slice(0, 400), status: 'pending'}];
        }
      }
      if (!items.length) throw new Error('update_plan requires items (or text/steps)');
      const plan = setSessionPlan(dataDir, conversationId, items, {
        title: args.title ? String(args.title) : undefined,
        merge: name === 'create_plan' ? false : merge,
      });
      broadcast({type: 'session_plan.updated', plan});
      return {ok: true, plan, message: formatSessionPlan(plan)};
    }
    // ── Pattern Engine ──
    case 'list_patterns': {
      const items = memory.patterns.list({
        status: args.status ? String(args.status) : null,
        category: args.category ? String(args.category) : null,
        limit: Math.max(1, Math.min(50, Number(args.limit) || 20)),
      });
      if (!items.length) return {ok: true, patterns: [], message: '目前还没有形成稳定的 Pattern。'};
      const lines = items.map((p) => `- [${p.status} conf=${p.confidence.toFixed(2)}] ${p.text}`);
      return {ok: true, patterns: items, message: lines.join('\n')};
    }
    case 'search_patterns': {
      const query = String(args.query || args.text || '').trim();
      if (!query) throw new Error('search_patterns requires query');
      const hits = memory.patterns.search(query, 6);
      if (!hits.length) return {ok: true, patterns: [], message: `没有找到与「${query}」相关的 Pattern。`};
      const lines = hits.map((p) => `- [${p.status} conf=${p.confidence.toFixed(2)}] ${p.text}`);
      return {ok: true, patterns: hits.map(({score: _s, ...item}) => item), message: lines.join('\n')};
    }
    case 'explain_pattern': {
      // Resolve pattern by explicit id or by best text match, then return full evidence
      // with original memory texts so the model can answer "why do you think this?".
      const patternId = String(args.patternId || args.pattern_id || '').trim();
      const query = String(args.query || args.text || '').trim();
      const pattern = patternId
        ? memory.patterns.getWithEvidence(patternId)
        : (() => {
            const best = memory.patterns.search(query, 1)[0];
            return best ? memory.patterns.getWithEvidence(best.id) : null;
          })();
      if (!pattern) {
        return {ok: false, pattern: null, message: '没有找到该 Pattern，无法解释。请如实告知用户目前没有这条认识。'};
      }
      const evidenceLines = pattern.evidence.map((e) => {
        const source = memory.get(e.memoryId);
        const when = new Date(e.createdAt * 1000).toLocaleDateString('zh-CN');
        return `- ${e.relation === 'supports' ? '支持' : '反对'} (${when}): ${source?.text || '(原始记忆已失效)'}`;
      });
      const message = [
        `Pattern: ${pattern.text} [status=${pattern.status}, confidence=${pattern.confidence.toFixed(2)}]`,
        evidenceLines.length ? '证据：' : '（暂无关联证据）',
        ...evidenceLines,
      ].join('\n');
      return {ok: true, pattern, message};
    }
    default:
      throw new Error(`未知 Pattern 工具: ${toolName}`);
  }
}

function resolveCompanionServerId(
  call: {serverId?: string; tool?: string},
  toolName: string,
  tools: CompanionTool[],
): string {
  const rawTool = String(call.tool || '');
  if (call.serverId) return String(call.serverId);
  if (/^desktop[.:]/i.test(rawTool)) return DESKTOP_SERVER_ID;
  const hit = tools.find((t) => t.name === toolName);
  return hit?.serverId || '';
}

const DESKTOP_APP_COMMANDS: Record<string, string> = {
  notepad: 'notepad',
  calc: 'calc',
  calculator: 'calc',
  explorer: 'explorer',
  cmd: 'cmd',
  powershell: 'powershell',
  terminal: 'wt',
  browser: 'start https://',
  edge: 'msedge',
  chrome: 'chrome',
  settings: 'ms-settings:',
  paint: 'mspaint',
  snippingtool: 'snippingtool',
  snip: 'snippingtool',
};

function sleepMs(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DESKTOP_FOCUS_HINTS: Record<string, string[]> = {
  notepad: ['Notepad', '无事本'],
  calc: ['Calculator', '计算器'],
  calculator: ['Calculator', '计算器'],
  explorer: ['File Explorer', '文件资源管理器'],
  cmd: ['Command Prompt', 'cmd.exe', '命令提示符'],
  powershell: ['PowerShell', 'Windows PowerShell'],
  terminal: ['Terminal', 'Windows Terminal'],
  edge: ['Microsoft Edge', 'Edge'],
  chrome: ['Google Chrome', 'Chrome'],
  settings: ['Settings', '设置'],
  paint: ['Paint', '画图'],
  snippingtool: ['Snipping Tool', '截图工具'],
  snip: ['Snipping Tool', '截图工具'],
  browser: ['Edge', 'Chrome', 'Firefox', '浏览器'],
};

async function focusWindowByHints(hints: string[]): Promise<{ok: boolean; method?: string; matched?: string; error?: string}> {
  const cleaned = hints.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 8);
  if (!cleaned.length) return {ok: false, error: 'no focus hints'};
  try {
    if (process.platform === 'win32') {
      // WScript.Shell AppActivate is the lightest reliable focus helper without a new Bridge endpoint.
      const list = cleaned.map((h) => `'${h.replace(/'/g, "''")}'`).join(',');
      const ps = [
        `$w = New-Object -ComObject WScript.Shell`,
        `$hints = @(${list})`,
        `$ok = $false`,
        `$matched = ''`,
        `foreach ($h in $hints) { if ($w.AppActivate($h)) { $ok = $true; $matched = $h; break } }`,
        `if ($ok) { Write-Output ("MATCH:" + $matched) } else { Write-Output "MISS" }`,
      ].join('; ');
      const {stdout} = await execFileAsync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
        windowsHide: true,
        timeout: 5000,
      });
      const line = String(stdout || '').trim();
      if (line.startsWith('MATCH:')) return {ok: true, method: 'AppActivate', matched: line.slice(6)};
      return {ok: false, method: 'AppActivate', error: 'no matching window title'};
    }
    if (process.platform === 'darwin') {
      const appName = cleaned[0];
      await execFileAsync('osascript', ['-e', `tell application "${appName.replace(/"/g, '\\"')}" to activate`], {timeout: 5000});
      return {ok: true, method: 'osascript', matched: appName};
    }
    return {ok: false, error: 'focus not implemented on this platform'};
  } catch (error) {
    return {ok: false, error: error instanceof Error ? error.message : String(error)};
  }
}

function summarizeAccessibilityTree(tree: any, limit = 40) {
  const controls = Array.isArray(tree?.controls) ? tree.controls : [];
  const useful = controls
    .filter((item: any) => item && (item.name || item.automationId || item.controlType))
    .slice(0, limit)
    .map((item: any) => ({
      ref: item.ref,
      name: item.name,
      automationId: item.automationId,
      controlType: item.controlType,
      enabled: item.enabled,
    }));
  return {
    supported: tree?.supported !== false,
    total: controls.length,
    shown: useful.length,
    controls: useful,
    note: controls.length > useful.length ? `truncated ${useful.length}/${controls.length} controls for model context` : undefined,
  };
}

async function readDesktopUiContext(options: {focusHints?: string[]; waitMs?: number} = {}) {
  if (options.waitMs) await sleepMs(options.waitMs);
  let focus: Awaited<ReturnType<typeof focusWindowByHints>> | undefined;
  if (options.focusHints?.length) {
    focus = await focusWindowByHints(options.focusHints);
    await sleepMs(250);
  }
  const foreground = bridgeReady() ? await bridgeCall('/foreground', undefined, true) : null;
  let accessibility: any = null;
  let treeSummary: any = null;
  if (bridgeReady()) {
    try {
      accessibility = await bridgeCall('/accessibility/tree', undefined, true);
      treeSummary = summarizeAccessibilityTree(accessibility);
    } catch (error) {
      treeSummary = {supported: false, error: error instanceof Error ? error.message : String(error)};
    }
  }
  const title = String(foreground?.title || '');
  return {
    focus,
    foreground: foreground || {title: ''},
    accessibility: treeSummary,
    warning:
      title && /pattern/i.test(title)
        ? 'Foreground is still Pattern. Do not claim you operated the target app UI until focus/tree shows the target.'
        : undefined,
  };
}

async function launchDesktopApp(args: Record<string, unknown>): Promise<unknown> {
  const app = String(args.app || args.name || '').trim().toLowerCase();
  const command = String(args.command || args.cmd || '').trim();
  let target = command || (app ? DESKTOP_APP_COMMANDS[app] : '');
  if (!target && app) {
    // Unknown id: try as executable / shell open name
    target = app;
  }
  if (!target) throw new Error('launch requires app or command');
  if (process.platform === 'win32') {
    if (target.startsWith('ms-settings:') || target.startsWith('http')) {
      await execFileAsync('cmd', ['/c', 'start', '', target], {windowsHide: true});
    } else if (target === 'start https://') {
      await execFileAsync('cmd', ['/c', 'start', '', 'https://www.bing.com'], {windowsHide: true});
    } else {
      // `start` allows shell apps like notepad/calc without waiting
      await execFileAsync('cmd', ['/c', 'start', '', target], {windowsHide: true});
    }
  } else if (process.platform === 'darwin') {
    await execFileAsync('open', [target.startsWith('/') ? target : `-a`, target].filter(Boolean) as string[]);
  } else {
    await execFileAsync('xdg-open', [target]);
  }

  // After launch: wait, try focus, then attach foreground title + UIA control summary for the model.
  const focusHints = [
    ...(app && DESKTOP_FOCUS_HINTS[app] ? DESKTOP_FOCUS_HINTS[app] : []),
    app,
    target,
  ].filter(Boolean) as string[];
  const ui = await readDesktopUiContext({focusHints, waitMs: 900});
  return {
    ok: true,
    launched: target,
    app: app || undefined,
    ...ui,
  };
}

async function executeDesktopTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const name = normalizeCompanionToolName(toolName);
  switch (name) {
    case 'launch':
      return await launchDesktopApp(args);
    case 'key':
      return await bridgeCall('/input', {
        type: 'key',
        key: String(args.key || ''),
        modifiers: Array.isArray(args.modifiers) ? args.modifiers : undefined,
      });
    case 'type':
      return await bridgeCall('/input', {type: 'type', text: String(args.text || '')});
    case 'click':
      return await bridgeCall('/input', {
        type: 'click',
        x: Number(args.x),
        y: Number(args.y),
        button: String(args.button || 'left'),
      });
    case 'scroll':
      return await bridgeCall('/input', {
        type: 'scroll',
        amount: Number(args.amount || 0),
        axis: args.axis ? String(args.axis) : undefined,
      });
    case 'foreground':
      return await bridgeCall('/foreground', undefined, true);
    case 'focus': {
      const hints = [
        ...(Array.isArray(args.hints) ? args.hints.map((item) => String(item)) : []),
        args.title ? String(args.title) : '',
        args.app ? String(args.app) : '',
        ...(args.app && DESKTOP_FOCUS_HINTS[String(args.app).toLowerCase()]
          ? DESKTOP_FOCUS_HINTS[String(args.app).toLowerCase()]
          : []),
      ].filter(Boolean);
      const focus = await focusWindowByHints(hints);
      await sleepMs(200);
      const foreground = bridgeReady() ? await bridgeCall('/foreground', undefined, true) : null;
      return {ok: !!focus.ok, focus, foreground};
    }
    case 'accessibility_tree': {
      const tree = await bridgeCall('/accessibility/tree', undefined, true);
      return summarizeAccessibilityTree(tree);
    }
    case 'accessibility_action':
      return await bridgeCall('/accessibility/action', {
        action: String(args.action || 'invoke'),
        ref: args.ref ? String(args.ref) : undefined,
        automationId: args.automationId ? String(args.automationId) : undefined,
        name: args.name ? String(args.name) : undefined,
        value: args.value != null ? String(args.value) : args.text != null ? String(args.text) : '',
      });
    case 'screenshot': {
      const shot = await bridgeCall('/screenshot', {});
      // Do not dump huge base64 into model context
      return {
        ok: true,
        path: shot?.path,
        hasImage: !!shot?.pngBase64,
        bytes: typeof shot?.pngBase64 === 'string' ? Math.floor((shot.pngBase64.length * 3) / 4) : 0,
      };
    }
    case 'computer_use': {
      const goal = String(args.goal || args.task || args.detail || '').trim();
      if (!goal) throw new Error('computer_use requires goal');
      const title = String(args.title || goal).trim().slice(0, 80);
      const app = String(args.app || '').trim();
      const detail = app ? `${goal}\n(app hint: ${app})` : goal;
      const task = await createTaskFromText(title, detail, undefined, undefined, undefined, {
        conversationId: typeof args.conversationId === 'string' ? args.conversationId : undefined,
        workspace: typeof args.workspace === 'string' ? args.workspace : undefined,
        projectName: typeof args.projectName === 'string' ? args.projectName : undefined,
      });
      return {
        ok: true,
        mode: 'computer_use',
        taskId: task.id,
        status: task.status,
        title: task.title,
        message: '已进入 computer-use 模式并排队执行；进度会通过任务事件同步到对话。',
      };
    }
    default:
      throw new Error(`未知桌面工具: ${toolName}`);
  }
}

type ChatOnceResult = {content: string; toolCalls: CompanionToolCall[]; raw: string};

async function completeChatOnce(
  message: ChatRequest,
  system: string,
  signal?: AbortSignal,
  options: {openAiTools?: ReturnType<typeof companionToolsAsOpenAi>} = {},
): Promise<ChatOnceResult> {
  if (!config) throw new Error('runtime is not configured');
  const anthropic = config.provider.toLowerCase().includes('anthropic');
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000);
  const openAiMessages = [{role: 'system', content: system}, ...message.history, {role: 'user', content: message.text}];
  const openAiBody: Record<string, unknown> = {
    model: config.model,
    stream: false,
    messages: openAiMessages,
  };
  // DeepSeek / OpenAI-compatible native tools (more reliable than free-form JSON for many models).
  if (!anthropic && options.openAiTools?.length) {
    openAiBody.tools = options.openAiTools;
    openAiBody.tool_choice = 'auto';
  }
  const response = await fetch(endpoint(anthropic ? '/messages' : '/chat/completions'), anthropic
    ? {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: 4096,
          stream: false,
          system,
          messages: [...message.history, {role: 'user', content: message.text}],
        }),
        signal: requestSignal,
      }
    : {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(openAiBody),
        signal: requestSignal,
      });
  if (!response.ok) throw new Error(`model API status ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const rawText = await response.text();
  const ctype = response.headers.get('content-type') || '';
  // Some providers (or test doubles) still stream even when stream:false was requested.
  if (ctype.includes('text/event-stream') || rawText.trimStart().startsWith('data:')) {
    let full = '';
    let usage: any;
    const streamedToolCalls: any[] = [];
    for (const raw of rawText.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        const delta = anthropic ? json.delta?.text || json.content?.map?.((item: any) => item.text).join('') : json.choices?.[0]?.delta?.content || json.choices?.[0]?.message?.content;
        if (typeof delta === 'string' && delta) full += delta;
        const tc = json.choices?.[0]?.delta?.tool_calls || json.choices?.[0]?.message?.tool_calls;
        if (Array.isArray(tc)) {
          for (const part of tc) {
            const idx = Number(part.index ?? streamedToolCalls.length);
            if (!streamedToolCalls[idx]) streamedToolCalls[idx] = {function: {name: '', arguments: ''}};
            if (part.function?.name) streamedToolCalls[idx].function.name += part.function.name;
            if (part.function?.arguments) streamedToolCalls[idx].function.arguments += part.function.arguments;
            if (part.id) streamedToolCalls[idx].id = part.id;
          }
        }
        if (json.usage) usage = {...usage, ...json.usage};
      } catch {
        /* keepalive / partial */
      }
    }
    if (usage) recordUsage(config.provider, config.model, usage);
    const fromNative = toolCallsFromOpenAiMessage({tool_calls: streamedToolCalls.filter(Boolean)});
    const fromText = extractCompanionToolPlan(full);
    return {
      content: full,
      toolCalls: fromNative.length ? fromNative : (fromText?.toolCalls || []),
      raw: full,
    };
  }
  let json: any;
  try {
    json = JSON.parse(rawText);
  } catch (error) {
    throw new Error(`model API returned non-JSON body: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`);
  }
  recordUsage(config.provider, config.model, json.usage);
  const messageOut = anthropic
    ? {content: json.content?.map((item: any) => item.text).join('') || '', tool_calls: json.content?.filter?.((item: any) => item.type === 'tool_use')}
    : (json.choices?.[0]?.message || {});
  const content = String(anthropic ? messageOut.content : (messageOut.content || ''));
  const fromNative = toolCallsFromOpenAiMessage(messageOut);
  const fromText = extractCompanionToolPlan(content);
  return {
    content,
    toolCalls: fromNative.length ? fromNative : (fromText?.toolCalls || []),
    raw: content,
  };
}

async function runCompanionToolLoop(
  socket: WebSocket,
  message: ChatRequest,
  baseSystem: string,
  signal?: AbortSignal,
): Promise<string> {
  const tools = listCompanionTools();
  const allowSubAgents = message.allowSubAgents !== false;
  const hasDesktop = tools.some((t) => t.kind === 'desktop');
  const hasMcp = tools.some((t) => t.kind === 'mcp');
  const system = `${baseSystem}
[Primary-agent tools]
- You are the primary agent. Call tools yourself when action is required.
- Computer Use is a dedicated MODE of the primary agent (not "ask user to open Tasks").
- Sub-agents toggle this turn: ${allowSubAgents ? 'ON (may use dedicated worker model for heavy sessions)' : 'OFF (you still own Computer Use yourself)'}.
- OS Bridge desktop tools: ${hasDesktop ? 'AVAILABLE' : 'UNAVAILABLE'}. MCP tools: ${hasMcp ? 'AVAILABLE' : 'NONE ENABLED'}.
- Tool catalog (authoritative for this turn — only call tools listed here):
${companionToolCatalogText(tools)}
[How to call tools — mandatory]
- Tools needed → JSON ONLY, no markdown fences:
  {"toolCalls":[{"serverId":"desktop","tool":"computer_use","arguments":{"goal":"打开计算器并计算 1+1"}}],"final":""}
- serverId="desktop" for OS tools; tool is SHORT NAME only (computer_use|launch|key|type|click|scroll|foreground|focus|accessibility_tree|accessibility_action|screenshot).
- NEVER use tool="desktop:launch" or "desktop.launch".
[Computer Use mode — primary path for desktop UI]
- Multi-step UI goals (open app THEN operate / calculate / click through UI / fill forms) MUST enter mode first:
  {"serverId":"desktop","tool":"computer_use","arguments":{"goal":"<user goal>"}}
- After enter, the runtime loop auto-provides per step: foreground title + screenshot + full UIA control tree, then executes controller actions. You do not need to manually chain launch→foreground→tree for multi-step work.
- Atomic tools (launch/key/type/click/...) are ONLY for a single short action with no multi-step UI closed loop.
[Policy]
- No tools needed → answer in natural language.
- Empty catalog / Bridge offline → say how to enable; no role-play.
- Only assert facts from tool receipts.
- Prefer computer_use for any goal that needs seeing or controlling another app's UI.`;

  setAgentState('thinking');
  send(socket, {type: 'chat.started', id: message.id, slot: 'companion'});
  send(socket, {
    type: 'chat.event',
    id: message.id,
    event: {
      id: `tools:${message.id}:catalog`,
      kind: 'tool',
      action: 'catalog',
      text: `工具面 · desktop ${hasDesktop ? 'on' : 'off'} · mcp ${hasMcp ? tools.filter((t) => t.kind === 'mcp').length : 0}`,
      status: 'done',
      ts: Date.now(),
    },
  });

  const openAiTools = companionToolsAsOpenAi(tools);
  // Pure conversation (no desktop/MCP intent) → real provider SSE typewriter, no tool probe round-trip.
  const mayNeedTools = tools.length > 0 && (
    shouldTransferToExecutor(message.text)
    || /(工具|打开|截图|点击|按键|启动|运行|创建|提醒|技能|工作流|循环|目标|计划|主动|computer\s*use|tool|launch|click|screenshot|mcp|skill|workflow|goal|loop|remind)/i.test(message.text)
  );
  if (!tools.length || !mayNeedTools) {
    const full = await streamChat(socket, message, system, 'companion', signal, {
      emitStarted: false,
      emitDone: true,
      setIdleOnDone: true,
    });
    return full;
  }

  // Tool-capable turn: non-stream plan (native tool_calls + JSON protocol), then live-stream the final prose.
  let result = await completeChatOnce(message, system, signal, {openAiTools});
  let history = [...message.history, {role: 'user' as const, content: message.text}];
  let usedTools = false;
  for (let round = 0; round < 3; round++) {
    if (signal?.aborted) throw new Error('aborted');
    const toolCalls = result.toolCalls.length
      ? result.toolCalls
      : (extractCompanionToolPlan(result.content)?.toolCalls || []);
    if (!toolCalls.length) break;
    usedTools = true;
    const observations: string[] = [];
    for (const call of toolCalls.slice(0, 4)) {
      const toolName = normalizeCompanionToolName(String(call.tool || ''));
      const serverId = resolveCompanionServerId(call, toolName, tools);
      const eventId = `tool:${message.id}:${round}:${serverId || 'x'}:${toolName || 'tool'}`;
      const args = call.arguments && typeof call.arguments === 'object' ? call.arguments as Record<string, unknown> : {};
      try {
        if (
          serverId === PATTERN_SERVER_ID
          || toolName.startsWith('pattern_')
          || tools.some((t) => t.kind === 'pattern' && t.name === toolName)
        ) {
          const patternName = toolName.replace(/^pattern_/, '');
          send(socket, {type: 'chat.event', id: message.id, event: {id: eventId, kind: 'tool', action: `pattern.${patternName}`, text: `Pattern · ${patternName}`, status: 'running', ts: Date.now()}});
          const toolResult = await executePatternTool(patternName, args, {
            conversationId: message.sessionId,
            workspace: message.workspace,
            projectName: message.projectName,
          });
          const receipt = JSON.stringify(toolResult).slice(0, 8000);
          observations.push(`pattern:${patternName}: ${receipt}`);
          let doneText = `${patternName} 完成`;
          if ((patternName === 'update_plan' || patternName === 'create_plan' || patternName === 'get_plan' || patternName === 'clear_plan')
            && toolResult && typeof toolResult === 'object' && (toolResult as any).plan?.items) {
            const planItems = (toolResult as any).plan.items as Array<{status?: string; content?: string}>;
            const doneN = planItems.filter((i) => i.status === 'completed').length;
            const totalN = planItems.filter((i) => i.status !== 'cancelled').length;
            const running = planItems.find((i) => i.status === 'in_progress');
            doneText = running
              ? `会话计划 ${doneN}/${totalN} · 进行中：${String(running.content || '').slice(0, 40)}`
              : `会话计划 ${doneN}/${totalN} 已更新`;
          }
          if ((patternName === 'update_goal' || patternName === 'create_goal' || patternName === 'control_goal' || patternName === 'get_goal')
            && toolResult && typeof toolResult === 'object' && (toolResult as any).goal) {
            const g = (toolResult as any).goal;
            const tail = Array.isArray(g.progress) && g.progress.length ? String(g.progress[g.progress.length - 1]).slice(0, 48) : '';
            doneText = g.status === 'done'
              ? `目标已完成：${String(g.objective || '').slice(0, 40)}`
              : `目标 · ${g.status}${tail ? ` · ${tail}` : ''}`;
          }
          if (patternName === 'create_reminder' || patternName === 'delete_reminder' || patternName === 'list_reminders') {
            doneText = String((toolResult as any)?.message || doneText).slice(0, 80);
          }
          if (patternName === 'create_loop' || patternName === 'list_loops' || patternName === 'delete_loop') {
            doneText = String((toolResult as any)?.message || doneText).slice(0, 80);
          }
          if (patternName === 'create_skill' || patternName === 'list_skills' || patternName === 'run_skill') {
            doneText = String((toolResult as any)?.message || doneText).slice(0, 80);
          }
          send(socket, {type: 'chat.event', id: message.id, event: {id: eventId, kind: 'tool', action: `pattern.${patternName}`, text: doneText, status: 'done', receipt, ts: Date.now()}});
          continue;
        }
        if (serverId === DESKTOP_SERVER_ID || tools.some((t) => t.kind === 'desktop' && t.name === toolName && (!call.serverId || call.serverId === DESKTOP_SERVER_ID))) {
          send(socket, {type: 'chat.event', id: message.id, event: {id: eventId, kind: 'tool', action: `desktop.${toolName}`, text: `桌面工具 ${toolName}`, status: 'running', ts: Date.now()}});
          const toolArgs = toolName === 'computer_use'
            ? {...args, conversationId: message.sessionId, workspace: message.workspace, projectName: message.projectName}
            : args;
          const toolResult = await executeDesktopTool(toolName, toolArgs);
          const receipt = JSON.stringify(toolResult).slice(0, 8000);
          observations.push(`desktop:${toolName}: ${receipt}`);
          const resultTaskId = toolResult && typeof toolResult === 'object' && (toolResult as any).taskId ? String((toolResult as any).taskId) : undefined;
          send(socket, {type: 'chat.event', id: message.id, event: {id: eventId, kind: 'tool', action: `desktop.${toolName}`, text: toolName === 'computer_use' ? `已进入 computer-use · ${(toolResult as any)?.title || toolName}` : `${toolName} 完成`, status: 'done', receipt, taskId: resultTaskId, ts: Date.now()}});
          continue;
        }
        const server = mcpServers.find((item) => item.id === serverId)
          || mcpServers.find((item) => item.tools?.includes(toolName) || item.toolSchemas?.some((schema) => schema.name === toolName));
        if (!server) {
          observations.push(`${toolName}: 未找到工具（serverId=${serverId || '∅'}）`);
          send(socket, {type: 'chat.event', id: message.id, event: {id: eventId, kind: 'tool', action: toolName, text: `${toolName}: 未找到服务`, status: 'failed', ts: Date.now()}});
          continue;
        }
        send(socket, {type: 'chat.event', id: message.id, event: {id: eventId, kind: 'mcp', action: `${server.id}.${toolName}`, text: `调用 ${server.name}/${toolName}`, status: 'running', ts: Date.now()}});
        const mcpResult = await callMcpTool(server, toolName, args);
        const receipt = JSON.stringify(mcpResult).slice(0, 8000);
        observations.push(`${server.id}:${toolName}: ${receipt}`);
        send(socket, {type: 'chat.event', id: message.id, event: {id: eventId, kind: 'mcp', action: `${server.id}.${toolName}`, text: `${toolName} 完成`, status: 'done', receipt, ts: Date.now()}});
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        observations.push(`${serverId || 'tool'}:${toolName}: 失败：${err}`);
        send(socket, {type: 'chat.event', id: message.id, event: {id: eventId, kind: serverId === DESKTOP_SERVER_ID ? 'tool' : 'mcp', action: serverId === DESKTOP_SERVER_ID ? `desktop.${toolName}` : toolName, text: `${toolName} 失败：${err}`, status: 'failed', receipt: err, ts: Date.now()}});
      }
    }
    history = [
      ...history,
      {role: 'assistant' as const, content: result.content || result.raw || JSON.stringify({toolCalls})},
      {role: 'user' as const, content: `[Tool receipts — facts only]\n${observations.join('\n')}\n说明：launch 回执若含 accessibility.controls，可直接用于 accessibility_action；若 foreground.title 仍是 Pattern，先 focus 再操作。\n请基于以上真实回执给出最终自然语言答复；不要再输出 toolCalls JSON，除非确实还需要另一轮工具。没有回执的动作不得声称成功。`},
    ];
    result = await completeChatOnce({
      ...message,
      text: history[history.length - 1]!.content,
      history: history.slice(0, -1),
    }, system, signal, {openAiTools});
  }

  let finalText = (result.content || result.raw || '').trim();
  if (extractCompanionToolPlan(finalText)?.toolCalls?.length) {
    finalText = finalText.replace(/\{[\s\S]*"toolCalls"[\s\S]*\}/g, '').trim()
      || (usedTools ? '已执行工具，但模型没有给出自然语言总结。' : '模型只返回了工具计划，未能完成调用。请重试。');
  }

  if (usedTools) {
    // Live SSE wrap-up after tools (real provider token deltas).
    const wrap = await streamChat(socket, {
      ...message,
      text: history[history.length - 1]?.content || message.text,
      history: history.slice(0, -1),
    }, `${system}\n[Final answer] Reply in natural language only. No toolCalls JSON.`, 'companion', signal, {
      emitStarted: false,
      emitDone: false,
      setIdleOnDone: false,
    });
    finalText = wrap.trim() || finalText;
  } else if (finalText) {
    // Tool catalog exists but this turn needed no tools: avoid a second model call;
    // emit paced deltas so the UI still typewrites instead of dumping the whole blob at once.
    const chunkSize = 6;
    for (let i = 0; i < finalText.length; i += chunkSize) {
      if (signal?.aborted) break;
      send(socket, {type: 'chat.delta', id: message.id, delta: finalText.slice(i, i + chunkSize)});
      await new Promise((resolve) => setTimeout(resolve, 14));
    }
  }

  send(socket, {type: 'chat.done', id: message.id, slot: 'companion'});
  setAgentState('idle');
  return finalText;
}

async function askChildAgent(prompt: string, useAgentModel = true): Promise<string> {
  if (!config?.apiKey) throw new Error('未配置模型 API Key');
  const configured = useAgentModel && config.agent?.model
    ? {provider:config.agent.provider || config.provider, endpoint:config.agent.endpoint || config.endpoint, model:config.agent.model, apiKey:config.agent.apiKey || config.apiKey}
    : {provider:config.provider, endpoint:config.endpoint, model:config.model, apiKey:config.apiKey};
  const provider = configured.provider; const model = configured.model; const anthropic = provider.toLowerCase().includes('anthropic');
  const response = await fetch(endpoint(anthropic ? '/messages' : '/chat/completions', configured.endpoint), anthropic ? {
    method:'POST', headers:{'content-type':'application/json','x-api-key':configured.apiKey,'anthropic-version':'2023-06-01'},
    body:JSON.stringify({model,max_tokens:1600,temperature:0,messages:[{role:'user',content:prompt}]})
  } : {
    method:'POST', headers:{'content-type':'application/json',authorization:`Bearer ${configured.apiKey}`},
    body:JSON.stringify({model,max_tokens:1600,temperature:0,messages:[{role:'system',content:'You are a specialist sub-agent. Do not claim tools or commands you did not run.'},{role:'user',content:prompt}]})
  });
  if (!response.ok) throw new Error(`子 Agent 返回 ${response.status}`);
  const json:any = await response.json(); recordUsage(provider, model, json.usage);
  return String(anthropic ? json.content?.map((item:any)=>item.text).join('') : json.choices?.[0]?.message?.content || '').slice(0, 12000);
}
async function runChildAgent(skill: SkillDefinition, task: TaskRecord): Promise<string> {
  const tools = mcpServers.filter((server) => server.enabled && server.tools?.length).flatMap((server) => (server.toolSchemas?.length ? server.toolSchemas.map((tool) => `${server.id}:${tool.name} ${JSON.stringify(tool.inputSchema || {}).slice(0,1200)}`) : (server.tools || []).map((tool) => `${server.id}:${tool}`)));
  const toolInstruction = tools.length
    ? `可用 MCP 工具：${tools.join(', ')}。如果确实需要工具，必须只输出 JSON：{"toolCalls":[{"serverId":"...","tool":"...","arguments":{}}],"final":""}；不要调用未列出的工具。若不需要工具，输出普通结论。`
    : '当前没有已授权 MCP 工具；只能分析输入，不得声称运行过测试、修改过文件或读取过工作区。';
  const prompt = `${skill.prompt}\n\n你是工作流中的专职子 Agent「${skill.name}」，只负责自己的分析，不得假设其他 Agent 已完成工作。\n任务：${task.title}\n详细目标：${task.detail}\n工作区：${task.workflow?.workspace || '当前工作区'}\n${toolInstruction}\n输出应包含结论、证据、风险和下一步建议。`;
  const first = await askChildAgent(prompt);
  let calls:any[] = [];
  try { const json = JSON.parse(first.match(/\{[\s\S]*\}/)?.[0] || ''); calls = Array.isArray(json.toolCalls) ? json.toolCalls.slice(0, 4) : []; if (!calls.length) return first; } catch { return first; }
  const observations:string[] = [];
  for (const call of calls) {
    const server = mcpServers.find((item) => item.id === call.serverId) || mcpServers.find((item) => item.tools?.includes(call.tool));
    if (!server) {
      observations.push(`${call.tool}: 未找到 MCP 服务`);
      task.steps = [...(task.steps || []), {id: randomUUID(), action: 'mcp', detail: `${call.tool}: 未找到服务`, tier: 1, status: 'failed', ts: Date.now()}];
      announceTask(task);
      continue;
    }
    try {
      task.steps = [...(task.steps || []), {id: randomUUID(), action: 'mcp', detail: `调用 ${server.name}/${call.tool}`, tier: 1, status: 'running', ts: Date.now()}];
      announceTask(task);
      const result = await callMcpTool(server, String(call.tool), call.arguments && typeof call.arguments === 'object' ? call.arguments : {});
      observations.push(`${call.tool}: ${JSON.stringify(result).slice(0, 8000)}`);
      task.steps = [...(task.steps || []), {id: randomUUID(), action: 'mcp', detail: `${call.tool} 完成`, tier: 1, status: 'done', receipt: JSON.stringify(result).slice(0, 500), ts: Date.now()}];
      announceTask(task);
    } catch (error) {
      observations.push(`${call.tool}: 工具调用失败：${error instanceof Error ? error.message : String(error)}`);
      task.steps = [...(task.steps || []), {id: randomUUID(), action: 'mcp', detail: `${call.tool} 失败：${error instanceof Error ? error.message : String(error)}`, tier: 1, status: 'failed', ts: Date.now()}];
      announceTask(task);
    }
  }
  return await askChildAgent(`${prompt}\n\n工具实际回执（仅可使用这些事实，不要虚构）：\n${observations.join('\n')}\n请输出最终结论，不要再次请求工具。`);
}
function clipAgentText(value: string, max = 8000) {
  return value.length > max ? `${value.slice(0, max)}\n…（已截断）` : value;
}
async function planWorkflowAgents(task: TaskRecord, workflow: WorkflowDefinition): Promise<Array<{name:string; prompt:string}>> {
  const fallback = workflow.skillIds.map((id) => allSkills().find((skill) => skill.id === id)).filter((skill): skill is SkillDefinition => !!skill).map((skill) => ({name:skill.name, prompt:skill.prompt}));
  try {
    const raw = await askChildAgent(`你是主 Agent。请把下面的编码目标拆成最多 ${task.workflow?.agents || workflow.maxAgents} 个可独立执行的子 Agent 任务。每个任务要有清晰角色和边界，不能重复；只输出 JSON：{"agents":[{"name":"角色名","prompt":"具体目标"}]}。工作流：${workflow.name}。目标：${task.detail}`, false);
    const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '');
    const agents = Array.isArray(parsed.agents) ? parsed.agents.map((item:any) => ({name:String(item.name || '子 Agent').slice(0,80), prompt:String(item.prompt || '').slice(0,1200)})).filter((item:any) => item.prompt) : [];
    return agents.length ? agents : fallback;
  } catch {
    return fallback;
  }
}
async function runWorkflowAgents(task: TaskRecord) {
  const workflow = codingWorkflows.find((item) => item.id === task.workflow?.id);
  if (!workflow) return;
  const planned = await planWorkflowAgents(task, workflow);
  const maxAgents = Math.max(1, Math.min(MAX_AGENT_COUNT, task.workflow?.agents || workflow.maxAgents));
  const baseSkills = workflow.skillIds.map((id) => allSkills().find((skill) => skill.id === id)).filter((skill): skill is SkillDefinition => !!skill);
  // The planner may return only a few role templates. Cycle those templates to
  // materialize the requested fan-out without asking the main model to emit a
  // 384-item JSON payload in one response.
  const assignments = Array.from({length: maxAgents}, (_, index) => {
    const plan = planned[index % planned.length] || {name:`子 Agent ${index + 1}`, prompt:task.detail};
    const base = baseSkills[index % Math.max(baseSkills.length, 1)] || allSkills()[0];
    return {...base, id:`agent-${String(index + 1).padStart(3, '0')}`, name:`${plan.name} #${index + 1}`, prompt:`${base.prompt}\n\n主 Agent 指派的具体目标：${plan.prompt}`};
  });
  const results: NonNullable<TaskRecord['agentResults']> = [];
  if (workflow.mode === 'parallel-read' || workflow.mode === 'peer-discussion') {
    results.push(...await Promise.all(assignments.map(async (skill) => { try { return {skillId:skill.id, output:await runChildAgent(skill, task), status:'done' as const, ts:Date.now()}; } catch (error) { return {skillId:skill.id, output:String(error), status:'failed' as const, ts:Date.now()}; } })));
  }
  if (workflow.mode === 'serial') {
    for (const skill of assignments) {
      try { results.push({skillId:skill.id, output:await runChildAgent(skill, task), status:'done', ts:Date.now()}); }
      catch (error) { results.push({skillId:skill.id, output:String(error), status:'failed', ts:Date.now()}); }
    }
  }
  if (workflow.mode === 'peer-discussion') {
    const rounds = Math.max(1, Math.min(4, workflow.discussionRounds || 1));
    for (let round = 2; round <= rounds; round += 1) {
      const transcript = clipAgentText(results.map((result, index) => `Agent ${index + 1}（${assignments[index]?.name || result.skillId}）：\n${clipAgentText(result.output, 1200)}`).join('\n\n'), 48000);
      const rebuttals = await Promise.all(assignments.map(async (skill, index) => {
        try {
          const output = await runChildAgent({...skill, prompt:`${skill.prompt}\n\n这是第 ${round} 轮平权研讨。请阅读其他 Agent 的观点，指出可证伪的问题、补充证据并修正自己的结论。不要盲从，也不要重复原文。\n\n当前讨论记录：\n${transcript}`}, task);
          return {index, output, ok:true as const};
        } catch (error) { return {index, output:`质询失败：${error}`, ok:false as const}; }
      }));
      for (const rebuttal of rebuttals) {
        const result = results[rebuttal.index];
        if (result) result.output += `\n\n[第 ${round} 轮质询]\n${rebuttal.output}`;
      }
    }
    const viewpoints = clipAgentText(results.map((result, index) => `Agent ${index + 1}（${assignments[index]?.name || result.skillId}）：\n${clipAgentText(result.output, 1600)}`).join('\n\n'), 64000);
    try {
      const synthesis = await askChildAgent(`你是主 Agent 主持人。以下是多个平权 Agent 对同一目标的独立意见。请保持证据边界，明确共识、分歧、风险和下一步行动，并给出最终建议。\n\n${viewpoints}`, false);
      results.push({skillId:'moderator', output:synthesis, status:'done', ts:Date.now()});
    } catch (error) { results.push({skillId:'moderator', output:`主持汇总失败：${error}`, status:'failed', ts:Date.now()}); }
  }
  task.agentResults = results; task.workflow.currentStep = results.length; saveTasks(); announceTask(task);
}
const approvalWaiters = new Map<string, {resolve: (ok: boolean) => void}>();
const defaultFileWatchConfig: FileWatchConfig = {enabled: false, paths: [], extensions: ['.md', '.txt', '.json', '.ts', '.js', '.svelte', '.rs', '.py'], maxBytes: 65536};
let fileWatchConfig = loadFileWatchConfig();
let fileWatchers: FSWatcher[] = [];
let fileWatchEvents: FileWatchEvent[] = [];
const fileWatchDebounce = new Map<string, NodeJS.Timeout>();
let localSemanticEmbedder: ((text: string) => Promise<Float32Array>) | null = null;
let localSemanticEmbeddingLoading: Promise<((text: string) => Promise<Float32Array>)> | null = null;
let healthChecks = loadHealthChecks();
const healthStates = new Map<string, boolean>();
let telegramOffset = loadTelegramOffset();
let emailPolling = false;
let cronTriggers = loadCronTriggers();
let lastPowerState: {percent:number;plugged:boolean}|null = null;
let plaaState = '';
const cronFired = new Set<string>();
const pluginChannels = new Map<string, Channel>();
let pluginUnsubscribers: Array<() => void> = [];
const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({ok: true}));
    return;
  }
  res.writeHead(404);
  res.end();
});
const sockets = new WebSocketServer({noServer: true});
const clients = new Set<WebSocket>();
const activeChats = new Map<string, {controller: AbortController; socket: WebSocket}>();
function send(socket: WebSocket, value: ServerMessage | Record<string, unknown>) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}
function broadcast(value: ServerMessage | Record<string, unknown>) {
  for (const socket of clients) send(socket, value);
}
function endpoint(path: string, base = config!.endpoint) {
  return `${base.replace(/\/$/, '')}${path}`;
}
function loadTasks(): TaskRecord[] {
  const file = join(dataDir, 'tasks.json');
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as TaskRecord[];
  } catch {
    return [];
  }
}
function saveTasks() {
  writeFileSync(join(dataDir, 'tasks.json'), JSON.stringify(tasks, null, 2));
}
function loadModelMetrics(): Record<string, ModelUsageMetrics> {
  try { return JSON.parse(readFileSync(join(dataDir, 'model-metrics.json'), 'utf8')) as Record<string, ModelUsageMetrics>; }
  catch { return {}; }
}
function saveModelMetrics() { writeFileSync(join(dataDir, 'model-metrics.json'), JSON.stringify(modelMetrics, null, 2)); }
function loadMcpServers(): McpServerConfig[] {
  try {
    const value = JSON.parse(readFileSync(join(dataDir, 'mcp-servers.json'), 'utf8')) as unknown;
    return Array.isArray(value) ? value.filter((item): item is McpServerConfig => !!item && typeof item.id === 'string' && typeof item.command === 'string').slice(0, 50) : [];
  } catch { return []; }
}
function saveMcpServers() { writeFileSync(join(dataDir, 'mcp-servers.json'), JSON.stringify(mcpServers, null, 2)); }
async function discoverMcpTools(server: McpServerConfig): Promise<Array<{name:string;description?:string;inputSchema?:unknown}>> {
  const child = execFile(server.command, server.args || [], {windowsHide:true});
  const request = (id:number, method:string, params:unknown) => JSON.stringify({jsonrpc:'2.0', id, method, params}) + '\n';
  child.stdin?.write(request(1, 'initialize', {protocolVersion:'2024-11-05', capabilities:{}, clientInfo:{name:'pattern',version:'0.3.0'}}));
  child.stdin?.write(request(2, 'tools/list', {}));
  return await new Promise<string[]>((resolve, reject) => {
    let buffer = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('MCP discovery timeout')); }, 8000);
    child.stdout?.on('data', (chunk:Buffer) => {
      buffer += chunk.toString();
      for (const line of buffer.split(/\r?\n/).slice(0, -1)) {
        try { const message:any = JSON.parse(line); if (message.id !== 2) continue; clearTimeout(timer); child.kill(); resolve(Array.isArray(message.result?.tools) ? message.result.tools.map((item:any)=>({name:String(item.name || ''),description:typeof item.description==='string' ? item.description.slice(0,500) : undefined,inputSchema:item.inputSchema})).filter((item:any)=>item.name) : []); return; } catch { /* wait for complete JSON lines */ }
      }
      buffer = buffer.split(/\r?\n/).at(-1) || '';
    });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
}
async function callMcpTool(server: McpServerConfig, tool: string, args: Record<string, unknown> = {}) {
  // mcp path boundary
  if (securityPolicy.enforceWorkspace && securityPolicy.workspaceRoot) {
    const args = (arguments[2] || {}) as any;
    for (const key of ['path', 'root', 'cwd', 'file', 'directory', 'target']) {
      if (typeof args?.[key] === 'string') assertWorkspaceAllowed(args[key], `mcp:${String(arguments[1] || 'tool')}`);
    }
  }

  if (!server.tools?.includes(tool)) throw new Error('工具不在最近一次发现列表中');
  const allowed = server.permissions.includes('mcp.call') || server.permissions.includes(`mcp.tool:${tool}`);
  if (!allowed) throw new Error(`MCP 权限未授予：mcp.tool:${tool}`);
  const mutating = /write|edit|patch|delete|remove|execute|command|run|set|create/i.test(tool);
  if (mutating && !server.permissions.includes('mcp.write')) throw new Error(`写入类 MCP 工具需要额外权限：mcp.write（${tool}）`);
  const child = execFile(server.command, server.args || [], {windowsHide:true});
  const send = (id:number, method:string, params:unknown) => child.stdin?.write(`${JSON.stringify({jsonrpc:'2.0',id,method,params})}\n`);
  send(1, 'initialize', {protocolVersion:'2024-11-05', capabilities:{}, clientInfo:{name:'pattern',version:'0.3.0'}});
  send(2, 'tools/call', {name:tool, arguments:args});
  return await new Promise<unknown>((resolve, reject) => {
    let buffer=''; const timer=setTimeout(()=>{child.kill();reject(new Error('MCP 调用超时'));}, 20_000);
    child.stdout?.on('data',(chunk:Buffer)=>{buffer+=chunk.toString(); for(const line of buffer.split(/\r?\n/).slice(0,-1)){try{const message:any=JSON.parse(line); if(message.id!==2)continue; clearTimeout(timer);child.kill(); if(message.error)reject(new Error(message.error.message||'MCP 工具调用失败')); else resolve(message.result); return;}catch{/* wait */}} buffer=buffer.split(/\r?\n/).at(-1)||'';});
    child.on('error',(error)=>{clearTimeout(timer);reject(error);});
  });
}
async function createGitWorktree(root: string, name?: string) {
  const absoluteRoot = root.trim();
  if (!absoluteRoot || !existsSync(absoluteRoot) || !statSync(absoluteRoot).isDirectory()) throw new Error('工作区目录不存在');
  const baseName = (name || 'pattern').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 38);
  const safeName = `${baseName}-${Date.now()}`;
  const path = join(absoluteRoot, '.pattern-worktrees', safeName);
  mkdirSync(join(absoluteRoot, '.pattern-worktrees'), {recursive:true});
  const branch = `pattern/${safeName}`;
  await execFileAsync('git', ['-C', absoluteRoot, 'worktree', 'add', '-b', branch, path, 'HEAD'], {windowsHide:true});
  return {path, branch};
}
function contextWindowFor(model: string) {
  const name = model.toLowerCase();
  if (name.includes('gpt-4.1') || name.includes('gpt-5')) return 1_000_000;
  if (name.includes('claude-fable-5') || name.includes('claude-opus-4-8') || name.includes('claude-sonnet-5')) return 1_000_000;
  if (name.includes('claude')) return 200_000;
  if (name.includes('deepseek')) return 128_000;
  if (name.includes('qwen')) return 128_000;
  return 128_000;
}
function modelPresets(provider: string): string[] {
  const name = provider.toLowerCase();
  if (name.includes('anthropic')) return ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'];
  if (name.includes('deepseek')) return ['deepseek-v4-pro', 'deepseek-v4-flash'];
  if (name.includes('qwen') || name.includes('百炼')) return ['qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-flash', 'qwen3.5-plus', 'qwen3.5-flash'];
  if (name.includes('智谱') || name.includes('zhipu')) return ['glm-5.1', 'glm-5v-turbo', 'glm-4.7'];
  if (name.includes('openai')) return ['gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.4-pro', 'gpt-5.4-mini', 'gpt-5.4-nano'];
  return [];
}
function recordUsage(provider: string, model: string, usage: any, durationMs?: number) {
  if (!usage) return;
  const key = `${provider}:${model}`;
  const previous = modelMetrics[key] || {model, provider, inputTokens: 0, outputTokens: 0, cachedTokens: 0, requests: 0, contextWindow: contextWindowFor(model), updatedAt: 0};
  const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const output = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
  const cached = Number(usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0);
  const rawCost = usage.cost ?? usage.total_cost ?? usage.cost_usd ?? usage.costUsd;
  const parsedCost = rawCost === undefined || rawCost === null || rawCost === '' ? undefined : Number(rawCost);
  const cost = Number.isFinite(parsedCost) ? parsedCost : undefined;
  const costCurrency = typeof usage.cost_currency === 'string' ? usage.cost_currency : typeof usage.currency === 'string' ? usage.currency : cost !== undefined ? 'USD' : undefined;
  const at = Date.now();
  modelMetrics[key] = {
    ...previous,
    inputTokens: previous.inputTokens + input,
    outputTokens: previous.outputTokens + output,
    cachedTokens: previous.cachedTokens + cached,
    requests: previous.requests + 1,
    cost: cost === undefined ? previous.cost : (previous.cost || 0) + cost,
    costCurrency: costCurrency || previous.costCurrency,
    lastRequest: {inputTokens: input, outputTokens: output, cachedTokens: cached, durationMs, cost, costCurrency, at},
    updatedAt: at,
  };
  saveModelMetrics();
  broadcast({type: 'model.metrics', id: 'update', metrics: Object.values(modelMetrics)});
}

type SecurityPolicyState = {
  workspaceRoot: string | null;
  enforceWorkspace: boolean;
  requireRecoveryForWorkspaceWrites: boolean;
  autoApproveBelow: number;
  hardDenyAt: number;
  tierGuide: Array<{tier: number; label: string; meaning: string}>;
};
const DEFAULT_SECURITY_POLICY: SecurityPolicyState = {
  workspaceRoot: null,
  enforceWorkspace: true,
  requireRecoveryForWorkspaceWrites: true,
  autoApproveBelow: 2,
  hardDenyAt: 3,
  tierGuide: [
    {tier: 0, label: 'T0 只读', meaning: '读取界面/文件，不改变系统状态'},
    {tier: 1, label: 'T1 低风险', meaning: '可逆的本地操作，通常自动放行'},
    {tier: 2, label: 'T2 需审批', meaning: '破坏性、外发、安装、提交等，必须人工确认'},
    {tier: 3, label: 'T3 禁区', meaning: '银行/密码管理器等，默认拒绝并冻结'},
  ],
};
function securityPolicyFile() { return join(dataDir, 'security-policy.json'); }
function loadSecurityPolicy(): SecurityPolicyState {
  try {
    if (!existsSync(securityPolicyFile())) return {...DEFAULT_SECURITY_POLICY, tierGuide: [...DEFAULT_SECURITY_POLICY.tierGuide]};
    const raw = JSON.parse(readFileSync(securityPolicyFile(), 'utf8'));
    return {
      workspaceRoot: raw.workspaceRoot ? String(raw.workspaceRoot) : null,
      enforceWorkspace: raw.enforceWorkspace !== false,
      requireRecoveryForWorkspaceWrites: raw.requireRecoveryForWorkspaceWrites !== false,
      // 4 is an intentional "above every known tier" sentinel used by the UI's
      // fully-allow and approve-everything modes. Actual action tiers remain 0–3.
      autoApproveBelow: Math.min(4, Math.max(0, Number(raw.autoApproveBelow ?? 2))),
      hardDenyAt: Math.min(4, Math.max(1, Number(raw.hardDenyAt ?? 3))),
      tierGuide: Array.isArray(raw.tierGuide) && raw.tierGuide.length ? raw.tierGuide : [...DEFAULT_SECURITY_POLICY.tierGuide],
    };
  } catch {
    return {...DEFAULT_SECURITY_POLICY, tierGuide: [...DEFAULT_SECURITY_POLICY.tierGuide]};
  }
}
function saveSecurityPolicy() { writeFileSync(securityPolicyFile(), JSON.stringify(securityPolicy, null, 2)); }
let securityPolicy = loadSecurityPolicy();
function normalizePathForBoundary(value: string) { return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); }
function isPathInsideWorkspace(target: string, root: string) {
  const a = normalizePathForBoundary(target);
  const b = normalizePathForBoundary(root);
  return a === b || a.startsWith(b + '/');
}
function assertWorkspaceAllowed(targetPath?: string | null, action = 'access') {
  if (!securityPolicy.enforceWorkspace || !securityPolicy.workspaceRoot) return;
  if (!targetPath) return;
  if (!isPathInsideWorkspace(String(targetPath), securityPolicy.workspaceRoot)) {
    appendJournal({line: `DENIED ${action} outside workspace: ${targetPath} (root=${securityPolicy.workspaceRoot})`, tier: 2, kind: 'boundary', decision: 'denied'});
    throw new Error(`工作区隔离：拒绝访问项目外路径\n目标：${targetPath}\n允许根：${securityPolicy.workspaceRoot}`);
  }
}
function parseJournalLine(raw: any): {ts: number; line: string; tier?: number; kind?: string; taskId?: string; decision?: string} {
  if (typeof raw === 'string') {
    try { return parseJournalLine(JSON.parse(raw)); } catch { return {ts: 0, line: raw}; }
  }
  return {
    ts: Number(raw.ts || 0),
    line: String(raw.line || ''),
    tier: raw.tier == null ? undefined : Number(raw.tier),
    kind: raw.kind ? String(raw.kind) : undefined,
    taskId: raw.taskId ? String(raw.taskId) : undefined,
    decision: raw.decision ? String(raw.decision) : undefined,
  };
}

function appendJournal(entry: string | {line: string; tier?: number; kind?: string; taskId?: string; decision?: string}) {
  try {
    const file = join(dataDir, 'journal', 'actions.jsonl');
    mkdirSync(join(dataDir, 'journal'), {recursive: true});
    const payload = typeof entry === 'string'
      ? {ts: Math.floor(Date.now()/1000), line: entry, decision: 'info'}
      : {ts: Math.floor(Date.now()/1000), line: entry.line, tier: entry.tier, kind: entry.kind, taskId: entry.taskId, decision: entry.decision || 'info'};
    writeFileSync(file, `${existsSync(file) ? readFileSync(file, 'utf8') : ''}${JSON.stringify(payload)}\n`);
  } catch {
    /* ignore journal failures */
  }
}
function bridgeReady() {
  return !!(config?.bridgeUrl && config.bridgeToken);
}
async function bridgeCall(path: string, body?: unknown, optional = false): Promise<any> {
  if (!bridgeReady()) {
    if (optional) return null;
    throw new Error('OS Bridge not ready');
  }
  const res = await fetch(`${config!.bridgeUrl!.replace(/\/$/, '')}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config!.bridgeToken}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    if (optional) return null;
    throw new Error(`Bridge ${path} => ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function recoveryState(value: any): NonNullable<TaskRecord['recovery']>['state'] {
  const state = String(value?.transaction?.state || '').toLowerCase();
  if (state === 'active') return 'active';
  if (state === 'prepared') return 'prepared';
  if (state === 'committed') return 'committed';
  if (state === 'rolledback') return 'rolled_back';
  if (state === 'conflicted') return 'conflicted';
  return 'recovery_required';
}


function declareRecoveryScopes(task: TaskRecord, fileScopes: string[]): {
  fileScopes: string[];
  registryScopes: string[];
  serviceScopes: string[];
  scheduledTaskScopes: string[];
} {
  const text = `${task.title || ''}\n${task.detail || ''}`;
  const registryScopes = new Set<string>();
  const serviceScopes = new Set<string>();
  const scheduledTaskScopes = new Set<string>();

  for (const match of text.matchAll(/registry-scope\s*[:=]\s*([^\r\n;]+)/gi)) {
    const value = match[1].trim();
    if (value) registryScopes.add(value);
  }
  for (const match of text.matchAll(/service-scope\s*[:=]\s*([A-Za-z0-9_.-]+)/gi)) {
    serviceScopes.add(match[1].trim());
  }
  for (const match of text.matchAll(/scheduled-task-scope\s*[:=]\s*([^\r\n;]+)/gi)) {
    const value = match[1].trim();
    if (!value) continue;
    scheduledTaskScopes.add(value.startsWith('\\') ? value : `\\${value.replace(/^\\+/, '')}`);
  }

  // Safe default for registry-oriented workspace tasks: protect a dedicated HKCU hive branch.
  if (fileScopes.length > 0 && /注册表|registry|HKCU|HKLM/i.test(text)) {
    registryScopes.add('HKCU\\Software\\PatternAgentOS');
  }

  return {
    fileScopes,
    registryScopes: [...registryScopes],
    serviceScopes: [...serviceScopes],
    scheduledTaskScopes: [...scheduledTaskScopes].map((name) => name.startsWith('\\') ? name : `\\${name.replace(/^\\+/, '')}`),
  };
}

async function beginTaskRecovery(task: TaskRecord): Promise<string | undefined> {
  if (task.recovery?.transactionId) return task.recovery.transactionId;
  const fileScope = task.workspace || securityPolicy.workspaceRoot;
  const fileScopes = fileScope && existsSync(fileScope) ? [fileScope] : [];
  const declaredScopes = declareRecoveryScopes(task, fileScopes);
  const recoveryRequired = process.platform === 'win32'
    && securityPolicy.requireRecoveryForWorkspaceWrites
    && !!fileScope;
  const capabilities = await bridgeCall('/recovery/capabilities', undefined, true);
  if (!capabilities?.available || fileScopes.length === 0) {
    task.recovery = {
      state: 'unavailable',
      fileScopes: declaredScopes.fileScopes,
      registryScopes: declaredScopes.registryScopes,
      serviceScopes: declaredScopes.serviceScopes,
      scheduledTaskScopes: declaredScopes.scheduledTaskScopes,
      error: !capabilities?.available ? 'AgentOS recovery runtime is unavailable' : 'No existing workspace scope was declared',
    };
    appendJournal({line: `${task.id} RECOVERY_UNAVAILABLE ${task.recovery.error}`, tier: 1, kind: 'recovery', taskId: task.id, decision: 'info'});
    saveTasks(); announceTask(task);
    if (recoveryRequired) {
      throw new Error(`工作区写入已阻止：${task.recovery.error}`);
    }
    return undefined;
  }
  const result = await bridgeCall('/recovery/begin', {taskId: task.id, mode: 'critical', ...declaredScopes});
  const transactionId = String(result?.transaction?.id || '');
  if (!result?.ok || !transactionId || recoveryState(result) !== 'active') {
    throw new Error(`AgentOS recovery baseline failed: ${result?.stderr || result?.transaction?.error || 'unknown error'}`);
  }
  task.recovery = {transactionId, state: 'active', ...declaredScopes};
  appendJournal({line: `${task.id} RECOVERY_BEGIN ${transactionId} scopes=${fileScopes.join('|')}`, tier: 1, kind: 'recovery', taskId: task.id, decision: 'info'});
  saveTasks(); announceTask(task);
  return transactionId;
}

async function finalizeTaskRecovery(
  task: TaskRecord,
  outcome: 'commit' | 'rollback',
  options: {assumeExclusive?: boolean} = {},
): Promise<void> {
  const transactionId = task.recovery?.transactionId;
  if (!transactionId || task.recovery?.state === 'rolled_back' || (outcome === 'commit' && task.recovery?.state === 'committed')) return;
  if (task.recovery?.state === 'active') {
    const prepared = await bridgeCall('/recovery/prepare', {transactionId});
    task.recovery.state = recoveryState(prepared);
    if (!prepared?.ok || task.recovery.state !== 'prepared') {
      task.recovery.error = prepared?.stderr || prepared?.transaction?.error || 'Could not persist recovery after-state';
      saveTasks(); announceTask(task);
      throw new Error(`AgentOS prepare failed: ${task.recovery.error}`);
    }
  }
  const operation = outcome === 'rollback' && task.recovery?.state === 'recovery_required' ? 'recover' : outcome;
  if (operation === 'recover' && !options.assumeExclusive) {
    throw new Error('中断事务需要显式确认：恢复范围内没有其它进程在事务后写入');
  }
  const result = await bridgeCall(`/recovery/${operation}`, {transactionId});
  task.recovery.state = recoveryState(result);
  task.recovery.error = result?.transaction?.error || result?.stderr || undefined;
  appendJournal({
    line: `${task.id} RECOVERY_${outcome.toUpperCase()} ${transactionId} state=${task.recovery.state}`,
    tier: 1, kind: 'recovery', taskId: task.id,
    decision: result?.ok ? 'info' : 'denied',
  });
  saveTasks(); announceTask(task);
  const expected = outcome === 'commit' ? 'committed' : 'rolled_back';
  if (!result?.ok || task.recovery.state !== expected) {
    throw new Error(`AgentOS ${outcome} did not complete: ${task.recovery.error || task.recovery.state}`);
  }
  if (outcome === 'commit') {
    const gc = await bridgeCall('/recovery/gc', {maxTransactions: 20, maxAgeDays: 7, maxBytes: 5 * 1024 * 1024 * 1024}, true);
    if (gc?.transaction?.purgedTransactionIds?.length) {
      appendJournal({line: `RECOVERY_GC purged=${gc.transaction.purgedTransactionIds.length} bytesAfter=${gc.transaction.bytesAfter}`, kind: 'recovery', decision: 'info'});
    }
  }
}

async function reconcileRecoveryTransactionsOnce(): Promise<boolean> {
  const capabilities = await bridgeCall('/recovery/capabilities', undefined, true);
  if (!capabilities?.available) return false;
  const result = await bridgeCall('/recovery/list', {}, true);
  if (!result?.ok) return false;
  const manifests = Array.isArray(result?.transaction) ? result.transaction : [];
  const latestManifestByTask = new Map<string, any>();
  for (const manifest of manifests) {
    const command = String(manifest?.command || '');
    if (!command.startsWith('detached:')) continue;
    const taskId = command.slice('detached:'.length);
    const existing = latestManifestByTask.get(taskId);
    const createdAt = Date.parse(String(manifest?.createdAt || '')) || 0;
    const existingCreatedAt = Date.parse(String(existing?.createdAt || '')) || 0;
    if (!existing || createdAt > existingCreatedAt) latestManifestByTask.set(taskId, manifest);
  }
  const correlatedTaskIds = new Set<string>();
  for (const [taskId, manifest] of latestManifestByTask) {
    const task = tasks.find((item) => item.id === taskId);
    if (!task) continue;
    correlatedTaskIds.add(taskId);
    const state = String(manifest.state || '').toLowerCase();
    const fileScopes = Array.isArray(manifest.fileScopes) ? manifest.fileScopes.map(String) : [];
    if (state === 'committed') {
      task.recovery = {transactionId: String(manifest.id), state: 'committed', fileScopes, error: manifest.error || undefined};
      if (['running','queued','awaiting_approval'].includes(task.status)) {
        task.status = 'done';
        task.error = undefined;
        finishTaskRun(task, 'done');
      }
      announceTask(task);
      continue;
    }
    if (state === 'rolledback') {
      task.recovery = {transactionId: String(manifest.id), state: 'rolled_back', fileScopes, error: manifest.error || undefined};
      if (['running','queued','awaiting_approval'].includes(task.status)) {
        task.status = 'failed';
        task.error = manifest.error || 'Pattern restarted after AgentOS rolled the interrupted transaction back';
        finishTaskRun(task, 'failed', task.error);
      }
      announceTask(task);
      continue;
    }
    if (state === 'failed') {
      task.recovery = {transactionId: String(manifest.id), state: 'unavailable', fileScopes, error: manifest.error || 'AgentOS baseline failed'};
      if (['running','queued','awaiting_approval'].includes(task.status)) {
        task.status = 'failed';
        task.error = task.recovery.error;
        finishTaskRun(task, 'failed', task.error);
      }
      announceTask(task);
      continue;
    }
    if (!['preparing','active','prepared','conflicted','recoveryrequired'].includes(state)) continue;
    task.recovery = {
      transactionId: String(manifest.id),
      state: state === 'prepared' ? 'prepared' : state === 'conflicted' ? 'conflicted' : 'recovery_required',
      fileScopes,
      error: manifest.error || (state === 'prepared' ? undefined : 'Pattern restarted before this AgentOS transaction reached a stable outcome'),
    };
    if (task.status === 'running' || task.status === 'queued' || task.status === 'awaiting_approval') {
      task.status = 'failed';
      task.error = task.recovery.error;
      finishTaskRun(task, 'failed', task.error);
    }
    announceTask(task);
  }
  for (const task of tasks) {
    if (!['running','awaiting_approval'].includes(task.status) || correlatedTaskIds.has(task.id)) continue;
    task.status = 'failed';
    task.error = 'Pattern restarted before this task reached a stable outcome';
    finishTaskRun(task, 'failed', task.error);
    announceTask(task);
  }
  saveTasks();
  return true;
}
async function reconcileRecoveryTransactions(): Promise<void> {
  if (recoveryReconciled) return;
  if (recoveryReconciliationInFlight) return recoveryReconciliationInFlight;
  recoveryReconciliationInFlight = (async () => {
    recoveryReconciled = await reconcileRecoveryTransactionsOnce();
  })();
  try {
    await recoveryReconciliationInFlight;
  } finally {
    recoveryReconciliationInFlight = null;
  }
}
async function notify(title: string, body: string) {
  try {
    await bridgeCall('/notify', {title, body}, true);
  } catch (error) {
    console.error('[pattern-sidecar] notify failed', error);
  }
}
async function getIdleSeconds(): Promise<number> {
  try {
    const data = await bridgeCall('/idle', undefined, true);
    return Number(data?.idleSeconds ?? 0);
  } catch {
    return 0;
  }
}
function buildSystemPrompt(
  memHits: MemoryRecord[],
  _slot: 'companion' | 'executor' = 'companion',
  context?: {
    workspace?: string;
    projectName?: string;
    attachments?: string[];
    allowSubAgents?: boolean;
    conversationId?: string;
    /** Current user message / topic text used to retrieve relevant long-term patterns. */
    patternQuery?: string;
  },
) {
  // Layers: persona (user) + primary runtime (product) + rules. Tool catalog is appended per-turn in runCompanionToolLoop.
  // Spec: docs/system-prompt.md
  const persona = config?.persona || 'You are Pattern, a desktop companion defined by the user.';
  const name = config?.personaName || 'Pattern';
  const user = config?.userName || 'User';
  const index = memory.buildIndex();
  const details = memHits.length
    ? memHits.map((m) => `- (${categoryLabel(m.category)}, imp=${m.importance.toFixed(2)}) ${m.text}`).join('\n')
    : '(no extra retrieval hits this turn)';
  const now = new Date();
  const allowSubAgents = context?.allowSubAgents !== false;
  // Retrieve relevant long-term patterns for context augmentation (§九).
  const patternQuery = context?.patternQuery?.trim() || '';
  const patternHits = patternQuery ? memory.patterns.search(patternQuery, 4) : [];
  const patternBlock = formatPatternsForPrompt(patternHits);
  const env = `Local time: ${now.toLocaleString('zh-CN')}. You are Pattern, a resident desktop companion agent (not a website chatbot).${plaaState?`\nPLAA emotional state: ${plaaState}`:''}`;
  const role = [
    'You are the primary agent: you own conversation, tools, and the user-facing answer.',
    allowSubAgents
      ? 'Sub-agents are optional workers; the runtime may spawn an executor for heavy desktop automation when enabled.'
      : 'Sub-agents are DISABLED this turn; complete work yourself using the tools listed later in this prompt.',
    'Keep the main chat as the result surface; do not dump low-level worker chatter into the user-facing reply.',
  ].join(' ');
  const workspaceBlock = context?.workspace
    ? `[Active project workspace]
- Name: ${context.projectName || 'project'}
- Root: ${context.workspace}
- Treat paths relative to this root unless the user says otherwise.
- Do not invent file contents you have not been given.
${context.attachments?.length ? `- User attached paths this turn:\n${context.attachments.map((p) => `  - ${p}`).join('\n')}` : '- No file attachments this turn.'}`
    : `[Active project workspace]
- None (global companion chat).`;
  const sessionPlan = context?.conversationId ? getSessionPlan(dataDir, context.conversationId) : null;
  const planBlock = sessionPlan?.items?.length
    ? `[Current session plan · todo checklist]
${formatSessionPlan(sessionPlan)}
- Update progress with pattern.update_plan (mark in_progress / completed) as you work.
- This plan is scoped to this conversation only — not a scheduled desktop task.`
    : `[Current session plan · todo checklist]
- (empty) For multi-step work, create a short plan with pattern.update_plan or ask the user to /plan.`;
  const goalsNow = loadGoals(dataDir);
  const active = goalsNow.find((g) => g.status === 'active' || g.status === 'paused' || g.status === 'blocked');
  const goalBlock = active
    ? `[Active goal · run-until-done]
- Status: ${active.status}
- Objective: ${active.objective}
${active.blockedReason ? `- Blocked: ${active.blockedReason}` : ''}
${active.progress?.length ? `- Recent progress:\n${active.progress.slice(-5).map((p) => `  - ${p}`).join('\n')}` : '- No progress notes yet.'}
- Keep advancing this goal. Use pattern.update_goal with message=progress, completed=true when verified, or blocked_reason when stuck.
- The desktop UI shows this goal continuously until completed/cleared.`
    : `[Active goal · run-until-done]
- (none) Create with /goal or pattern.create_goal when the user wants a verifiable long-running objective.`;
  return `${persona}
[Identity]
- Your name: ${name}
- User address: ${user}
- Agent role: primary desktop companion
- ${role}
[MEMORY-INDEX | always know what you remember]
${index}
[Retrieved memory details]
${details}
${patternBlock}
[Environment]
${env}
${workspaceBlock}
${goalBlock}
${planBlock}
[Capability honesty]
- Tools available this turn are listed only in the later [Primary-agent tools] / tool catalog section (desktop + MCP).
- If the catalog shows no desktop tools, OS Bridge is offline — you cannot press keys or open apps until Bridge is connected.
- If the catalog shows no MCP tools, none are enabled — do not invent plugin capabilities.
- Sub-agents this turn: ${allowSubAgents ? 'enabled' : 'disabled'}.
[Rules]
- Use memories naturally; do not recite entry ids.
- If a memory conflicts with the user's latest statement, prefer the latest statement.
- Never claim computer-use / desktop / MCP success without tool receipts.
- Never claim you pressed keys, clicked, opened apps, launched programs, or used accessibility unless a receipt proves it.
- Never role-play actions in pure chat. Either tools produced receipts, or you must say you cannot act yet and why (Bridge/MCP/permissions).
- Do not ask the user to open the tasks page or press a handoff button to make work happen.
- Never claim you read or modified project files unless tool receipts or attached contents prove it.
- When the user asks to open an app or operate the desktop, follow [Tool calling method].
- Users may create skills / tasks / workflows / reminders / proactive triggers with natural language OR slash commands (/goal /skill /loop /plan /task /remind /proactive /workflow /help). Prefer pattern.* tools to persist them.
- @skill:name @workflow:id @task:title mentions inject context; honor them.
[Slash & Pattern tools]
- Slash and NL both map to pattern.* tools (serverId=\"pattern\"). Prefer tools over role-play.
- /goal → create_goal | update_goal | control_goal | get_goal
- /plan → create_plan | update_plan | get_plan | clear_plan  (session todo checklist, not a scheduled task)
- /skill → create_skill | list_skills | run_skill
- /loop → create_loop | list_loops | delete_loop
- /task → create_task | list_tasks
- /remind → create_reminder | list_reminders | delete_reminder
- /proactive → trigger_proactive (action=trigger|pause|resume)
- /workflow → create_workflow | list_workflows | run_workflow
- When user speaks natural language (「设定目标」「写个计划」「每天 21:30 提醒」「每隔半小时巡检」), call the matching pattern tool.
[Tool calling method]
- Need tools? Prefer native tool_calls when the API supports tools; else JSON ONLY:
  {"toolCalls":[{"serverId":"pattern|desktop|<mcp>","tool":"SHORT_NAME","arguments":{...}}],"final":""}
- serverId: "pattern" for skill/task/goal/loop/reminder/workflow/plan/proactive, "desktop" for OS Bridge, or MCP server id.
- pattern SHORT_NAME examples: create_goal, update_plan, create_reminder, create_loop, create_skill, run_workflow.
- desktop tools: computer_use, launch, key, type, click, scroll, foreground, focus, accessibility_tree, accessibility_action, screenshot.
- NEVER set tool to "desktop:launch" or "desktop.launch" — put "desktop" in serverId.
- Computer Use MODE (required for multi-step UI: open app + operate, calculate, click controls):
  {"serverId":"desktop","tool":"computer_use","arguments":{"goal":"打开计算器并计算 1+1"}}
  Entering this mode starts a closed loop that injects screenshot + UIA tree every step. Do not fake multi-step UI with only launch+foreground.
- Single short action only (no multi-step UI): launch / key / type / click etc.
- MCP: {"serverId":"<id>","tool":"<name>","arguments":{}} only if listed in this turn's catalog.
- After receipts: natural-language answer; only claim what receipts prove.`;
}
function listJournal(limit = 80, query?: string | null) {
  try {
    const file = join(dataDir, 'journal', 'actions.jsonl');
    if (!existsSync(file)) return [] as Array<{ts: number; line: string; tier?: number; kind?: string; taskId?: string; decision?: string}>;
    const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    let items = lines.map((raw) => {
      try { return parseJournalLine(JSON.parse(raw)); } catch { return parseJournalLine(raw); }
    });
    if (query && query.trim()) {
      const q = query.trim().toLowerCase();
      items = items.filter((item) =>
        item.line.toLowerCase().includes(q)
        || String(item.kind || '').toLowerCase().includes(q)
        || String(item.decision || '').toLowerCase().includes(q)
        || String(item.taskId || '').toLowerCase().includes(q)
        || (item.tier != null && `t${item.tier}` === q)
      );
    }
    return items.slice(-Math.max(1, limit)).reverse();
  } catch {
    return [];
  }
}
function cleanupJournal() {
  const dir = join(dataDir, 'journal');
  if (!existsSync(dir)) return;
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.png')) continue;
    const file = join(dir, name);
    try { if (statSync(file).mtimeMs < cutoff) unlinkSync(file); } catch { /* best effort */ }
  }
}
cleanupJournal();

// ---- Project/global file-change buffer (for proactive inject + dreaming) ----
type FileChangeEntry = {
  path: string;
  kind: string;
  ts: number;
  scope: string; // global | project:<id>
  projectId?: string;
  projectName?: string;
  size?: number;
  excerpt?: string;
};
const FILE_CHANGE_BUFFER_MAX = 400;
let fileChangeBuffer: FileChangeEntry[] = [];
let lastProactiveInjectAt = 0;
let lastDreamDay = '';
const DEFAULT_WATCH_IGNORES = ['node_modules', '.git', 'dist', 'target', 'build', '.next', '__pycache__', '.reasonix', 'release'];

function loadProjectsForWatch(): Array<{id: string; name: string; path: string}> {
  try {
    // Desktop persists projects in localStorage; sidecar may receive via config later.
    // Also check projects.json under dataDir if present.
    const file = join(dataDir, 'projects.json');
    if (!existsSync(file)) return [];
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((p: any) => p && typeof p.path === 'string' && typeof p.id === 'string')
      .map((p: any) => ({id: String(p.id), name: String(p.name || p.id), path: String(p.path)}));
  } catch {
    return [];
  }
}

function shouldIgnoreWatchPath(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/').toLowerCase();
  return DEFAULT_WATCH_IGNORES.some((seg) => norm.includes(`/${seg}/`) || norm.endsWith(`/${seg}`));
}

function pushFileChange(entry: FileChangeEntry) {
  if (shouldIgnoreWatchPath(entry.path)) return;
  // merge same path within buffer: keep latest
  fileChangeBuffer = fileChangeBuffer.filter((item) => item.path !== entry.path || item.scope !== entry.scope);
  fileChangeBuffer.unshift(entry);
  if (fileChangeBuffer.length > FILE_CHANGE_BUFFER_MAX) fileChangeBuffer = fileChangeBuffer.slice(0, FILE_CHANGE_BUFFER_MAX);
}

function listFileChangesSince(sinceTs: number, scope?: string, limit = 40): FileChangeEntry[] {
  return fileChangeBuffer
    .filter((item) => item.ts >= sinceTs && (!scope || item.scope === scope || (scope === 'global' && item.scope === 'global')))
    .slice(0, limit);
}

function formatFileDeltaForPrompt(entries: FileChangeEntry[], maxChars = 3500): string {
  if (!entries.length) return '(no file changes since last proactive/dream window)';
  const lines: string[] = [`File changes (${entries.length} recent):`];
  let used = lines[0].length;
  for (const e of entries) {
    const head = `- [${e.scope}] ${e.kind} ${e.path}${e.size != null ? ` (${e.size}B)` : ''}`;
    const body = e.excerpt ? `\n  excerpt: ${e.excerpt.replace(/\s+/g, ' ').slice(0, 180)}` : '';
    const line = head + body;
    if (used + line.length + 1 > maxChars) {
      lines.push(`- … (${entries.length - lines.length + 1} more omitted)`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

function resolveWatchScope(filePath: string): {scope: string; projectId?: string; projectName?: string} {
  const norm = filePath.replace(/\\/g, '/').toLowerCase();
  for (const project of loadProjectsForWatch()) {
    const root = project.path.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');
    if (norm === root || norm.startsWith(root + '/')) {
      return {scope: `project:${project.id}`, projectId: project.id, projectName: project.name};
    }
  }
  return {scope: 'global'};
}

async function runDreamingJob(force = false): Promise<{ok: boolean; text?: string; error?: string}> {
  if (!config?.apiKey) return {ok: false, error: 'no model'};
  const dayKey = new Date().toISOString().slice(0, 10);
  if (!force && lastDreamDay === dayKey) return {ok: true, text: 'already dreamed today'};
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const changes = listFileChangesSince(since, undefined, 80);
  const recentConvHint = `Local day ${dayKey}. Summarize the companion's day for durable memory.`;
  const delta = formatFileDeltaForPrompt(changes, 6000);
  const system = `You are Pattern's dreaming process. Compress the last day into durable daily memories.
Return JSON only: {"memories":[{"text":"string","category":"event|reference|fact|preference","importance":0.0-1.0,"scope":"global|project","projectId":"optional"}]}.
Rules: short factual bullets; no role-play; do not invent files not listed; if no signal, return {"memories":[]}.`;
  const user = `${recentConvHint}\n\n${delta}\n\nAlso consider this purpose: consolidate file awareness into daily memory for later retrieval.`;
  try {
    const anthropic = config.provider.toLowerCase().includes('anthropic');
    const response = await fetch(endpoint(anthropic ? '/messages' : '/chat/completions'), anthropic
      ? {
          method: 'POST',
          headers: {'content-type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01'},
          body: JSON.stringify({model: config.model, max_tokens: 1200, temperature: 0.2, system, messages: [{role: 'user', content: user}]}),
        }
      : {
          method: 'POST',
          headers: {'content-type': 'application/json', authorization: `Bearer ${config.apiKey}`},
          body: JSON.stringify({model: config.model, temperature: 0.2, messages: [{role: 'system', content: system}, {role: 'user', content: user}]}),
        });
    if (!response.ok) return {ok: false, error: `dream model ${response.status}`};
    const json: any = await response.json();
    recordUsage(config.provider, config.model, json.usage);
    const raw = String(anthropic ? json.content?.map((item: any) => item.text).join('') : json.choices?.[0]?.message?.content || '');
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = match ? JSON.parse(match[0]) : {memories: []};
    const items = Array.isArray(parsed.memories) ? parsed.memories : [];
    let written = 0;
    for (const item of items.slice(0, 12)) {
      const body = String(item.text || '').trim();
      if (!body) continue;
      const scope = String(item.scope || 'global');
      const projectId = item.projectId ? String(item.projectId) : '';
      const prefix = scope.startsWith('project') || projectId
        ? `[daily:${dayKey}][project:${projectId || scope.replace(/^project:/, '')}] `
        : `[daily:${dayKey}][global] `;
      await memory.upsertSimilar({
        text: `${prefix}${body}`.slice(0, 2000),
        category: ['event', 'reference', 'fact', 'preference', 'feedback'].includes(String(item.category)) ? String(item.category) : 'event',
        importance: Math.max(0.2, Math.min(0.95, Number(item.importance) || 0.55)),
        sourceConv: `dream:${dayKey}:${scope}`,
      });
      written += 1;
    }
    // still run decay consolidate
    memory.consolidate(dayKey);
    lastDreamDay = dayKey;
    try { writeFileSync(join(dataDir, 'last-dream-day.txt'), dayKey); } catch { /* ignore */ }
    return {ok: true, text: `dreamed ${written} memories for ${dayKey}`};
  } catch (error) {
    return {ok: false, error: error instanceof Error ? error.message : String(error)};
  }
}

try { lastDreamDay = readFileSync(join(dataDir, 'last-dream-day.txt'), 'utf8').trim(); } catch { lastDreamDay = ''; }
function loadFileWatchConfig(): FileWatchConfig {
  const file = join(dataDir, 'file-watch.json');
  if (!existsSync(file)) return {...defaultFileWatchConfig};
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<FileWatchConfig>;
    return {
      enabled: !!value.enabled,
      paths: Array.isArray(value.paths) ? value.paths.filter((p): p is string => typeof p === 'string') : [],
      extensions: Array.isArray(value.extensions) ? value.extensions.map((x) => String(x).toLowerCase()) : defaultFileWatchConfig.extensions,
      maxBytes: Math.max(1024, Math.min(1024 * 1024, Number(value.maxBytes) || defaultFileWatchConfig.maxBytes)),
    };
  } catch { return {...defaultFileWatchConfig}; }
}
function saveFileWatchConfig() {
  writeFileSync(join(dataDir, 'file-watch.json'), JSON.stringify(fileWatchConfig, null, 2));
}
function loadHealthChecks(): HealthCheckConfig[] {
  const file = join(dataDir, 'health-checks.json');
  if (!existsSync(file)) return [];
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return Array.isArray(value) ? value.filter((item): item is HealthCheckConfig => !!item && typeof item.url === 'string' && /^https?:\/\//i.test(item.url)).slice(0, 20) : [];
  } catch { return []; }
}
function saveHealthChecks() { writeFileSync(join(dataDir, 'health-checks.json'), JSON.stringify(healthChecks, null, 2)); }
function loadTelegramOffset() {
  try { return Number(readFileSync(join(dataDir, 'telegram-offset.txt'), 'utf8')) || 0; } catch { return 0; }
}
function saveTelegramOffset() { writeFileSync(join(dataDir, 'telegram-offset.txt'), String(telegramOffset)); }
function loadCronTriggers(): CronTriggerConfig[] {
  try {
    const value = JSON.parse(readFileSync(join(dataDir, 'cron-triggers.json'), 'utf8')) as unknown;
    return Array.isArray(value) ? value.filter((item): item is CronTriggerConfig => !!item && typeof item.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(item.time) && typeof item.message === 'string').slice(0,30) : [];
  } catch { return []; }
}
function saveCronTriggers() { writeFileSync(join(dataDir, 'cron-triggers.json'), JSON.stringify(cronTriggers, null, 2)); }
async function cronTick() {
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const day = `${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()}`;
  for (const trigger of cronTriggers) {
    const key = `${day}:${trigger.id}`;
    if (!trigger.enabled || trigger.time !== time || cronFired.has(key)) continue;
    cronFired.add(key);
    if (cronFired.size > 500) cronFired.clear();
    // Legacy clock reminders are an explicit user promise, not a model suggestion.
    await deliverProactive({body: trigger.message, type: 'reminder', reason: `定时提醒 ${trigger.time}`, origin: 'system'});
  }
}
function scheduledTime(now: Date) { return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`; }
function scheduleDue(task: TaskRecord, now: Date) {
  const schedule = task.schedule;
  if (!schedule?.enabled) return false;
  if (schedule.kind === 'interval') return now.getTime() - (task.lastRunAt || new Date(task.createdAt).getTime() || now.getTime()) >= Math.max(1, schedule.intervalMinutes || 60) * 60_000;
  if (schedule.kind === 'once') return !!schedule.at && schedule.at <= now.getTime();
  if (schedule.time !== scheduledTime(now)) return false;
  return schedule.kind === 'daily' || (schedule.days || []).includes(now.getDay());
}
function nextScheduleAt(schedule: TaskSchedule, from = Date.now()) {
  if (schedule.kind === 'interval') return from + Math.max(1, schedule.intervalMinutes || 60) * 60_000;
  if (schedule.kind === 'once') return schedule.at;
  const cursor = new Date(from); cursor.setSeconds(0, 0);
  for (let i=0; i<8; i++) {
    if (i) cursor.setDate(cursor.getDate() + 1);
    const [hour, minute] = (schedule.time || '09:00').split(':').map(Number); cursor.setHours(hour, minute, 0, 0);
    if (cursor.getTime() <= from) continue;
    if (schedule.kind === 'daily' || (schedule.days || []).includes(cursor.getDay())) return cursor.getTime();
  }
  return undefined;
}
function startTaskRun(task: TaskRecord): TaskRun {
  const run: TaskRun = {id: randomUUID(), startedAt: Date.now(), status: 'running'};
  task.runs = [run, ...(task.runs || [])].slice(0, 50); task.activeRunId = run.id;
  task.lastRunAt = run.startedAt; task.runCount = (task.runCount || 0) + 1;
  return run;
}
function heartbeatUrl(connection: {provider: string; endpoint: string}) {
  const base = connection.endpoint.replace(/\/+$/, '');
  return connection.provider.toLowerCase().includes('anthropic') ? base : `${base}/models`;
}
function heartbeatChecks(): HealthCheckConfig[] {
  const configured = (config?.modelConnections || [])
    .filter((item) => item.enabled !== false && item.provider?.trim() && /^https?:\/\//i.test(item.endpoint || ''))
    .map((item) => ({url: heartbeatUrl(item), label: `${item.name?.trim() || item.provider} · 模型服务`}));
  return configured.length ? configured.slice(0, 20) : healthChecks;
}
function finishTaskRun(task: TaskRecord, status: TaskRun['status'], error?: string) {
  const run = task.runs?.find((item) => item.id === task.activeRunId);
  if (run) { run.status = status; run.finishedAt = Date.now(); run.error = error; }
  task.activeRunId = undefined;
}
function enqueueComputerUseTask(task: TaskRecord) {
  if (queuedComputerUseTaskIds.has(task.id)) return;
  queuedComputerUseTaskIds.add(task.id);
  const execute = async () => {
    try {
      while (task.status === 'paused') await new Promise((resolve) => setTimeout(resolve, 300));
      if (['cancelled','done','failed','scheduled'].includes(task.status)) return;
      await runComputerUseTask(task);
    } finally {
      queuedComputerUseTaskIds.delete(task.id);
    }
  };
  computerUseQueue = computerUseQueue.then(execute, execute);
  void computerUseQueue;
}
/** Fire persisted execution tasks. Each firing enters the normal approval pipeline and is retained in run history. */
async function scheduledTaskTick() {
  const now = new Date(); const day = `${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()}`;
  for (const task of tasks) {
    const schedule = task.schedule; const key = `task:${day}:${task.id}:${scheduledTime(now)}`;
    if (!scheduleDue(task, now) || cronFired.has(key)) continue;
    if (['running', 'paused', 'awaiting_approval', 'queued'].includes(task.status)) continue;
    cronFired.add(key); if (cronFired.size > 1000) cronFired.clear();
    task.status = 'queued'; task.error = undefined; startTaskRun(task);
    task.nextRunAt = nextScheduleAt(schedule!, now.getTime());
    if (schedule?.kind === 'once') schedule.enabled = false;
    saveTasks(); announceTask(task); enqueueComputerUseTask(task);
  }
}
async function healthTick() {
  for (const check of heartbeatChecks()) {
    let online = false;
    try {
      const active = config && check.url.startsWith(heartbeatUrl({provider: config.provider, endpoint: config.endpoint}));
      const provider = config?.provider.toLowerCase() || '';
      const headers = active && config?.apiKey
        ? provider.includes('anthropic')
          ? {'x-api-key': config.apiKey}
          : {authorization: `Bearer ${config.apiKey}`}
        : undefined;
      const response = await fetch(check.url, {headers, signal: AbortSignal.timeout(10_000)});
      // 401/404 still proves the supplier is reachable; only transport/server failures are offline.
      online = response.status < 500;
    } catch { /* offline */ }
    const previous = healthStates.get(check.url);
    healthStates.set(check.url, online);
    if (previous === undefined || previous === online) continue;
    const label = check.label?.trim() || check.url;
    const impulse = proactive.manualImpulse({type:'health_check', reason:`${label} ${online ? '已恢复' : '不可用'}`, topicKey:`health:${check.url}`});
    await handleImpulse(impulse, true);
  }
}
function emitFileWatch(item: FileWatchEvent) {
  fileWatchEvents.unshift(item);
  fileWatchEvents = fileWatchEvents.slice(0, 200);
  broadcast({type: 'filewatch.event', item});
  try {
    const scopeInfo = resolveWatchScope(String((item as any).path || ''));
    pushFileChange({
      path: String((item as any).path || ''),
      kind: String((item as any).kind || 'change'),
      ts: Date.now(),
      scope: scopeInfo.scope,
      projectId: scopeInfo.projectId,
      projectName: scopeInfo.projectName,
    });
  } catch { /* ignore */ }
}
async function decideFileRead(path: string, kind: string): Promise<{read: boolean; reason: string}> {
  if (!config?.apiKey) return {read: false, reason: '未配置模型，不自动读取'};
  const utility = config.utility;
  const provider = utility?.provider || config.provider;
  const base = utility?.endpoint || config.endpoint;
  const model = utility?.model || config.model;
  const apiKey = utility?.apiKey || config.apiKey;
  const anthropic = provider.toLowerCase().includes('anthropic');
  const prompt = `A watched file changed. Decide whether reading it would materially help a personal desktop companion understand the user. Consider only metadata; do not assume content. Return JSON only: {"read":boolean,"reason":"short reason"}.\nPath: ${path}\nChange: ${kind}`;
  try {
    const response = await fetch(endpoint(anthropic ? '/messages' : '/chat/completions', base), anthropic ? {
      method: 'POST', headers: {'content-type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
      body: JSON.stringify({model, max_tokens: 160, temperature: 0, messages:[{role:'user',content:prompt}]})
    } : {
      method: 'POST', headers: {'content-type':'application/json',authorization:`Bearer ${apiKey}`},
      body: JSON.stringify({model, temperature:0, stream:false, messages:[{role:'system',content:'Return JSON only.'},{role:'user',content:prompt}]})
    });
    if (!response.ok) return {read:false, reason:`判断模型返回 ${response.status}`};
    const json:any = await response.json();
    const text = anthropic ? json.content?.map((x:any)=>x.text).join('') : json.choices?.[0]?.message?.content;
    const parsed = JSON.parse(String(text).match(/\{[\s\S]*\}/)?.[0] || '{}');
    return {read: parsed.read === true, reason: String(parsed.reason || (parsed.read ? '与用户上下文可能有关' : '无需读取')).slice(0, 200)};
  } catch (error) { return {read:false, reason:`判断失败：${error instanceof Error ? error.message : error}`}; }
}
async function processFileChange(path: string, kind: string) {
  const item: FileWatchEvent = {id: randomUUID(), path, kind, ts: Math.floor(Date.now()/1000), decision:'pending', reason:'AI 正在判断是否需要阅读'};
  emitFileWatch(item);
  try {
    if (!existsSync(path) || !statSync(path).isFile()) { item.decision='ignored'; item.reason='不是可读文件或已删除'; emitFileWatch(item); return; }
    const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
    if (fileWatchConfig.extensions.length && !fileWatchConfig.extensions.includes(ext)) { item.decision='ignored'; item.reason=`扩展名 ${ext || '(无)'} 不在允许列表`; emitFileWatch(item); return; }
    const decision = await decideFileRead(path, kind);
    if (!decision.read) { item.decision='ignored'; item.reason=decision.reason; emitFileWatch(item); return; }
    const size = statSync(path).size;
    if (size > fileWatchConfig.maxBytes) { item.decision='ignored'; item.reason=`文件 ${size} bytes，超过读取上限`; emitFileWatch(item); return; }
    const content = readFileSync(path, 'utf8');
    item.decision='read'; item.reason=decision.reason; emitFileWatch(item);
    const scopeInfo = resolveWatchScope(path);
    pushFileChange({
      path,
      kind: item.kind || 'change',
      ts: Date.now(),
      scope: scopeInfo.scope,
      projectId: scopeInfo.projectId,
      projectName: scopeInfo.projectName,
      size: content.length,
      excerpt: content.slice(0, 400),
    });
    const memoryItem = await memory.upsertSimilar({text:`文件变化 ${path}：${content.slice(0, 1200)}`, category:'reference', importance:0.45, sourceConv:`filewatch:${item.id}`});
    broadcast({type:'memory.changed'});
    const impulse = proactive.manualImpulse({type:'file_change', reason:`我阅读了变化的文件 ${path}`, topicKey:`file:${path}`});
    const log = proactive.markDelivered(impulse, `文件已更新：${path}\n${decision.reason}\n已索引为参考记忆 ${memoryItem.id}`, 'log');
    broadcast({type:'proactive.impulse', item:log});
  } catch (error) { item.decision='failed'; item.reason=error instanceof Error ? error.message : String(error); emitFileWatch(item); }
}
function restartFileWatchers() {
  for (const watcher of fileWatchers) watcher.close();
  fileWatchers = [];
  if (!fileWatchConfig.enabled && loadProjectsForWatch().length === 0) return;
  const roots = new Map<string, string>(); // path -> scope label
  if (fileWatchConfig.enabled) {
    for (const root of fileWatchConfig.paths) roots.set(root, 'global');
  }
  // Auto-watch registered project folders
  for (const project of loadProjectsForWatch()) {
    if (project.path) roots.set(project.path, `project:${project.id}`);
  }
  for (const root of roots.keys()) {
    if (!existsSync(root)) continue;
    try {
      const watcher = watch(root, {recursive:true}, (kind, filename) => {
        if (!filename) return;
        const path = join(root, filename.toString());
        const previous = fileWatchDebounce.get(path); if (previous) clearTimeout(previous);
        fileWatchDebounce.set(path, setTimeout(() => { fileWatchDebounce.delete(path); void processFileChange(path, kind); }, 800));
      });
      fileWatchers.push(watcher);
    } catch (error) { console.error('[pattern-sidecar] file watch failed', root, error); }
  }
}
async function callEmbedding(text: string): Promise<Float32Array | null> {
  const emb = config?.embedding;
  if (!emb?.endpoint || !emb.apiKey) return null;
  try {
    const res = await fetch(endpoint('/embeddings', emb.endpoint), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${emb.apiKey}`,
      },
      body: JSON.stringify({model: emb.model || 'text-embedding-3-small', input: text}),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {data?: Array<{embedding: number[]}>};
    const arr = json.data?.[0]?.embedding;
    if (!arr?.length) return null;
    return Float32Array.from(arr);
  } catch {
    return null;
  }
}
async function localSemanticEmbedding(text: string): Promise<Float32Array> {
  if (!localSemanticEmbedder) {
    localSemanticEmbeddingLoading ??= (async () => {
      const transformers = await import('@huggingface/transformers');
      transformers.env.cacheDir = join(dataDir, 'models');
      const extractor = await transformers.pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5', {dtype: 'q8', device: 'wasm'} as any);
      return async (input: string) => {
        const output: any = await extractor(input, {pooling: 'mean', normalize: true});
        return Float32Array.from(output.data as Float32Array);
      };
    })();
    try { localSemanticEmbedder = await localSemanticEmbeddingLoading; }
    finally { localSemanticEmbeddingLoading = null; }
  }
  return localSemanticEmbedder(text);
}
memory.setEmbedder(async (text) => {
  const remote = await callEmbedding(text);
  if (remote) return remote;
  if (config?.embedding?.provider === 'local') {
    try { return await localSemanticEmbedding(text); }
    catch (error) { console.warn('[pattern-sidecar] local semantic embedding unavailable; using hash fallback', error); }
  }
  return localEmbed(text);
});
async function streamChat(
  socket: WebSocket,
  message: ChatRequest,
  system: string,
  slot: AgentSlot = 'companion',
  signal?: AbortSignal,
  options: {emitStarted?: boolean; emitDone?: boolean; setIdleOnDone?: boolean} = {},
): Promise<string> {
  if (!config) throw new Error('runtime is not configured');
  const emitStarted = options.emitStarted !== false;
  const emitDone = options.emitDone !== false;
  const setIdleOnDone = options.setIdleOnDone !== false;
  setAgentState('thinking');
  if (emitStarted) send(socket, {type: 'chat.started', id: message.id, slot});
  const anthropic = config.provider.toLowerCase().includes('anthropic');
  const startedAt = Date.now();
  let streamUsage: any;
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000);
  const response = await fetch(endpoint(anthropic ? '/messages' : '/chat/completions'), anthropic
    ? {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: 2048,
          stream: true,
          system,
          messages: [...message.history, {role: 'user', content: message.text}],
        }),
        signal: requestSignal,
      }
    : {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          stream: true,
          stream_options: {include_usage: true},
          messages: [{role: 'system', content: system}, ...message.history, {role: 'user', content: message.text}],
        }),
        signal: requestSignal,
      });
  if (!response.ok) throw new Error(`model API status ${response.status}: ${(await response.text()).slice(0, 300)}`);
  if (!response.body) throw new Error('model API returned empty body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, {stream: true});
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        const delta = anthropic ? json.delta?.text : json.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) {
          full += delta;
          send(socket, {type: 'chat.delta', id: message.id, delta});
        }
        if (json.usage || json.message?.usage) streamUsage = {...streamUsage, ...(json.usage || json.message?.usage)};
      } catch {
        /* keepalive */
      }
    }
  }
  if (streamUsage) recordUsage(config.provider, config.model, streamUsage, Date.now() - startedAt);
  if (emitDone) send(socket, {type: 'chat.done', id: message.id, slot});
  if (setIdleOnDone) setAgentState('idle');
  return full;
}
function heuristicExtract(userText: string): Array<{text: string; category: string; importance: number}> {
  const text = userText.trim();
  if (!text) return [];
  const rules: Array<{re: RegExp; category: string; importance: number; toText?: (m: RegExpMatchArray) => string}> = [
    {re: /\u6211(?:\u517b\u4e86|\u6709)(.+?)(?:[\u3002\uff01\uff1f.!?]|$)/, category: 'fact', importance: 0.8, toText: (m) => `\u7528\u6237\u517b\u4e86/\u6709${m[1].trim()}`},
    {re: /\u6211\u4f4f\u5728(.+?)(?:[\u3002\uff01\uff1f.!?]|$)/, category: 'fact', importance: 0.8, toText: (m) => `\u7528\u6237\u4f4f\u5728${m[1].trim()}`},
    {re: /\u6211(?:\u559c\u6b22|\u7231)(.+?)(?:[\u3002\uff01\uff1f.!?]|$)/, category: 'preference', importance: 0.7, toText: (m) => `\u7528\u6237\u559c\u6b22${m[1].trim()}`},
    {re: /\u6211(?:\u4e0d\u559c\u6b22|\u8ba8\u538c)(.+?)(?:[\u3002\uff01\uff1f.!?]|$)/, category: 'preference', importance: 0.7, toText: (m) => `\u7528\u6237\u4e0d\u559c\u6b22${m[1].trim()}`},
    {re: /\u6211\u53eb(.+?)(?:[\u3002\uff01\uff1f.!?]|$)/, category: 'fact', importance: 0.9, toText: (m) => `\u7528\u6237\u540d\u5b57\u662f${m[1].trim()}`},
  ];
  const out: Array<{text: string; category: string; importance: number}> = [];
  for (const rule of rules) {
    const m = text.match(rule.re);
    if (m) out.push({text: rule.toText ? rule.toText(m) : m[0], category: rule.category, importance: rule.importance});
  }
  return out;
}
type MemoryProposal = {id: string; text: string; category: string; importance: number; sourceConv?: string | null; reason?: string; ts: number};
let memoryProposals: MemoryProposal[] = [];
function proposeMemory(item: {text: string; category: string; importance: number; sourceConv?: string | null; reason?: string}) {
  const text = item.text.trim();
  if (!text) return;
  if (memoryProposals.some((entry) => entry.text === text)) return;
  const proposal: MemoryProposal = {
    id: randomUUID(),
    text,
    category: item.category || 'fact',
    importance: typeof item.importance === 'number' ? item.importance : 0.5,
    sourceConv: item.sourceConv || null,
    reason: item.reason || '对话提取',
    ts: Date.now(),
  };
  memoryProposals = [proposal, ...memoryProposals].slice(0, 40);
  broadcast({type: 'memory.proposed', items: memoryProposals});
}
async function extractMemories(userText: string, assistantText: string, sessionId?: string) {
  for (const item of heuristicExtract(userText)) {
    proposeMemory({
      text: item.text,
      category: item.category,
      importance: item.importance,
      sourceConv: sessionId || null,
      reason: '规则提取',
    });
  }
  if (!config?.apiKey) return;
  const utility = config.utility;
  const provider = utility?.provider || config.provider;
  const model = utility?.model || config.model;
  const apiKey = utility?.apiKey || config.apiKey;
  const base = utility?.endpoint || config.endpoint;
  const anthropic = provider.toLowerCase().includes('anthropic');
  const prompt = [
    'Extract durable memories from the dialogue.',
    'Return ONLY a JSON array. Each item: {"text":"...","category":"fact|preference|event|feedback","importance":0-1}',
    'If nothing worth remembering, return [].',
    '',
    `User: ${userText}`,
    `Assistant: ${assistantText}`,
  ].join('\n');
  try {
    const response = await fetch(endpoint(anthropic ? '/messages' : '/chat/completions', base), anthropic
      ? {
          method: 'POST',
          headers: {'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01'},
          body: JSON.stringify({
            model,
            max_tokens: 800,
            temperature: 0,
            stream: false,
            messages: [{role: 'user', content: prompt}],
          }),
        }
      : {
          method: 'POST',
          headers: {'content-type': 'application/json', authorization: `Bearer ${apiKey}`},
          body: JSON.stringify({
            model,
            temperature: 0,
            stream: false,
            messages: [
              {role: 'system', content: 'Output JSON array only.'},
              {role: 'user', content: prompt},
            ],
          }),
        });
    if (!response.ok) return;
    const ctype = response.headers.get('content-type') || '';
    const rawText = await response.text();
    if (ctype.includes('text/event-stream') || rawText.trimStart().startsWith('data:')) return;
    let json: any;
    try { json = JSON.parse(rawText); } catch { return; }
    const text = anthropic
      ? json.content?.map((c: any) => c.text).join('') || ''
      : json.choices?.[0]?.message?.content || '';
    const match = String(text).match(/\[[\s\S]*\]/);
    if (!match) return;
    const items = JSON.parse(match[0]) as Array<{text: string; category: string; importance: number}>;
    for (const item of items) {
      if (!item?.text?.trim()) continue;
      proposeMemory({
        text: item.text.trim(),
        category: item.category || 'fact',
        importance: item.importance,
        sourceConv: sessionId || null,
        reason: '模型提取',
      });
    }
  } catch (error) {
    console.error('[pattern-sidecar] extractMemories failed', error);
  }
}
function scheduleFromText(text: string): TaskSchedule | undefined {
  const match = text.match(/(?:每天|每日|every\s+day(?:\s+at)?)\s*(?:在|at)?\s*([01]?\d|2[0-3])[:：]([0-5]\d)/i);
  if (match) return {kind: 'daily', time: `${match[1].padStart(2, '0')}:${match[2]}`, enabled: true};
  const every = text.match(/(?:每隔|每)\s*(\d+)\s*(?:分钟|分|minutes?)/i);
  return every ? {kind:'interval', intervalMinutes:Math.max(1, Number(every[1])), enabled:true} : undefined;
}
async function createTaskFromText(
  title: string,
  detail = '',
  schedule?: TaskSchedule,
  workflow?: TaskRecord['workflow'],
  plan?: TaskRecord['plan'],
  context?: {conversationId?: string; workspace?: string; projectName?: string},
) {
  const normalizedSchedule = schedule || scheduleFromText(`${title}\n${detail}`);
  const task: TaskRecord = {
    id: randomUUID(),
    title: title.trim() || '未命名任务',
    detail: detail || title,
    status: normalizedSchedule ? 'scheduled' : 'queued',
    createdAt: new Date().toLocaleString('zh-CN'),
    conversationId: context?.conversationId,
    workspace: context?.workspace,
    projectName: context?.projectName,
    steps: [],
    riskTier: classifyTaskTier(title, detail || title),
    schedule: normalizedSchedule,
    plan: plan?.filter((step) => step?.title?.trim() && step?.detail?.trim()).slice(0, 30),
    nextRunAt: normalizedSchedule ? nextScheduleAt(normalizedSchedule) : undefined,
    workflow,
  };
  tasks.unshift(task);
  saveTasks();
  announceTask(task);
  if (!normalizedSchedule) enqueueComputerUseTask(task);
  return task;
}
function announceTask(task: TaskRecord) {
  broadcast({type: 'task.updated', task});
  if (!relay.status().configured) return;
  const envelope = relay.createEnvelope({
    role: 'system',
    type: 'task',
    body: JSON.stringify({version: 1, updatedAt: Date.now(), task}),
  });
  void relay.publish(envelope).catch((error) => console.error('[pattern-sidecar] relay task publish failed', error));
}
async function chat(socket: WebSocket, message: ChatRequest) {
  lastUserActivityAt = Math.floor(Date.now() / 1000);
  if (!config) {
    send(socket, {type: 'chat.error', id: message.id, message: 'runtime is not configured'});
    return;
  }
  const controller = new AbortController();
  activeChats.set(message.id, {controller, socket});
  try {
    const allowSubAgents = message.allowSubAgents !== false;

    // Slash commands (/goal /skill /loop /plan …) short-circuit into structured handlers.
    const slash = parseSlashCommand(message.text);
    if (slash) {
      setAgentState('thinking');
      send(socket, {type: 'chat.started', id: message.id, slot: 'companion'});
      send(socket, {
        type: 'chat.event',
        id: message.id,
        event: {
          id: `slash:${message.id}`,
          kind: 'tool',
          action: `slash.${slash.kind}`,
          text: `斜杠指令 · /${slash.kind}`,
          status: 'running',
          ts: Date.now(),
        },
      });
      try {
        const reply = await executeSlashCommand(slash, makeSlashDeps({
          conversationId: message.sessionId,
          workspace: message.workspace,
          projectName: message.projectName,
        }));
        // Keep dedicated UIs in sync after any slash side-effect.
        if (slash.kind === 'goal') {
          const goals = loadGoals(dataDir);
          const goal = goals.find((g: GoalState) => g.status === 'active' || g.status === 'paused' || g.status === 'done' || g.status === 'blocked') || goals[0];
          if (goal) broadcast({type: 'goal.updated', goal, goals});
        }
        if (slash.kind === 'plan' && message.sessionId) {
          const plan = getSessionPlan(dataDir, message.sessionId);
          if (plan) broadcast({type: 'session_plan.updated', plan});
        }
        if (slash.kind === 'skill') {
          broadcast({type: 'skill.updated', id: message.id, skills: allSkills()});
        }
        if (slash.kind === 'remind' || slash.kind === 'loop') {
          broadcast({type: 'cron.config', id: message.id, triggers: cronTriggers});
        }
        if (slash.kind === 'proactive' && config?.proactive) {
          broadcast({
            type: 'proactive.config',
            id: message.id,
            enabled: config.proactive.enabled !== false,
            paused: !!config.proactive.paused,
            bedtimeHour: config.proactive.bedtimeHour ?? 23,
          });
        }
        // task/loop/workflow/skill-run already announce via createTaskFromText → task.updated
        const slashLabels: Record<string, string> = {
          goal: '目标已更新 · 见顶栏 Goal',
          plan: '会话计划已更新 · 见顶栏 Plan',
          loop: '循环已创建 · 见顶栏 Loop / 任务页',
          skill: '技能已处理 · 见侧栏「技能」',
          task: '任务已创建 · 见侧栏「任务」',
          remind: '提醒已设置 · 见顶栏 Remind / 主动页',
          proactive: '主动设置已更新 · 见侧栏「主动」',
          workflow: '工作流已处理 · 见侧栏「技能」与任务',
          help: '帮助',
          unknown: '未识别指令',
        };
        send(socket, {
          type: 'chat.event',
          id: message.id,
          event: {
            id: `slash:${message.id}`,
            kind: 'tool',
            action: `slash.${slash.kind}`,
            text: slashLabels[slash.kind] || `/${slash.kind} 完成`,
            status: 'done',
            ts: Date.now(),
          },
        });
        const chunkSize = 48;
        for (let i = 0; i < reply.length; i += chunkSize) {
          send(socket, {type: 'chat.delta', id: message.id, delta: reply.slice(i, i + chunkSize)});
        }
        send(socket, {type: 'chat.done', id: message.id, slot: 'companion'});
      } catch (error) {
        send(socket, {
          type: 'chat.error',
          id: message.id,
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setAgentState('idle');
      }
      return;
    }

    // Computer Use is a primary-agent MODE. Re-classify even if the client forced slot=companion.
    // allowSubAgents only affects worker-model preference later — it must NOT block mode entry.
    const classified = await classifyRoute(message.text);
    const wantsComputerUse =
      message.slot === 'executor'
      || shouldTransferToExecutor(message.text)
      || (classified.slot === 'executor' && classified.confidence >= 0.85);
    if (wantsComputerUse) {
      const title = taskTitleFromText(message.text);
      const task = await createTaskFromText(title, message.text, scheduleFromText(message.text), undefined, undefined, {
        conversationId: message.sessionId,
        workspace: message.workspace,
        projectName: message.projectName,
      });
      send(socket, {type: 'chat.started', id: message.id, slot: 'executor'});
      send(socket, {
        type: 'chat.event',
        id: message.id,
        event: {
          id: `task:${task.id}:start`,
          kind: 'tool',
          action: 'computer_use',
          text: `已进入 computer-use · ${task.title}`,
          status: 'running',
          taskId: task.id,
          receipt: JSON.stringify({
            mode: 'computer_use',
            taskId: task.id,
            status: task.status,
            title: task.title,
            allowSubAgents,
            note: 'Per-step UIA tree + screenshot injected inside the computer-use loop',
          }),
          ts: Date.now(),
        },
      });
      send(socket, {
        type: 'chat.delta',
        id: message.id,
        delta: `好的，我来处理：${task.title}
已进入 computer-use 模式（每步自动注入前台窗口 UIA 控件树 + 截图并执行操作）。进度会显示在上方「工作过程」里。`,
      });
      send(socket, {type: 'chat.done', id: message.id, slot: 'executor'});
      return;
    }
    const hits = await memory.search(message.text, 5);
    if (hits.length) memory.touch(hits.map((h) => h.id));
    if (message.workspace) {
      if (securityPolicy.enforceWorkspace) {
        securityPolicy.workspaceRoot = message.workspace;
        saveSecurityPolicy();
      }
      send(socket, {
        type: 'chat.event',
        id: message.id,
        event: {
          id: `workspace:${message.workspace}`,
          kind: 'workspace',
          text: ('工作区隔离已绑定 · ' + (message.projectName || '') + ' · ' + message.workspace).replace(/\s+·/g, ' ·').trim(),
          status: 'done',
          ts: Date.now(),
        },
      });
    }
    const mentionBlock = enrichWithMentions(message.text, {
      allSkills,
      getWorkflows: allWorkflows,
      getTasks: () => tasks,
      projectName: message.projectName,
      workspace: message.workspace,
    });
    const enrichedMessage = mentionBlock
      ? {...message, text: `${message.text}\n\n${mentionBlock}`}
      : message;
    const system = buildSystemPrompt(hits, 'companion', {
      workspace: message.workspace,
      projectName: message.projectName,
      attachments: message.attachments,
      allowSubAgents,
      conversationId: message.sessionId,
      patternQuery: message.text,
    });
    const full = await runCompanionToolLoop(socket, enrichedMessage, system, controller.signal);
    void extractMemories(message.text, full, message.sessionId).then(() => {
      const related = memoryProposals.filter((item) => item.sourceConv === (message.sessionId || null)).slice(0, 5);
      if (related.length) {
        send(socket, {
          type: 'chat.event',
          id: message.id,
          event: {
            id: `memory:proposals:${message.sessionId || message.id}`,
            kind: 'memory',
            text: `待确认记忆 ${related.length} 条：${related.map((item) => item.text).join(' / ').slice(0, 160)}`,
            status: 'done',
            ts: Date.now(),
          },
        });
      }
    });
  } catch (error) {
    setAgentState('idle');
    if (controller.signal.aborted) send(socket, {type: 'chat.cancelled', id: message.id});
    else send(socket, {
        type: 'chat.error',
        id: message.id,
        message: error instanceof Error ? error.message : String(error),
      });
  } finally {
    if (activeChats.get(message.id)?.controller === controller) activeChats.delete(message.id);
  }
}
async function classifyRoute(text:string) {
  const local=routeUserMessage(text);
  if(local.confidence>=0.8||!config)return local;
  const utility=config.utility;
  const provider=utility?.provider||config.provider;
  const model=utility?.model||config.model;
  const apiKey=utility?.apiKey||config.apiKey;
  const base=utility?.endpoint||config.endpoint;
  if(!apiKey||!model)return local;
  const anthropic=provider.toLowerCase().includes('anthropic');
  const prompt=`Classify the user's intent. executor means they want the computer to perform an action; companion means conversation, advice, explanation, or information. Return JSON only: {"slot":"companion|executor","confidence":0..1}. User: ${JSON.stringify(text)}`;
  try{
    const response=await fetch(endpoint(anthropic?'/messages':'/chat/completions',base),anthropic?{method:'POST',headers:{'content-type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},body:JSON.stringify({model,max_tokens:80,temperature:0,messages:[{role:'user',content:prompt}]})}:{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${apiKey}`},body:JSON.stringify({model,temperature:0,max_tokens:80,messages:[{role:'system',content:'Return route JSON only.'},{role:'user',content:prompt}]})});
    if(!response.ok)return local;
    const rawBody=await response.text();
    if((response.headers.get('content-type')||'').includes('text/event-stream')||rawBody.trimStart().startsWith('data:'))return local;
    const json:any=JSON.parse(rawBody);
    const raw=anthropic?json.content?.map((item:any)=>item.text).join(''):json.choices?.[0]?.message?.content;
    const parsed=JSON.parse(String(raw).match(/\{[\s\S]*\}/)?.[0]||'{}');
    if((parsed.slot==='executor'||parsed.slot==='companion')&&Number(parsed.confidence)>=0.6)return{slot:parsed.slot,confidence:Number(parsed.confidence),reason:'utility model classifier'};
  }catch{/* local routing remains authoritative on classifier failures */}
  return local;
}
type ProactiveDecision = {message?: string; nextRunAt?: number; reason?: string};
const proactiveTools = [
  {type:'function', function:{name:'emit_proactive_message', description:'Send one short, in-character proactive message to the user.', parameters:{type:'object', properties:{text:{type:'string'},reason:{type:'string'}}, required:['text'], additionalProperties:false}}},
  {type:'function', function:{name:'schedule_next_wakeup', description:'Schedule exactly one future autonomous wake-up for this same objective.', parameters:{type:'object', properties:{runAt:{type:'string', description:'RFC3339 timestamp'},purpose:{type:'string'},context:{type:'string'}}, required:['runAt','purpose'], additionalProperties:false}}},
] as const;

async function decideProactive(chain: ProactiveChain): Promise<ProactiveDecision> {
  if (!config?.apiKey) throw new Error('未配置模型，无法生成 AI 主动消息');
  const hits = await memory.search(`${chain.purpose}\n${chain.context || ''}`, 5);
  if (hits.length) memory.touch(hits.map((item) => item.id));
  const system = `${buildSystemPrompt(hits, 'companion', {patternQuery: `${chain.purpose}\n${chain.context || ''}`})}
[Proactive wake-up]
You are the user's companion, not a notification template.
Speak like a real person who knows them: short, specific, natural, in the companion's language and personality.
You may call emit_proactive_message once, schedule_next_wakeup once, both, or neither.
Never put a user-visible message in normal assistant text — only via emit_proactive_message.
Do not use canned lines such as "It is late. Save your work and get some rest." or bare internal reasons.
If you speak, invent one fresh human sentence grounded in the objective, memory, and current local time.
Do not schedule earlier than five minutes from now.`;
  const since = lastProactiveInjectAt || (Date.now() - 6 * 60 * 60 * 1000);
  const deltaEntries = listFileChangesSince(since, undefined, 30);
  const fileDelta = formatFileDeltaForPrompt(deltaEntries, 2500);
  const prompt = `Objective: ${chain.purpose}
Context: ${chain.context || '(none)'}
Current local time: ${new Date().toLocaleString('zh-CN')}
This is wake-up #${chain.consecutiveSilentRuns + 1}.
File awareness since last proactive window:
${fileDelta}
If you choose to speak, write one natural companion message (not a system notice). You may briefly reference real file changes above when relevant; do not invent paths. Keep it under 80 Chinese characters or 2 short English sentences.`;
  const anthropic = config.provider.toLowerCase().includes('anthropic');
  const response = await fetch(endpoint(anthropic ? '/messages' : '/chat/completions'), anthropic ? {
    method:'POST', headers:{'content-type':'application/json','x-api-key':config.apiKey,'anthropic-version':'2023-06-01'},
    body:JSON.stringify({model:config.model,max_tokens:360,system,messages:[{role:'user',content:prompt}],tools:proactiveTools.map((tool) => ({name:tool.function.name,description:tool.function.description,input_schema:tool.function.parameters}))})
  } : {
    method:'POST', headers:{'content-type':'application/json',authorization:`Bearer ${config.apiKey}`},
    body:JSON.stringify({model:config.model,temperature:0.8,messages:[{role:'system',content:system},{role:'user',content:prompt}],tools:proactiveTools,tool_choice:'auto'})
  });
  if (!response.ok) throw new Error(`主动模型返回 ${response.status}`);
  const json:any = await response.json();
  recordUsage(config.provider, config.model, json.usage);
  const calls = anthropic
    ? (json.content || []).filter((item:any) => item.type === 'tool_use').map((item:any) => ({name:item.name, args:item.input || {}}))
    : (json.choices?.[0]?.message?.tool_calls || []).map((item:any) => ({name:item.function?.name, args:JSON.parse(item.function?.arguments || '{}')}));
  const decision: ProactiveDecision = {};
  for (const call of calls) {
    if (call.name === 'emit_proactive_message' && !decision.message) {
      const text = String(call.args.text || '').trim().slice(0, 1200);
      if (text) { decision.message = text; decision.reason = String(call.args.reason || chain.purpose).slice(0, 300); }
    }
    if (call.name === 'schedule_next_wakeup' && !decision.nextRunAt) {
      const at = Date.parse(String(call.args.runAt || ''));
      if (Number.isFinite(at) && at >= Date.now() + 5 * 60_000) decision.nextRunAt = at;
    }
  }
  return decision;
}
async function telegramSend(text: string) {
  const telegram = config?.telegram;
  if (!telegram?.enabled || !telegram.token || !telegram.chatId) return;
  try { await new TelegramChannel(telegram.token,telegram.chatId).send(channelMessage(text)); }
  catch (error) { console.error('[pattern-sidecar] Telegram send failed', error); }
}
async function emailSend(subject: string, text: string) {
  const email = config?.email;
  if (!email?.enabled || !email.host || !email.recipient || !email.username || !email.password) return;
  try {
    const channel=await createSmtpChannel({host:email.host,port:email.port||587,secure:email.secure,username:email.username,password:email.password,recipient:email.recipient});
    await channel.send({...channelMessage(text,'proactive'),text});
  } catch (error) { console.error('[pattern-sidecar] email send failed', error); }
}
async function sendToPlugins(text: string, type: ChannelMessage['type']) {
  for (const [id, channel] of pluginChannels) {
    if (!channel.capabilities.outbound) continue;
    try {
      await channel.send({...channelMessage(text, type, `plugin:${id}`), text});
    } catch (error) {
      console.error(`[pattern-sidecar] plugin ${id} send failed`, error);
    }
  }
}
async function handlePluginMessage(pluginId: string, message: ChannelMessage) {
  const text = message.text?.trim();
  if (!text) return;
  lastUserActivityAt = Math.floor(Date.now() / 1000);
  try {
    const reply = await companionReply(text);
    const channel = pluginChannels.get(pluginId);
    if (reply && channel?.capabilities.outbound) {
      await channel.send({...channelMessage(reply, 'chat', `plugin:${pluginId}`), text: reply});
      void extractMemories(text, reply, `${pluginId}:${message.id}`);
    }
  } catch (error) {
    console.error(`[pattern-sidecar] plugin ${pluginId} inbound handling failed`, error);
  }
}
async function configurePlugins() {
  for (const unsubscribe of pluginUnsubscribers.splice(0)) unsubscribe();
  for (const channel of pluginChannels.values()) {
    try { await (channel as Channel & {close?: () => void | Promise<void>}).close?.(); } catch (error) { console.warn('[pattern-sidecar] plugin close failed', error); }
  }
  pluginChannels.clear();
  const enabled = new Map((config?.plugins || []).filter((item) => item?.enabled && item.id).map((item) => [item.id, item.config]));
  if (!enabled.size) return;
  for (const plugin of discoverChannelPlugins(join(dataDir, 'plugins'))) {
    if (!enabled.has(plugin.manifest.id)) continue;
    try {
      const channel = await loadChannelPlugin(plugin, enabled.get(plugin.manifest.id), dataDir, (message, error) => console.warn(`[pattern-plugin:${plugin.manifest.id}] ${message}`, error));
      pluginChannels.set(channel.id, channel);
      if (channel.capabilities.inbound) pluginUnsubscribers.push(channel.onMessage((message) => void handlePluginMessage(channel.id, message)));
      console.info(`[pattern-sidecar] enabled channel plugin ${plugin.manifest.id}`);
    } catch (error) {
      console.error(`[pattern-sidecar] plugin ${plugin.manifest.id} failed to load`, error);
    }
  }
}
async function companionReply(text: string): Promise<string> {
  if (!config?.apiKey) return '我收到了，但目前还没有配置可用模型。';
  const hits = await memory.search(text, 5);
  if (hits.length) memory.touch(hits.map((item) => item.id));
  const system = buildSystemPrompt(hits, 'companion', {patternQuery: text});
  const anthropic = config.provider.toLowerCase().includes('anthropic');
  const response = await fetch(endpoint(anthropic ? '/messages' : '/chat/completions'), anthropic ? {
    method:'POST', headers:{'content-type':'application/json','x-api-key':config.apiKey,'anthropic-version':'2023-06-01'},
    body:JSON.stringify({model:config.model,max_tokens:800,system,messages:[{role:'user',content:text}]})
  } : {
    method:'POST', headers:{'content-type':'application/json',authorization:`Bearer ${config.apiKey}`},
    body:JSON.stringify({model:config.model,messages:[{role:'system',content:system},{role:'user',content:text}]})
  });
  if (!response.ok) throw new Error(`模型返回 ${response.status}`);
  const json:any = await response.json();
  return anthropic ? json.content?.map((item:any)=>item.text).join('') || '' : json.choices?.[0]?.message?.content || '';
}
async function handleRelayEnvelope(env: {id:string;from:string;role:string;type:string;body:string}) {
  if (env.role !== 'user') return;
  lastUserActivityAt = Math.floor(Date.now() / 1000);
  if (env.type === 'task') {
    let request: {action?:string;title?:string;detail?:string};
    try { request = JSON.parse(env.body); } catch { request = {action:'create', title:env.body}; }
    if (request.action !== 'create' || !request.title?.trim()) return;
        const task = await createTaskFromText(request.title, request.detail || request.title, scheduleFromText(request.detail || request.title));
    await relay.publish(relay.createEnvelope({role:'companion', type:'chat', body:`已创建远程任务：${task.title}。状态会同步到任务页。`}));
    return;
  }
  if (env.type !== 'chat') return;
  const text = env.body.trim();
  if (!text) return;
  if ((await classifyRoute(text)).slot === 'executor') {
          const task = await createTaskFromText(taskTitleFromText(text), text, scheduleFromText(text));
    await relay.publish(relay.createEnvelope({role:'companion', type:'chat', body:`好的，我来处理：${task.title}。进度会同步回来。`}));
    return;
  }
  const reply = await companionReply(text);
  if (!reply) return;
  await relay.publish(relay.createEnvelope({role:'companion', type:'chat', body:reply}));
  void extractMemories(text, reply, `relay:${env.id}`);
}
async function telegramPoll() {
  const telegram = config?.telegram;
  if (!telegram?.enabled || !telegram.token || !telegram.chatId) return;
  try {
    const channel=new TelegramChannel(telegram.token,telegram.chatId,fetch,telegramOffset);
    for (const message of await channel.poll()) {
      const text = message.text;
      if (!text) continue;
      lastUserActivityAt = Math.floor(Date.now()/1000);
      const reply = await companionReply(text);
      if (reply) {
        await telegramSend(reply);
        void extractMemories(text, reply, message.id);
      }
    }
    telegramOffset=channel.getOffset();
    saveTelegramOffset();
  } catch (error) { console.error('[pattern-sidecar] Telegram poll failed', error); }
}
async function emailPoll() {
  const email=config?.email;
  if(emailPolling||!email?.enabled||!email.imapEnabled||!email.imapHost||!email.username||!email.password)return;
  emailPolling=true;
  try{
    const channel=new ImapChannel({host:email.imapHost,port:email.imapPort||993,secure:email.imapSecure!==false,username:email.username,password:email.password});
    for(const message of await channel.poll()){
      lastUserActivityAt=Math.floor(Date.now()/1000);
      const reply=await companionReply(message.text);
      if(reply){await emailSend(`${config?.personaName||'Pattern'} · 邮件回复`,reply);void extractMemories(message.text,reply,message.id);}
    }
  }catch(error){console.error('[pattern-sidecar] IMAP poll failed',error);}finally{emailPolling=false;}
}
async function deliverProactive(input: {body: string; type: string; reason: string; origin: 'ai' | 'system'; chainId?: string}) {
  const impulse = proactive.manualImpulse({type: input.type, reason: input.reason, topicKey: input.chainId || `delivery:${Date.now()}`});
  const item = proactive.markDelivered(impulse, input.body, bridgeReady() ? 'notification' : 'log', {
    origin: input.origin, state: 'unread', chainId: input.chainId,
  });
  // Desktop receives this via its persistent quick window; use native notifications only without that bridge.
  if (!bridgeReady()) await notify(config?.personaName || 'Pattern', input.body);
  await telegramSend(input.body);
  await emailSend(`${config?.personaName || 'Pattern'} · ${input.origin === 'ai' ? '主动消息' : '提醒'}`, input.body);
  await sendToPlugins(input.body, input.origin === 'ai' ? 'proactive' : 'notification');
  lastProactiveInjectAt = Date.now();
  broadcast({type: 'proactive.impulse', item});
  broadcast({type: 'proactive.inbox.updated', item});
  try { await relay.publish(relay.createEnvelope({role: 'companion', type: 'proactive', body: input.body})); }
  catch (error) { console.error('[pattern-sidecar] relay publish failed', error); }
  return item;
}
async function runProactiveChain(chain: ProactiveChain) {
  const limits = proactive.getConfig();
  if (chain.kind === 'autonomous' && limits.dailyQuotaEnabled && proactive.todayCount() >= limits.dailyQuota) {
    const updated = proactive.finishChainRun(chain.id, {});
    if (updated) broadcast({type: 'proactive.chain.updated', chain: updated});
    return updated;
  }
  try {
    const decision = await decideProactive(chain);
    let emitted = false;
    if (decision.message) {
      await deliverProactive({body: decision.message, type: 'autonomous', reason: decision.reason || chain.purpose, origin: 'ai', chainId: chain.id});
      emitted = true;
    } else if (chain.kind === 'required_reminder') {
      await deliverProactive({body: chain.purpose, type: 'reminder', reason: '显式提醒的可靠兜底', origin: 'system', chainId: chain.id});
      emitted = true;
    }
    const updated = proactive.finishChainRun(chain.id, {nextRunAt: decision.nextRunAt, emitted});
    if (updated) broadcast({type: 'proactive.chain.updated', chain: updated});
    return updated;
  } catch (error) {
    // Explicit reminders are never silently dropped when the model is unavailable.
    if (chain.kind === 'required_reminder') {
      await deliverProactive({body: chain.purpose, type: 'reminder', reason: '模型不可用，已按提醒兜底发送', origin: 'system', chainId: chain.id});
      const updated = proactive.finishChainRun(chain.id, {emitted: true});
      if (updated) broadcast({type: 'proactive.chain.updated', chain: updated});
      return updated;
    }
    console.error('[pattern-sidecar] proactive chain failed', error);
    const updated = proactive.finishChainRun(chain.id, {failed: true});
    if (updated) broadcast({type: 'proactive.chain.updated', chain: updated});
    return updated;
  }
}
async function handleImpulse(raw: ReturnType<ProactiveEngine['evaluateTriggers']>[number], force = false) {
  const admitted = proactive.admit(raw, {force});
  if (!admitted) return null;
  const id = `trigger:${admitted.topicKey}`;
  if (proactive.listChains(200).some((item) => item.id === id)) return null;
  const chain = proactive.createChain({id, kind: force ? 'required_reminder' : 'autonomous', purpose: admitted.reason, context: JSON.stringify(admitted.payload), nextRunAt: Date.now(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', recurrence: null, sourceConversationId: null});
  await runProactiveChain(proactive.runNow(chain.id) || chain);
  return proactive.list(1)[0] || null;
}
async function proactiveChainTick() {
  for (const chain of proactive.markDue()) await runProactiveChain(chain);
}
async function proactiveTick() {
  const idleSeconds = await getIdleSeconds();
  const nowSec = Math.floor(Date.now() / 1000);
  const hour = new Date().getHours();
  const impulses = proactive.evaluateTriggers({hour, idleSeconds, lastUserActivityAt, now: nowSec});
  for (const impulse of impulses) await handleImpulse(impulse);
}
async function powerTick() {
  if (!bridgeReady() || !config?.proactive?.enabled) return;
  try {
    const value=await bridgeCall('/power',undefined,true);
    if(!value?.supported)return;
    const current={percent:Number(value.percent),plugged:!!value.plugged};
    if(Number.isFinite(current.percent)&&current.percent<=20&&!current.plugged&&(!lastPowerState||lastPowerState.percent>20||lastPowerState.plugged)){
      await handleImpulse(proactive.manualImpulse({type:'battery_low', reason:`电量仅剩 ${Math.round(current.percent)}%，且未连接电源`, topicKey:`power:battery-low:${Math.round(current.percent/5)*5}`}));
    } else if(lastPowerState&&lastPowerState.plugged!==current.plugged){
      await handleImpulse(proactive.manualImpulse({type:'power_changed', reason:current.plugged?'已连接电源':'已断开电源', topicKey:`power:${current.plugged?'plugged':'unplugged'}`}));
    }
    lastPowerState=current;
  } catch(error){console.error('[pattern-sidecar] power check failed',error);}
}
async function plaaTick(){const url=config?.plaa?.url?.replace(/\/+$/,'');if(!url){plaaState='';return}try{const response=await fetch(`${url}/state`,{signal:AbortSignal.timeout(3000)});if(!response.ok)throw new Error(String(response.status));const value:any=await response.json();plaaState=typeof value.description==='string'?value.description:JSON.stringify(value).slice(0,1000);}catch{plaaState='';}}
function classifyTaskTier(title: string, detail: string): number {
  return assessSafety(`${title}\n${detail}`, 'task').tier;
}
async function waitApproval(taskId: string, step: TaskStep, screenshotBase64?: string) {
  broadcast({type: 'task.approval_required', taskId, step, screenshotBase64});
  return await new Promise<boolean>((resolve) => {
    const waiter = {resolve};
    approvalWaiters.set(taskId, waiter);
    setTimeout(() => {
      if (approvalWaiters.get(taskId) === waiter) {
        approvalWaiters.delete(taskId);
        resolve(false);
      }
    }, 5 * 60 * 1000);
  });
}
async function runComputerUseTask(task: TaskRecord) {
  if (!task.activeRunId) startTaskRun(task);
  task.status = 'running';
  task.steps = [];
  task.recovery = undefined;
  saveTasks();
  setAgentState('executing');
  announceTask(task);
  try {
    if (task.workflow) {
      await runWorkflowAgents(task);
      task.status = task.agentResults?.some((result) => result.status === 'failed') ? 'failed' : 'done';
      if (task.status === 'failed') task.error = '一个或多个子 Agent 未能完成分析';
      finishTaskRun(task, task.status === 'done' ? 'done' : 'failed', task.error);
      saveTasks(); setAgentState('idle'); announceTask(task);
      return;
    }
    if (!bridgeReady()) throw new Error('OS Bridge 未连接，不会模拟执行');
    const initialTier = classifyTaskTier(task.title, task.detail || '');
    if (initialTier >= 3) throw new Error('T3 任务涉及银行或密码管理器，已拒绝执行');
    task.riskTier = initialTier;
    const receipts: string[] = [];
    let completed = false;
    for (let iteration = 0; iteration < 20; iteration++) {
      while (task.status === 'paused') {
        setAgentState('paused');
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      if (task.status === 'cancelled') {
        await finalizeTaskRecovery(task, 'rollback');
        finishTaskRun(task, 'cancelled'); saveTasks(); announceTask(task);
        setAgentState('idle');
        return;
      }
      setAgentState('executing');
      const foreground = await bridgeCall('/foreground', undefined, true);
      if (sensitiveForeground(String(foreground?.title || ''))) {
        await bridgeCall('/freeze', {frozen:true}, true);
        throw new Error(`T3 禁区：检测到敏感前台窗口“${foreground.title}”，键鼠已冻结`);
      }
      const screenshot = await bridgeCall('/screenshot', {});
      broadcast({type:'task.screenshot', taskId:task.id, screenshotBase64:screenshot.pngBase64, screenshotPath:screenshot.path});
      const accessibility = await bridgeCall('/accessibility/tree', undefined, true);
      const controls = Array.isArray(accessibility?.controls) ? accessibility.controls : [];
      const action = await decideComputerAction(task, screenshot.pngBase64, controls, receipts, String(foreground?.title||''));
      const tier = action.tier ?? actionTier(action);
      task.riskTier = Math.max(task.riskTier || 0, tier);
      const step: TaskStep = {
        id: randomUUID(),
        action: action.type,
        detail: action.reason,
        tier,
        status: 'running',
        screenshotPath: screenshot.path,
        ts: Math.floor(Date.now() / 1000),
      };
      task.steps.push(step);
      task.status = 'running';
      saveTasks();
      announceTask(task);
      if (tier >= securityPolicy.hardDenyAt) {
        await bridgeCall('/freeze', {frozen:true}, true);
        appendJournal({line: `${task.id} DENIED T${tier} ${action.type} ${action.reason}`, tier, kind: 'approval', taskId: task.id, decision: 'denied'});
        throw new Error(`T${tier} 动作已拦截（硬拒绝阈值 T${securityPolicy.hardDenyAt}）：${action.reason}`);
      }
      if (tier >= securityPolicy.autoApproveBelow) {
        step.status = 'awaiting_approval';
        task.status = 'awaiting_approval';
        setAgentState('approval');
        appendJournal({line: `${task.id} APPROVAL_REQUIRED T${tier} ${action.type} ${action.reason}`, tier, kind: 'approval', taskId: task.id, decision: 'info'});
        saveTasks();
        announceTask(task);
        const ok = await waitApproval(task.id, step, screenshot.pngBase64);
        if (!ok) {
          step.status = 'failed';
          task.status = 'cancelled';
          task.error = 'rejected or timed out';
          await finalizeTaskRecovery(task, 'rollback');
          finishTaskRun(task, 'cancelled', task.error);
          saveTasks();
          setAgentState('idle');
          announceTask(task);
          return;
        }
        setAgentState('executing');
      }
      if (action.type === 'fail') throw new Error(action.reason);
      if (action.type === 'done') {
        step.receipt = '当前截屏已由视觉模型验证为完成';
        completed = true;
      } else if (action.type === 'wait') {
        await new Promise((resolve) => setTimeout(resolve, Math.min(5000, Math.max(300, Number(action.amount) || 1000))));
        step.receipt = '等待完成';
      } else {
        await beginTaskRecovery(task);
        if (action.type === 'uiaInvoke' || action.type === 'uiaSetValue') {
          try {
            await bridgeCall('/accessibility/action', {
              action: action.type === 'uiaInvoke' ? 'invoke' : 'setValue', ref: action.ref,
              automationId: action.automationId, name: action.name, value: action.value ?? action.text ?? '',
            });
            step.receipt = `${action.type} 已由系统无障碍接口执行`;
          } catch (error) {
            if (Number.isFinite(action.x) && Number.isFinite(action.y)) {
              await bridgeCall('/input', {type:'click',x:action.x,y:action.y,button:'left'});
              if (action.type === 'uiaSetValue' && (action.value ?? action.text)) await bridgeCall('/input',{type:'type',text:action.value ?? action.text});
              step.receipt = `UIA 失败后回退到视觉坐标：${error instanceof Error ? error.message : error}`;
            } else throw error;
          }
        } else {
          await bridgeCall('/input', action);
          step.receipt = `${action.type} 已由 OS Bridge 执行`;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      receipts.push(`${iteration + 1}. ${step.receipt}: ${action.reason}`);
      step.status = 'done';
      appendJournal(`${task.id} ${step.action} T${tier} ${step.detail}`);
      saveTasks();
      announceTask(task);
      if (completed) break;
    }
    if (!completed) throw new Error('达到 20 步安全上限，任务未显式完成');
    await finalizeTaskRecovery(task, 'commit');
    task.status = 'done';
    finishTaskRun(task, 'done');
    saveTasks();
    setAgentState('idle');
    announceTask(task);
    await notify(config?.personaName || 'Pattern', `Task done: ${task.title}`);
    await telegramSend(`任务已完成：${task.title}`);
    await emailSend(`${config?.personaName || 'Pattern'} · 任务已完成`, task.title);
  } catch (error) {
    let recoveryError: string | undefined;
    try {
      await finalizeTaskRecovery(task, 'rollback');
    } catch (rollbackError) {
      recoveryError = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
    }
    task.status = 'failed';
    task.error = error instanceof Error ? error.message : String(error);
    if (recoveryError) task.error += `\nRecovery: ${recoveryError}`;
    finishTaskRun(task, 'failed', task.error);
    saveTasks();
    setAgentState('idle');
    announceTask(task);
  }
}
async function handleClient(socket: WebSocket, message: ClientMessage) {
  try {
    switch (message.type) {
      case 'chat.send':
        await chat(socket, message);
        break;
      case 'chat.cancel': {
        activeChats.get(message.id)?.controller.abort();
        break;
      }
      case 'memory.list': {
        const items = memory.list(message.query, message.category);
        send(socket, {type: 'memory.list.result', id: message.id, items});
        break;
      }
      case 'memory.add': {
        const item = await memory.add({
          text: message.item.text,
          category: String(message.item.category),
          importance: message.item.importance,
          sourceConv: message.item.sourceConv,
        });
        queuePatternUpdate(item.id);
        send(socket, {type: 'memory.add.result', id: message.id, item});
        broadcast({type: 'memory.changed'});
        break;
      }
      case 'memory.update': {
        const item = memory.update(message.memoryId, {
          text: message.item?.text,
          category: message.item?.category ? String(message.item.category) : undefined,
          importance: message.item?.importance,
        });
        if (!item) {
          send(socket, {type: 'memory.expire.result', id: message.id, ok: false});
          break;
        }
        send(socket, {type: 'memory.update.result', id: message.id, item});
        broadcast({type: 'memory.changed'});
        break;
      }
      case 'memory.expire': {
        memory.expire(message.memoryId);
        send(socket, {type: 'memory.expire.result', id: message.id, ok: true});
        broadcast({type: 'memory.changed'});
        break;
      }
      case 'memory.stats': {
        send(socket, {
          type: 'memory.stats.result',
          id: message.id,
          count: memory.count(),
          lastConsolidateAt: memory.getLastConsolidateAt(),
        });
        break;
      }
            case 'memory.propose.list': {
        send(socket, {type: 'memory.propose.list.result', id: message.id, items: memoryProposals});
        break;
      }
      case 'memory.propose.accept': {
        const proposal = memoryProposals.find((item) => item.id === message.proposalId);
        if (!proposal) {
          send(socket, {type: 'memory.propose.accept.result', id: message.id, ok: false});
          break;
        }
        const saved = await memory.upsertSimilar({
          text: proposal.text,
          category: proposal.category,
          importance: proposal.importance,
          sourceConv: proposal.sourceConv || null,
        });
        queuePatternUpdate((saved.item || saved).id);
        memoryProposals = memoryProposals.filter((entry) => entry.id !== proposal.id);
        broadcast({type: 'memory.changed'});
        broadcast({type: 'memory.proposed', items: memoryProposals});
        send(socket, {type: 'memory.propose.accept.result', id: message.id, ok: true, item: saved.item || saved});
        break;
      }
      case 'memory.propose.reject': {
        memoryProposals = memoryProposals.filter((entry) => entry.id !== message.proposalId);
        broadcast({type: 'memory.proposed', items: memoryProposals});
        send(socket, {type: 'memory.propose.reject.result', id: message.id, ok: true});
        break;
      }
      // --- Pattern Engine (derived cognitive layer) ---
      case 'pattern.list': {
        const items = memory.patterns.list({
          query: message.query ?? null,
          category: message.category ?? null,
          status: message.status ?? null,
          limit: message.limit ?? 200,
        });
        send(socket, {type: 'pattern.list.result', id: message.id, items});
        break;
      }
      case 'pattern.get': {
        const pattern = memory.patterns.getWithEvidence(message.patternId);
        send(socket, {type: 'pattern.get.result', id: message.id, pattern});
        break;
      }
      case 'pattern.search': {
        const limit = Math.max(1, Math.min(20, message.limit ?? 6));
        const hits = memory.patterns.search(message.query, limit);
        const items = hits.map(({score: _score, ...item}) => item);
        send(socket, {type: 'pattern.search.result', id: message.id, items});
        break;
      }
      case 'pattern.evidence': {
        const evidence = memory.patterns.listEvidence(message.patternId);
        send(socket, {type: 'pattern.evidence.result', id: message.id, patternId: message.patternId, evidence});
        break;
      }
      case 'pattern.update': {
        const pattern = memory.patterns.update(message.patternId, {
          text: message.text,
          category: message.category,
          confidence: message.confidence,
          status: message.status,
        });
        send(socket, {type: 'pattern.update.result', id: message.id, pattern});
        if (pattern) broadcast({type: 'pattern.changed'});
        break;
      }
      case 'pattern.archive': {
        const ok = memory.patterns.archive(message.patternId);
        send(socket, {type: 'pattern.archive.result', id: message.id, ok});
        if (ok) broadcast({type: 'pattern.changed'});
        break;
      }
      case 'pattern.delete': {
        const ok = memory.patterns.delete(message.patternId);
        send(socket, {type: 'pattern.delete.result', id: message.id, ok});
        if (ok) broadcast({type: 'pattern.changed'});
        break;
      }
      case 'pattern.consolidate': {
        const result = memory.patterns.consolidate();
        send(socket, {
          type: 'pattern.consolidate.result',
          id: message.id,
          at: result.at,
          promoted: result.promoted,
          weakened: result.weakened,
          contradicted: result.contradicted,
          archived: result.archived,
          merged: result.merged,
        });
        broadcast({type: 'pattern.changed'});
        break;
      }
      case 'runtime.foreground': {
        try {
          const foreground = await bridgeCall('/foreground', undefined, true);
          const title = String(foreground?.title || '');
          const busyHint = /Visual Studio Code|Code -|IntelliJ|PyCharm|terminal|Windows Terminal|cmd\.exe|powershell|Chrome|Edge|Firefox|Slack|Zoom|会议|Excel|Word|PowerPoint/i.test(title);
          send(socket, {type: 'runtime.foreground.result', id: message.id, title, busyHint});
        } catch {
          send(socket, {type: 'runtime.foreground.result', id: message.id, title: '', busyHint: false});
        }
        break;
      }
case 'journal.list': {
        send(socket, {type: 'journal.list.result', id: message.id, items: listJournal(message.limit ?? 80, (message as any).query)});
        break;
      }
      case 'security.policy.get': {
        send(socket, {type: 'security.policy', id: message.id, policy: securityPolicy});
        break;
      }
      case 'security.policy.set': {
        const next = (message as any).policy || {};
        if ('workspaceRoot' in next) securityPolicy.workspaceRoot = next.workspaceRoot ? String(next.workspaceRoot) : null;
        if ('enforceWorkspace' in next) securityPolicy.enforceWorkspace = next.enforceWorkspace !== false;
        if ('requireRecoveryForWorkspaceWrites' in next) securityPolicy.requireRecoveryForWorkspaceWrites = next.requireRecoveryForWorkspaceWrites !== false;
        if ('autoApproveBelow' in next) securityPolicy.autoApproveBelow = Math.min(4, Math.max(0, Number(next.autoApproveBelow)));
        if ('hardDenyAt' in next) securityPolicy.hardDenyAt = Math.min(4, Math.max(1, Number(next.hardDenyAt)));
        saveSecurityPolicy();
        appendJournal({line: `security.policy updated enforce=${securityPolicy.enforceWorkspace} requireRecovery=${securityPolicy.requireRecoveryForWorkspaceWrites} root=${securityPolicy.workspaceRoot || '-'} auto<${securityPolicy.autoApproveBelow} deny>=${securityPolicy.hardDenyAt}`, kind: 'policy', decision: 'info'});
        send(socket, {type: 'security.policy', id: message.id, policy: securityPolicy});
        break;
      }
      case 'proactive.list': {
        send(socket, {type: 'proactive.list.result', id: message.id, items: proactive.list(message.limit ?? 50)});
        break;
      }
      case 'proactive.setPaused': {
        proactive.setPaused(message.paused);
        if (config?.proactive) config.proactive = {...config.proactive, paused: message.paused};
        const c = proactive.getConfig();
        send(socket, {
          type: 'proactive.config',
          id: message.id,
          enabled: c.enabled,
          paused: c.paused,
          bedtimeHour: c.bedtimeHour,
        });
        break;
      }
      case 'proactive.getConfig': {
        const c = proactive.getConfig();
        send(socket, {
          type: 'proactive.config',
          id: message.id,
          enabled: c.enabled,
          paused: c.paused,
          bedtimeHour: c.bedtimeHour,
        });
        break;
      }
      case 'proactive.setConfig': {
        const next = {
          enabled: message.enabled !== undefined ? !!message.enabled : proactive.getConfig().enabled,
          paused: message.paused !== undefined ? !!message.paused : proactive.getConfig().paused,
          bedtimeHour: message.bedtimeHour !== undefined
            ? Math.min(23, Math.max(0, Number(message.bedtimeHour)))
            : proactive.getConfig().bedtimeHour,
        };
        proactive.setConfig(next);
        if (config) {
          config.proactive = {
            enabled: next.enabled,
            paused: next.paused,
            bedtimeHour: next.bedtimeHour,
          };
        }
        const c = proactive.getConfig();
        broadcast({
          type: 'proactive.config',
          id: message.id,
          enabled: c.enabled,
          paused: c.paused,
          bedtimeHour: c.bedtimeHour,
        });
        send(socket, {
          type: 'proactive.config',
          id: message.id,
          enabled: c.enabled,
          paused: c.paused,
          bedtimeHour: c.bedtimeHour,
        });
        break;
      }
      case 'relay.status': {
        send(socket, {type: 'relay.status.result', id: message.id, status: relay.status()});
        break;
      }
      case 'relay.syncNow': {
        await relay.sync();
        send(socket, {type: 'relay.status.result', id: message.id, status: relay.status()});
        break;
      }
      case 'task.list': {
        send(socket, {type: 'task.list.result', id: message.id, tasks});
        break;
      }
      case 'model.metrics.get': {
        send(socket, {type: 'model.metrics', id: message.id, metrics: Object.values(modelMetrics)});
        break;
      }
      case 'skill.list': {
        send(socket, {type:'skill.list.result', id:message.id, skills:allSkills()});
        break;
      }
      case 'skill.install': {
        const incoming = message.skill;
        const skill: SkillDefinition = {
          id: String(incoming.id || randomUUID()).slice(0, 80),
          name: String(incoming.name || '').slice(0, 80),
          description: String(incoming.description || '').slice(0, 400),
          kind: (['coding', 'research', 'desktop'].includes(String(incoming.kind)) ? incoming.kind : 'coding') as SkillDefinition['kind'],
          permissions: Array.isArray(incoming.permissions) ? incoming.permissions.map(String).slice(0, 20) : ['workspace.read'],
          prompt: String(incoming.prompt || '').slice(0, 4000),
        };
        if (!skill.name || !skill.prompt) {
          send(socket, {type: 'error', id: message.id, message: 'skill 需要 name 与 prompt'});
          break;
        }
        if (codingSkills.some((item) => item.id === skill.id)) {
          send(socket, {type: 'error', id: message.id, message: '不能覆盖内置 skill'});
          break;
        }
        customSkills = [skill, ...customSkills.filter((item) => item.id !== skill.id)].slice(0, 100);
        saveCustomSkills(customSkills);
        send(socket, {type: 'skill.updated', id: message.id, skills: allSkills()});
        break;
      }
      case 'skill.remove': {
        if (codingSkills.some((item) => item.id === message.skillId)) {
          send(socket, {type: 'error', id: message.id, message: '不能删除内置 skill'});
          break;
        }
        customSkills = customSkills.filter((item) => item.id !== message.skillId);
        saveCustomSkills(customSkills);
        send(socket, {type: 'skill.updated', id: message.id, skills: allSkills()});
        break;
      }
      case 'workflow.list': {
        send(socket, {type:'workflow.list.result', id:message.id, workflows:allWorkflows()});
        break;
      }
      case 'goal.list': {
        send(socket, {type: 'goal.list.result', id: message.id, goals: loadGoals(dataDir)});
        break;
      }
      case 'goal.set': {
        const objective = String(message.objective || '').trim().slice(0, 2000);
        if (!objective) {
          send(socket, {type: 'error', id: message.id, message: '请填写目标内容'});
          break;
        }
        let goals = loadGoals(dataDir).map((g) =>
          g.status === 'active' || g.status === 'paused'
            ? {...g, status: 'cleared' as const, updatedAt: Date.now()}
            : g,
        );
        const task = await createTaskFromText(
          taskTitleFromText(objective),
          `[Goal]\n${objective}\n\n完成条件：目标被验证达成后，用 pattern.update_goal 标记 completed。`,
          undefined,
          undefined,
          undefined,
          {
            conversationId: message.conversationId,
            workspace: message.workspace,
            projectName: message.projectName,
          },
        );
        const goal: GoalState = {
          id: randomUUID(),
          objective,
          status: 'active',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          taskId: task.id,
          conversationId: message.conversationId,
          progress: [`已创建并排队执行 · ${new Date().toLocaleString('zh-CN')}`],
        };
        goals = [goal, ...goals].slice(0, 50);
        saveGoals(dataDir, goals);
        broadcast({type: 'goal.updated', goal, goals});
        send(socket, {type: 'goal.list.result', id: message.id, goals});
        break;
      }
      case 'goal.control': {
        const goals = loadGoals(dataDir);
        const goal = goals.find((g) => g.id === message.goalId);
        if (!goal) {
          send(socket, {type: 'error', id: message.id, message: 'goal not found'});
          break;
        }
        if (message.action === 'pause') {
          if (goal.status !== 'active') {
            send(socket, {type: 'error', id: message.id, message: '只有进行中的目标可以暂停'});
            break;
          }
          goal.status = 'paused';
        } else if (message.action === 'resume') {
          if (goal.status !== 'paused') {
            send(socket, {type: 'error', id: message.id, message: '只有已暂停的目标可以恢复'});
            break;
          }
          goal.status = 'active';
        } else if (message.action === 'clear') {
          goal.status = 'cleared';
        } else if (message.action === 'complete') {
          goal.status = 'done';
          goal.progress = [...(goal.progress || []), `已标记完成 · ${new Date().toLocaleString('zh-CN')}`].slice(-20);
        }
        goal.updatedAt = Date.now();
        saveGoals(dataDir, goals);
        broadcast({type: 'goal.updated', goal, goals});
        send(socket, {type: 'goal.list.result', id: message.id, goals});
        break;
      }
      case 'goal.update': {
        const goals = loadGoals(dataDir);
        const goal = goals.find((g) => g.id === message.goalId);
        if (!goal) {
          send(socket, {type: 'error', id: message.id, message: 'goal not found'});
          break;
        }
        if (message.progress?.trim()) {
          goal.progress = [...(goal.progress || []), message.progress.trim().slice(0, 500)].slice(-20);
        }
        if (message.status) goal.status = message.status;
        if (message.blockedReason !== undefined) {
          goal.blockedReason = message.blockedReason.slice(0, 500) || undefined;
          if (message.blockedReason.trim() && !message.status) goal.status = 'blocked';
        }
        goal.updatedAt = Date.now();
        saveGoals(dataDir, goals);
        broadcast({type: 'goal.updated', goal, goals});
        send(socket, {type: 'goal.list.result', id: message.id, goals});
        break;
      }
      case 'session_plan.get': {
        const plan = getSessionPlan(dataDir, String(message.conversationId || ''));
        send(socket, {type: 'session_plan.result', id: message.id, plan});
        break;
      }
      case 'session_plan.set': {
        const conversationId = String(message.conversationId || '').trim();
        if (!conversationId) {
          send(socket, {type: 'error', id: message.id, message: 'conversationId required'});
          break;
        }
        const plan = setSessionPlan(dataDir, conversationId, message.items || [], {
          title: message.title,
          merge: !!message.merge,
        });
        broadcast({type: 'session_plan.updated', plan});
        send(socket, {type: 'session_plan.result', id: message.id, plan});
        break;
      }
      case 'session_plan.clear': {
        const conversationId = String(message.conversationId || '').trim();
        if (!conversationId) {
          send(socket, {type: 'error', id: message.id, message: 'conversationId required'});
          break;
        }
        const plan = clearSessionPlan(dataDir, conversationId);
        broadcast({type: 'session_plan.updated', plan});
        send(socket, {type: 'session_plan.result', id: message.id, plan});
        break;
      }
      case 'workflow.run': {
        const workflow = allWorkflows().find((item) => item.id === message.workflowId);
        if (!workflow) { send(socket, {type:'error', id:message.id, message:'workflow not found'}); break; }
        const skillText = workflow.skillIds.map((id) => allSkills().find((skill) => skill.id === id)).filter(Boolean).map((skill) => `${skill!.name}：${skill!.prompt} 权限：${skill!.permissions.join(', ')}`).join('\n');
        let workspace = message.workspace;
        if (message.isolatedWorktree) {
          if (!workspace) { send(socket, {type:'error', id:message.id, message:'创建 Worktree 需要工作区路径'}); break; }
          const worktree = await createGitWorktree(workspace, workflow.id);
          workspace = worktree.path;
        }
        const agentCount = Math.max(1, Math.min(MAX_AGENT_COUNT, Number(message.agentCount) || workflow.maxAgents));
        const rounds = workflow.mode === 'peer-discussion' ? Math.max(1, Math.min(4, workflow.discussionRounds || 1)) : 1;
        const detail = `[Workflow: ${workflow.name}]\n${workflow.description}\n工作区：${workspace || '当前工作区'}\n执行模式：${workflow.mode}，Agent 数：${agentCount}${workflow.mode === 'peer-discussion' ? `，研讨轮次：${rounds}` : ''}\n\n用户目标：${message.input}\n\n技能步骤：\n${skillText}`;
        const task = await createTaskFromText(`${workflow.name} · ${message.input.slice(0, 48)}`, detail, undefined, {id:workflow.id, name:workflow.name, stepCount:agentCount + (workflow.mode === 'peer-discussion' ? 1 : 0), currentStep:0, workspace, agents:agentCount});
        send(socket, {type:'workflow.started', id:message.id, workflowId:workflow.id, taskId:task.id, workspace});
        break;
      }
      case 'mcp.list': {
        send(socket, {type:'mcp.list.result', id:message.id, servers:mcpServers});
        break;
      }
      case 'mcp.set': {
        mcpServers = message.servers.map((server) => ({...server, id:String(server.id).slice(0,64), name:String(server.name).slice(0,100), command:String(server.command).slice(0,300), args:Array.isArray(server.args) ? server.args.map(String).slice(0,30) : [], permissions:Array.isArray(server.permissions) ? server.permissions.map(String).slice(0,30) : [], enabled:!!server.enabled})).slice(0,50);
        saveMcpServers(); send(socket, {type:'mcp.updated', id:message.id, servers:mcpServers});
        break;
      }
      case 'mcp.discover': {
        const server = mcpServers.find((item) => item.id === message.serverId);
        if (!server) { send(socket, {type:'error', id:message.id, message:'MCP server not found'}); break; }
        try { const discovered = await discoverMcpTools(server); server.tools = discovered.map((item) => item.name); server.toolSchemas = discovered; server.error = undefined; server.lastDiscoveredAt = Date.now(); }
        catch (error) { server.error = error instanceof Error ? error.message : String(error); }
        saveMcpServers(); send(socket, {type:'mcp.updated', id:message.id, servers:mcpServers});
        break;
      }
      case 'mcp.call': {
        const server = mcpServers.find((item) => item.id === message.serverId);
        if (!server) { send(socket, {type:'error', id:message.id, message:'MCP server not found'}); break; }
        try { const result = await callMcpTool(server, message.tool, message.arguments || {}); send(socket, {type:'mcp.call.result', id:message.id, serverId:server.id, tool:message.tool, result}); }
        catch (error) { send(socket, {type:'error', id:message.id, message:error instanceof Error ? error.message : String(error)}); }
        break;
      }
      case 'workspace.worktree.create': {
        assertWorkspaceAllowed(message.root, 'workspace.worktree');
        try { const result = await createGitWorktree(message.root, message.name); send(socket, {type:'workspace.worktree.created', id:message.id, ...result}); }
        catch (error) { send(socket, {type:'error', id:message.id, message:error instanceof Error ? error.message : String(error)}); }
        break;
      }
      case 'workspace.diff': {
        assertWorkspaceAllowed(message.root, 'workspace.diff');
        try {
          if (!existsSync(message.root) || !statSync(message.root).isDirectory()) throw new Error('工作区目录不存在');
          const [status, diff] = await Promise.all([
            execFileAsync('git', ['-C', message.root, 'status', '--short'], {windowsHide:true}),
            execFileAsync('git', ['-C', message.root, 'diff', '--no-ext-diff'], {windowsHide:true}),
          ]);
          send(socket, {type:'workspace.diff.result', id:message.id, root:message.root, status:status.stdout.slice(0,12000), diff:diff.stdout.slice(0,12000)});
        } catch (error) { send(socket, {type:'error', id:message.id, message:error instanceof Error ? error.message : String(error)}); }
        break;
      }
      case 'model.catalog.get': {
        const fallback = modelPresets(config?.provider || '');
        if (!config?.apiKey || config.provider.toLowerCase().includes('anthropic')) {
          send(socket, {type:'model.catalog', id:message.id, models:fallback, source:'preset'}); break;
        }
        try {
          const response = await fetch(endpoint('/models'), {headers:{authorization:`Bearer ${config.apiKey}`}});
          const data:any = response.ok ? await response.json() : null;
          const models = Array.isArray(data?.data) ? data.data.map((item:any) => String(item.id || '')).filter(Boolean).sort() : fallback;
          send(socket, {type:'model.catalog', id:message.id, models:models.length ? models : fallback, source:models.length ? 'provider' : 'preset'});
        } catch { send(socket, {type:'model.catalog', id:message.id, models:fallback, source:'preset'}); }
        break;
      }
      case 'model.balance.check': {
        const provider = config?.provider.toLowerCase() || '';
        const key = config ? `${config.provider}:${config.model}` : '';
        const metric = modelMetrics[key];
        if (!config || !metric) { send(socket, {type:'model.metrics', id:message.id, metrics:Object.values(modelMetrics)}); break; }
        try {
          if (provider.includes('openrouter')) {
            const response = await fetch(endpoint('/auth/key'), {headers:{authorization:`Bearer ${config.apiKey}`}});
            const data:any = response.ok ? await response.json() : null;
            const limit = Number(data?.data?.limit); const used = Number(data?.data?.usage || 0);
            metric.balance = Number.isFinite(limit) ? `$${Math.max(0, limit - used).toFixed(2)}` : '按量计费';
          } else metric.balance = '服务商未提供统一余额接口';
          metric.updatedAt = Date.now(); saveModelMetrics();
        } catch { metric.balance = '查询失败'; }
        send(socket, {type:'model.metrics', id:message.id, metrics:Object.values(modelMetrics)});
        break;
      }
      case 'task.create': {
        const task = await createTaskFromText(message.title, message.detail || '', message.schedule, undefined, message.plan, {
          conversationId: message.conversationId,
          workspace: message.workspace,
          projectName: message.projectName,
        });
        send(socket, {type: 'task.list.result', id: message.id, tasks, createdTask: task});
        // ensure caller still sees the created task via list result
        void task;
        break;
      }
      case 'task.update': {
        const task = tasks.find((item) => item.id === message.taskId);
        if (!task) { send(socket, {type:'error', id:message.id, message:'task not found'}); break; }
        if (['running', 'awaiting_approval'].includes(task.status)) { send(socket, {type:'error', id:message.id, message:'执行中的任务不能编辑'}); break; }
        task.title = message.title.trim().slice(0, 160) || task.title;
        task.detail = (message.detail || '').trim().slice(0, 8000);
        task.schedule = message.schedule;
        task.plan = message.plan?.filter((step) => step?.title?.trim() && step?.detail?.trim()).slice(0, 30);
        task.schedule.enabled = true;
        task.status = 'scheduled';
        task.nextRunAt = nextScheduleAt(task.schedule);
        task.error = undefined;
        saveTasks(); announceTask(task);
        send(socket, {type:'task.list.result', id:message.id, tasks});
        break;
      }
      case 'task.control': {
        const task = tasks.find((t) => t.id === message.taskId);
        if (!task) {
          send(socket, {type: 'error', id: message.id, message: 'task not found'});
          break;
        }
        if (message.action === 'approve' || message.action === 'reject') {
          const waiter = approvalWaiters.get(task.id);
          if (waiter) {
            approvalWaiters.delete(task.id);
            waiter.resolve(message.action === 'approve');
          }
        } else if (message.action === 'pause') {
          task.status = 'paused';
          if (task.schedule) task.schedule.enabled = false;
        }
        else if (message.action === 'resume' && task.status === 'paused') {
          if (task.schedule) { task.schedule.enabled = true; task.status = 'scheduled'; }
          else task.status = 'running';
        } else if (message.action === 'run') {
          if (['running', 'queued', 'awaiting_approval'].includes(task.status)) {
            send(socket, {type: 'error', id: message.id, message: '任务已在执行中'});
            break;
          }
          if (task.status === 'cancelled') {
            send(socket, {type: 'error', id: message.id, message: '已终止的任务不能再执行'});
            break;
          }
          // One-shot run (plan-only / idle scheduled tasks).
          if (task.schedule) task.schedule = {...task.schedule, enabled: false};
          task.status = 'queued';
          task.error = undefined;
          saveTasks();
          announceTask(task);
          enqueueComputerUseTask(task);
          send(socket, {type: 'task.list.result', id: message.id, tasks});
          break;
        } else if (message.action === 'cancel') {
          task.status = 'cancelled';
          finishTaskRun(task, 'cancelled');
          const waiter = approvalWaiters.get(task.id);
          if (waiter) {
            approvalWaiters.delete(task.id);
            waiter.resolve(false);
          }
        }
        saveTasks();
        announceTask(task);
        send(socket, {type: 'task.list.result', id: message.id, tasks});
        break;
      }
      case 'recovery.status': {
        const capabilities = await bridgeCall('/recovery/capabilities', undefined, true);
        const listed = capabilities?.available ? await bridgeCall('/recovery/list', {}, true) : null;
        const manifests = Array.isArray(listed?.transaction) ? listed.transaction : [];
        const openStates = new Set(['Preparing','Active','Prepared','RollingBack','Conflicted','RecoveryRequired']);
        send(socket, {
          type: 'recovery.status.result', id: message.id,
          available: !!capabilities?.available,
          store: capabilities?.store,
          transactionCount: manifests.length,
          openCount: manifests.filter((manifest:any) => openStates.has(String(manifest?.state))).length,
          error: capabilities?.available ? undefined : 'AgentOS recovery runtime is unavailable',
        });
        break;
      }
      case 'task.recovery.rollback': {
        const task = tasks.find((item) => item.id === message.taskId);
        if (!task) { send(socket, {type:'error', id:message.id, message:'task not found'}); break; }
        if (['running','queued','paused','awaiting_approval'].includes(task.status)) {
          send(socket, {type:'error', id:message.id, message:'任务仍在执行，必须先终止再恢复'}); break;
        }
        try {
          await finalizeTaskRecovery(task, 'rollback', {assumeExclusive: message.assumeExclusive === true});
          send(socket, {type:'task.list.result', id:message.id, tasks});
        } catch (error) {
          send(socket, {type:'error', id:message.id, message:error instanceof Error ? error.message : String(error)});
        }
        break;
      }
      case 'healthcheck.getConfig': {
        send(socket, {type:'healthcheck.config', id:message.id, checks:healthChecks});
        break;
      }
      case 'healthcheck.setConfig': {
        healthChecks = message.checks
          .filter((check) => /^https?:\/\//i.test(check.url.trim()))
          .map((check) => ({url:check.url.trim(), label:check.label?.trim().slice(0,80)}))
          .slice(0,20);
        healthStates.clear(); saveHealthChecks();
        send(socket, {type:'healthcheck.config', id:message.id, checks:healthChecks});
        void healthTick();
        break;
      }
      case 'cron.getConfig': {
        send(socket, {type:'cron.config', id:message.id, triggers:cronTriggers});
        break;
      }
      case 'cron.setConfig': {
        cronTriggers = message.triggers
          .filter((trigger) => /^([01]\d|2[0-3]):[0-5]\d$/.test(trigger.time) && trigger.message.trim())
          .map((trigger) => ({id:trigger.id || randomUUID(),time:trigger.time,message:trigger.message.trim().slice(0,500),enabled:trigger.enabled !== false}))
          .slice(0,30);
        saveCronTriggers();
        send(socket, {type:'cron.config', id:message.id, triggers:cronTriggers});
        break;
      }
      case 'task.delete': {
        const target = tasks.find((t)=>t.id===message.taskId);
        if (target && ['running','queued','paused','awaiting_approval'].includes(target.status)) {
          send(socket,{type:'error',id:message.id,message:'请先终止正在执行的任务'}); break;
        }
        tasks = tasks.filter((t)=>t.id!==message.taskId); saveTasks();
        send(socket,{type:'task.list.result',id:message.id,tasks});
        break;
      }
      case 'projects.sync': {
        const list = Array.isArray((message as any).projects) ? (message as any).projects : [];
        const normalized = list
          .filter((p: any) => p && typeof p.path === 'string' && typeof p.id === 'string')
          .map((p: any) => ({id: String(p.id), name: String(p.name || p.id), path: String(p.path)}))
          .slice(0, 100);
        try {
          writeFileSync(join(dataDir, 'projects.json'), JSON.stringify(normalized, null, 2));
          restartFileWatchers();
          send(socket, {type: 'projects.sync.result', id: message.id, ok: true, count: normalized.length});
        } catch (error) {
          send(socket, {type: 'error', id: message.id, message: error instanceof Error ? error.message : String(error)});
        }
        break;
      }
      case 'filewatch.getConfig': {
        send(socket, {type:'filewatch.config', id:message.id, config:fileWatchConfig});
        break;
      }
      case 'filewatch.setConfig': {
        fileWatchConfig = {
          enabled: !!message.config.enabled,
          paths: message.config.paths.map((p) => p.trim()).filter(Boolean),
          extensions: message.config.extensions.map((x) => x.trim().toLowerCase()).filter(Boolean).map((x) => x.startsWith('.') ? x : `.${x}`),
          maxBytes: Math.max(1024, Math.min(1024 * 1024, Number(message.config.maxBytes) || 65536)),
        };
        saveFileWatchConfig(); restartFileWatchers();
        send(socket, {type:'filewatch.config', id:message.id, config:fileWatchConfig});
        break;
      }
      case 'filewatch.list': {
        send(socket, {type:'filewatch.list.result', id:message.id, items:fileWatchEvents.slice(0, message.limit ?? 50)});
        break;
      }
      case 'proactive.trigger': {
        const kind = message.kind || 'manual';
        const reason = message.reason || 'manual proactive trigger';
        const impulse = proactive.manualImpulse({type: kind, reason, topicKey: `manual:${kind}:${Date.now()}`});
        const item = await handleImpulse(impulse, true);
        if (!item) {
          send(socket, {type: 'error', id: message.id, message: 'proactive is paused or disabled'});
          break;
        }
        send(socket, {type: 'proactive.list.result', id: message.id, items: proactive.list(20)});
        break;
      }
      case 'proactive.chain.list': {
        send(socket, {type:'proactive.chain.list.result', id:message.id, chains:proactive.listChains(message.limit ?? 50)});
        break;
      }
      case 'proactive.chain.cancel': {
        const chain = proactive.cancelChain(message.chainId);
        if (!chain) send(socket, {type:'error', id:message.id, message:'未找到可取消的主动链'});
        else { broadcast({type:'proactive.chain.updated', chain}); send(socket, {type:'proactive.chain.list.result', id:message.id, chains:proactive.listChains(50)}); }
        break;
      }
      case 'proactive.chain.runNow': {
        const chain = proactive.runNow(message.chainId);
        if (!chain) send(socket, {type:'error', id:message.id, message:'该主动链当前不可执行'});
        else { void runProactiveChain(chain); send(socket, {type:'proactive.chain.list.result', id:message.id, chains:proactive.listChains(50)}); }
        break;
      }
      case 'proactive.inbox.mark': {
        const item = proactive.markInboxState(message.itemId, message.state);
        if (!item) send(socket, {type:'error', id:message.id, message:'未找到主动消息'});
        else { broadcast({type:'proactive.inbox.updated', item}); send(socket, {type:'proactive.list.result', id:message.id, items:proactive.list(50)}); }
        break;
      }
      case 'memory.dream': {
        const result = await runDreamingJob(true);
        send(socket, {type: 'memory.stats.result', id: message.id, count: memory.count(), lastConsolidateAt: memory.getLastConsolidateAt()});
        if (!result.ok) send(socket, {type: 'error', id: message.id, message: result.error || 'dream failed'});
        break;
      }
      case 'memory.consolidate': {
        const result = memory.consolidate();
        // Pattern consolidation runs alongside memory consolidation (spec §十五).
        const patternResult = memory.patterns.consolidate();
        send(socket, {
          type: 'memory.consolidate.result',
          id: message.id,
          at: result.at,
          decayed: result.decayed,
          evicted: result.evicted,
        });
        console.log(
          `[pattern-sidecar] consolidation: memory decayed=${result.decayed} evicted=${result.evicted}; pattern promoted=${patternResult.promoted} weakened=${patternResult.weakened} contradicted=${patternResult.contradicted} archived=${patternResult.archived} merged=${patternResult.merged}`,
        );
        broadcast({type: 'memory.changed'});
        broadcast({type: 'pattern.changed'});
        break;
      }
      case 'runtime.ping': {
        send(socket, {
          type: 'runtime.status',
          sidecar: 'connected',
          memory: 'ready',
          proactive: proactive.getConfig().paused ? 'paused' : 'ready',
          relay: relay.status().configured ? (relay.status().online ? 'online' : 'configured') : 'off',
          version: '0.2.0',
        });
        break;
      }
      default:
        send(socket, {type: 'error', id: (message as any).id || 'unknown', message: 'unknown message type'});
    }
  } catch (error) {
    send(socket, {
      type: 'error',
      id: (message as any).id || 'unknown',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
function applyConfig(next: RuntimeConfigure) {
  config = next;
  healthStates.clear();
  if (next.proactive) {
    proactive.setConfig({
      enabled: next.proactive.enabled,
      paused: next.proactive.paused ?? false,
      bedtimeHour: next.proactive.bedtimeHour,
    });
  }
  if (next.dataDir) {
    // dataDir fixed at boot for this process
  }
  const relayConfig: RelayConfig | null = next.webdav?.url
    ? {url: next.webdav.url, username: next.webdav.username || '', password: next.webdav.password || ''}
    : null;
  relay.updateConfig(relayConfig);
  if (next.deviceId) relay.deviceId = next.deviceId;
  if (next.channelKey) relay.channelKey = next.channelKey;
  restartFileWatchers();
  void telegramPoll();
  void configurePlugins();
  void reconcileRecoveryTransactions()
    .catch((error) => console.error('[pattern-sidecar] recovery reconciliation failed', error))
    .finally(() => {
      for (const task of tasks) if (task.status === 'queued') enqueueComputerUseTask(task);
    });
}
type ComputerAction = {type:'uiaInvoke'|'uiaSetValue'|'click'|'type'|'key'|'scroll'|'wait'|'done'|'fail'; ref?:string; automationId?:string; name?:string; value?:string; x?:number; y?:number; text?:string; key?:string; modifiers?:string[]; amount?:number; reason:string; tier?:number};
function actionTier(action: ComputerAction): number {
  return assessSafety(`${action.type} ${action.text || ''} ${action.reason}`, 'action').tier;
}
async function decideComputerAction(task: TaskRecord, screenshotBase64: string, controls: unknown[], history: string[], foregroundTitle=''): Promise<ComputerAction> {
  if (!config?.apiKey && !config?.executor?.apiKey) throw new Error('执行视觉循环需要已配置的模型 API Key');
  const executor = config.executor?.apiKey ? config.executor : undefined;
  const provider = executor?.provider || config.provider;
  const base = executor?.endpoint || config.endpoint;
  const model = executor?.model || config.model;
  const apiKey = executor?.apiKey || config.apiKey;
  const anthropic = provider.toLowerCase().includes('anthropic');
  const vision=config.executor?.vision!==false;
  const plan = task.plan?.filter((step) => step.enabled).map((step, index) => `${index + 1}. ${step.title}: ${step.detail}`).join('\n') || '(no explicit step list; infer the task from its details)';
  const instruction = `You control a desktop to complete this task: ${task.title}\nDetails: ${task.detail || '(none)'}\nWorkspace: ${task.workspace || task.workflow?.workspace || '(none)'}\nOrdered automation steps (follow in order; do not skip or reorder):\n${plan}\nForeground window: ${foregroundTitle||'(unknown)'}\nRecent receipts:\n${history.slice(-6).join('\n')}\nAccessible controls from the foreground window:\n${JSON.stringify(controls).slice(0,18000)}\nPrefer uiaInvoke for buttons/menu items and uiaSetValue for editable fields. To open the Windows Start menu, return {"type":"key","key":"win","reason":"open Start menu"}. ${vision?'Use the control ref and include x/y as visual fallback when possible. Otherwise choose click,type,key,scroll,wait,done,fail. Never claim done unless the screenshot visibly proves the result.':'This is accessibility-only mode: no screenshot is available. Never invent coordinates. Use uiaInvoke/uiaSetValue or keyboard actions only. Infer completion only from control-tree state and receipts; if required controls are unavailable, return fail with a precise accessibility limitation.'} Return JSON only with type,ref,automationId,name,value,x,y,text,key,modifiers,amount,reason,tier. Set tier 2 for destructive actions, external communication, uploads, installs, purchases or final submission; tier 3 for password managers or banking.`;
  const userContent:any=vision?[{type:'text',text:instruction},{type:'image',source:{type:'base64',media_type:'image/png',data:screenshotBase64}}]:instruction;
  const openAiContent:any=vision?[{type:'text',text:instruction},{type:'image_url',image_url:{url:`data:image/png;base64,${screenshotBase64}`}}]:instruction;
  const response = await fetch(endpoint(anthropic ? '/messages' : '/chat/completions', base), anthropic ? {
    method:'POST', headers:{'content-type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
    body:JSON.stringify({model,max_tokens:500,temperature:0,messages:[{role:'user',content:userContent}]})
  } : {
    method:'POST', headers:{'content-type':'application/json',authorization:`Bearer ${apiKey}`},
    body:JSON.stringify({model,temperature:0,stream:false,messages:[{role:'system',content:'You are a careful computer-use controller. Return JSON only.'},{role:'user',content:openAiContent}]})
  });
  if (!response.ok) throw new Error(`视觉模型返回 ${response.status}: ${(await response.text()).slice(0,300)}`);
  const json:any = await response.json();
  recordUsage(provider, model, json.usage);
  const text = anthropic ? json.content?.map((x:any)=>x.text).join('') : json.choices?.[0]?.message?.content;
  const parsed = JSON.parse(String(text).match(/\{[\s\S]*\}/)?.[0] || '{}') as ComputerAction;
  if (!['uiaInvoke','uiaSetValue','click','type','key','scroll','wait','done','fail'].includes(parsed.type)) throw new Error('模型返回了无效的桌面动作');
  parsed.reason = String(parsed.reason || parsed.type).slice(0,500);
  parsed.tier = Math.max(actionTier(parsed), Number(parsed.tier) || 0);
  return parsed;
}
function sensitiveForeground(title: string) { return /(1password|bitwarden|keepass|password|\u5bc6码|bank|banking|\u94f6行|alipay|\u652f付宝)/i.test(title); }
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
  if (url.pathname !== '/ws' || url.searchParams.get('token') !== token) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(request, socket, head, (client) => sockets.emit('connection', client, request));
});
sockets.on('connection', (socket) => {
  clients.add(socket);
  send(socket, {type: 'runtime.ready'});
  socket.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString()) as ClientMessage;
      void handleClient(socket, message);
    } catch (error) {
      send(socket, {type: 'error', id: 'unknown', message: String(error)});
    }
  });
  socket.on('close', () => {
    clients.delete(socket);
    for (const active of activeChats.values()) if (active.socket === socket) active.controller.abort();
  });
});
createInterface({input: process.stdin}).on('line', (line) => {
  try {
    const message = JSON.parse(line);
    if (message.method === 'runtime.configure') applyConfig(message.params as RuntimeConfigure);
    if (message.method === 'proactive.setPaused') proactive.setPaused(!!message.params?.paused);
    if (message.method === 'task.approve') {
      const id = message.params?.taskId as string;
      const waiter = approvalWaiters.get(id);
      if (waiter) {
        approvalWaiters.delete(id);
        waiter.resolve(true);
      }
    }
    if (message.method === 'task.reject') {
      const id = message.params?.taskId as string;
      const waiter = approvalWaiters.get(id);
      if (waiter) {
        approvalWaiters.delete(id);
        waiter.resolve(false);
      }
    }
  } catch (error) {
    console.error('[pattern-sidecar] invalid stdin message', error);
  }
});
// nightly consolidate + proactive + relay loops
setInterval(() => {
  const d = new Date();
  if (d.getHours() === 3 && d.getMinutes() < 2) {
    void runDreamingJob(false).then((result) => console.log('[pattern-sidecar] dreaming', result));
    memory.consolidate(`${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`);
    // Pattern Engine nightly consolidation (spec §十五): aging, promotion, merging.
    try {
      const patternResult = memory.patterns.consolidate();
      console.log('[pattern-sidecar] nightly pattern consolidation', patternResult);
      broadcast({type: 'pattern.changed'});
    } catch (error) {
      console.error('[pattern-sidecar] nightly pattern consolidation failed', error);
    }
  }
}, 60_000);
setInterval(() => {
  void proactiveTick();
}, 60_000);
setInterval(() => { void proactiveChainTick(); }, 30_000);
setInterval(() => { void powerTick(); }, 60_000);
setInterval(() => { void plaaTick(); }, 10_000);
setInterval(() => { void healthTick(); }, 60_000);
setInterval(() => { void cronTick(); void scheduledTaskTick(); }, 30_000);
setInterval(() => { void telegramPoll(); }, 5_000);
setInterval(() => { void emailPoll(); }, 30_000);
setInterval(() => {
  void (async () => {
    try {
      const incoming = await relay.sync();
      for (const env of incoming) {
        if (env.role === 'user' && (env.type === 'chat' || env.type === 'task')) {
          await handleRelayEnvelope(env);
        } else if (env.type === 'chat' || env.type === 'proactive') {
          const item = proactive.markDelivered(
            {
              type: 'relay_inbound',
              score: 1,
              topicKey: `relay:${env.id}`,
              reason: `from device ${env.from}`,
              payload: {},
            },
            env.body,
            'relay',
          );
          broadcast({type: 'proactive.impulse', item});
        }
      }
    } catch {
      /* ignore tick errors */
    }
  })();
}, 15_000);
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('cannot read sidecar port');
  process.stdout.write(`${JSON.stringify({port: address.port, token})}\n`);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
