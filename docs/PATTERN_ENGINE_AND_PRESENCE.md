# Pattern Engine 与 Presence 层

> 0.3.x 增量文档 · 与代码同步。Pattern Engine 是记忆之上的派生认知层；
> Presence 层是它在桌面上的表达层。两者都是增量扩展，不改动既有记忆/主动性/Computer Use 架构。

---

## 1. Pattern Engine（派生认知层）

Memory 存的是**事实**，Pattern 存的是**由多个事实归纳出的长期推断**：

```text
Conversation → Episodes/Memories → Evidence → Patterns → 对用户的长期认识 → 回到对话/主动/决策
```

- 记忆：「用户昨晚三点才睡」
- Pattern：「用户在项目高强度阶段容易推迟睡眠」（多条熬夜记忆归纳而来）

### 数据模型

表结构在 `packages/memory/src/pattern.ts`（与记忆共用 `memory.db`）：

| 表 | 作用 |
|----|------|
| `pattern` | id / text / category / confidence(0–1) / status / created_at / updated_at / last_observed_at / evidence_count / metadata(JSON，含 keywords 与未来 observerId) |
| `pattern_evidence` | pattern_id → memory_id，relation(supports/contradicts)，weight(0–1)，reason |
| `pattern_fts` | FTS5 索引，含检索 keywords（用于跨词汇检索） |

`status` 生命周期：`candidate → active → weakening → contradicted → archived`。

- **candidate**：一次观察只是弱候选（起始置信度 ≤ 0.3）。
- **active**：累计 ≥3 条支持证据且置信度 ≥ 0.55 时升级。
- **weakening**：超过 14 天无新证据，置信度随时间衰减。
- **contradicted**：反对证据占优且置信度 < 0.35。
- **archived**：置信度跌破阈值，保留历史但不删除。

### 增量提取（sidecar/src/pattern-pipeline.ts）

不做全量重扫。流程：

```text
新保存的记忆 → 检索邻近 Pattern → 模型输出结构化决策 → 校验后落库
```

模型决策必须是下列之一的 JSON：`support / contradict / update / create / ignore`。
所有输出都经过 **schema 校验 + 边界钳制 + 安全兜底**，错误输出一律视为 ignore，
绝不写入坏数据。

证据约束与安全护栏（防止"随意分析人格"）：

- 单条消息只能产生低置信候选，不能直接形成强 Pattern。
- `confidence_delta` 钳制在 ±0.3。
- 诊断/人格障碍/道德评价类词汇（抑郁症、工作成瘾、自恋型……）在 `create/update`
  时被 `findUnsafePatternLabel` 拒绝。Pattern 只描述可观察行为/习惯/偏好。

### 检索与可解释性

- `patterns.search(query)`：FTS + keyword 双通道，返回少量最相关 Pattern
  （active 优先，低置信/已归档自动过滤）。检索查询源为**当前消息 + 本轮记忆命中**
  （spec §九），去重后合并注入，上限 4 条。
- 聊天、主动消息、companion 回复的 system prompt 里只注入 `[Relevant long-term patterns]`
  片段（最多 4 条），并明确要求"自然融入、不要机械引用"。
- Agent 工具：`list_patterns` / `search_patterns` / `explain_pattern`。
  用户问"你为什么觉得我…"时，`explain_pattern` 返回该 Pattern 的支持/反对原始记忆，
  保证可解释。
- WS：`pattern.list / get / search / evidence / update / archive / delete / consolidate`
  供前端"认识"页使用。

### 固化

Pattern 固化挂在既有 dreaming/consolidate 任务里（不新增调度器）：
凌晨自动运行，`memory.consolidate` 与 `pattern.consolidate` 一起执行；
`pattern.consolidate` 也可通过 WS 手动触发。

---

## 2. Presence 层（形象与桌宠）

Presence 是**表达层**，不是新的 agent 核心。数据流单向：

```text
Persona/Memory/Pattern/Proactive → 智能系统决定"状态/态度/是否开口"
                              ↓
Presence State → 桌宠/头像决定"如何在桌面上表现"
```

### 数据模型（packages/protocol）

- `PresenceState`: `idle|speaking|thinking|happy|concerned|sleepy|busy|notification|away`
- `PersonaVisualProfile`: persona 的视觉资源（各状态图片引用）
- `PresenceConfig`: 模式/置顶/透明度/气泡/位置等，持久化在 `%LOCALAPPDATA%/pattern/presence.json`

### 状态推导（sidecar/src/presence.ts）

只用可靠信号，不做情感识别：

- `thinking` / `executing` → 思考 / 忙碌
- 刚发生主动消息 → `notification`
- 长时间无活动 → `away`
- 深夜（23:00–05:00）用户仍活跃 → `sleepy`
- 其余 → `idle`

每 60s 刷新一次（含真实 idle 秒数），agent 状态变化时也会即时推送。

### 桌宠窗口（CompanionWidget）

- Tauri 新增 `companion` 透明置顶窗口（`tauri.conf.json`），默认隐藏。
- 前端 `CompanionWidget.svelte`：显示人格图片/默认 orb，按 presenceState 换状态样式，
  主动消息时弹气泡。可拖动（位置持久化）、单击开快捷窗、双击开主窗、右键菜单。
- Rust 命令 `set_companion`：显示/隐藏 + 位置 + 置顶；**绝不 set_focus 抢焦点**。
- 无视觉资源时优雅回退到内置 orb，应用照常运行。

### 头像模式（Phase A）

`mode=avatar` 时主窗口标题栏显示人格头像（`brand-avatar`）。
人格图片在 设置 → 常规 → 形象与桌宠 导入（PNG/JPG，≤4MB，存 localStorage）。

### 设置

设置 → 常规 → 「形象与桌宠」：

- 显示模式：关闭 / 头像 / 桌宠（默认关闭，首次需显式开启）
- 始终置顶、气泡提醒、主动气泡、透明度、大小
- 人格形象导入

配置错误不会导致启动失败——`normalizePresenceConfig` 会把越界值钳回安全范围。

### 与主动性联动

主动消息投递时（`deliverProactive`）会调用 `emitProactiveBubble`，
桌宠据此切换状态并弹气泡。`proactiveBubbleEnabled=false` 可关闭主动气泡。

---

## 3. 测试

| 套件 | 文件 | 覆盖 |
|------|------|------|
| Pattern DB | `sidecar/test/pattern-db.test.mjs` | 建/改/归档/删除、支持/反对证据、置信度钳制、生命周期、合并、keyword 检索 |
| Pattern 流水线 | `sidecar/test/pattern-pipeline.test.mjs` | 决策解析、边界钳制、恶意/畸形输出兜底、不安全标签拦截 |
| Presence | `sidecar/test/presence.test.mjs` | 配置归一化/持久化/损坏兜底、状态推导、气泡开关 |
| UI | `tests/oobe.mjs`、`tests/app-flows.mjs`、`tests/ui-accessibility.mjs` | OOBE、主流程、可访问性冒烟 |

运行：`pnpm --dir sidecar test`、`pnpm check`、`pnpm build`、`pnpm test:ui`、
`cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`。

## 4. 已知限制

- Pattern 检索用 FTS + keyword，不引入向量 ANN（与记忆系统一致）。
- 桌宠第一版用静态图 + CSS 状态切换，未引入动画引擎；位置跨显示器恢复为物理坐标。
- 头像资源存 localStorage（≤4MB），未做云端/文件中转；多人格皮肤与 observerId 已留字段。
- Pattern 提取依赖 utility/companion 模型；未配置模型时只做确定性回退，不报错。
