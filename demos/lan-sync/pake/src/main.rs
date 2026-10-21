use serde_json::{json, Value};
use spake2::{Ed25519Group, Identity, Password, Spake2};
use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::time::{Duration, Instant};

// A bounded, local stdin/stdout worker. No network or secret logging.
fn main() {
    let mut states: HashMap<String, (Instant, Spake2<Ed25519Group>)> = HashMap::new();
    for line in io::stdin().lock().lines() {
        let result = (|| -> Result<Value, String> {
            let line = line.map_err(|_| "input")?;
            if line.len() > 8192 { return Err("oversize".into()); }
            let v: Value = serde_json::from_str(&line).map_err(|_| "json")?;
            let field = |k: &str| v[k].as_str().ok_or_else(|| format!("missing {k}"));
            let id = field("id")?.to_owned();
            states.retain(|_, (t, _)| t.elapsed() < Duration::from_secs(30));
            match field("op")? {
                "start" => {
                    if states.len() >= 32 { return Err("busy".into()); }
                    let pw = Password::new(field("code")?.as_bytes());
                    let a = Identity::new(field("a")?.as_bytes());
                    let b = Identity::new(field("b")?.as_bytes());
                    let (s, msg) = if field("role")? == "a" {
                        Spake2::<Ed25519Group>::start_a(&pw, &a, &b)
                    } else {
                        Spake2::<Ed25519Group>::start_b(&pw, &a, &b)
                    };
                    states.insert(id, (Instant::now(), s));
                    Ok(json!({"message": hex::encode(msg)}))
                }
                "finish" => {
                    let (_, s) = states.remove(&id).ok_or("expired")?;
                    let msg = hex::decode(field("message")?).map_err(|_| "hex")?;
                    let key = s.finish(&msg).map_err(|_| "exchange")?;
                    Ok(json!({"key": hex::encode(key)}))
                }
                _ => Err("operation".into()),
            }
        })();
        let response = match result { Ok(v) => v, Err(e) => json!({"error": e}) };
        println!("{response}");
        let _ = io::stdout().flush();
    }
}
