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
import {assessSafety, routeUserMessage, taskTitleFromText} from '@pattern/core';
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
} from '@pattern/protocol';
interface ChatRequest {
  type: 'chat.send';
  id: string;
  text: string;
  history: Array<{role: 'user' | 'assistant'; content: string}>;
  sessionId?: string;
  slot?: AgentSlot;
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
let lastUserActivityAt = Math.floor(Date.now() / 1000);
let tasks: TaskRecord[] = loadTasks();
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
const execFileAsync = promisify(execFile);
let mcpServers = loadMcpServers();
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
  autoApproveBelow: number;
  hardDenyAt: number;
  tierGuide: Array<{tier: number; label: string; meaning: string}>;
};
const DEFAULT_SECURITY_POLICY: SecurityPolicyState = {
  workspaceRoot: null,
  enforceWorkspace: true,
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
      autoApproveBelow: Math.min(3, Math.max(0, Number(raw.autoApproveBelow ?? 2))),
      hardDenyAt: Math.min(3, Math.max(1, Number(raw.hardDenyAt ?? 3))),
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
  context?: {workspace?: string; projectName?: string; attachments?: string[]},
) {
  const persona = config?.persona || 'You are Pattern, a desktop companion defined by the user.';
  const name = config?.personaName || 'Pattern';
  const user = config?.userName || 'User';
  const index = memory.buildIndex();
  const details = memHits.length
    ? memHits.map((m) => `- (${categoryLabel(m.category)}, imp=${m.importance.toFixed(2)}) ${m.text}`).join('\n')
    : '(no extra retrieval hits this turn)';
  const now = new Date();
  const env = `Local time: ${now.toLocaleString('zh-CN')}. You are a resident desktop companion, not a website chatbot.${plaaState?`\nPLAA emotional state: ${plaaState}`:''}`;
  const role = 'You are the primary agent. Keep one coherent context for conversation and work. When the user clearly asks you to act, delegate execution to a child agent and return only a concise result summary; do not pollute the main context with child-agent implementation chatter.';
  const workspaceBlock = context?.workspace
    ? `[Active project workspace]
- Name: ${context.projectName || 'project'}
- Root: ${context.workspace}
- Treat paths relative to this root unless the user says otherwise.
- Do not invent file contents you have not been given.
${context.attachments?.length ? `- User attached paths this turn:\n${context.attachments.map((p) => `  - ${p}`).join('\n')}` : '- No file attachments this turn.'}`
    : `[Active project workspace]
- None (global companion chat).`;
  return `${persona}
[Identity]
- Your name: ${name}
- User address: ${user}
- Agent role: primary agent
- ${role}
[MEMORY-INDEX | always know what you remember]
${index}
[Retrieved memory details]
${details}
[Environment]
${env}
${workspaceBlock}
[Rules]
- Use memories naturally; do not recite entry ids.
- If a memory conflicts with the user's latest statement, prefer the latest statement.
- Never claim computer-use success without tool receipts.
- Never claim you read or modified project files unless tool receipts or attached contents prove it.`;
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
    saveTasks(); announceTask(task); void runComputerUseTask(task);
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
  if (!fileWatchConfig.enabled) return;
  for (const root of fileWatchConfig.paths) {
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
): Promise<string> {
  if (!config) throw new Error('runtime is not configured');
  setAgentState('thinking');
  send(socket, {type: 'chat.started', id: message.id, slot});
  const anthropic = config.provider.toLowerCase().includes('anthropic');
  const startedAt = Date.now();
  let streamUsage: any;
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
  send(socket, {type: 'chat.done', id: message.id, slot});
  setAgentState('idle');
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
async function createTaskFromText(title: string, detail = '', schedule?: TaskSchedule, workflow?: TaskRecord['workflow'], plan?: TaskRecord['plan']) {
  const normalizedSchedule = schedule || scheduleFromText(`${title}\n${detail}`);
  const task: TaskRecord = {
    id: randomUUID(),
    title: title.trim() || '未命名任务',
    detail: detail || title,
    status: normalizedSchedule ? 'scheduled' : 'queued',
    createdAt: new Date().toLocaleString('zh-CN'),
    steps: [],
    riskTier: classifyTaskTier(title, detail || title),
    schedule: normalizedSchedule,
    plan: plan?.filter((step) => step?.title?.trim() && step?.detail?.trim()).slice(0, 30),
    nextRunAt: normalizedSchedule ? Date.now() : undefined,
    workflow,
  };
  tasks.unshift(task);
  saveTasks();
  announceTask(task);
  if (!normalizedSchedule) void runComputerUseTask(task);
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
  try {
    const routed = message.slot || (await classifyRoute(message.text)).slot;
    if (routed === 'executor') {
      const title = taskTitleFromText(message.text);
      const task = await createTaskFromText(title, message.text, scheduleFromText(message.text));
      send(socket, {type: 'chat.started', id: message.id, slot: 'executor'});
      send(socket, {
        type: 'chat.delta',
        id: message.id,
        delta: `已交给子代理：${task.title}\n任务已创建，主对话只保留结果摘要；可在任务页与审查窗跟踪进度。`,
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
          kind: 'workspace',
          text: ('工作区隔离已绑定 · ' + (message.projectName || '') + ' · ' + message.workspace).replace(/\s+·/g, ' ·').trim(),
          ts: Date.now(),
        },
      });
    }
    const system = buildSystemPrompt(hits, 'companion', {
      workspace: message.workspace,
      projectName: message.projectName,
      attachments: message.attachments,
    });
    const full = await streamChat(socket, message, system, 'companion');
    void extractMemories(message.text, full, message.sessionId).then(() => {
      const related = memoryProposals.filter((item) => item.sourceConv === (message.sessionId || null)).slice(0, 5);
      if (related.length) {
        send(socket, {
          type: 'chat.event',
          id: message.id,
          event: {
            kind: 'memory',
            text: `待确认记忆 ${related.length} 条：${related.map((item) => item.text).join(' / ').slice(0, 160)}`,
            ts: Date.now(),
          },
        });
      }
    });
  } catch (error) {
    setAgentState('idle');
    send(socket, {
      type: 'chat.error',
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    });
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
  const system = `${buildSystemPrompt(hits)}\n[Proactive wake-up]\nYou may call emit_proactive_message once, schedule_next_wakeup once, both, or neither. Never put a user-visible message in normal text. Do not use a schedule earlier than five minutes from now.`;
  const prompt = `Objective: ${chain.purpose}\nContext: ${chain.context || '(none)'}\nCurrent local time: ${new Date().toLocaleString('zh-CN')}\nThis is wake-up #${chain.consecutiveSilentRuns + 1}. Decide whether to speak and/or schedule the next check.`;
  const anthropic = config.provider.toLowerCase().includes('anthropic');
  const response = await fetch(endpoint(anthropic ? '/messages' : '/chat/completions'), anthropic ? {
    method:'POST', headers:{'content-type':'application/json','x-api-key':config.apiKey,'anthropic-version':'2023-06-01'},
    body:JSON.stringify({model:config.model,max_tokens:360,system,messages:[{role:'user',content:prompt}],tools:proactiveTools.map((tool) => ({name:tool.function.name,description:tool.function.description,input_schema:tool.function.parameters}))})
  } : {
    method:'POST', headers:{'content-type':'application/json',authorization:`Bearer ${config.apiKey}`},
    body:JSON.stringify({model:config.model,temperature:0,messages:[{role:'system',content:system},{role:'user',content:prompt}],tools:proactiveTools,tool_choice:'auto'})
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
  const system = buildSystemPrompt(hits);
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
    await relay.publish(relay.createEnvelope({role:'companion', type:'chat', body:`已交给子代理：${task.title}。结果会同步到任务页。`}));
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
  const chain = proactive.createChain({id, kind: 'autonomous', purpose: admitted.reason, context: JSON.stringify(admitted.payload), nextRunAt: Date.now(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', recurrence: null, sourceConversationId: null});
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
    approvalWaiters.set(taskId, {resolve});
    setTimeout(() => {
      if (approvalWaiters.has(taskId)) {
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
    task.status = 'done';
    finishTaskRun(task, 'done');
    saveTasks();
    setAgentState('idle');
    announceTask(task);
    await notify(config?.personaName || 'Pattern', `Task done: ${task.title}`);
    await telegramSend(`任务已完成：${task.title}`);
    await emailSend(`${config?.personaName || 'Pattern'} · 任务已完成`, task.title);
  } catch (error) {
    task.status = 'failed';
    task.error = error instanceof Error ? error.message : String(error);
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
        if ('autoApproveBelow' in next) securityPolicy.autoApproveBelow = Math.min(3, Math.max(0, Number(next.autoApproveBelow)));
        if ('hardDenyAt' in next) securityPolicy.hardDenyAt = Math.min(3, Math.max(1, Number(next.hardDenyAt)));
        saveSecurityPolicy();
        appendJournal({line: `security.policy updated enforce=${securityPolicy.enforceWorkspace} root=${securityPolicy.workspaceRoot || '-'} auto<${securityPolicy.autoApproveBelow} deny>=${securityPolicy.hardDenyAt}`, kind: 'policy', decision: 'info'});
        send(socket, {type: 'security.policy', id: message.id, policy: securityPolicy});
        break;
      }
      case 'proactive.list': {
        send(socket, {type: 'proactive.list.result', id: message.id, items: proactive.list(message.limit ?? 50)});
        break;
      }
      case 'proactive.setPaused': {
        proactive.setPaused(message.paused);
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
        send(socket, {type:'workflow.list.result', id:message.id, workflows:codingWorkflows});
        break;
      }
      case 'workflow.run': {
        const workflow = codingWorkflows.find((item) => item.id === message.workflowId);
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
        const task = await createTaskFromText(message.title, message.detail || '', message.schedule, undefined, message.plan);
        send(socket, {type: 'task.list.result', id: message.id, tasks});
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
      case 'memory.consolidate': {
        const result = memory.consolidate();
        send(socket, {
          type: 'memory.consolidate.result',
          id: message.id,
          at: result.at,
          decayed: result.decayed,
          evicted: result.evicted,
        });
        broadcast({type: 'memory.changed'});
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
  const instruction = `You control a desktop to complete this task: ${task.title}\nDetails: ${task.detail || '(none)'}\nOrdered automation steps (follow in order; do not skip or reorder):\n${plan}\nForeground window: ${foregroundTitle||'(unknown)'}\nRecent receipts:\n${history.slice(-6).join('\n')}\nAccessible controls from the foreground window:\n${JSON.stringify(controls).slice(0,18000)}\nPrefer uiaInvoke for buttons/menu items and uiaSetValue for editable fields. ${vision?'Use the control ref and include x/y as visual fallback when possible. Otherwise choose click,type,key,scroll,wait,done,fail. Never claim done unless the screenshot visibly proves the result.':'This is accessibility-only mode: no screenshot is available. Never invent coordinates. Use uiaInvoke/uiaSetValue or keyboard actions only. Infer completion only from control-tree state and receipts; if required controls are unavailable, return fail with a precise accessibility limitation.'} Return JSON only with type,ref,automationId,name,value,x,y,text,key,modifiers,amount,reason,tier. Set tier 2 for destructive actions, external communication, uploads, installs, purchases or final submission; tier 3 for password managers or banking.`;
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
  socket.on('close', () => clients.delete(socket));
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
  if (d.getHours() === 3 && d.getMinutes() < 2) memory.consolidate(`${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`);
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
