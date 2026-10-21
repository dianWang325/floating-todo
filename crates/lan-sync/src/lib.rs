//! Native LAN transport. Only explicit short-code pairing grants read access.
//! Revisions are published after the application's durable single-writer commit.
use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, KeyInit, Nonce,
};
use axum::{
    extract::{DefaultBodyLimit, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use rand::{Rng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use spake2::{Ed25519Group, Identity, Password, Spake2};
use std::{
    collections::{BTreeMap, HashMap},
    net::{IpAddr, Ipv4Addr},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::task::JoinHandle;
use uuid::Uuid;

pub const PORT: u16 = 47831;
const SERVICE: &str = "_floatingtodo._tcp.local.";
const PROTOCOL: &str = "floating-todo-lan/1";
const MAX_BODY: usize = 512 * 1024;
const MAX_RECORD: usize = 128 * 1024;
type Result<T> = std::result::Result<T, String>;
type Save = Arc<dyn Fn(&str) -> Result<()> + Send + Sync>;
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn random_hex(n: usize) -> String {
    let mut b = vec![0; n];
    rand::thread_rng().fill_bytes(&mut b);
    hex::encode(b)
}
fn code(digits: u32) -> String {
    format!(
        "{:0width$}",
        rand::thread_rng().gen_range(0..10u64.pow(digits)),
        width = digits as usize
    )
}
fn field<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key].as_str().ok_or_else(|| format!("缺少 {key}"))
}
fn valid_id(id: &str) -> bool {
    Uuid::parse_str(id).is_ok()
}
fn proof(key: &[u8], text: &str) -> String {
    let mut h = <Hmac<Sha256> as Mac>::new_from_slice(key).unwrap();
    h.update(text.as_bytes());
    hex::encode(h.finalize().into_bytes())
}
fn verify(key: &[u8], text: &str, value: &str) -> Result<()> {
    let mut h = <Hmac<Sha256> as Mac>::new_from_slice(key).unwrap();
    h.update(text.as_bytes());
    h.verify_slice(&hex::decode(value).map_err(|_| "认证失败")?)
        .map_err(|_| "短码或配对认证失败".into())
}
fn context(a: &str, b: &str, mode: &str, session: &str, am: &str, bm: &str) -> String {
    json!([PROTOCOL, a, b, mode, session, am, bm]).to_string()
}
fn crypt_key(key: &[u8], from: &str, to: &str, kind: &str) -> [u8; 32] {
    let mut out = [0; 32];
    Hkdf::<Sha256>::new(None, key)
        .expand(
            json!([PROTOCOL, from, to, kind]).to_string().as_bytes(),
            &mut out,
        )
        .unwrap();
    out
}
fn seal(
    key: &[u8],
    from: &str,
    to: &str,
    kind: &str,
    request: &str,
    body: &Value,
) -> Result<Value> {
    let header = json!({"from":from,"to":to,"kind":kind,"request":request});
    let nonce = random_hex(12);
    let n = hex::decode(&nonce).unwrap();
    let data = Aes256Gcm::new_from_slice(&crypt_key(key, from, to, kind))
        .unwrap()
        .encrypt(
            Nonce::from_slice(&n),
            Payload {
                msg: body.to_string().as_bytes(),
                aad: header.to_string().as_bytes(),
            },
        )
        .map_err(|_| "加密失败")?;
    Ok(json!({"header":header,"nonce":nonce,"data":hex::encode(data)}))
}
fn unseal(key: &[u8], v: &Value, from: &str, to: &str, kind: &str, request: &str) -> Result<Value> {
    let header = json!({"from":from,"to":to,"kind":kind,"request":request});
    if v["header"] != header {
        return Err("消息身份不匹配".into());
    }
    let n = hex::decode(field(v, "nonce")?).map_err(|_| "无效消息")?;
    if n.len() != 12 {
        return Err("无效 nonce".into());
    }
    let bytes = hex::decode(field(v, "data")?).map_err(|_| "无效消息")?;
    let plain = Aes256Gcm::new_from_slice(&crypt_key(key, from, to, kind))
        .unwrap()
        .decrypt(
            Nonce::from_slice(&n),
            Payload {
                msg: &bytes,
                aad: header.to_string().as_bytes(),
            },
        )
        .map_err(|_| "消息认证失败")?;
    serde_json::from_slice(&plain).map_err(|e| e.to_string())
}
#[derive(Clone, Serialize, Deserialize)]
struct Peer {
    id: String,
    name: String,
    url: String,
    key: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Vault {
    fixed: String,
    peers: BTreeMap<String, Peer>,
    #[serde(default)]
    attempts: Vec<u64>,
}
impl Default for Vault {
    fn default() -> Self {
        Self {
            fixed: code(8),
            peers: BTreeMap::new(),
            attempts: vec![],
        }
    }
}
struct Pending {
    key: Vec<u8>,
    context: String,
    id: String,
    name: String,
    url: String,
    expires: u64,
    mode: String,
    code: String,
}
#[derive(Clone, Serialize)]
struct Candidate {
    id: String,
    name: String,
    url: String,
    source: String,
    seen: u64,
}
#[derive(Default)]
struct Health {
    failures: u32,
    retry: u64,
    last_success: u64,
    error: String,
}
struct Data {
    id: String,
    name: String,
    vault: Vault,
    save: Save,
    enabled: bool,
    dynamic: String,
    expires: u64,
    pending: HashMap<String, Pending>,
    candidates: BTreeMap<String, Candidate>,
    revisions: BTreeMap<String, Value>,
    hashes: BTreeMap<String, String>,
    root: String,
    health: BTreeMap<String, Health>,
    pairing: bool,
    pull_cursor: usize,
    discovery_cursor: usize,
}
impl Data {
    fn persist(&self, vault: &Vault) -> Result<()> {
        (self.save)(&serde_json::to_string(vault).map_err(|e| e.to_string())?)
    }
    fn put_peer(&mut self, peer: Peer) -> Result<()> {
        if !self.enabled {
            return Err("同步已关闭".into());
        }
        if self.vault.peers.len() >= 16 && !self.vault.peers.contains_key(&peer.id) {
            return Err("最多配对 16 台设备".into());
        }
        let mut vault = self.vault.clone();
        vault.peers.insert(peer.id.clone(), peer);
        self.persist(&vault)?;
        self.vault = vault;
        Ok(())
    }
    fn codes(&mut self) -> Value {
        if now() >= self.expires {
            let previous = self.dynamic.clone();
            loop {
                self.dynamic = code(6);
                if self.dynamic != previous {
                    break;
                }
            }
            self.expires = now() + 60000;
        }
        json!({"dynamic":self.dynamic,"fixed":self.vault.fixed,"expires":self.expires})
    }
    fn charge(&mut self) -> Result<()> {
        let mut v = self.vault.clone();
        v.attempts.retain(|t| now().saturating_sub(*t) < 60000);
        if v.attempts.len() >= 5 {
            return Err("配对尝试过多，请一分钟后重试".into());
        }
        v.attempts.push(now());
        self.persist(&v)?;
        self.vault = v;
        Ok(())
    }
}
#[derive(Clone)]
pub struct Node {
    data: Arc<Mutex<Data>>,
    client: reqwest::Client,
    port: u16,
    permits: Arc<tokio::sync::Semaphore>,
}
pub struct Runtime {
    pub node: Node,
    tasks: Vec<JoinHandle<()>>,
    mdns: Option<ServiceDaemon>,
}
impl Drop for Runtime {
    fn drop(&mut self) {
        self.node.data.lock().unwrap().enabled = false;
        for task in &self.tasks {
            task.abort();
        }
        if let Some(m) = &self.mdns {
            let _ = m.shutdown();
        }
    }
}
fn endpoint(input: &str) -> Result<String> {
    let u = reqwest::Url::parse(input).map_err(|_| "请输入 http://局域网IP:端口")?;
    if u.scheme() != "http"
        || !u.username().is_empty()
        || u.password().is_some()
        || u.path() != "/"
        || u.query().is_some()
        || u.fragment().is_some()
    {
        return Err("仅支持局域网 HTTP 地址".into());
    }
    let ip: IpAddr = u
        .host_str()
        .ok_or("缺少 IP")?
        .trim_matches(['[', ']'])
        .parse()
        .map_err(|_| "请使用 IP 地址")?;
    let allowed = match ip {
        IpAddr::V4(x) => {
            x.is_private()
                || x.is_link_local()
                || (x.octets()[0] == 100 && (64..=127).contains(&x.octets()[1]))
                || cfg!(test) && x.is_loopback()
        }
        IpAddr::V6(_) => false,
    };
    if !allowed {
        return Err("仅允许局域网或虚拟局域网地址".into());
    }
    Ok(input.trim_end_matches('/').to_owned())
}
impl Node {
    pub async fn start(
        id: String,
        name: String,
        vault: Vault,
        save: Save,
        port: u16,
        discovery: bool,
    ) -> Result<Runtime> {
        if !valid_id(&id) {
            return Err("无效设备标识".into());
        }
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::UNSPECIFIED, port))
            .await
            .map_err(|e| format!("监听失败：{e}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let node = Self {
            data: Arc::new(Mutex::new(Data {
                id: id.clone(),
                name: name.chars().take(40).collect(),
                vault,
                save,
                enabled: true,
                dynamic: code(6),
                expires: now() + 60000,
                pending: HashMap::new(),
                candidates: BTreeMap::new(),
                revisions: BTreeMap::new(),
                hashes: BTreeMap::new(),
                root: String::new(),
                health: BTreeMap::new(),
                pairing: false,
                pull_cursor: 0,
                discovery_cursor: 0,
            })),
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(4))
                .build()
                .map_err(|e| e.to_string())?,
            port,
            permits: Arc::new(tokio::sync::Semaphore::new(8)),
        };
        node.publish(vec![])?;
        let router = Router::new()
            .route("/hello", get(hello))
            .route("/pair/start", post(pair_start))
            .route("/pair/finish", post(pair_finish))
            .route("/read", post(read))
            .layer(DefaultBodyLimit::max(MAX_BODY))
            .layer(axum::middleware::from_fn_with_state(
                node.clone(),
                limit_request,
            ))
            .with_state(node.clone());
        let task = tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await;
        });
        let mut runtime = Runtime {
            node: node.clone(),
            tasks: vec![task],
            mdns: None,
        };
        if discovery {
            let m = ServiceDaemon::new().map_err(|e| e.to_string())?;
            runtime.mdns = Some(m.clone());
            m.disable_interface(mdns_sd::IfKind::IPv6)
                .map_err(|e| e.to_string())?;
            let info = ServiceInfo::new(
                SERVICE,
                &id,
                &format!("todo-{id}.local."),
                "",
                port,
                [("protocol", PROTOCOL), ("id", id.as_str())].as_slice(),
            )
            .map_err(|e| e.to_string())?
            .enable_addr_auto();
            m.register(info).map_err(|e| e.to_string())?;
            let receiver = m.browse(SERVICE).map_err(|e| e.to_string())?;
            let n = node.clone();
            runtime.tasks.push(tokio::spawn(async move {
                let mut probed: HashMap<String, u64> = HashMap::new();
                while let Ok(event) = receiver.recv_async().await {
                    if let ServiceEvent::ServiceResolved(info) = event {
                        if info.get_property_val_str("id")
                            == Some(n.data.lock().unwrap().id.as_str())
                        {
                            continue;
                        }
                        for ip in info.get_addresses_v4() {
                            let url = format!("http://{ip}:{}", info.get_port());
                            probed.retain(|_, t| now().saturating_sub(*t) < 20000);
                            if probed.contains_key(&url) || probed.len() >= 128 {
                                continue;
                            }
                            probed.insert(url.clone(), now());
                            let _ = n.discover(&url, "mdns").await;
                        }
                    }
                }
            }));
            runtime.mdns = Some(m);
            let n = node.clone();
            runtime.tasks.push(tokio::spawn(async move {
                loop {
                    n.refresh_candidates().await;
                    n.tailscale().await;
                    tokio::time::sleep(Duration::from_secs(30)).await;
                }
            }));
        }
        Ok(runtime)
    }
    pub fn publish(&self, revisions: Vec<Value>) -> Result<()> {
        let mut records = BTreeMap::new();
        let mut hashes = BTreeMap::new();
        for r in revisions {
            let id = field(&r, "revisionId")?.to_owned();
            let raw = r.to_string();
            hashes.insert(id.clone(), hex::encode(Sha256::digest(raw.as_bytes())));
            records.insert(id, r);
        }
        let root = hex::encode(Sha256::digest(serde_json::to_vec(&hashes).unwrap()));
        let mut d = self.data.lock().unwrap();
        d.revisions = records;
        d.hashes = hashes;
        d.root = root;
        Ok(())
    }
    pub fn status(&self) -> Value {
        let mut d = self.data.lock().unwrap();
        d.candidates
            .retain(|_, c| now().saturating_sub(c.seen) < 120000);
        json!({"enabled":d.enabled,"id":d.id,"name":d.name,"port":self.port,"candidates":d.candidates.values().collect::<Vec<_>>(),"peers":d.vault.peers.values().map(|p|{let h=d.health.get(&p.id);json!({"id":p.id,"name":p.name,"url":p.url,"error":h.map(|x|x.error.clone()).unwrap_or_default(),"lastSuccess":h.map(|x|x.last_success).unwrap_or(0)})}).collect::<Vec<_>>()})
    }
    pub fn codes(&self) -> Value {
        self.data.lock().unwrap().codes()
    }
    pub fn rotate(&self, fixed: bool) -> Result<Value> {
        let mut d = self.data.lock().unwrap();
        if fixed {
            let mut v = d.vault.clone();
            loop {
                v.fixed = code(8);
                if v.fixed != d.vault.fixed {
                    break;
                }
            }
            d.persist(&v)?;
            d.vault = v;
        } else {
            d.expires = 0;
        }
        d.pending.clear();
        Ok(d.codes())
    }
    pub fn revoke(&self, id: &str) -> Result<()> {
        let mut d = self.data.lock().unwrap();
        let mut v = d.vault.clone();
        v.peers.remove(id);
        d.persist(&v)?;
        d.vault = v;
        d.pending.retain(|_, p| p.id != id);
        Ok(())
    }
    async fn request(&self, url: &str, path: &str, body: Option<Value>) -> Result<Value> {
        let url = endpoint(url)?;
        let request = if let Some(v) = body {
            self.client.post(format!("{url}{path}")).json(&v)
        } else {
            self.client.get(format!("{url}{path}"))
        };
        let mut r = request.send().await.map_err(|e| format!("{e:?}"))?;
        if !r.status().is_success() {
            return Err(format!("设备请求失败 ({})", r.status()));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = r.chunk().await.map_err(|e| e.to_string())? {
            if bytes.len() + chunk.len() > MAX_BODY {
                return Err("设备响应过大".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|e| e.to_string())
    }
    pub async fn discover(&self, url: &str, source: &str) -> Result<()> {
        if !self.data.lock().unwrap().enabled {
            return Err("同步已关闭".into());
        }
        let url = endpoint(url)?;
        let h = self.request(&url, "/hello", None).await?;
        let id = field(&h, "id")?.to_owned();
        if h["protocol"] != PROTOCOL || !valid_id(&id) {
            return Err("不支持的设备协议".into());
        }
        let peer = {
            let d = self.data.lock().unwrap();
            if d.id == id {
                return Ok(());
            }
            d.vault.peers.get(&id).cloned()
        };
        if let Some(mut p) = peer {
            if p.url != url {
                p.url = url.clone();
                self.rpc(&p, json!({"op":"status"})).await?;
                let mut d = self.data.lock().unwrap();
                if d.vault.peers.get(&id).map(|x| &x.key) == Some(&p.key) {
                    d.put_peer(p)?;
                }
            }
        }
        let mut d = self.data.lock().unwrap();
        d.candidates
            .retain(|_, c| now().saturating_sub(c.seen) < 120000);
        if d.candidates.len() < 64 || d.candidates.contains_key(&id) {
            d.candidates.insert(
                id.clone(),
                Candidate {
                    id,
                    name: field(&h, "name")?.chars().take(40).collect(),
                    url,
                    source: source.into(),
                    seen: now(),
                },
            );
        }
        Ok(())
    }
    async fn refresh_candidates(&self) {
        let candidates = self
            .data
            .lock()
            .unwrap()
            .candidates
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for chunk in candidates.chunks(4) {
            let mut tasks = Vec::new();
            for c in chunk {
                let n = self.clone();
                let c = c.clone();
                tasks.push(tokio::spawn(async move {
                    let _ = n.discover(&c.url, &c.source).await;
                }));
            }
            for task in tasks {
                let _ = task.await;
            }
        }
    }
    async fn tailscale(&self) {
        let executable = [
            "tailscale",
            "/opt/homebrew/bin/tailscale",
            "/usr/local/bin/tailscale",
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
            r"C:\Program Files\Tailscale\tailscale.exe",
        ];
        let mut output = None;
        for path in executable {
            let mut command = tokio::process::Command::new(path);
            command.args(["status", "--json"]).kill_on_drop(true);
            #[cfg(target_os = "windows")]
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW for background discovery.
            match tokio::time::timeout(Duration::from_secs(4), command.output()).await {
                Ok(Ok(out)) if out.status.success() => {
                    output = Some(out);
                    break;
                }
                Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => continue,
                _ => break,
            }
        }
        if let Some(out) = output {
            if out.stdout.len() > 512 * 1024 {
                return;
            }
            if let Ok(v) = serde_json::from_slice::<Value>(&out.stdout) {
                if let Some(peers) = v["Peer"].as_object() {
                    let mut urls: Vec<_> = peers
                        .values()
                        .filter(|p| p["Online"] == true)
                        .filter_map(|p| {
                            p["TailscaleIPs"]
                                .as_array()?
                                .iter()
                                .filter_map(Value::as_str)
                                .find(|s| !s.contains(':'))
                                .map(|ip| format!("http://{ip}:{}", PORT))
                        })
                        .collect();
                    if !urls.is_empty() {
                        let mut d = self.data.lock().unwrap();
                        let offset = d.discovery_cursor % urls.len();
                        urls.rotate_left(offset);
                        d.discovery_cursor = (offset + 32) % urls.len();
                        urls.truncate(32);
                    }
                    for chunk in urls.chunks(4) {
                        let mut tasks = Vec::new();
                        for url in chunk {
                            let n = self.clone();
                            let url = url.clone();
                            tasks.push(tokio::spawn(async move {
                                let _ = n.discover(&url, "tailscale").await;
                            }));
                        }
                        for t in tasks {
                            let _ = t.await;
                        }
                    }
                }
            }
        }
    }
    pub async fn pair(&self, url: &str, mode: &str, code: &str) -> Result<()> {
        if !matches!(mode, "dynamic" | "fixed")
            || code.len() != if mode == "dynamic" { 6 } else { 8 }
            || !code.bytes().all(|b| b.is_ascii_digit())
        {
            return Err("请输入正确位数的数字短码".into());
        }
        {
            let mut d = self.data.lock().unwrap();
            if d.pairing {
                return Err("正在配对".into());
            }
            d.pairing = true;
        }
        let result = self.pair_inner(url, mode, code).await;
        self.data.lock().unwrap().pairing = false;
        result
    }
    async fn pair_inner(&self, url: &str, mode: &str, code: &str) -> Result<()> {
        let url = endpoint(url)?;
        let h = self.request(&url, "/hello", None).await?;
        let b = field(&h, "id")?;
        let (a, name) = {
            let d = self.data.lock().unwrap();
            (d.id.clone(), d.name.clone())
        };
        if h["protocol"] != PROTOCOL || !valid_id(b) || a == b {
            return Err("不支持的配对目标".into());
        }
        // Already paired keys are retained until both confirmations complete.
        let (pake, msg) = Spake2::<Ed25519Group>::start_a(
            &Password::new(code.as_bytes()),
            &Identity::new(a.as_bytes()),
            &Identity::new(b.as_bytes()),
        );
        let am = hex::encode(msg);
        let response = self
            .request(
                &url,
                "/pair/start",
                Some(json!({"id":a,"name":name,"mode":mode,"message":am,"port":self.port})),
            )
            .await?;
        let bm = field(&response, "message")?;
        let session = field(&response, "session")?;
        let key = pake
            .finish(&hex::decode(bm).map_err(|_| "无效握手")?)
            .map_err(|_| "无效握手")?;
        let ctx = context(&a, b, mode, session, &am, bm);
        verify(&key, &format!("server:{ctx}"), field(&response, "proof")?)?;
        let result = self
            .request(
                &url,
                "/pair/finish",
                Some(json!({"session":session,"proof":proof(&key,&format!("client:{ctx}"))})),
            )
            .await?;
        verify(&key, &format!("complete:{ctx}"), field(&result, "proof")?)?;
        self.data.lock().unwrap().put_peer(Peer {
            id: b.into(),
            name: field(&h, "name")?.chars().take(40).collect(),
            url,
            key: hex::encode(key),
        })
    }
    async fn rpc(&self, p: &Peer, body: Value) -> Result<Value> {
        let id = self.data.lock().unwrap().id.clone();
        let key = hex::decode(&p.key).map_err(|_| "配对凭据损坏")?;
        let req = random_hex(16);
        let response = self
            .request(
                &p.url,
                "/read",
                Some(seal(&key, &id, &p.id, "request", &req, &body)?),
            )
            .await?;
        unseal(&key, &response, &p.id, &id, "response", &req)
    }
    pub async fn pull(&self) -> Result<Vec<Value>> {
        let peers = {
            let mut d = self.data.lock().unwrap();
            let mut peers = d
                .vault
                .peers
                .values()
                .filter(|p| d.health.get(&p.id).map_or(true, |h| now() >= h.retry))
                .cloned()
                .collect::<Vec<_>>();
            if !peers.is_empty() {
                let offset = d.pull_cursor % peers.len();
                peers.rotate_left(offset);
                d.pull_cursor = (offset + 2) % peers.len();
                peers.truncate(2);
            }
            peers
        };
        // Two independent peers per pass: bounded work and fair service when one is offline.
        let mut tasks = tokio::task::JoinSet::new();
        for p in peers {
            let n = self.clone();
            tasks.spawn(async move {
                let received = tokio::time::timeout(Duration::from_secs(20), n.pull_peer(&p))
                    .await
                    .unwrap_or_else(|_| Err("设备同步超时".into()));
                (p, received)
            });
        }
        let mut result = Vec::new();
        while let Some(task) = tasks.join_next().await {
            let (p, received) = task.map_err(|e| e.to_string())?;
            let mut d = self.data.lock().unwrap();
            if d.vault.peers.get(&p.id).map(|x| &x.key) != Some(&p.key) {
                continue;
            }
            let h = d.health.entry(p.id.clone()).or_default();
            match received {
                Ok(mut r) => {
                    h.failures = 0;
                    h.retry = 0;
                    h.error.clear();
                    h.last_success = now();
                    result.append(&mut r);
                }
                Err(e) => {
                    h.failures += 1;
                    h.retry = now() + 1000 * (2u64.pow(h.failures.min(6))).min(60);
                    h.error = e;
                }
            }
        }
        Ok(result)
    }
    async fn pull_peer(&self, p: &Peer) -> Result<Vec<Value>> {
        let status = self.rpc(p, json!({"op":"status"})).await?;
        let (root, hashes) = {
            let d = self.data.lock().unwrap();
            (d.root.clone(), d.hashes.clone())
        };
        if status["root"] == root {
            return Ok(vec![]);
        }
        let mut after = String::new();
        let mut missing = Vec::new();
        let mut expected = BTreeMap::new();
        // Bounded per pass. Server inventory is sorted by immutable ID, not mutable offset.
        for _ in 0..4096 {
            let v = self.rpc(p, json!({"op":"inventory","after":after})).await?;
            let rows = v["rows"].as_array().ok_or("无效清单")?;
            if rows.len() > 256 {
                return Err("清单过大".into());
            }
            for row in rows {
                let id = field(row, "id")?;
                if id <= after.as_str() {
                    return Err("清单顺序无效".into());
                }
                after = id.into();
                let hash = field(row, "hash")?;
                if let Some(old) = hashes.get(id) {
                    if old != hash {
                        return Err("同一版本 ID 内容变化".into());
                    }
                } else {
                    expected.insert(id.to_owned(), hash.to_owned());
                    missing.push(id.to_string());
                    if missing.len() == 100 {
                        break;
                    }
                }
            }
            if missing.len() >= 100 || rows.len() < 256 {
                break;
            }
        }
        if missing.is_empty() {
            return Ok(vec![]);
        }
        let v = self.rpc(p, json!({"op":"get","ids":missing})).await?;
        let records = v["revisions"].as_array().ok_or("无效版本批次")?;
        if records.len() > 100 {
            return Err("版本批次过大".into());
        }
        for r in records {
            let id = field(r, "revisionId")?;
            let raw = r.to_string();
            if raw.len() > MAX_RECORD
                || expected.remove(id) != Some(hex::encode(Sha256::digest(raw.as_bytes())))
            {
                return Err("版本内容与清单不符或大小超限".into());
            }
        }
        Ok(records.clone())
    }
}
async fn hello(State(n): State<Node>) -> Json<Value> {
    let d = n.data.lock().unwrap();
    Json(json!({"protocol":PROTOCOL,"id":d.id,"name":d.name}))
}
type Response = std::result::Result<Json<Value>, (StatusCode, String)>;
fn response(v: Result<Value>) -> Response {
    v.map(Json).map_err(|e| (StatusCode::BAD_REQUEST, e))
}
async fn pair_start(
    State(n): State<Node>,
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>,
    Json(v): Json<Value>,
) -> Response {
    response((|| {
        let mut d = n.data.lock().unwrap();
        if !d.enabled {
            return Err("同步已关闭".into());
        }
        d.charge()?;
        let id = field(&v, "id")?;
        if !valid_id(id) || id == d.id {
            return Err("无效设备".into());
        }
        let mode = field(&v, "mode")?;
        let codes = d.codes();
        let password = field(&codes, mode)?;
        if !matches!(mode, "dynamic" | "fixed") {
            return Err("无效短码类型".into());
        }
        let am = field(&v, "message")?;
        let (p, msg) = Spake2::<Ed25519Group>::start_b(
            &Password::new(password.as_bytes()),
            &Identity::new(id.as_bytes()),
            &Identity::new(d.id.as_bytes()),
        );
        let key = p
            .finish(&hex::decode(am).map_err(|_| "无效握手")?)
            .map_err(|_| "无效握手")?;
        let bm = hex::encode(msg);
        let session = random_hex(16);
        let ctx = context(id, &d.id, mode, &session, am, &bm);
        let port = v["port"]
            .as_u64()
            .filter(|p| *p > 0 && *p <= 65535)
            .ok_or("无效端口")?;
        let url = endpoint(&format!("http://{}:{port}", addr.ip()))?;
        d.pending.retain(|_, p| p.expires > now());
        if d.pending.len() >= 16 {
            return Err("配对繁忙".into());
        }
        let answer =
            json!({"message":bm,"session":session,"proof":proof(&key,&format!("server:{ctx}"))});
        d.pending.insert(
            session,
            Pending {
                key,
                context: ctx,
                id: id.into(),
                name: field(&v, "name")?.chars().take(40).collect(),
                url,
                expires: now() + 30000,
                mode: mode.into(),
                code: password.into(),
            },
        );
        Ok(answer)
    })())
}
async fn pair_finish(State(n): State<Node>, Json(v): Json<Value>) -> Response {
    response((|| {
        let mut d = n.data.lock().unwrap();
        if !d.enabled {
            return Err("同步已关闭".into());
        }
        let p = d
            .pending
            .remove(field(&v, "session")?)
            .ok_or("配对请求过期")?;
        let codes = d.codes();
        if p.expires < now() || codes[&p.mode] != p.code {
            return Err("短码已失效".into());
        }
        verify(
            &p.key,
            &format!("client:{}", p.context),
            field(&v, "proof")?,
        )?;
        d.put_peer(Peer {
            id: p.id,
            name: p.name,
            url: p.url,
            key: hex::encode(&p.key),
        })?;
        Ok(json!({"proof":proof(&p.key,&format!("complete:{}",p.context))}))
    })())
}
async fn read(State(n): State<Node>, Json(v): Json<Value>) -> Response {
    response((|| {
        let d = n.data.lock().unwrap();
        if !d.enabled {
            return Err("同步已关闭".into());
        }
        let from = field(&v["header"], "from")?;
        let req = field(&v["header"], "request")?;
        if req.len() != 32 {
            return Err("无效请求".into());
        }
        let p = d.vault.peers.get(from).ok_or("设备尚未配对")?;
        let key = hex::decode(&p.key).map_err(|_| "无效凭据")?;
        let body = unseal(&key, &v, from, &d.id, "request", req)?;
        let result = match field(&body, "op")? {
            "status" => json!({"root":d.root}),
            "inventory" => {
                let after = field(&body, "after")?;
                json!({"rows":d.hashes.iter().filter(|(id,_)|id.as_str()>after).take(256).map(|(id,hash)|json!({"id":id,"hash":hash})).collect::<Vec<_>>()})
            }
            "get" => {
                let ids = body["ids"].as_array().ok_or("无效请求")?;
                if ids.len() > 100 {
                    return Err("请求过大".into());
                }
                let mut bytes = 0;
                let mut records = Vec::new();
                for id in ids {
                    if let Some(r) = d.revisions.get(id.as_str().ok_or("无效 ID")?) {
                        let size = r.to_string().len();
                        if size > MAX_RECORD {
                            return Err("单条版本超过 128 KiB，请缩小内容".into());
                        }
                        if bytes + size > 200 * 1024 {
                            break;
                        }
                        bytes += size;
                        records.push(r);
                    }
                }
                json!({"revisions":records})
            }
            _ => return Err("无效操作".into()),
        };
        seal(&key, &d.id, from, "response", req, &result)
    })())
}

async fn limit_request(
    State(n): State<Node>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let Ok(_permit) = n.permits.clone().try_acquire_owned() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    match tokio::time::timeout(Duration::from_secs(5), next.run(request)).await {
        Ok(r) => r,
        Err(_) => StatusCode::REQUEST_TIMEOUT.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn device() -> Runtime {
        Node::start(
            Uuid::new_v4().to_string(),
            "test".into(),
            Vault::default(),
            Arc::new(|_| Ok(())),
            0,
            false,
        )
        .await
        .unwrap()
    }
    fn url(r: &Runtime) -> String {
        format!("http://127.0.0.1:{}", r.node.port)
    }
    fn record(id: usize) -> Value {
        json!({"revisionId":format!("revision-{id:06}"),"payload":{"text":format!("record {id}")}})
    }
    async fn pair(a: &Runtime, b: &Runtime, mode: &str) {
        let code = b.node.codes()[mode].as_str().unwrap().to_string();
        a.node.pair(&url(b), mode, &code).await.unwrap();
    }
    #[tokio::test]
    async fn pairing_encryption_pagination_relay_and_revoke() {
        let a = device().await;
        let b = device().await;
        let c = device().await;
        pair(&a, &b, "dynamic").await;
        pair(&b, &c, "fixed").await;
        a.node.publish((0..305).map(record).collect()).unwrap();
        for _ in 0..4 {
            let received = b.node.pull().await.unwrap();
            let mut records = b
                .node
                .data
                .lock()
                .unwrap()
                .revisions
                .values()
                .cloned()
                .collect::<Vec<_>>();
            records.extend(received);
            b.node.publish(records).unwrap();
        }
        assert_eq!(b.node.data.lock().unwrap().revisions.len(), 305);
        for _ in 0..4 {
            let received = c.node.pull().await.unwrap();
            let mut records = c
                .node
                .data
                .lock()
                .unwrap()
                .revisions
                .values()
                .cloned()
                .collect::<Vec<_>>();
            records.extend(received);
            c.node.publish(records).unwrap();
        }
        assert_eq!(
            a.node.data.lock().unwrap().root,
            c.node.data.lock().unwrap().root
        );
        let aid = a.node.status()["id"].as_str().unwrap().to_owned();
        b.node.revoke(&aid).unwrap();
        let peer = a
            .node
            .data
            .lock()
            .unwrap()
            .vault
            .peers
            .values()
            .next()
            .unwrap()
            .clone();
        assert!(a.node.rpc(&peer, json!({"op":"status"})).await.is_err());
    }
    #[tokio::test]
    async fn wrong_codes_rate_limit_and_restart_credentials() {
        let saved = Arc::new(Mutex::new(String::new()));
        let copy = saved.clone();
        let b = Node::start(
            Uuid::new_v4().to_string(),
            "b".into(),
            Vault::default(),
            Arc::new(move |v| {
                *copy.lock().unwrap() = v.into();
                Ok(())
            }),
            0,
            false,
        )
        .await
        .unwrap();
        let a = device().await;
        let fixed = b.node.codes()["fixed"].as_str().unwrap().to_string();
        let wrong = if fixed == "00000000" {
            "11111111"
        } else {
            "00000000"
        };
        for _ in 0..5 {
            assert!(a.node.pair(&url(&b), "fixed", wrong).await.is_err());
        }
        assert!(a.node.pair(&url(&b), "fixed", &fixed).await.is_err());
        let vault: Vault = serde_json::from_str(&saved.lock().unwrap()).unwrap();
        assert_eq!(vault.attempts.len(), 5);
        assert_eq!(vault.fixed, fixed);
        let id = b.node.status()["id"].as_str().unwrap().to_string();
        drop(b);
        let restarted = Node::start(id, "b".into(), vault, Arc::new(|_| Ok(())), 0, false)
            .await
            .unwrap();
        assert!(a
            .node
            .pair(&url(&restarted), "fixed", &fixed)
            .await
            .is_err());
    }
    #[test]
    fn envelope_binds_identity_direction_and_request() {
        let key = [42; 32];
        let body = json!({"secret":"value"});
        let mut packet = seal(&key, "a", "b", "request", "id", &body).unwrap();
        assert_eq!(
            unseal(&key, &packet, "a", "b", "request", "id").unwrap(),
            body
        );
        assert!(unseal(&key, &packet, "a", "b", "request", "other").is_err());
        assert!(unseal(&key, &packet, "b", "a", "request", "id").is_err());
        packet["data"] = json!("00000000000000000000000000000000");
        assert!(unseal(&key, &packet, "a", "b", "request", "id").is_err());
    }
    #[test]
    fn endpoints_reject_public_redirect_credentials_and_paths() {
        for url in [
            "http://example.com:47831",
            "https://192.168.1.2",
            "http://1.1.1.1:47831",
            "http://user:pass@192.168.1.2",
            "http://192.168.1.2/path",
            "http://192.168.1.2/?query",
        ] {
            assert!(endpoint(url).is_err(), "{url}");
        }
        assert!(endpoint("http://100.64.0.5:47831").is_ok());
    }
    #[tokio::test]
    async fn failed_secret_save_does_not_grant_trust_and_rotation_clears_pending() {
        let b = Node::start(
            Uuid::new_v4().to_string(),
            "b".into(),
            Vault::default(),
            Arc::new(|_| Err("keychain unavailable".into())),
            0,
            false,
        )
        .await
        .unwrap();
        let a = device().await;
        assert!(a
            .node
            .pair(
                &url(&b),
                "dynamic",
                b.node.codes()["dynamic"].as_str().unwrap()
            )
            .await
            .is_err());
        assert!(b.node.data.lock().unwrap().vault.peers.is_empty());
        let c = device().await;
        let codes = c.node.codes();
        let a_id = a.node.status()["id"].as_str().unwrap().to_string();
        let b_id = c.node.status()["id"].as_str().unwrap().to_string();
        let (p, msg) = Spake2::<Ed25519Group>::start_a(
            &Password::new(codes["dynamic"].as_str().unwrap().as_bytes()),
            &Identity::new(a_id.as_bytes()),
            &Identity::new(b_id.as_bytes()),
        );
        let am = hex::encode(msg);
        let start = a
            .node
            .request(
                &url(&c),
                "/pair/start",
                Some(
                    json!({"id":a_id,"name":"a","mode":"dynamic","message":am,"port":a.node.port}),
                ),
            )
            .await
            .unwrap();
        let key = p
            .finish(&hex::decode(start["message"].as_str().unwrap()).unwrap())
            .unwrap();
        let ctx = context(
            &a_id,
            &b_id,
            "dynamic",
            start["session"].as_str().unwrap(),
            &am,
            start["message"].as_str().unwrap(),
        );
        c.node.rotate(false).unwrap();
        assert!(a
            .node
            .request(
                &url(&c),
                "/pair/finish",
                Some(
                    json!({"session":start["session"],"proof":proof(&key,&format!("client:{ctx}"))})
                )
            )
            .await
            .is_err());
    }
    #[tokio::test]
    async fn oversized_records_and_tampered_ids_are_reported() {
        let a = device().await;
        let b = device().await;
        pair(&a, &b, "fixed").await;
        a.node.publish(vec![record(1)]).unwrap();
        b.node
            .publish(vec![
                json!({"revisionId":"revision-000001","payload":{"text":"tampered"}}),
            ])
            .unwrap();
        assert!(b.node.pull().await.unwrap().is_empty());
        assert!(b.node.status()["peers"][0]["error"]
            .as_str()
            .unwrap()
            .contains("内容变化"));
        let c = device().await;
        pair(&c, &a, "fixed").await;
        a.node
            .publish(vec![
                json!({"revisionId":"large", "payload":{"text":"x".repeat(MAX_RECORD)}}),
            ])
            .unwrap();
        assert!(c.node.pull().await.unwrap().is_empty());
        assert!(!c.node.status()["peers"][0]["error"]
            .as_str()
            .unwrap()
            .is_empty());
    }
}

/// The OS credential manager holds only this wrapping key; the encrypted vault can grow.
pub fn storage_key() -> String {
    random_hex(32)
}
pub fn encrypt_vault(key: &str, id: &str, vault: &str) -> Result<String> {
    let key = hex::decode(key).map_err(|_| "凭据密钥损坏")?;
    Ok(seal(&key, id, id, "vault", "storage", &json!({"vault":vault}))?.to_string())
}
pub fn decrypt_vault(key: &str, id: &str, encrypted: &str) -> Result<String> {
    let key = hex::decode(key).map_err(|_| "凭据密钥损坏")?;
    let v = serde_json::from_str(encrypted).map_err(|_| "凭据文件损坏")?;
    let value = unseal(&key, &v, id, id, "vault", "storage")?;
    Ok(field(&value, "vault")?.to_owned())
}

#[cfg(test)]
mod discovery_tests {
    use super::*;
    #[tokio::test]
    #[ignore = "requires multicast and OS firewall approval; run explicitly on network test hosts"]
    async fn mdns_discovers_two_real_tcp_nodes_and_reuses_pairing_after_restart() {
        let saved = Arc::new(Mutex::new(String::new()));
        let copy = saved.clone();
        let a = Node::start(
            Uuid::new_v4().to_string(),
            "discovery-a".into(),
            Vault::default(),
            Arc::new(|_| Ok(())),
            0,
            true,
        )
        .await
        .unwrap();
        let id = Uuid::new_v4().to_string();
        let b = Node::start(
            id.clone(),
            "discovery-b".into(),
            Vault::default(),
            Arc::new(move |v| {
                *copy.lock().unwrap() = v.into();
                Ok(())
            }),
            0,
            true,
        )
        .await
        .unwrap();
        let target = tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let status = a.node.status();
                if let Some(c) = status["candidates"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|c| c["id"] == id)
                {
                    break c["url"].as_str().unwrap().to_string();
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .expect("mDNS discovery");
        assert!(target.starts_with("http://"));
        a.node
            .pair(&target, "fixed", b.node.codes()["fixed"].as_str().unwrap())
            .await
            .unwrap();
        let vault: Vault = serde_json::from_str(&saved.lock().unwrap()).unwrap();
        drop(b);
        let restarted = Node::start(
            id.clone(),
            "discovery-b".into(),
            vault,
            Arc::new(|_| Ok(())),
            0,
            false,
        )
        .await
        .unwrap();
        let ip = reqwest::Url::parse(&target)
            .unwrap()
            .host_str()
            .unwrap()
            .to_owned();
        let new_url = format!("http://{ip}:{}", restarted.node.port);
        a.node.discover(&new_url, "mdns").await.unwrap();
        assert_eq!(a.node.status()["peers"][0]["url"], new_url);
        restarted
            .node
            .publish(vec![json!({"revisionId":"restart-test","value":true})])
            .unwrap();
        assert_eq!(a.node.pull().await.unwrap().len(), 1);
    }
    #[test]
    fn encrypted_vault_detects_tampering_and_wrong_identity() {
        let key = storage_key();
        let encrypted = encrypt_vault(&key, "device", "private credentials").unwrap();
        assert!(!encrypted.contains("private credentials"));
        assert_eq!(
            decrypt_vault(&key, "device", &encrypted).unwrap(),
            "private credentials"
        );
        assert!(decrypt_vault(&key, "other", &encrypted).is_err());
        assert!(decrypt_vault(&storage_key(), "device", &encrypted).is_err());
    }
}
