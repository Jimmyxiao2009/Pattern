use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;

mod bridge;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersonaConfig {
    name: String,
    user_name: String,
    description: String,
    proactive: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SlotBindings {
    /// "shared" | "split"
    mode: String,
    companion_name: String,
    executor_name: String,
}

impl Default for SlotBindings {
    fn default() -> Self {
        Self {
            mode: "shared".into(),
            companion_name: String::new(),
            executor_name: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ModelConnection {
    id: String,
    #[serde(default)]
    name: String,
    provider: String,
    endpoint: String,
    #[serde(default = "default_true")]
    enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ModelConfig {
    provider: String,
    endpoint: String,
    model: String,
    #[serde(default)]
    connections: Vec<ModelConnection>,
    #[serde(default)]
    profile_id: String,
    #[serde(default)]
    agent_provider: String,
    #[serde(default)]
    agent_endpoint: String,
    #[serde(default)]
    agent_model: String,
    #[serde(default)]
    executor_provider: String,
    #[serde(default)]
    executor_endpoint: String,
    #[serde(default)]
    executor_model: String,
    #[serde(default = "default_true")]
    executor_vision: bool,
    #[serde(default)]
    local_embedding: bool,
    #[serde(default)]
    plaa_url: String,
}

fn default_true() -> bool { true }

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ChannelConfig {
    webdav_url: String,
    username: String,
    #[serde(default)]
    telegram_enabled: bool,
    #[serde(default)]
    telegram_chat_id: String,
    #[serde(default)]
    email_enabled: bool,
    #[serde(default)]
    email_host: String,
    #[serde(default)]
    email_port: u16,
    #[serde(default)]
    email_secure: bool,
    #[serde(default)]
    email_username: String,
    #[serde(default)]
    email_recipient: String,
    #[serde(default)]
    email_imap_enabled: bool,
    #[serde(default)]
    email_imap_host: String,
    #[serde(default)]
    email_imap_port: u16,
    #[serde(default)]
    email_imap_secure: bool,
    #[serde(default)]
    plugins: Vec<ChannelPluginConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChannelPluginConfig {
    id: String,
    enabled: bool,
    #[serde(default)]
    config: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChannelPluginInfo {
    id: String,
    name: String,
    version: String,
    description: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayPairingInfo {
    webdav_url: String,
    username: String,
    password: String,
    channel_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProactiveConfig {
    enabled: bool,
    #[serde(default)]
    paused: bool,
    bedtime_hour: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShortcutConfig {
    #[serde(default = "default_quick_shortcut")]
    quick_shortcut: String,
}

fn default_quick_shortcut() -> String { "alt-space".into() }

impl Default for ShortcutConfig {
    fn default() -> Self { Self { quick_shortcut: default_quick_shortcut() } }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShortcutStatus {
    quick_shortcut: String,
    active_quick_shortcut: String,
    fallback: bool,
}

impl Default for ProactiveConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            paused: false,
            bedtime_hour: 23,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RuntimeConnection {
    port: u16,
    token: String,
}

struct RuntimeState {
    connection: Mutex<Option<RuntimeConnection>>,
    child: Mutex<Option<Child>>,
    bridge: Mutex<Option<bridge::BridgeHandle>>,
    proactive_paused: Mutex<bool>,
    active_quick_shortcut: Mutex<String>,
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            connection: Mutex::new(None),
            child: Mutex::new(None),
            bridge: Mutex::new(None),
            proactive_paused: Mutex::new(false),
            active_quick_shortcut: Mutex::new(default_quick_shortcut()),
        }
    }
}

fn pattern_dir() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|dir| dir.join("pattern"))
        .ok_or_else(|| "无法定位本地应用数据目录".to_string())
}

fn ensure_pattern_dir() -> Result<PathBuf, String> {
    let dir = pattern_dir()?;
    fs::create_dir_all(dir.join("personas")).map_err(|error| error.to_string())?;
    fs::create_dir_all(dir.join("sessions")).map_err(|error| error.to_string())?;
    fs::create_dir_all(dir.join("journal")).map_err(|error| error.to_string())?;
    fs::create_dir_all(dir.join("logs")).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn read_proactive_config() -> Result<ProactiveConfig, String> {
    let file = ensure_pattern_dir()?.join("proactive.json");
    if !file.exists() {
        return Ok(ProactiveConfig::default());
    }
    serde_json::from_slice(&fs::read(file).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}

fn write_proactive_config(config: &ProactiveConfig) -> Result<(), String> {
    fs::write(
        ensure_pattern_dir()?.join("proactive.json"),
        serde_json::to_vec_pretty(config).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn read_shortcut_config() -> Result<ShortcutConfig, String> {
    let file = ensure_pattern_dir()?.join("shortcuts.json");
    if !file.exists() { return Ok(ShortcutConfig::default()); }
    let mut config: ShortcutConfig = serde_json::from_slice(&fs::read(file).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    if quick_shortcut(&config.quick_shortcut).is_none() { config.quick_shortcut = default_quick_shortcut(); }
    Ok(config)
}

fn write_shortcut_config(config: &ShortcutConfig) -> Result<(), String> {
    fs::write(
        ensure_pattern_dir()?.join("shortcuts.json"),
        serde_json::to_vec_pretty(config).map_err(|error| error.to_string())?,
    ).map_err(|error| error.to_string())
}

fn quick_shortcut(id: &str) -> Option<Shortcut> {
    match id {
        "alt-space" => Some(Shortcut::new(Some(Modifiers::ALT), Code::Space)),
        "ctrl-alt-space" => Some(Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space)),
        "ctrl-shift-space" => Some(Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space)),
        _ => None,
    }
}

fn quick_shortcut_matches(shortcut: &Shortcut, id: &str) -> bool {
    match id {
        "alt-space" => shortcut.matches(Modifiers::ALT, Code::Space),
        "ctrl-alt-space" => shortcut.matches(Modifiers::CONTROL | Modifiers::ALT, Code::Space),
        "ctrl-shift-space" => shortcut.matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::Space),
        _ => false,
    }
}

fn quick_shortcut_label(id: &str) -> &'static str {
    match id {
        "ctrl-alt-space" => "Ctrl+Alt+Space",
        "ctrl-shift-space" => "Ctrl+Shift+Space",
        _ => "Alt+Space",
    }
}

fn register_quick_shortcut(app: &AppHandle, state: &RuntimeState, preferred: &str) -> Result<ShortcutStatus, String> {
    let preferred = if quick_shortcut(preferred).is_some() { preferred } else { "alt-space" };
    let previous = state.active_quick_shortcut.lock().map_err(|_| "快捷键状态锁损坏".to_string())?.clone();
    if let Some(shortcut) = quick_shortcut(&previous) { let _ = app.global_shortcut().unregister(shortcut); }
    let mut candidates = vec![preferred];
    for fallback in ["alt-space", "ctrl-alt-space", "ctrl-shift-space"] {
        if fallback != preferred { candidates.push(fallback); }
    }
    for candidate in candidates {
        if let Some(shortcut) = quick_shortcut(candidate) {
            if app.global_shortcut().register(shortcut).is_ok() {
                *state.active_quick_shortcut.lock().map_err(|_| "快捷键状态锁损坏".to_string())? = candidate.into();
                return Ok(ShortcutStatus { quick_shortcut: preferred.into(), active_quick_shortcut: candidate.into(), fallback: candidate != preferred });
            }
        }
    }
    if let Some(shortcut) = quick_shortcut(&previous) {
        if app.global_shortcut().register(shortcut).is_ok() {
            *state.active_quick_shortcut.lock().map_err(|_| "快捷键状态锁损坏".to_string())? = previous.clone();
        }
    }
    Err("所选快捷键及所有回退组合均被占用，请从托盘菜单打开快捷窗。".into())
}

fn safe_file_name(name: &str) -> String {
    let value: String = name
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_'))
        .collect();
    if value.is_empty() {
        "persona".into()
    } else {
        value
    }
}

fn read_persona() -> Result<Option<PersonaConfig>, String> {
    let file = ensure_pattern_dir()?.join("active-persona.json");
    if !file.exists() {
        return Ok(None);
    }
    let bytes = fs::read(file).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| error.to_string())
}

fn parse_persona_card(content: &str) -> Option<PersonaConfig> {
    let mut name = String::new();
    let mut user_name = String::new();
    let mut proactive = "free".to_string();
    let mut description = content.to_string();
    if let Some(rest) = content.strip_prefix("---\n") {
        if let Some((frontmatter, body)) = rest.split_once("\n---\n") {
            description = body.trim().to_string();
            for line in frontmatter.lines() {
                if let Some((key, value)) = line.split_once(':') {
                    match key.trim() {
                        "name" => name = value.trim().to_string(),
                        "user_name" => user_name = value.trim().to_string(),
                        "proactive" => proactive = value.trim().to_string(),
                        _ => {}
                    }
                }
            }
        }
    }
    if name.is_empty() { None } else { Some(PersonaConfig { name, user_name, description, proactive }) }
}

fn list_persona_cards() -> Result<Vec<PersonaConfig>, String> {
    let mut cards = Vec::new();
    for entry in fs::read_dir(ensure_pattern_dir()?.join("personas")).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("md") { continue; }
        if let Ok(content) = fs::read_to_string(path) {
            if let Some(card) = parse_persona_card(&content) { cards.push(card); }
        }
    }
    cards.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(cards)
}


fn read_slot_bindings() -> Result<SlotBindings, String> {
    let file = ensure_pattern_dir()?.join("slot-bindings.json");
    if !file.exists() {
        if let Some(persona) = read_persona()? {
            return Ok(SlotBindings {
                mode: "shared".into(),
                companion_name: persona.name.clone(),
                executor_name: persona.name,
            });
        }
        return Ok(SlotBindings::default());
    }
    serde_json::from_slice(&fs::read(file).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}

fn write_slot_bindings(bindings: &SlotBindings) -> Result<(), String> {
    fs::write(
        ensure_pattern_dir()?.join("slot-bindings.json"),
        serde_json::to_vec_pretty(bindings).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn find_persona_by_name(name: &str) -> Result<Option<PersonaConfig>, String> {
    if name.trim().is_empty() {
        return Ok(None);
    }
    Ok(list_persona_cards()?
        .into_iter()
        .find(|card| card.name == name)
        .or_else(|| {
            read_persona()
                .ok()
                .flatten()
                .filter(|card| card.name == name)
        }))
}

fn read_model_config() -> Result<Option<ModelConfig>, String> {
    let file = ensure_pattern_dir()?.join("model.json");
    if !file.exists() {
        return Ok(None);
    }
    let bytes = fs::read(file).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| error.to_string())
}

fn read_channel_config() -> Result<Option<ChannelConfig>, String> {
    let file = ensure_pattern_dir()?.join("channel.json");
    if !file.exists() {
        return Ok(None);
    }
    let bytes = fs::read(file).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| error.to_string())
}

fn valid_plugin_id(id: &str) -> bool {
    let mut chars = id.chars();
    matches!(chars.next(), Some(first) if first.is_ascii_lowercase() || first.is_ascii_digit())
        && id.len() <= 64
        && chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '.' | '_' | '-'))
}

fn list_channel_plugins_inner() -> Result<Vec<ChannelPluginInfo>, String> {
    let root = ensure_pattern_dir()?.join("plugins");
    if !root.exists() { return Ok(Vec::new()); }
    let mut plugins = Vec::new();
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if !path.is_dir() { continue; }
        let manifest = path.join("pattern.channel.json");
        if !manifest.exists() { continue; }
        let value: serde_json::Value = match serde_json::from_slice(&fs::read(manifest).map_err(|error| error.to_string())?) { Ok(value) => value, Err(_) => continue };
        let id = value.get("id").and_then(|item| item.as_str()).unwrap_or_default();
        let name = value.get("name").and_then(|item| item.as_str()).unwrap_or_default();
        let version = value.get("version").and_then(|item| item.as_str()).unwrap_or_default();
        if !valid_plugin_id(id) || name.trim().is_empty() || version.trim().is_empty() { continue; }
        plugins.push(ChannelPluginInfo {
            id: id.to_string(), name: name.trim().to_string(), version: version.trim().to_string(),
            description: value.get("description").and_then(|item| item.as_str()).unwrap_or_default().trim().to_string(),
        });
    }
    plugins.sort_by(|a, b| a.name.cmp(&b.name));
    plugins.dedup_by(|a, b| a.id == b.id);
    Ok(plugins)
}

fn configure_runtime(state: &RuntimeState) -> Result<(), String> {
    let model = read_model_config()?.unwrap_or_default();
    let persona = read_persona()?;
    let mut slots = read_slot_bindings().unwrap_or_default();
    if slots.companion_name.is_empty() {
        if let Some(p) = persona.as_ref() {
            slots.companion_name = p.name.clone();
            if slots.executor_name.is_empty() {
                slots.executor_name = p.name.clone();
            }
        }
    }
    let companion = find_persona_by_name(&slots.companion_name)?
        .or_else(|| persona.clone())
        .unwrap_or(PersonaConfig {
            name: "Pattern".into(),
            user_name: String::new(),
            description: "你是 Pattern，一个由用户定义人格的桌面伴随助手。".into(),
            proactive: "free".into(),
        });
    let executor_persona = if slots.mode == "split" {
        find_persona_by_name(&slots.executor_name)?.unwrap_or_else(|| companion.clone())
    } else {
        companion.clone()
    };
    let persona_desc = companion.description.clone();
    let persona_name = companion.name.clone();
    let user_name = companion.user_name.clone();
    let profile_key = if model.profile_id.trim().is_empty() { "companion-api-key".to_string() } else { format!("companion-api-key-{}", model.profile_id) };
    let executor_profile_key = if model.profile_id.trim().is_empty() { "executor-api-key".to_string() } else { format!("executor-api-key-{}", model.profile_id) };
    let agent_profile_key = if model.profile_id.trim().is_empty() { "agent-api-key".to_string() } else { format!("agent-api-key-{}", model.profile_id) };
    let api_key = keyring::Entry::new("app.pattern.desktop", &profile_key)
        .map_err(|error| error.to_string())?
        .get_password()
        .unwrap_or_default();
    let executor_api_key = keyring::Entry::new("app.pattern.desktop", &executor_profile_key)
        .map_err(|error| error.to_string())?
        .get_password()
        .unwrap_or_default();
    let agent_api_key = keyring::Entry::new("app.pattern.desktop", &agent_profile_key)
        .map_err(|error| error.to_string())?
        .get_password()
        .unwrap_or_default();
    let proactive = read_proactive_config().unwrap_or_default();
    let paused = *state
        .proactive_paused
        .lock()
        .map_err(|_| "运行时状态锁损坏".to_string())?;
    let channel = read_channel_config()?.unwrap_or_default();
    let webdav_password = keyring::Entry::new("app.pattern.desktop", "webdav-password")
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .unwrap_or_default();
    let telegram_token = keyring::Entry::new("app.pattern.desktop", "telegram-bot-token")
        .ok().and_then(|entry| entry.get_password().ok()).unwrap_or_default();
    let email_password = keyring::Entry::new("app.pattern.desktop", "smtp-password")
        .ok().and_then(|entry| entry.get_password().ok()).unwrap_or_default();
    let bridge = state
        .bridge
        .lock()
        .map_err(|_| "运行时状态锁损坏".to_string())?
        .clone();
    let model_connections = if model.connections.is_empty() {
        vec![ModelConnection {
            id: "active".into(),
            name: model.provider.clone(),
            provider: model.provider.clone(),
            endpoint: model.endpoint.clone(),
            enabled: true,
        }]
    } else {
        model.connections.clone()
    };
    let mut params = serde_json::json!({
        "provider": model.provider,
        "endpoint": model.endpoint,
        "model": model.model,
        "modelConnections": model_connections,
        "apiKey": api_key,
        "persona": persona_desc,
        "personaName": persona_name,
        "userName": user_name,
        "slots": {
            "mode": slots.mode,
            "companionName": slots.companion_name,
            "executorName": slots.executor_name
        },
        "executorPersona": {
            "name": executor_persona.name,
            "description": executor_persona.description,
            "userName": executor_persona.user_name
        },
        "proactive": {
            "enabled": proactive.enabled,
            "paused": paused || proactive.paused,
            "bedtimeHour": proactive.bedtime_hour
        },
        "dataDir": ensure_pattern_dir()?.to_string_lossy(),
    });
    if !model.plaa_url.is_empty() {
        params["plaa"] = serde_json::json!({"url":model.plaa_url});
    }
    if !channel.webdav_url.is_empty() {
        params["webdav"] = serde_json::json!({
            "url": channel.webdav_url,
            "username": channel.username,
            "password": webdav_password
        });
    }
    if channel.telegram_enabled && !channel.telegram_chat_id.is_empty() {
        params["telegram"] = serde_json::json!({"enabled":true,"chatId":channel.telegram_chat_id,"token":telegram_token});
    }
    if channel.email_enabled && !channel.email_host.is_empty() && !channel.email_recipient.is_empty() {
        params["email"] = serde_json::json!({"enabled":true,"host":channel.email_host,"port":if channel.email_port == 0 { 587 } else { channel.email_port },"secure":channel.email_secure,"username":channel.email_username,"recipient":channel.email_recipient,"password":email_password,"imapEnabled":channel.email_imap_enabled,"imapHost":channel.email_imap_host,"imapPort":if channel.email_imap_port == 0 { 993 } else { channel.email_imap_port },"imapSecure":channel.email_imap_secure});
    }
    if !channel.plugins.is_empty() {
        params["plugins"] = serde_json::to_value(&channel.plugins).map_err(|error| error.to_string())?;
    }
    if !model.executor_model.is_empty() {
        params["executor"] = serde_json::json!({
            "provider": if model.executor_provider.is_empty() { &model.provider } else { &model.executor_provider },
            "endpoint": if model.executor_endpoint.is_empty() { &model.endpoint } else { &model.executor_endpoint },
            "model": model.executor_model,
            "apiKey": executor_api_key
            ,"vision": model.executor_vision
        });
    }
    if !model.agent_model.is_empty() {
        params["agent"] = serde_json::json!({
            "provider": if model.agent_provider.is_empty() { &model.provider } else { &model.agent_provider },
            "endpoint": if model.agent_endpoint.is_empty() { &model.endpoint } else { &model.agent_endpoint },
            "model": model.agent_model,
            "apiKey": agent_api_key
        });
    }
    if model.local_embedding {
        params["embedding"] = serde_json::json!({"provider":"local","model":"bge-small-zh-v1.5"});
    }
    if let Some(bridge) = bridge {
        params["bridgeUrl"] = serde_json::json!(bridge.url);
        params["bridgeToken"] = serde_json::json!(bridge.token);
    }
    let message = serde_json::json!({
        "method": "runtime.configure",
        "params": params
    });
    let mut guard = state
        .child
        .lock()
        .map_err(|_| "运行时状态锁损坏".to_string())?;
    if let Some(stdin) = guard.as_mut().and_then(|child| child.stdin.as_mut()) {
        writeln!(stdin, "{message}").map_err(|error| error.to_string())?;
        stdin.flush().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn start_runtime(state: &RuntimeState) -> Result<(), String> {
    if let Ok(mut guard) = state.child.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
        }
    }
    if let Ok(mut guard) = state.connection.lock() {
        *guard = None;
    }
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../sidecar/dist/index.cjs");
    let binary_name = if cfg!(windows) { "pattern-sidecar.exe" } else { "pattern-sidecar" };
    let dev_binary = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../sidecar/dist").join(binary_name);
    let bundled_binary = std::env::current_exe().ok().and_then(|exe| exe.parent().map(|dir| dir.join("resources").join(binary_name)));
    let configured_binary = std::env::var_os("PATTERN_SIDECAR_PATH").map(PathBuf::from);
    let binary = configured_binary
        .filter(|path| path.exists())
        .or_else(|| dev_binary.exists().then_some(dev_binary))
        .or_else(|| bundled_binary.filter(|path| path.exists()));
    let mut command = if let Some(binary) = binary {
        Command::new(binary)
    } else {
        if !script.exists() {
            return Err(format!("找不到 sidecar 构建产物：{}", script.display()));
        }
        let mut command = Command::new("node");
        command.arg(script);
        command
    };
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("无法启动 sidecar：{error}"))?;
    let stdout = child.stdout.take().ok_or("无法读取 sidecar stdout")?;
    let mut line = String::new();
    BufReader::new(stdout)
        .read_line(&mut line)
        .map_err(|error| error.to_string())?;
    let connection: RuntimeConnection =
        serde_json::from_str(line.trim()).map_err(|error| format!("sidecar 握手失败：{error}"))?;
    *state
        .connection
        .lock()
        .map_err(|_| "运行时状态锁损坏")? = Some(connection);
    *state.child.lock().map_err(|_| "运行时状态锁损坏")? = Some(child);
    configure_runtime(state)
}

fn write_stdin(state: &RuntimeState, message: serde_json::Value) -> Result<(), String> {
    let mut guard = state
        .child
        .lock()
        .map_err(|_| "运行时状态锁损坏".to_string())?;
    if let Some(stdin) = guard.as_mut().and_then(|child| child.stdin.as_mut()) {
        writeln!(stdin, "{message}").map_err(|error| error.to_string())?;
        stdin.flush().map_err(|error| error.to_string())?;
    }
    Ok(())
}


#[tauri::command]
fn get_foreground_window() -> serde_json::Value {
    // Reuse OS bridge helper via a small inline probe on Windows/macOS.
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW};
        unsafe {
            let hwnd = GetForegroundWindow();
            let len = GetWindowTextLengthW(hwnd);
            let mut buf = vec![0u16; (len + 1).max(1) as usize];
            let read = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
            return serde_json::json!({"title": String::from_utf16_lossy(&buf[..read.max(0) as usize])});
        }
    }
    #[cfg(target_os = "macos")]
    {
        return serde_json::json!({"title": ""});
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        serde_json::json!({"title": ""})
    }
}

#[tauri::command]
fn runtime_status(state: State<'_, RuntimeState>) -> serde_json::Value {
    let connected = state
        .connection
        .lock()
        .map(|value| value.is_some())
        .unwrap_or(false);
    let frozen = state
        .bridge
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|b| b.is_frozen()))
        .unwrap_or(false);
    serde_json::json!({
        "sidecar": if connected { "connected" } else { "disconnected" },
        "memory": "ready",
        "computerUseFrozen": frozen,
        "version": env!("CARGO_PKG_VERSION")
    })
}

#[tauri::command]
fn runtime_connection(state: State<'_, RuntimeState>) -> Option<RuntimeConnection> {
    let existing = state
        .connection
        .lock()
        .ok()
        .and_then(|value| value.clone());
    if existing.is_some() {
        return existing;
    }
    // Attempt a one-shot restart so the frontend can recover after sidecar death.
    if let Err(error) = start_runtime(&state) {
        eprintln!("[pattern] runtime restart failed: {error}");
        return None;
    }
    state
        .connection
        .lock()
        .ok()
        .and_then(|value| value.clone())
}

#[tauri::command]
fn save_persona(persona: PersonaConfig, state: State<'_, RuntimeState>) -> Result<(), String> {
    let dir = ensure_pattern_dir()?;
    let body = format!(
        "---\nname: {}\nuser_name: {}\nproactive: {}\n---\n\n{}\n",
        persona.name, persona.user_name, persona.proactive, persona.description
    );
    let file = dir
        .join("personas")
        .join(format!("{}.md", safe_file_name(&persona.name)));
    fs::write(file, body).map_err(|error| error.to_string())?;
    fs::write(
        dir.join("active-persona.json"),
        serde_json::to_vec_pretty(&persona).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    // Keep proactive preference aligned with the active persona.
    let mut proactive = read_proactive_config().unwrap_or_default();
    proactive.enabled = persona.proactive == "free";
    write_proactive_config(&proactive)?;
    let mut slots = read_slot_bindings().unwrap_or_default();
    if slots.mode != "split" {
        slots.mode = "shared".into();
        slots.companion_name = persona.name.clone();
        slots.executor_name = persona.name.clone();
        write_slot_bindings(&slots)?;
    } else if slots.companion_name.is_empty() {
        slots.companion_name = persona.name.clone();
        write_slot_bindings(&slots)?;
    }
    configure_runtime(&state)
}

#[tauri::command]
fn load_persona() -> Result<Option<PersonaConfig>, String> {
    read_persona()
}

#[tauri::command]
fn list_personas() -> Result<Vec<PersonaConfig>, String> {
    list_persona_cards()
}

#[tauri::command]
fn activate_persona(persona: PersonaConfig, state: State<'_, RuntimeState>) -> Result<(), String> {
    save_persona(persona, state)
}

#[tauri::command]
fn save_model_config(
    config: ModelConfig,
    api_key: Option<String>,
    executor_api_key: Option<String>,
    agent_api_key: Option<String>,
    state: State<'_, RuntimeState>,
) -> Result<(), String> {
    let dir = ensure_pattern_dir()?;
    fs::write(
        dir.join("model.json"),
        serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    if let Some(key) = api_key.filter(|key| !key.trim().is_empty()) {
        let account = if config.profile_id.trim().is_empty() { "companion-api-key".to_string() } else { format!("companion-api-key-{}", config.profile_id) };
        keyring::Entry::new("app.pattern.desktop", &account)
            .map_err(|error| error.to_string())?
            .set_password(&key)
            .map_err(|error| error.to_string())?;
    }
    if let Some(key) = executor_api_key.filter(|key| !key.trim().is_empty()) {
        let account = if config.profile_id.trim().is_empty() { "executor-api-key".to_string() } else { format!("executor-api-key-{}", config.profile_id) };
        keyring::Entry::new("app.pattern.desktop", &account)
            .map_err(|error| error.to_string())?
            .set_password(&key)
            .map_err(|error| error.to_string())?;
    }
    if let Some(key) = agent_api_key.filter(|key| !key.trim().is_empty()) {
        let account = if config.profile_id.trim().is_empty() { "agent-api-key".to_string() } else { format!("agent-api-key-{}", config.profile_id) };
        keyring::Entry::new("app.pattern.desktop", &account)
            .map_err(|error| error.to_string())?
            .set_password(&key)
            .map_err(|error| error.to_string())?;
    }
    configure_runtime(&state)
}

#[tauri::command]
fn load_model_config() -> Result<Option<ModelConfig>, String> {
    read_model_config()
}

#[derive(serde::Serialize)]
struct FileNodeDto {
    name: String,
    path: String,
    kind: String,
    children: Option<Vec<FileNodeDto>>,
}

fn list_directory_recursive(path: &std::path::Path, depth: u32) -> Result<Vec<FileNodeDto>, String> {
    if depth == 0 {
        return Ok(Vec::new());
    }
    let mut entries = fs::read_dir(path)
        .map_err(|error| format!("无法读取目录 {}: {error}", path.display()))?
        .filter_map(|entry| entry.ok())
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| {
        let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        (!is_dir, entry.file_name().to_string_lossy().to_lowercase())
    });

    let mut nodes = Vec::new();
    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" || name == "target" || name == "dist" {
            continue;
        }
        let full = entry.path();
        let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        let children = if is_dir && depth > 1 {
            Some(list_directory_recursive(&full, depth - 1)?)
        } else {
            None
        };
        nodes.push(FileNodeDto {
            name,
            path: full.to_string_lossy().to_string(),
            kind: if is_dir {
                "directory".to_string()
            } else {
                "file".to_string()
            },
            children,
        });
    }
    Ok(nodes)
}

#[tauri::command]
fn list_directory(path: String, depth: Option<u32>) -> Result<Vec<FileNodeDto>, String> {
    let root = std::path::PathBuf::from(path.trim());
    if !root.exists() {
        return Err(format!("路径不存在: {}", root.display()));
    }
    if !root.is_dir() {
        return Err(format!("不是目录: {}", root.display()));
    }
    list_directory_recursive(&root, depth.unwrap_or(2).clamp(1, 4))
}


#[tauri::command]
fn read_text_file(path: String, max_bytes: Option<u64>) -> Result<String, String> {
    let file = std::path::PathBuf::from(path.trim());
    if !file.exists() {
        return Err(format!("文件不存在: {}", file.display()));
    }
    if !file.is_file() {
        return Err(format!("不是文件: {}", file.display()));
    }
    let limit = max_bytes.unwrap_or(120_000).clamp(1_024, 512_000) as usize;
    let bytes = fs::read(&file).map_err(|error| error.to_string())?;
    if bytes.len() > limit {
        let slice = String::from_utf8_lossy(&bytes[..limit]);
        return Ok(format!("{slice}

…(截断，原文件 {} 字节)", bytes.len()));
    }
    String::from_utf8(bytes).map_err(|error| format!("不是 UTF-8 文本: {error}"))
}


#[tauri::command]
fn pick_directory() -> Result<Option<String>, String> {
    let folder = rfd::FileDialog::new()
        .set_title("选择项目文件夹")
        .pick_folder();
    Ok(folder.map(|path| path.to_string_lossy().to_string()))
}

#[tauri::command]
fn save_session(messages: serde_json::Value) -> Result<(), String> {
    let file = ensure_pattern_dir()?.join("sessions").join("current.json");
    fs::write(
        file,
        serde_json::to_vec_pretty(&messages).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn load_session() -> Result<Option<serde_json::Value>, String> {
    let file = ensure_pattern_dir()?.join("sessions").join("current.json");
    if !file.exists() {
        return Ok(None);
    }
    let bytes = fs::read(file).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn save_tasks(tasks: serde_json::Value) -> Result<(), String> {
    let file = ensure_pattern_dir()?.join("tasks.json");
    fs::write(
        file,
        serde_json::to_vec_pretty(&tasks).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn load_tasks() -> Result<Option<serde_json::Value>, String> {
    let file = ensure_pattern_dir()?.join("tasks.json");
    if !file.exists() {
        return Ok(None);
    }
    let bytes = fs::read(file).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn save_channel_config(config: ChannelConfig, password: Option<String>, telegram_token: Option<String>, smtp_password: Option<String>, state: State<'_, RuntimeState>) -> Result<(), String> {
    let file = ensure_pattern_dir()?.join("channel.json");
    fs::write(
        file,
        serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    if let Some(value) = password.filter(|value| !value.is_empty()) {
        keyring::Entry::new("app.pattern.desktop", "webdav-password")
            .map_err(|error| error.to_string())?
            .set_password(&value)
            .map_err(|error| error.to_string())?;
    }
    if let Some(value) = telegram_token.filter(|value| !value.is_empty()) {
        keyring::Entry::new("app.pattern.desktop", "telegram-bot-token")
            .map_err(|error| error.to_string())?
            .set_password(&value)
            .map_err(|error| error.to_string())?;
    }
    if let Some(value) = smtp_password.filter(|value| !value.is_empty()) {
        keyring::Entry::new("app.pattern.desktop", "smtp-password")
            .map_err(|error| error.to_string())?
            .set_password(&value)
            .map_err(|error| error.to_string())?;
    }
    configure_runtime(&state)
}

#[tauri::command]
fn load_channel_config() -> Result<Option<ChannelConfig>, String> {
    read_channel_config()
}

#[tauri::command]
fn list_channel_plugins() -> Result<Vec<ChannelPluginInfo>, String> {
    list_channel_plugins_inner()
}

#[tauri::command]
fn relay_pairing_info() -> Result<RelayPairingInfo, String> {
    let channel = read_channel_config()?.ok_or_else(|| "请先配置 WebDAV 中继".to_string())?;
    if channel.webdav_url.is_empty() { return Err("请先配置 WebDAV 中继".into()); }
    let device_file = ensure_pattern_dir()?.join("device.json");
    let device: serde_json::Value = serde_json::from_slice(&fs::read(device_file).map_err(|_| "运行时未就绪，请稍后再试".to_string())?)
        .map_err(|error| error.to_string())?;
    let channel_key = device.get("channelKey").and_then(|value| value.as_str()).unwrap_or_default().to_string();
    if channel_key.is_empty() { return Err("中继密钥不可用，请重启 Pattern".into()); }
    let password = keyring::Entry::new("app.pattern.desktop", "webdav-password")
        .ok().and_then(|entry| entry.get_password().ok()).unwrap_or_default();
    Ok(RelayPairingInfo { webdav_url: channel.webdav_url, username: channel.username, password, channel_key })
}

#[tauri::command]
fn save_proactive_config(config: ProactiveConfig, state: State<'_, RuntimeState>) -> Result<(), String> {
    write_proactive_config(&ProactiveConfig {
        bedtime_hour: config.bedtime_hour.min(23),
        ..config
    })?;
    *state
        .proactive_paused
        .lock()
        .map_err(|_| "运行时状态锁损坏".to_string())? = config.paused;
    let _ = write_stdin(
        &state,
        serde_json::json!({"method":"proactive.setPaused","params":{"paused": config.paused}}),
    );
    configure_runtime(&state)
}

#[tauri::command]
fn load_proactive_config() -> Result<ProactiveConfig, String> {
    read_proactive_config()
}

#[tauri::command]
fn load_shortcut_config(state: State<'_, RuntimeState>) -> Result<ShortcutStatus, String> {
    let config = read_shortcut_config()?;
    let active = state.active_quick_shortcut.lock().map_err(|_| "快捷键状态锁损坏".to_string())?.clone();
    Ok(ShortcutStatus { fallback: config.quick_shortcut != active, quick_shortcut: config.quick_shortcut, active_quick_shortcut: active })
}

#[tauri::command]
fn save_shortcut_config(config: ShortcutConfig, state: State<'_, RuntimeState>, app: AppHandle) -> Result<ShortcutStatus, String> {
    if quick_shortcut(&config.quick_shortcut).is_none() { return Err("不支持的快捷键组合".into()); }
    let status = register_quick_shortcut(&app, &state, &config.quick_shortcut)?;
    write_shortcut_config(&config)?;
    Ok(status)
}

fn set_proactive_paused_inner(state: &RuntimeState, paused: bool) -> Result<(), String> {
    *state
        .proactive_paused
        .lock()
        .map_err(|_| "运行时状态锁损坏".to_string())? = paused;
    let mut config = read_proactive_config().unwrap_or_default();
    config.paused = paused;
    write_proactive_config(&config)?;
    write_stdin(
        state,
        serde_json::json!({"method":"proactive.setPaused","params":{"paused": paused}}),
    )?;
    Ok(())
}

#[tauri::command]
fn set_proactive_paused(paused: bool, state: State<'_, RuntimeState>) -> Result<(), String> {
    set_proactive_paused_inner(&state, paused)
}

fn emergency_stop_inner(state: &RuntimeState) -> Result<(), String> {
    if let Ok(guard) = state.bridge.lock() {
        if let Some(bridge) = guard.as_ref() {
            bridge.set_frozen(true);
        }
    }
    Ok(())
}

#[tauri::command]
fn emergency_stop(state: State<'_, RuntimeState>) -> Result<(), String> {
    emergency_stop_inner(&state)
}

#[tauri::command]
fn resume_computer_use(state: State<'_, RuntimeState>) -> Result<(), String> {
    if let Ok(guard) = state.bridge.lock() {
        if let Some(bridge) = guard.as_ref() {
            bridge.set_frozen(false);
        }
    }
    Ok(())
}


#[tauri::command]
fn load_slot_bindings() -> Result<SlotBindings, String> {
    read_slot_bindings()
}

#[tauri::command]
fn save_slot_bindings(bindings: SlotBindings, state: State<'_, RuntimeState>) -> Result<(), String> {
    let mut next = bindings;
    if next.mode != "split" {
        next.mode = "shared".into();
        if next.companion_name.is_empty() {
            if let Some(persona) = read_persona()? {
                next.companion_name = persona.name.clone();
            }
        }
        next.executor_name = next.companion_name.clone();
    } else if next.companion_name.is_empty() || next.executor_name.is_empty() {
        return Err("拆分槽位时需要同时指定陪伴人格与执行人格".into());
    }
    write_slot_bindings(&next)?;
    configure_runtime(&state)
}

#[tauri::command]
fn set_tray_state(app: AppHandle, state: String) -> Result<(), String> {
    let label = match state.as_str() {
        "thinking" => "思考中",
        "executing" => "执行中",
        "paused" => "已暂停",
        "approval" => "等待确认",
        _ => "空闲",
    };
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(format!("Pattern · {label}")));
    }
    Ok(())
}

#[tauri::command]
fn show_main(app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("主窗口不存在")?;
    window.show().map_err(|error| error.to_string())?;
    let _ = window.unminimize();
    window.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
fn show_review(app: AppHandle, task_id: Option<String>) -> Result<(), String> {
    let url = if let Some(id) = task_id.filter(|value| !value.is_empty()) {
        format!("index.html?window=review&taskId={id}")
    } else {
        "index.html?window=review".into()
    };
    if let Some(window) = app.get_webview_window("review") {
        // Recreate URL is hard on existing webview; still show and focus. Frontend also listens to task updates.
        let _ = window.eval(&format!("window.__patternFocusTaskId = {};", serde_json::to_string(&url).unwrap_or_else(|_| "null".into())));
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, "review", WebviewUrl::App(url.into()))
        .title("Pattern 执行审查")
        .inner_size(960.0, 640.0)
        .decorations(false)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn toggle_quick(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("quick") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.center();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

#[tauri::command]
fn show_quick(app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("quick").ok_or_else(|| "快捷窗尚未初始化".to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.unminimize().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn permission_status() -> serde_json::Value {
    #[cfg(target_os = "macos")]
    {
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" { fn CGPreflightScreenCaptureAccess() -> bool; }
        let accessibility = unsafe { accessibility_sys::AXIsProcessTrusted() };
        let screen_recording = unsafe { CGPreflightScreenCaptureAccess() };
        return serde_json::json!({"platform":"macos","notifications":true,"accessibility":accessibility,"screenRecording":screen_recording});
    }
    #[cfg(windows)]
    return serde_json::json!({"platform":"windows","notifications":true,"accessibility":true,"screenRecording":true});
    #[cfg(all(not(target_os = "macos"), not(windows)))]
    serde_json::json!({"platform":"other","notifications":true,"accessibility":true,"screenRecording":true})
}

#[tauri::command]
fn open_permission_settings(kind: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let pane = if kind == "screen" { "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture" } else if kind == "notifications" { "x-apple.systempreferences:com.apple.preference.notifications" } else { "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" };
        std::process::Command::new("open").arg(pane).spawn().map_err(|error| error.to_string())?;
    }
    #[cfg(windows)]
    {
        let page = if kind == "notifications" { "ms-settings:notifications" } else if kind == "screen" { "ms-settings:privacy-screenrecording" } else { "ms-settings:privacy" };
        std::process::Command::new("explorer.exe").arg(page).spawn().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(RuntimeState::default())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let active_quick = app.state::<RuntimeState>().active_quick_shortcut
                        .lock().map(|value| value.clone()).unwrap_or_else(|_| default_quick_shortcut());
                    let emergency =
                        shortcut.matches(Modifiers::CONTROL | Modifiers::ALT, Code::Escape);
                    if emergency {
                        let state = app.state::<RuntimeState>();
                        if let Ok(guard) = state.bridge.lock() {
                            if let Some(bridge) = guard.as_ref() {
                                bridge.set_frozen(true);
                            }
                        }
                        let _ = app
                            .notification()
                            .builder()
                            .title("Pattern")
                            .body("Computer Use 已急停")
                            .show();
                        return;
                    }
                    if quick_shortcut_matches(shortcut, &active_quick) {
                        toggle_quick(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let notify_cb: Arc<Mutex<Option<Box<dyn Fn(String, String) + Send>>>> =
                Arc::new(Mutex::new(None));
            let app_handle = app.handle().clone();
            *notify_cb.lock().unwrap() = Some(Box::new(move |title, body| {
                let _ = app_handle
                    .notification()
                    .builder()
                    .title(title)
                    .body(body)
                    .show();
            }));
            let bridge_handle = bridge::start_bridge(notify_cb);
            {
                let state = app.state::<RuntimeState>();
                *state.bridge.lock().unwrap() = Some(bridge_handle);
            }

            if let Err(error) = start_runtime(&app.state::<RuntimeState>()) {
                eprintln!("[pattern] {error}");
            }

            // reconfigure after short delay so bridge is included
            let handle = app.handle().clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(300));
                let state = handle.state::<RuntimeState>();
                let _ = configure_runtime(&state);
            });

            let emergency = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Escape);
            let shortcut_config = read_shortcut_config().unwrap_or_default();
            match register_quick_shortcut(app.handle(), &app.state::<RuntimeState>(), &shortcut_config.quick_shortcut) {
                Ok(status) if status.fallback => {
                    let _ = app.notification().builder().title("Pattern 快捷键").body(format!("{} 已被占用，已改用 {} 唤起快捷窗。", quick_shortcut_label(&status.quick_shortcut), quick_shortcut_label(&status.active_quick_shortcut))).show();
                }
                Ok(_) => {}
                Err(error) => {
                    eprintln!("[pattern] {error}");
                    let _ = app.notification().builder().title("Pattern 快捷键").body(error).show();
                }
            }
            if let Err(error) = app.global_shortcut().register(emergency) {
                eprintln!("[pattern] 急停快捷键注册失败：{error}");
            }

            let open = MenuItem::with_id(app, "open", "打开主窗口", true, None::<&str>)?;
            let quick = MenuItem::with_id(app, "quick", "唤起快捷窗", true, None::<&str>)?;
            let pause = MenuItem::with_id(app, "pause", "暂停主动性", true, None::<&str>)?;
            let resume = MenuItem::with_id(app, "resume", "恢复主动性", true, None::<&str>)?;
            let estop = MenuItem::with_id(app, "estop", "急停 Computer Use", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quick, &pause, &resume, &estop, &quit])?;
            let mut tray = TrayIconBuilder::with_id("main")
                .menu(&menu)
                .tooltip("Pattern · 空闲")
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    "quick" => toggle_quick(app),
                    "pause" => {
                        let state = app.state::<RuntimeState>();
                        let _ = set_proactive_paused_inner(&state, true);
                    }
                    "resume" => {
                        let state = app.state::<RuntimeState>();
                        let _ = set_proactive_paused_inner(&state, false);
                    }
                    "estop" => {
                        let state = app.state::<RuntimeState>();
                        let _ = emergency_stop_inner(&state);
                    }
                    "quit" => {
                        if let Ok(mut guard) = app.state::<RuntimeState>().child.lock() {
                            if let Some(mut child) = guard.take() {
                                let _ = child.kill();
                            }
                        }
                        app.exit(0)
                    }
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Keep the desktop companion alive in the tray for main/quick/review.
                if matches!(window.label(), "main" | "quick" | "review") {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            runtime_status,
            get_foreground_window,
            runtime_connection,
            save_persona,
            load_persona,
            list_personas,
            activate_persona,
            load_slot_bindings,
            save_slot_bindings,
            set_tray_state,
            save_model_config,
            load_model_config,
            list_directory,
            read_text_file,
            pick_directory,
            save_session,
            load_session,
            save_tasks,
            load_tasks,
            save_channel_config,
            load_channel_config,
            list_channel_plugins,
            relay_pairing_info,
            save_proactive_config,
            load_proactive_config,
            load_shortcut_config,
            save_shortcut_config,
            set_proactive_paused,
            emergency_stop,
            resume_computer_use,
            show_main,
            show_quick,
            show_review
            ,permission_status
            ,open_permission_settings
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Pattern");
}
