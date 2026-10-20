use reqwest::{header, Client, Method};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const MAX_BYTES: usize = 32 * 1024 * 1024;

fn connection(app: &AppHandle) -> Result<Connection, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let db = Connection::open(dir.join("todo-v3.sqlite3")).map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    initialize_connection(&db)?;
    Ok(db)
}

fn initialize_connection(db: &Connection) -> Result<(), String> {
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS document (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions (id TEXT PRIMARY KEY, entity_key TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (revision_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS migration_backup (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);")
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn storage_load(app: AppHandle) -> Result<Option<String>, String> {
    let db = connection(&app)?;
    use rusqlite::OptionalExtension;
    db.query_row("SELECT json FROM document WHERE id=1", [], |row| row.get(0))
        .optional()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn storage_save(
    app: AppHandle,
    json: String,
    legacy: Option<String>,
    expected_generation: u64,
) -> Result<u64, String> {
    let mut db = connection(&app)?;
    save_document(&mut db, &json, legacy, expected_generation)
}

fn save_document(
    db: &mut Connection,
    json: &str,
    legacy: Option<String>,
    expected_generation: u64,
) -> Result<u64, String> {
    let value: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    if value["schemaVersion"] != 3 {
        return Err("不支持的数据版本".into());
    }
    let revisions = value["revisions"].as_array().ok_or("缺少版本记录")?;
    let outbox = value["outbox"].as_array().ok_or("缺少上传队列")?;
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    use rusqlite::OptionalExtension;
    let existing: Option<String> = tx
        .query_row("SELECT json FROM document WHERE id=1", [], |row| row.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let generation = if let Some(raw) = existing {
        let saved: serde_json::Value =
            serde_json::from_str(&raw).map_err(|_| "数据库内容损坏，已停止写入")?;
        saved["localGeneration"].as_u64().unwrap_or(0)
    } else {
        0
    };
    if generation != expected_generation {
        return Err("另一个应用实例已修改数据，请关闭重复实例并重新打开应用".into());
    }
    let mut stored = value.clone();
    stored["localGeneration"] = (generation + 1).into();
    let json = stored.to_string();
    tx.execute("INSERT INTO document(id,json) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET json=excluded.json", [&json]).map_err(|e| e.to_string())?;
    for r in revisions {
        let id = r["revisionId"].as_str().ok_or("版本 ID 缺失")?;
        let key = format!(
            "{}:{}",
            r["entityType"].as_str().unwrap_or(""),
            r["entityId"].as_str().unwrap_or("")
        );
        tx.execute(
            "INSERT OR IGNORE INTO revisions(id,entity_key,json) VALUES(?1,?2,?3)",
            params![id, key, r.to_string()],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.execute("DELETE FROM outbox", [])
        .map_err(|e| e.to_string())?;
    for id in outbox {
        tx.execute(
            "INSERT INTO outbox(revision_id) VALUES(?1)",
            [id.as_str().ok_or("上传队列格式不正确")?],
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(raw) = legacy {
        tx.execute(
            "INSERT OR IGNORE INTO migration_backup(id,json) VALUES(1,?1)",
            [raw],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(generation + 1)
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DavConfig {
    url: String,
    username: String,
}

fn base_url(config: &DavConfig) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(&config.url).map_err(|_| "WebDAV 地址无效")?;
    if url.scheme() != "https"
        && !(url.scheme() == "http"
            && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")))
    {
        return Err("请使用 HTTPS WebDAV 地址".into());
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("地址不能包含密码、查询参数或片段".into());
    }
    if !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path()));
    }
    Ok(url)
}
fn credential(config: &DavConfig) -> Result<keyring::Entry, String> {
    let base = base_url(config)?;
    let key = format!(
        "{:x}",
        Sha256::digest(format!("{}\n{}", base, config.username).as_bytes())
    );
    keyring::Entry::new("com.gaopengfei.floating-todo.webdav", &key)
        .map_err(|e| format!("无法访问系统凭据存储：{e}"))
}
#[tauri::command]
pub fn sync_set_password(config: DavConfig, password: String) -> Result<(), String> {
    credential(&config)?
        .set_password(&password)
        .map_err(|e| format!("无法保存 WebDAV 密码：{e}"))
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DavResponse {
    status: u16,
    body: String,
    etag: Option<String>,
    entries: Vec<DavEntry>,
}
#[derive(Serialize)]
pub struct DavEntry {
    path: String,
    collection: bool,
}

fn list_entries(
    body: &str,
    base: &reqwest::Url,
    requested: &reqwest::Url,
) -> Result<Vec<DavEntry>, String> {
    let doc = roxmltree::Document::parse(body).map_err(|_| "WebDAV 目录响应不是有效 XML")?;
    let mut entries = Vec::new();
    for response in doc
        .descendants()
        .filter(|n| n.has_tag_name(("DAV:", "response")))
    {
        let Some(href) = response
            .children()
            .find(|n| n.has_tag_name(("DAV:", "href")))
            .and_then(|n| n.text())
        else {
            continue;
        };
        let url = requested.join(href).map_err(|_| "WebDAV 返回了无效路径")?;
        if url.origin() != base.origin()
            || !url.path().starts_with(base.path())
            || url == *requested
        {
            continue;
        }
        let collection = response
            .descendants()
            .any(|n| n.has_tag_name(("DAV:", "collection")));
        let path = url.path()[base.path().len()..].to_string();
        // Protocol paths are ASCII UUIDs; reject unexpected names rather than follow arbitrary URLs.
        if path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_/ .".contains(&b))
            && !path.contains("..")
            && !path.contains(' ')
        {
            entries.push(DavEntry { path, collection });
        }
    }
    Ok(entries)
}

#[tauri::command]
pub async fn dav_request(
    config: DavConfig,
    path: String,
    method: String,
    body: Option<String>,
    etag: Option<String>,
) -> Result<DavResponse, String> {
    let password = credential(&config)?
        .get_password()
        .map_err(|_| "无法读取 WebDAV 密码，请重新保存连接设置")?;
    request_with_password(config, path, method, body, etag, password).await
}

async fn request_with_password(
    config: DavConfig,
    path: String,
    method: String,
    body: Option<String>,
    etag: Option<String>,
    password: String,
) -> Result<DavResponse, String> {
    let base = base_url(&config)?;
    if path.starts_with('/')
        || path.contains("..")
        || !path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_/ .".contains(&b))
        || path.contains(' ')
    {
        return Err("同步路径无效".into());
    }
    if !["GET", "PUT", "PROPFIND", "MKCOL"].contains(&method.as_str()) {
        return Err("不支持的 WebDAV 操作".into());
    }
    if body.as_ref().is_some_and(|b| b.len() > MAX_BYTES) {
        return Err("同步文件过大".into());
    }
    let url = base.join(&path).map_err(|_| "同步路径无效")?;
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法创建网络客户端")?;
    let mut request = client
        .request(
            Method::from_bytes(method.as_bytes()).map_err(|_| "请求方式无效")?,
            url.clone(),
        )
        .basic_auth(config.username, Some(password));
    if method == "PROPFIND" {
        request = request.header("Depth", "1").header(header::CONTENT_TYPE, "application/xml").body("<?xml version=\"1.0\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:resourcetype/><d:getetag/></d:prop></d:propfind>");
    } else if let Some(body) = body {
        request = request
            .header(header::CONTENT_TYPE, "application/json")
            .body(body);
    }
    if method == "PUT" {
        request = if let Some(etag) = etag {
            request.header(header::IF_MATCH, etag)
        } else {
            request.header(header::IF_NONE_MATCH, "*")
        };
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| "WebDAV 连接失败或超时，请检查地址与网络")?;
    let status = response.status().as_u16();
    if status == 401 || status == 403 {
        return Err("WebDAV 身份验证失败或无访问权限".into());
    }
    if (300..400).contains(&status) {
        return Err("WebDAV 地址发生重定向，请填写最终 HTTPS 地址".into());
    }
    let etag = response
        .headers()
        .get(header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取 WebDAV 响应失败")? {
        if bytes.len() + chunk.len() > MAX_BYTES {
            return Err("WebDAV 响应过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = String::from_utf8(bytes).map_err(|_| "WebDAV 返回了非 UTF-8 内容")?;
    let entries = if method == "PROPFIND" && status == 207 {
        list_entries(&body, &base, &url)?
    } else {
        Vec::new()
    };
    Ok(DavResponse {
        status,
        body,
        etag,
        entries,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dav_paths_stay_within_configured_root() {
        let base = reqwest::Url::parse("https://example.com/dav/").unwrap();
        let requested = base.join("floating-todo/").unwrap();
        let body = r#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/floating-todo/</d:href></d:response><d:response><d:href>/dav/floating-todo/device/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response><d:response><d:href>https://evil.example/file</d:href></d:response></d:multistatus>"#;
        let entries = list_entries(body, &base, &requested).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "floating-todo/device/");
        assert!(entries[0].collection);
    }
    #[test]
    fn sqlite_commits_document_revisions_and_outbox_atomically() {
        let mut db = Connection::open_in_memory().unwrap();
        initialize_connection(&db).unwrap();
        let valid = serde_json::json!({"schemaVersion":3,"revisions":[{"revisionId":"r1","entityType":"task","entityId":"a"}],"outbox":["r1"]}).to_string();
        assert_eq!(
            save_document(&mut db, &valid, Some("legacy".into()), 0).unwrap(),
            1
        );
        let invalid =
            serde_json::json!({"schemaVersion":3,"revisions":[],"outbox":[123]}).to_string();
        assert!(save_document(&mut db, &invalid, None, 1).is_err());
        let stored: String = db
            .query_row("SELECT json FROM document WHERE id=1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&stored).unwrap()["localGeneration"],
            1
        );
        assert_eq!(
            db.query_row("SELECT revision_id FROM outbox", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "r1"
        );
        assert!(save_document(&mut db, &valid, None, 0).is_err());
        assert_eq!(
            save_document(&mut db, &valid, Some("replacement".into()), 1).unwrap(),
            2
        );
        assert_eq!(
            db.query_row("SELECT json FROM migration_backup", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "legacy"
        );
    }

    #[test]
    fn dav_requires_secure_urls_and_rejects_embedded_credentials() {
        for url in [
            "http://example.com/dav/",
            "https://user:secret@example.com/",
            "https://example.com/?password=secret",
        ] {
            assert!(base_url(&DavConfig {
                url: url.into(),
                username: "u".into()
            })
            .is_err());
        }
        assert!(base_url(&DavConfig {
            url: "https://example.com/dav".into(),
            username: "u".into()
        })
        .unwrap()
        .as_str()
        .ends_with("/dav/"));
    }

    #[test]
    fn dav_put_sends_conditional_header_and_reads_response() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0; 1024];
            loop {
                let n = stream.read(&mut buffer).unwrap();
                if n == 0 {
                    break;
                }
                bytes.extend_from_slice(&buffer[..n]);
                if bytes.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            let request = String::from_utf8(bytes).unwrap().to_lowercase();
            assert!(request.starts_with("put /dav/batch.json http/1.1"));
            assert!(request.contains("if-none-match: *"));
            assert!(request.contains("authorization: basic "));
            stream.write_all(b"HTTP/1.1 201 Created\r\nContent-Length: 2\r\nETag: \"v1\"\r\nConnection: close\r\n\r\n{}").unwrap();
        });
        let result = tauri::async_runtime::block_on(request_with_password(
            DavConfig {
                url: format!("http://{address}/dav/"),
                username: "u".into(),
            },
            "batch.json".into(),
            "PUT".into(),
            Some("{}".into()),
            None,
            "test".into(),
        ))
        .unwrap();
        assert_eq!(result.status, 201);
        assert_eq!(result.body, "{}");
        assert_eq!(result.etag.as_deref(), Some("\"v1\""));
        server.join().unwrap();
    }
}
