# Pattern — 桌面 AI 伴随助手 · 架构设计

> 版本 0.3 · 2026-07-16（同步 AgentOS Windows Recovery、移动端、中继与角色槽实现）
> 技术路线：**Tauri 2 + Svelte 5 前端 + Node sidecar（自研 agent loop）**
> 目标平台：Windows 10/11 · macOS 13+
>
> **读法**：下文 §1–§11 仍是目标架构；**§0 实现现状**与代码仓库对齐，避免按目标态误判进度。

---

## 0. 实现现状（对照仓库，0.3.0）

| 层 | 目标态 | 当前实现 |
|----|--------|----------|
| 外壳 | Tauri 2 | ✅ `apps/desktop` Tauri 2 |
| 前端 | Svelte 5 + Tailwind 4 | ✅ Svelte 5；❌ 无 Tailwind，手写 CSS 主题 |
| Agent | pi-mono + `AgentCore` | ❌ 未接 pi；`sidecar/src/index.ts` 自研 chat / computer-use loop |
| Windows 恢复层 | AgentOS sandbox + transaction recovery | ⚠️ 已接入声明 scope 的用户态 detached transaction、冲突检测、重启协调、GC 与人工恢复；❌ 尚无 Minifilter/Registry callback/WFP/WinRE |
| Sidecar 运行时 | Bun 单二进制优先 | ⚠️ **默认 Node 22 + esbuild CJS**；`bun build --compile` 仅脚本，分发暂缓 |
| 数据 | SQLite + sqlite-vec + FTS5 | ⚠️ SQLite + FTS5（CJK 扩展索引 + MATCH 粗排）+ embedding BLOB；❌ 无 sqlite-vec |
| 嵌入 | 默认 bge ONNX | ⚠️ 默认 **hash 近似向量**；可选 API embedding / `provider=local` transformers.wasm |
| 进程 IPC | stdio JSON-RPC 2.0 + OS RPC | ⚠️ stdin 简易 `{method,params}`；OS 能力走 **HTTP Bridge**（`bridge.rs`） |
| 包结构 | core/memory/proactive/relay/channels/protocol/shared | ✅ 全部包已建；channels 含 Telegram/SMTP/IMAP 与本地插件发现，shared 提供跨包工具 |
| 移动端 | `apps/mobile` | ⚠️ Svelte + Tauri、WebDAV 对话、远程任务、二维码导入与 Android 原生工程已实现；iOS 工程需在 macOS 生成 |
| 中继 | WebDAV 信封 + 游标 + E2E 密钥 | ⚠️ mailbox 为 AES-256-GCM；local/远程 list、游标、outbox 与跨端收发已实现；设备配对已使用 X25519 + XChaCha20-Poly1305 双二维码交换 |
| 角色槽 | companion / executor 双槽 + 路由 | ✅ 双模型、槽绑定、规则快路由 + utility 小模型分类、多人格切换 UI 已实现 |
| 通道 | Channel 插件 | ✅ Telegram、SMTP、IMAP 已迁入 `packages/channels` 适配器；本地第三方插件支持 manifest 发现与显式启用 |
| Pattern Engine | 记忆之上的派生认知层 | ✅ `packages/memory/src/pattern.ts`（pattern/pattern_evidence/pattern_fts 表，生命周期 candidate→active→weakening→contradicted→archived）+ `sidecar/src/pattern-pipeline.ts`（增量提取、结构化校验、不安全标签拦截）；检索注入 chat/proactive prompt，可解释工具；凌晨随 dreaming 固化 |
| Presence 层 | 形象/桌宠表达层 | ✅ `sidecar/src/presence.ts` + `apps/desktop/src/lib/presence.ts` + `CompanionWidget.svelte`；人格头像（avatar）、透明置顶 companion 窗（pet）、PresenceState、主动气泡；设置持久化 `presence.json`，默认关闭 |

### 里程碑进度（诚实）

| 阶段 | 状态 | 说明 |
|------|------|------|
| M0 骨架 | ~90% | OOBE 最小、主/快捷/审查窗、托盘、流式对话、keyring；Bun 打包与 pi 未按原验收 |
| M1 记忆 | ~85% | schema/提取/INDEX/浏览/固化；**FTS 粗排 + 混合精排**已落地；默认 hash embedding |
| M2 主动性+中继 | ~97% | 深夜/电源电量/健康检查/文件监视/暂停/日志；中继跨端闭环、X25519 安全配对、SMTP/IMAP 与本地 Channel 插件已完成 |
| M3 Computer Use | ~88% | Win UIA / mac AX、视觉与无视觉无障碍树模式、T0–T3、审查窗、急停、journal；Windows 已接 AgentOS 用户态恢复，内核捕获与 mac 真机验收待完成 |
| M4 移动端 | ~65% | WebDAV 对话/任务、安全配对、持久消息、前后台自适应同步、Android 原生工程与 debug APK 已验证；iOS 与系统级后台推送待平台验收 |
| M5 打磨 | ~68% | 自启动、双槽路由、多人格 UI、权限检查、PLAA 挂载点、本地 Channel 插件管理与可配置快捷键已完成；签名公证与样式迁移待发布环境 |
| M6 Pattern Engine | 完成* | 记忆之上的派生认知层；增量提取 + 证据约束 + 不安全语言护栏 + 可解释；详见 [`docs/PATTERN_ENGINE_AND_PRESENCE.md`](docs/PATTERN_ENGINE_AND_PRESENCE.md) |
| M7 Presence 层 | 完成* | 头像模式 + 桌宠 Companion 窗（透明置顶、拖动、气泡、不抢焦点）；与主动性联动；详见上述文档 |

**刻意延后**：pi 接入、Tailwind 迁移、mDNS、OneBot。PLAA 已提供可选 HTTP 挂载点；优先把桌面 MVP 做扎实。

---
## 1. 项目定位

Pattern 不是一个"聊天客户端"，而是一个**常驻操作系统的 AI 伴随体**：

- **有记忆**：跨会话、跨月份地记住用户的生活与工作事实（记忆架构继承 Lumina-Yanshuai 的 RagMemory 设计并升级）；
- **有人格**：稳定的性格与立场，会反对、会催促，不无条件顺从；
- **会主动**：基于时间、系统状态、外部事件主动开口（深夜催睡、服务器告警、日程提醒），且有分寸控制；
- **能动手**：computer use（截屏 + 键鼠注入 + 无障碍树）替用户操作电脑；
- **能传话**：通过系统通知 / Telegram / 邮件等通道收发消息，人不在电脑前也能联系。

### 人格系统：没有预设

Pattern **不内置任何人格**。首次启动的 OOBE 向导（接入模型 → 授予权限 → 定义人格）由用户亲手定义：名字、对用户的称呼、性格与说话方式（自由书写，不给模板库）、主动性偏好；也可以直接导入现成人格卡。人格定义完成之前，托盘的眼睛保持熄灭。

人格是数据不是代码：`personas/*.md`（frontmatter 存元数据，正文就是人格自述），可导入导出、可建多个。人格与能力解耦——能力由两个**角色槽**提供，人格绑定槽位后才获得对应工具权限：

| 角色槽 | 职责 | 默认工具权限 | 模型配置 |
|--------|------|------------|---------|
| **陪伴槽** | 对话、情绪、记忆、主动开口 | 只读 + 记忆写入 | `models.companion` |
| **执行槽** | computer use、跑代码、运维、发消息 | 全工具（分级审批） | `models.executor` |

一个人格可以同时占两个槽；也可以定义两个人格分别绑定——聊天是一个性子，干活是另一个。所有人格**共享同一记忆库**。快捷窗输入先过一层轻量路由（规则 + 小模型分类）决定进哪个槽。

---

## 2. 技术选型

| 层 | 选择 | 理由 |
|----|------|------|
| 外壳 | **Tauri 2**（Rust） | 体积小（~10MB vs Electron ~150MB）、原生窗口特效（vibrancy/acrylic）、全局快捷键 / 托盘 / 自启动官方插件齐全、win/mac 统一 |
| 前端 | **Svelte 5 + Vite + Tailwind 4** | 单文件组件写法接近 XAML 心智，模板即状态，无 React 样板代码；从 C# 迁移最平滑 |
| Agent 运行时 | **pi agent（pi-mono，TS）** 跑在 sidecar | 提供 agent loop、工具调度、统一 LLM provider 层；以 `AgentCore` 接口封装隔离，若框架能力不够可整体换成自研 loop 而不动上层 |
| Sidecar 运行时 | **Bun**（首选） | `bun build --compile` 产出单文件二进制，直接做 Tauri sidecar；`bun:sqlite` 内置，免 better-sqlite3 原生编译坑 |
| 数据 | **SQLite** + `sqlite-vec`（向量） + FTS5（BM25） | 单文件、免服务、离线；两阶段检索天然对应 vec 粗排 + FTS 混排 |
| 本地嵌入 | transformers.js / fastembed（`bge-small-zh-v1.5`，~60MB ONNX） | 记忆检索完全离线；API embedding 作为可选加速 |
| 移动端 | **Tauri 2 Mobile**（iOS/Android） | 复用同一套 Svelte UI 出手机瘦客户端，经 WebDAV 中继与桌面主控通信（见 §7.1） |

> **Bun 风险备注**：macOS 系统 sqlite 不允许加载扩展，`bun:sqlite` 需 `Database.setCustomSQLite()` 指向自带 libsqlite；若 sqlite-vec 集成受阻，退路是 Node + better-sqlite3，sidecar 改为随应用分发 node 运行时（Tauri resources）。
>
> **现状（0.3.0）**：已走 Node 退路（`better-sqlite3` + FTS5，无 sqlite-vec）。开发依赖本机 Node 22+ 与原生模块编译环境；单文件 sidecar 打包与 sqlite 扩展加载仍待验证。Agent 侧为自研 loop，未接 pi-mono——后续以 `packages/core` 的 `AgentCore` 边界替换，而不是绑定 pi。

---

## 3. 进程模型

```
┌────────────────────────────────────────────────────────────┐
│ Tauri Shell (Rust)                                          │
│  · 窗口管理：主窗 / 快捷窗 / 设置窗 / 执行审查窗              │
│  · 全局快捷键 (Alt+Space / ⌥Space)、托盘、通知、自启动、单实例 │
│  · OS Bridge：截屏(xcap) 键鼠(enigo) 无障碍树(UIA/AX)        │
│  ·           空闲检测 / 前台窗口 / 电源状态                   │
│  · 密钥保管：系统 Keychain / 凭据管理器 (keyring)             │
└──────┬─────────────────────────────┬───────────────────────┘
       │ spawn + stdio JSON-RPC      │ Tauri command/event
       ▼                             ▼
┌─────────────────────────┐   ┌──────────────────────────────┐
│ Sidecar (Bun, 单二进制)  │◄──┤ WebView 前端 (Svelte)         │
│  · AgentCore (pi 封装)   │ WS │  · 对话流 / 记忆浏览 / 任务    │
│  · 人格/角色槽 + 路由     │   │  · 执行审查 UI                │
│  · 记忆引擎 (SQLite)      │   │  · 设置                      │
│  · 主动性引擎 (事件总线)   │   └──────────────────────────────┘
│  · 消息通道 (WebDAV 中继/  │──► <webdav>/pattern/ ◄── Pattern Mobile
│    通知/TG…)              │      (发布-订阅-拉取，见 §7.1)
│  · LLM providers          │──► Anthropic / OpenAI 兼容 / 本地 llama.cpp
└─────────────────────────┘        (可选) PLAA 情感状态服务
```

### IPC 设计

1. **Rust ↔ Sidecar**：stdio 上跑 JSON-RPC 2.0。sidecar 启动后在 stdout 宣告 `{port, token}`；OS 能力（截屏、点击、通知……）全部是 Rust 暴露给 sidecar 的 RPC 方法——**agent 的工具调用最终落到 Rust 执行**。
2. **前端 ↔ Sidecar**：WebSocket（127.0.0.1 随机端口 + token 鉴权），承载对话流式 token、记忆事件、任务进度。前端不经过 Rust 中转，避免流式转发开销。
3. **前端 ↔ Rust**：Tauri command/event，只管窗口行为与本机设置。

---

## 4. 记忆系统（继承 RagMemory，升级版）

### 4.1 数据模型

沿用 Lumina `MemoryItem` 的字段设计，落到 SQLite：

```sql
CREATE TABLE memory (
  id            TEXT PRIMARY KEY,
  text          TEXT NOT NULL,
  category      TEXT NOT NULL,          -- fact | preference | event | feedback | reference
  importance    REAL DEFAULT 0.5,       -- 0~1，小模型打分
  created_at    INTEGER,
  updated_at    INTEGER,
  access_count  INTEGER DEFAULT 0,      -- LRU 淘汰因子
  source_conv   TEXT,                   -- 溯源会话
  expired       INTEGER DEFAULT 0       -- 软删除，被新事实取代时置位
);
-- 向量表 (sqlite-vec)
CREATE VIRTUAL TABLE memory_vec USING vec0(id TEXT PRIMARY KEY, embedding float[512]);
-- 全文表 (FTS5, BM25)
CREATE VIRTUAL TABLE memory_fts USING fts5(text, content=memory);
```

### 4.2 两阶段检索（沿用 Agent 版实现思路）

```
query ──► embed ──► Stage1: vec0 粗排 top-50
                         │
                         ▼
              Stage2 混合评分 rerank：
              score = 0.55·cosine + 0.25·bm25_norm
                    + 0.10·importance + 0.06·recency + 0.04·log(access)
                         │
                         ▼
                    top-K (默认 5) 注入上下文，命中项 access_count++
```

> **现状（0.3.0）**：Stage1 为 **FTS5 MATCH**（CJK 字/双字扩展写入 `memory_fts`）∪ `LIKE`，候选上限 ~300；无 sqlite-vec 时不依赖向量粗排。Stage2 混合权重与上式一致。默认 embedding 为 hash(dim256)；sidecar 可注入 API / local-model embedder。

### 4.3 写入管线

1. **逐轮提取**：每轮对话结束，廉价小模型判断"有没有值得长期记住的事"，产出候选条目 + importance 评分 + category；
2. **去重合并**：候选先对库内做相似检索，高相似（>0.92）则更新原条目而非新增；事实冲突（如搬家换地址）将旧条目 `expired=1` 并链接新条目；
3. **夜间固化**：每日一次，把当天情景流水（episodic）压缩成长期语义记忆（semantic），同时衰减长期未访问的低重要性条目；
4. **容量淘汰**：沿用 Lumina 公式——超上限（10,000 条）时按 `importance × (1 + log10(access+1))` 排序淘汰尾部。

### 4.4 常驻索引

维护一份 `MEMORY-INDEX`（每条记忆一行摘要，类似 MEMORY.md），**每次会话开场整份注入**，检索只补充细节。这保证人格"始终知道自己知道什么"，而不是每次都失忆后再检索。

---

## 5. 主动性引擎

```
触发源 ──► 事件总线 ──► 冲动(impulse){type, score, payload}
                              │
                        政策闸门 Policy Gate（默认全放行）
                        · 不设配额、不设冷却——想开口就开口
                        · 同话题去重合并，不连环刷屏
                        · 通知不抢焦点、不要求回应，可直接忽视
                        · 免打扰/暂停为用户手动开关（默认关闭）
                              │
              ┌───────────────┼────────────────┐
              ▼               ▼                ▼
          系统通知 toast   打开快捷窗说话     IM 通道外发
```

**关于打扰的立场（用户已拍板：不限制）**：主动性不设每日配额与冷却——她想说就说，被打扰是被欢迎的。作为交换，用户保留"忽视"的自由，因此所有主动通知必须满足三条硬约束：**不抢输入焦点、不要求回应、可无操作自动淡出**。系统只做两件兜底：同话题去重合并（不连环刷屏），以及托盘上的手动暂停/免打扰开关。设置里保留配额选项供未来想收紧时启用，默认关闭。

**触发源清单（v1）**：cron 定时、系统空闲/活跃切换、深夜仍活跃检测、电源/电量、文件监视、HTTP 健康检查（服务器监控）、IM 入站消息。

主动说话的内容生成走陪伴槽人格，并带上"这次为什么开口"的触发上下文。所有主动行为记入日志，UI 可回看"TA 今天为什么找我"。

---

## 6. Computer Use

### 6.1 执行链

```
任务 ──► 执行人格 loop：
   截屏(xcap, Rust) ──► 模型决策 ──► 动作
   动作优先走无障碍树（Windows UIAutomation / macOS AXUIElement）
   —— 拿得到控件就点控件（可靠），拿不到才退化为坐标点击(enigo)
   每步动作后再截屏验证 ──► 循环
```

### 6.2 安全分级

| 级别 | 定义 | 处置 |
|------|------|------|
| T0 | 只读（截屏、读文件、查状态） | 自动执行 |
| T1 | 可逆写（改文件、点普通按钮） | 自动执行 + 全程日志 |
| T2 | 破坏性/外发（删除、支付页、发消息给他人、shell 危险命令） | **弹执行审查窗，人工确认** |
| T3 | 禁区（密码管理器、银行类应用前台时） | 检测到即暂停整个任务 |

- **急停**：全局快捷键（默认 `Ctrl+Alt+Esc` / `⌃⌥Esc`）立即冻结键鼠注入；
- **审计**：动作日志 + 每步截屏存 `journal/`，30 天自动清理；
- **macOS 权限**：首次运行引导授予"屏幕录制"与"辅助功能"（OOBE 页面负责）。

### 6.3 执行审查窗

独立窗口：左侧实时截屏，右侧步骤流（动作 + 分级徽章 + 耗时），底部 暂停 / 接管 / 终止。T2 动作在此窗内联确认。

### 6.4 Windows AgentOS Recovery

第一个可变更动作前，Sidecar 通过 Rust Bridge 创建 detached transaction；成功时 `prepare → commit`，失败或终止时 `prepare → rollback`。commit 后仍保留恢复数据，任务页可人工恢复；Pattern 重启会关联最新 `detached:<task-id>` 并重建任务状态。Computer Use 由单一 FIFO 串行执行。中断事务只有在用户明确确认 scope 内没有其它写入后才能走 `recover --assume-exclusive`。

当前实现是声明 workspace scope 的用户态快照与条件式恢复，不会自动发现 scope 外副作用，也不覆盖网络、驱动、锁定系统对象或 WinRE。Windows 默认对已声明 workspace 的可变更动作要求 Recovery 可用，否则在 OS 动作前 fail closed；安全设置允许显式关闭。完整状态机、资源矩阵、存储布局、开源复用与 Minifilter/Registry/WFP/WinRE 路线见 [`docs/AGENTOS_RECOVERY.md`](docs/AGENTOS_RECOVERY.md)。

Runtime 为 baseline / after snapshot 生成 SHA-256 索引并锚定到 hash-chain journal；rollback 会先 staging 并校验全部 before-image，任何 snapshot、索引、journal 或 blob 损坏都在首次恢复写入前进入 `RecoveryRequired`。这些无密钥 hash 用于损坏检测，不抵抗能整体改写 store 的同权限进程。

---

## 7. 消息通道

### 7.1 首选：Pattern Mobile + WebDAV 中继（自有通道，无第三方依赖）

人不在电脑前时，靠**自己的手机 app** 而不是第三方 IM。Tauri 2 原生支持 iOS/Android——手机端复用同一套 Svelte UI，是一个**瘦客户端**：不跑 agent，只收发消息、看任务状态。设备间用任意 WebDAV 服务（坚果云 / Nextcloud / 自建）做中继，**发布-订阅-拉取**模型：

```
桌面主控（跑 agent runtime）                    手机 / 其他设备（瘦客户端）
      │ 发布：主动消息、回复、任务事件                │
      ▼                                            │
<webdav>/pattern/                                  │
├─ lock.json                 # 主控租约（心跳续期，防双主）│
├─ devices/<id>.json         # 设备注册 + 心跳       │
├─ mailbox/<msg-id>.json     # 消息信封（端到端加密）◄─┤ 轮询拉取 + 发布用户消息
├─ cursors/<device-id>.json  # 各设备已读游标         │
└─ state/agenda.json         # 轻状态：眼睛状态/任务进度│
```

- **消息信封**：`{id: ulid, from, role, type: chat|proactive|task, ts, body*, sig}`；ULID 自带时序，按 id 去重，各设备游标独立推进；主控负责压缩清理所有游标已过的旧消息。
- **端到端加密**：设备配对走桌面二维码（交换 X25519 密钥并以 XChaCha20-Poly1305 包装配对响应）；mailbox 信封 body 使用 AES-256-GCM——WebDAV 供应商只见密文。
- **轮询节奏**：手机前台 5–15s 自适应；后台受 OS 限制（Android 前台服务可近实时，iOS BGAppRefresh 分钟级，作为已知限制接受）。桌面主控 5s 拉 mailbox。
- **主控租约**：跑 agent 的桌面持有 `lock.json` 租约（TTL 心跳续期）；多台桌面时先到先得，租约过期自动接管。
- **本地 fallback**：WebDAV 不可达时，出站消息进本地 SQLite outbox 队列，指数退避重试；同一局域网内的设备后续可加 mDNS 直连（v2）。

手机端入站消息进事件总线，等同一次用户发言（带设备来源标记）——在外面也能远程下达任务、收她的主动消息。

### 7.2 可选：第三方通道（插件形态）

统一 `Channel` 适配器接口（`send / onMessage / capabilities`），默认不启用：

| 通道 | 方向 | 用途 |
|------|------|------|
| 系统通知 | 出站 | 本机轻提醒（内置，非插件） |
| Telegram Bot（grammY） | 双向 | 不想装手机 app 时的替代远程通道 |
| 邮件（SMTP/IMAP） | 双向 | 低频正式消息、日报 |
| QQ（OneBot/NapCat） | 双向 | 社区插件（协议灰色，风险自担） |

执行槽可代发消息，但**给"人"发的消息一律 T2 级需确认**，除非目标在用户预授权名单。

---

## 8. 模型层

`ModelRegistry` 按角色配置，互相独立：

```toml
[models.companion]   # 陪伴对话
provider = "anthropic"; model = "claude-sonnet-5"
[models.executor]    # 工具/computer use
provider = "anthropic"; model = "claude-sonnet-5"
[models.utility]     # 记忆提取、紧迫度分类、路由 —— 要便宜
provider = "openai-compatible"; model = "本地 llama.cpp / qwen"
[models.embedding]
provider = "local"; model = "bge-small-zh-v1.5"
```

**PLAA 挂载点（v2，可选）**：本地情感状态服务（复用 OnDeviceAI2/PLAA 的 S_t ∈ ℝ²⁵⁶）以 HTTP 暴露当前情感轨迹；对 API 模型映射为 prompt 中的状态描述行，对本地 Qwen 直接走门控注入。架构上只是 companion prompt 组装器的一个可选输入，不侵入主链路。

### 每轮上下文组装（陪伴槽）

```
persona 卡 + MEMORY-INDEX（全量）+ 检索记忆 top-K
+ 情感状态行（可选 PLAA）+ 环境行（时间/电量/前台应用*）
+ 近期对话窗口
```
\* 前台应用感知默认关闭，隐私开关显式打开才启用。

---

## 9. 数据与安全

```
<appdata>/pattern/
├─ config.toml          # 非敏感配置
├─ memory.db            # 记忆库
├─ sessions/            # 会话历史 (jsonl)
├─ journal/             # computer use 审计（截屏+动作）
├─ recovery/            # AgentOS manifests、snapshots、blobs 与 hash-chain journal
├─ personas/            # 人格卡 (md + frontmatter)
└─ logs/
```

- API key、bot token 一律存系统 keychain（Rust `keyring`），配置文件里只留引用名；
- sidecar WS 只绑 127.0.0.1，握手带一次性 token；
- 无遥测；所有数据本地，云端只有模型 API 调用本身。

---

## 10. 仓库结构（pnpm monorepo）

```
pattern/
├─ apps/
│  ├─ desktop/              # ✅ Svelte 5 UI + Tauri/Rust
│  │  ├─ src/
│  │  └─ src-tauri/         # 窗口/托盘/快捷键/HTTP OS Bridge/keyring
│  └─ mobile/               # ⚠️ Svelte/Tauri 瘦客户端 + Android 工程；iOS/真机验收待补
├─ packages/
│  ├─ core/                 # ✅ AgentCore 边界、规则路由与安全分级（实现仍轻量）
│  ├─ memory/               # ✅ schema / FTS 粗排 / 混合精排 / 提取钩子
│  ├─ proactive/            # ✅ 冲动、政策闸门、部分触发源
│  ├─ relay/                # ✅ 信封加密 / outbox / local+远程 list / 游标
│  ├─ channels/             # ✅ 公共接口 + Telegram/SMTP/IMAP 适配器
│  ├─ protocol/             # ✅ WS 与配置类型
│  └─ shared/               # ✅ 跨包时间、范围与错误工具
└─ sidecar/                 # ✅ Node 入口（esbuild）；build:binary 为 bun 实验轨
```

## 11. 窗口清单与交互

| 窗口 | 规格 | 行为 |
|------|------|------|
| 快捷窗 | 680×自适应，无边框、**始终置顶**、vibrancy | `Alt+Space`/`⌥Space` 唤起于活跃屏幕中上；**需手动关闭（Esc 或 ✕），失焦不消失**——可以一边干活一边把她留在手边；"失焦即隐"作为可选轻量模式（默认关）。支持追问、一键"转交执行" |
| 主窗 | 1120×760 起，自绘标题栏 | 左侧图标栏（对话/记忆/任务/通道/设置）+ 内容区；关闭到托盘 |
| 执行审查窗 | 960×640 | 任务开始自动弹出，可最小化为悬浮胶囊 |
| 托盘 | — | 状态眼（空闲/思考/执行/暂停），菜单：唤起、暂停主动性、急停、退出 |

UI 设计语言见 `docs/`（设计稿另出，现代深色优先、琥珀色点缀，win/mac 通用自绘标题栏，细节以设计稿为准）。

---

## 12. 里程碑

| 阶段 | 内容 | 验收 |
|------|------|------|
| **M0 骨架** | Tauri+sidecar+WS 链路、快捷窗、基础对话（pi 接 API 模型）、**人格定义向导（最小版）**、bun sidecar 打包验证 | 首启定义人格 → 热键唤起 → 流式回答 |
| **M1 记忆** | SQLite schema、两阶段检索、逐轮提取、MEMORY-INDEX、记忆浏览 UI | 跨会话记得上周说过的事 |
| **M2 主动性+中继** | 事件总线、cron/空闲/深夜触发、政策闸门、toast、WebDAV 中继（信封/加密/游标/outbox fallback） | 深夜催睡；消息可靠落到 WebDAV 并被第二台设备拉到 |
| **M3 Computer use** | OS Bridge 工具、执行人格、安全分级、执行审查窗、急停、AgentOS scoped recovery | "帮我把这批文件整理好"全程可视可停；成功后可恢复，失败时条件式回滚 |
| **M4 移动端** | Tauri Mobile 瘦客户端：收主动消息、远程对话、下达任务、看任务状态；设备配对（二维码交换密钥） | 出门在外能收到她的消息并回话 |
| **M5 打磨** | 多人格/双槽路由、PLAA 挂载点、自启动/托盘、OOBE 完整版（权限引导）、签名分发（mac 公证 + 手机端上架/侧载） | 可日常常驻使用 |

## 13. 已知风险

1. **pi 框架贴合度**——它为 coding agent 设计，长驻多人格调度可能要绕；`AgentCore` 接口就是为可替换预留的。
2. **bun 单二进制 + sqlite 扩展**（macOS）——M0 首要验证项，有 Node 退路。
3. **Computer use 成本/延迟**——每步一张截屏喂视觉模型；优先无障碍树可大幅省 token。
4. **移动端推送延迟**——WebDAV 轮询没有真推送：Android 前台服务可近实时，iOS 后台刷新是分钟级，急消息的送达时效受限（接受为 v1 已知限制；v2 可选自建极简推送网关）。
5. **WebDAV 供应商差异**——限速（坚果云按请求数）、最终一致性、时钟偏差影响租约判定；中继层要按"不可靠存储"设计，全部操作幂等。
6. **IM 通道合规**——QQ/微信无官方 API，只做可选插件；Telegram 作为不装手机 app 时的替代。
7. **全局快捷键冲突**——`Alt+Space` 在部分 Windows 输入法/PowerToys 下被占；现可选择三种组合并自动回退，但仍应在干净 Windows 用户账户中验收输入法和 PowerToys 共存行为。
8. **WebView CJK 输入法**——Tauri(wry) 大体正常，但快捷窗置顶层级与 IME 候选窗的遮挡关系需专项测试（可选的失焦即隐模式下更甚）。
9. **Recovery 覆盖错觉**——当前 AgentOS 只保护显式 scope；UI 点击可能在其它应用目录、注册表或云端产生副作用。UI 与文档必须持续展示 scope，不得把“运行时已连接”解释成“全系统可回滚”。
10. **内核与离线恢复发布风险**——Minifilter、Registry callback、WFP、WinRE、驱动签名和升级回退仍是独立的大型交付项；完成 HLK/兼容/断电测试前不能作为默认安全边界。
