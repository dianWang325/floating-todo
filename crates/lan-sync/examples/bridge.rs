//! Stdin-only test controller for the same library linked into the desktop app.
//! Uses synthetic data and an in-memory credential sink; never ship as an app service.
use floating_todo_lan::{Node, Vault};
use serde_json::{json, Value};
use std::{
    io::{self, BufRead, Write},
    sync::Arc,
};
#[tokio::main(worker_threads = 2)]
async fn main() {
    let runtime = Node::start(
        uuid::Uuid::new_v4().to_string(),
        "native-lan-test".into(),
        Vault::default(),
        Arc::new(|_| Ok(())),
        std::env::var("LAN_TEST_PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0),
        true,
    )
    .await
    .unwrap();
    for line in io::stdin().lock().lines() {
        let result = async {
            let v: Value = serde_json::from_str(&line.map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            let n = &runtime.node;
            match v["op"].as_str().unwrap_or("") {
                "status" => Ok(n.status()),
                "metrics" => {
                    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
                    let stat = std::fs::read_to_string("/proc/self/stat").unwrap_or_default();
                    let fields: Vec<_> = stat.split_whitespace().collect();
                    let ticks = [13, 14]
                        .iter()
                        .map(|i| {
                            fields
                                .get(*i)
                                .and_then(|v| v.parse::<u64>().ok())
                                .unwrap_or(0)
                        })
                        .sum::<u64>();
                    let rss = status
                        .lines()
                        .find(|l| l.starts_with("VmRSS:"))
                        .and_then(|l| l.split_whitespace().nth(1))
                        .and_then(|v| v.parse::<u64>().ok());
                    Ok(json!({"rssKiB":rss,"cpuTicks":ticks}))
                }
                "codes" => Ok(n.codes()),
                "publish" => {
                    n.publish(v["revisions"].as_array().ok_or("records")?.clone())?;
                    Ok(json!(true))
                }
                "pull" => Ok(json!(n.pull().await?)),
                "discover" => {
                    n.discover(v["url"].as_str().ok_or("url")?, "manual")
                        .await?;
                    Ok(n.status())
                }
                "pair" => {
                    n.pair(
                        v["url"].as_str().ok_or("url")?,
                        v["mode"].as_str().ok_or("mode")?,
                        v["code"].as_str().ok_or("code")?,
                    )
                    .await?;
                    Ok(json!(true))
                }
                "revoke" => {
                    n.revoke(v["id"].as_str().ok_or("id")?)?;
                    Ok(json!(true))
                }
                _ => Err("operation".to_string()),
            }
        }
        .await;
        println!(
            "{}",
            match result {
                Ok(v) => json!({"value":v}),
                Err(e) => json!({"error":e}),
            }
        );
        io::stdout().flush().unwrap();
    }
}
