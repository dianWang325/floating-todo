use floating_todo_lan::{Node, Runtime, Vault, PORT};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
#[derive(Default)]
pub struct LanState {
    node: Mutex<Option<Node>>,
    runtime: tokio::sync::Mutex<Option<Runtime>>,
}
fn node(state: &LanState) -> Result<Node, String> {
    state
        .node
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("请先开启局域网同步".into())
}
pub fn publish(app: &AppHandle, json: &str) {
    if let Some(state) = app.try_state::<LanState>() {
        if let Ok(n) = node(&state) {
            if let Ok(v) = serde_json::from_str::<Value>(json) {
                if let Some(r) = v["revisions"].as_array() {
                    let _ = n.publish(r.clone());
                }
            }
        }
    }
}
/// Use the user-facing computer name on macOS, and the Windows device name.
#[tauri::command]
pub async fn lan_device_name() -> String {
    #[cfg(target_os = "macos")]
    {
        let mut command = tokio::process::Command::new("/usr/sbin/scutil");
        command.args(["--get", "ComputerName"]).kill_on_drop(true);
        if let Ok(Ok(output)) =
            tokio::time::timeout(std::time::Duration::from_secs(2), command.output()).await
        {
            if output.status.success() {
                let name = String::from_utf8_lossy(&output.stdout).trim().to_owned();
                if !name.is_empty() {
                    return name.chars().take(40).collect();
                }
            }
        }
    }
    for key in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(name) = std::env::var(key) {
            let name = name.trim();
            if !name.is_empty() {
                return name.chars().take(40).collect();
            }
        }
    }
    "floating todo".into()
}

#[tauri::command]
pub async fn lan_start(
    app: AppHandle,
    state: State<'_, LanState>,
    name: String,
) -> Result<Value, String> {
    let mut guard = state.runtime.lock().await;
    if let Some(r) = guard.as_ref() {
        return Ok(r.node.status());
    }
    let raw = crate::sync_storage::storage_load(app.clone())?.ok_or("请先保存本地数据")?;
    let doc: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let id = doc["deviceId"].as_str().ok_or("缺少设备 ID")?.to_owned();
    let account = format!("lan-{id}");
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("lan-vault.sqlite3");
    let db = vault_db(&path)?;
    use rusqlite::OptionalExtension;
    let encrypted: Option<String> = db
        .query_row("SELECT value FROM vault WHERE id=1", [], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let entry =
        keyring::Entry::new("com.gaopengfei.floating-todo", &account).map_err(|e| e.to_string())?;
    let key = match entry.get_password() {
        Ok(value) => value,
        Err(keyring::Error::NoEntry) if encrypted.is_none() => {
            let key = floating_todo_lan::storage_key();
            entry.set_password(&key).map_err(|e| e.to_string())?;
            key
        }
        Err(e) => return Err(format!("读取系统配对密钥失败：{e}")),
    };
    let vault = if let Some(value) = encrypted {
        serde_json::from_str::<Vault>(&floating_todo_lan::decrypt_vault(&key, &id, &value)?)
            .map_err(|_| "配对凭据损坏")?
    } else {
        Vault::default()
    };
    let owner = id.clone();
    let save = Arc::new(move |value: &str| {
        let encrypted = floating_todo_lan::encrypt_vault(&key, &owner, value)?;
        vault_db(&path)?.execute("INSERT INTO vault (id,value) VALUES (1,?1) ON CONFLICT(id) DO UPDATE SET value=excluded.value",[encrypted]).map_err(|e|e.to_string())?;
        Ok(())
    });
    save(&serde_json::to_string(&vault).map_err(|e| e.to_string())?)?;
    let mut runtime = Node::start(id, name, vault, save, PORT, true).await?;
    let events = app.clone();
    runtime.on_change(Arc::new(move || {
        let _ = events.emit("lan-changed", ());
    }));
    runtime
        .node
        .publish(doc["revisions"].as_array().ok_or("缺少版本记录")?.clone())?;
    let status = runtime.node.status();
    *state.node.lock().map_err(|e| e.to_string())? = Some(runtime.node.clone());
    *guard = Some(runtime);
    Ok(status)
}
#[tauri::command]
pub async fn lan_stop(state: State<'_, LanState>) -> Result<(), String> {
    let mut guard = state.runtime.lock().await;
    *state.node.lock().map_err(|e| e.to_string())? = None;
    *guard = None;
    Ok(())
}
#[tauri::command]
pub fn lan_status(state: State<'_, LanState>) -> Result<Value, String> {
    Ok(node(&state)
        .map(|n| n.status())
        .unwrap_or_else(|_| serde_json::json!({"enabled":false,"peers":[],"candidates":[]})))
}
#[tauri::command]
pub fn lan_codes(state: State<'_, LanState>) -> Result<Value, String> {
    Ok(node(&state)?.codes())
}
#[tauri::command]
pub fn lan_rotate(state: State<'_, LanState>, fixed: bool) -> Result<Value, String> {
    node(&state)?.rotate(fixed)
}
#[tauri::command]
pub fn lan_revoke(state: State<'_, LanState>, id: String) -> Result<(), String> {
    node(&state)?.revoke(&id)
}
#[tauri::command]
pub async fn lan_discover(state: State<'_, LanState>, url: String) -> Result<Value, String> {
    let n = node(&state)?;
    n.discover(&url, "manual").await?;
    Ok(n.status())
}
#[tauri::command]
pub async fn lan_pair(
    state: State<'_, LanState>,
    url: String,
    mode: String,
    code: String,
) -> Result<(), String> {
    node(&state)?.pair(&url, &mode, &code).await
}
#[tauri::command]
pub async fn lan_pull(state: State<'_, LanState>) -> Result<Vec<Value>, String> {
    node(&state)?.pull().await
}

#[tauri::command]
pub fn lan_poll(state: State<'_, LanState>) -> Result<(), String> {
    node(&state)?.request_poll();
    Ok(())
}

fn vault_db(path: &std::path::Path) -> Result<rusqlite::Connection, String> {
    let db = rusqlite::Connection::open(path).map_err(|e| e.to_string())?;
    db.busy_timeout(std::time::Duration::from_secs(3))
        .map_err(|e| e.to_string())?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS vault(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);").map_err(|e|e.to_string())?;
    Ok(db)
}
