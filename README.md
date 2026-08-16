# Pattern
---
**以下内容全部是ai胡扯的，可能是对的可能不是，请大家到手以后先看看项目现状**
---

Pattern 是一个基于 **Tauri 2 + Svelte 5 + Node sidecar** 的桌面 AI 伴随助手。

当前版本 **0.3.0** 覆盖：

| 里程碑 | 状态 | 说明 |
|--------|------|------|
| M0 骨架 | 完成 | OOBE、主窗/快捷窗、托盘、流式对话、keyring、自启动 |
| M1 记忆 | 完成* | SQLite + FTS 粗排 + 混合精排、MEMORY-INDEX、提取/固化、可选 BGE Small 本地向量 |
| M2 主动性 | 完成 | 深夜、空闲、电源/电量、cron、HTTP 健康检查、文件变化、去重、通知与日志 |
| M2 WebDAV 中继 | 完成* | 加密信封、outbox、local + 远程 PROPFIND、游标、同步状态、pull 脚本 |
| M3 Computer Use | 完成* | Windows UIA / macOS AX 优先 + 视觉坐标回退、逐步验证、T0–T3、审查/急停；Windows 工作区写操作接入 AgentOS 条件式恢复 |
| M5 桌面打磨 | 大部完成 | 双槽模型、规则+小模型路由、人格卡、PLAA、Telegram、SMTP/IMAP、文件感知、本地通道插件、可配置快捷键 |
| M4 移动端 | Android 可构建 | Tauri Mobile、WebDAV 对话/任务、X25519 安全配对、持久消息；Android debug APK 已验证，iOS 待 macOS |
| M6 Pattern Engine | 完成* | 记忆之上的派生认知层：Pattern/Evidence 表、candidate→active→weakening→contradicted→archived 生命周期、增量提取 + 结构化校验、可解释证据、凌晨固化 |
| M7 Presence 层 | 完成* | 形象/桌宠表达层：人格头像、透明置顶 Companion 窗、PresenceState、主动气泡、设置持久化；默认关闭需显式开启 |

## 开发与运行时要求

需要 **Node.js 22+**、pnpm、Rust 工具链。Pattern 的界面和 Agent 运行时是两个进程：Svelte/Vite 负责界面，Node sidecar 负责模型调用、记忆、主动消息和工具执行。运行时使用 `better-sqlite3` 存储记忆（FTS5），不再依赖 Node 实验性的 `node:sqlite`。

这一区分很重要：

- `pnpm dev` 只启动浏览器预览，不会启动 Node sidecar。打开 `http://127.0.0.1:1420/?demo=1` 时，底部显示「演示模式 · 不连接运行时」是预期状态；可以查看和操作界面，但不会调用模型或保存需要运行时的内容。
- `pnpm tauri dev` 启动完整桌面应用。Tauri 会通过 `beforeDevCommand` 自动构建并拉起 sidecar，底部应显示「运行时已连接」。
- 如果桌面端仍显示「运行时未连接」，先确认 `node --version` 为 22 或更高版本，再重新运行 `pnpm install` 和 `pnpm tauri dev`；也可以先手动执行 `pnpm sidecar:build`，确认 `sidecar/dist/index.cjs` 已生成。

```powershell
pnpm install
pnpm sidecar:build
pnpm dev
```

浏览器预览：`http://127.0.0.1:1420/`（`?demo=1` 跳过 OOBE，不写人格）。

桌面应用：

```powershell
pnpm tauri dev
```

Windows 开发时，Bridge 会从 `PATTERN_AGENTOS_EXE`、应用资源目录或同级 `Core/artifacts/win-x64/agentos.exe` 查找恢复运行时。Windows 发布包先执行：

```powershell
pnpm desktop:build:windows
```

该命令会发布并验证 AgentOS、核对 SHA-256，再通过 Windows Tauri 配置把 `agentos.exe` 打进资源目录。Computer Use 在第一个可变更动作前创建 detached transaction；成功后提交但保留恢复数据，失败或终止时自动回滚。任务页可以对已完成事务再次执行恢复。

Recovery store 会校验 baseline/after snapshot 索引、hash-chain journal 与 before-image blob；rollback 在首次范围写入前先 staging 并验证全部恢复源，证据损坏时 fail closed 为 `RecoveryRequired`。当前索引没有受保护密钥，不能视为对同权限本机攻击者的认证边界。

移动端 Web 开发预览：

```powershell
pnpm mobile:dev
pnpm mobile:check
```

Android 原生工程位于 `apps/mobile/src-tauri/gen/android`。Windows 下工作区含中文路径时须使用仓库脚本，它会把 Cargo 产物重定向到 ASCII 路径：

```powershell
pnpm mobile:android:build
```

Debug APK 输出到 `apps/mobile/src-tauri/gen/android/app/build/outputs/apk/universal/debug/`。

## 验证

```powershell
pnpm --dir sidecar test
pnpm check
pnpm build
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml real_agentos_committed_transaction_can_restore_workspace
pnpm test:ui
```

Sidecar 测试覆盖：

- 流式对话 WS
- 记忆 add/search/expire + FTS 中文粗排
- Pattern DB（建/改/归档/删除、支持/反对证据、置信度钳制、生命周期、合并、keyword 检索）
- Pattern 流水线（决策解析、边界钳制、畸形输出兜底、不安全标签拦截）
- Presence（配置归一化/持久化/损坏兜底、状态推导、气泡开关）
- 中继：local 游标去重、PROPFIND 解析、远程 list/pull
- e2e：记忆 / 主动 / 任务（无 Bridge 失败）/ local 中继加密 / 第二设备 pull
- 对话记忆注入 + 启发式提取（「我养了黑猫」）
- 浏览器 UI：OOBE、记忆/任务/通道配置、快捷键设置与桌面/移动端无障碍冒烟

## 使用速查

### 记忆（M1）
1. 正常聊天：说「我养了一只黄眼睛的黑猫」
2. 打开「记忆」页应能搜到；新对话提问「我养了什么」应能用到
3. 可手动添加/删除；「固化」触发衰减与容量整理

### Pattern / 长期认识（M6）
1. 多轮提到同一行为（如连续几天熬夜），系统自动沉淀具体记忆
2. 打开「认识」页查看 Pattern 的置信度、状态与证据
3. 问「你为什么觉得我…？」会返回可解释的原始记忆
4. 「固化 Pattern」手动触发候选升级/衰减/合并

### 形象与桌宠（M7）
1. 设置 → 常规 → 形象与桌宠：导入人格头像（PNG/JPG）
2. 「显示模式」选 头像（主窗口标题栏）或 桌宠（桌面常驻小窗）
3. 桌宠可拖动、单击开快捷窗、双击开主窗、右键菜单；默认关闭

### 主动性（M2）
1. 设置 → 主动性：打开深夜提醒、设定时间
2. 「立即试一次」可强制触发（验收用）
3. 托盘可暂停/恢复主动性
4. 日志在设置页「TA 今天为什么找我」
5. 服务健康检查可监视 HTTP URL；定时触发每行填写 `HH:MM | 提醒内容`

### WebDAV 中继（M2）
1. 通道页配置 WebDAV，或开发用 `local:C:\path\to\relay-root`
2. 主动消息会加密写入 `pattern/mailbox/*.json`
3. 密钥在 `%LOCALAPPDATA%\pattern\device.json` 的 `channelKey`
4. 拉取：

```powershell
node scripts/relay-pull.mjs --url <base> --user <u> --pass <p> --key <channelKey> --id <envelopeId>
```

本地目录后端无需账号密码，直接看 `relay-root/pattern/mailbox/`。

### Computer Use（M3）
1. 任务页创建任务；执行模型同时获取最新截屏与 Windows UI Automation 控件树
2. T2 弹出执行审查窗，可批准/拒绝/终止
3. 急停：`Ctrl+Alt+Esc` 或托盘「急停 Computer Use」
4. 截屏与动作日志在 `%LOCALAPPDATA%\pattern\journal\`
5. 无 Bridge 时任务明确失败，不会模拟成功；最多 20 步防止失控
6. macOS 首次执行前需在「系统设置 → 隐私与安全性」授予「辅助功能」与「屏幕录制」权限
7. Windows 使用 UI 自动化（UIA），通常无需单独开启“辅助功能”；若目标程序以管理员身份运行，Pattern 也需以管理员身份运行。视觉模式的屏幕捕获可在「设置 → 隐私和安全性 → 屏幕捕获」中管理；部分 Windows 版本默认允许且不显示该页。

### 文件感知
1. 设置 → 文件感知，每行填写一个允许监视的绝对目录
2. 可限制扩展名和单文件读取上限
3. 变化后先只发送路径元数据给 AI，判定有价值后才读取内容

### 人格、模型与通道

1. 设置 → 人格与角色：可切换已保存的人格卡；OOBE 可导入带 frontmatter 的 `.md` 人格卡
2. 设置 → 模型：陪伴槽与执行槽可使用不同模型和密钥；高置信度桌面操作请求会自动转到执行槽
3. 通道：Telegram Bot 双向；SMTP 负责出站，IMAP 轮询未读邮件并送入陪伴槽
4. 执行模型不支持图像时，关闭“执行模型支持图像”，Computer Use 将只使用 UIA/AX 控件树、键盘动作和回执
5. 设置 → 快捷键可选择 `Alt + Space`、`Ctrl + Alt + Space` 或 `Ctrl + Shift + Space`；若首选被占用，Pattern 会自动尝试其余组合并显示实际生效的快捷键

### 本地通道插件

将一个插件目录放到 `%LOCALAPPDATA%\pattern\plugins\<插件目录>\`，并提供 `pattern.channel.json`：

```json
{
  "id": "example.channel",
  "name": "Example Channel",
  "version": "1.0.0",
  "entry": "index.mjs",
  "description": "可选说明"
}
```

在“通道 → 配置远程消息”中启用它并填写非敏感 JSON 配置。入口必须导出 `createChannel({ id, config, dataDir, log })`，返回统一的 `Channel`（`send`、`onMessage`、`capabilities`）对象。插件仅在用户显式启用后才会导入；密钥应由插件自身写入系统凭据管理器，不能填入这段 JSON。

## 数据位置

`%LOCALAPPDATA%/pattern`

```
memory.db
personas/
sessions/
journal/          # 截屏与动作日志
recovery/         # AgentOS 事务、before-image、after-state 与哈希链日志
logs/proactive.jsonl
device.json       # deviceId + channelKey
relay-outbox.json
tasks.json
proactive.json
shortcuts.json
model.json
channel.json
plugins/          # 本地通道插件
cron-triggers.json
health-checks.json
file-watch.json
```

敏感信息：Windows Credential Manager（API Key、WebDAV 密码）。

## 仓库结构

```
apps/desktop/          # Svelte UI + Tauri/Rust
packages/protocol/     # WS 与配置类型
packages/memory/       # 记忆引擎
packages/proactive/    # 主动性引擎
packages/relay/        # WebDAV/local 中继
packages/channels/     # Channel 接口 + Telegram/SMTP 适配器
sidecar/               # Agent 运行时入口
scripts/relay-pull.mjs
```

## 边界（诚实版）

- Windows 优先使用 UIA Invoke/Value Pattern，macOS 优先使用 AXPress/AXValue；控件不可用时回退视觉坐标
- Windows 工作区内的 Computer Use 写操作由 AgentOS detached transaction 保护；默认在 Recovery 不可用时阻断该动作，可在安全设置显式关闭；当前仍是声明范围的用户态快照，不代表 Minifilter 级全系统捕获
- macOS AX 已完成代码适配，但签名、TCC 权限弹窗和 AppKit 行为仍需在 macOS 真机做最终验收
- 记忆检索：FTS5（CJK 扩展索引）粗排 + 混合精排；默认 embedding 为哈希近似向量，可配 API embedding / `provider=local`（transformers.js bge-small-zh）
- 无 sqlite-vec；大库性能依赖 FTS 候选集，而非向量 ANN

AgentOS 的状态机、资源覆盖、故障语义、开源复用决策与内核/WinRE 路线见 [`docs/AGENTOS_RECOVERY.md`](docs/AGENTOS_RECOVERY.md)。
- 开发版 sidecar 依赖本机 Node 22+；单文件打包暂缓（Bun compile 为实验脚本）
- WebDAV 中继：local 与远程 PROPFIND 列举 + 游标；手机先生成 X25519 请求，桌面以 XChaCha20-Poly1305 加密配对响应；mailbox 正文继续使用 AES-256-GCM
- Android 原生工程和 universal debug APK 已在 Windows + NDK 27 验证；iOS 工程与真机后台策略仍需 macOS/Xcode
- 签名与公证需要实际 Windows 代码签名证书 / Apple Developer 证书，当前仓库只能提供未签名构建
- Bun 单文件 sidecar 已提供 `pnpm sidecar:binary` 构建脚本；当前开发环境未安装 Bun，日常开发继续使用 Node sidecar
- Telegram 已双向实现；SMTP 出站与 IMAP 入站均已接入统一 Channel 适配器
- 第三方本地 Channel 插件支持 manifest 发现、显式启用、入站回复与主动消息外发；插件目录下的代码属于用户信任边界

## 架构文档

详见 `ARCHITECTURE.md`；各平台的已验证范围与发布前验收项见 [`docs/PLATFORM_VALIDATION.md`](docs/PLATFORM_VALIDATION.md)。
