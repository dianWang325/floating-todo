use semver::Version;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const RELEASES_API: &str = "https://api.github.com/repos/dianWang325/floating-todo/releases";
const RELEASES_URL: &str = "https://github.com/dianWang325/floating-todo/releases";

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    current_version: String,
    version: Option<String>,
    url: String,
}

fn select_release(current: &Version, releases: &[Release]) -> Option<Version> {
    releases
        .iter()
        .filter(|r| !r.draft)
        .filter_map(|r| {
            let version =
                Version::parse(r.tag_name.strip_prefix('v').unwrap_or(&r.tag_name)).ok()?;
            if current.pre.is_empty() && (r.prerelease || !version.pre.is_empty()) {
                return None;
            }
            (version.cmp_precedence(current).is_gt()).then_some(version)
        })
        .max_by(|a, b| a.cmp_precedence(b))
}

#[tauri::command]
pub fn installed_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub async fn check_for_updates(app: tauri::AppHandle) -> Result<UpdateStatus, String> {
    let current = app.package_info().version.clone();
    let client = reqwest::Client::builder()
        .user_agent(format!("floating-todo/{current}"))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| "无法创建更新检查连接".to_string())?;
    let mut releases = Vec::new();
    // Traverse pages so release publication order never substitutes for version ordering.
    for page in 1..=10 {
        let response = client
            .get(RELEASES_API)
            .query(&[("per_page", 100), ("page", page)])
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|_| "无法连接 GitHub，请检查网络后重试".to_string())?;
        let status = response.status();
        if !status.is_success() {
            return Err(match status.as_u16() {
                403 | 429 => "GitHub 请求受限，请稍后重试".to_string(),
                404 => "无法访问更新仓库，请确认仓库已公开".to_string(),
                _ => format!("更新检查失败（HTTP {status}）"),
            });
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|_| "读取更新信息失败".to_string())?;
        let batch: Vec<Release> = serde_json::from_slice(&bytes)
            .map_err(|_| "GitHub 返回了无法识别的更新信息".to_string())?;
        let complete = batch.len() < 100;
        releases.extend(batch);
        if complete {
            break;
        }
        if page == 10 {
            return Err("发布记录过多，请前往 Releases 查看更新".to_string());
        }
    }
    let version = select_release(&current, &releases);
    let url = version
        .as_ref()
        .and_then(|v| {
            releases.iter().find(|r| {
                !r.draft
                    && Version::parse(r.tag_name.strip_prefix('v').unwrap_or(&r.tag_name))
                        .ok()
                        .as_ref()
                        == Some(v)
            })
        })
        .map(|r| format!("{RELEASES_URL}/tag/{}", r.tag_name))
        .unwrap_or_else(|| RELEASES_URL.to_string());
    Ok(UpdateStatus {
        current_version: current.to_string(),
        version: version.map(|v| v.to_string()),
        url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn release(tag: &str, prerelease: bool, draft: bool) -> Release {
        Release {
            tag_name: tag.into(),
            prerelease,
            draft,
        }
    }
    #[test]
    fn selects_semantic_maximum_and_respects_channels() {
        let releases = vec![
            release("v0.4.0-rc.10", true, false),
            release("v0.4.0-rc.6", true, false),
            release("v0.3.9", false, false),
            release("v9.0.0", false, true),
            release("bad", false, false),
        ];
        assert_eq!(
            select_release(&Version::parse("0.4.0-rc.5").unwrap(), &releases)
                .unwrap()
                .to_string(),
            "0.4.0-rc.10"
        );
        assert_eq!(
            select_release(&Version::parse("0.3.8").unwrap(), &releases)
                .unwrap()
                .to_string(),
            "0.3.9"
        );
        assert!(select_release(&Version::parse("0.4.0").unwrap(), &releases).is_none());
    }
    #[test]
    fn stable_promotes_rc_and_build_metadata_is_not_an_update() {
        let releases = vec![
            release("0.4.0", false, false),
            release("v0.4.0+build.2", false, false),
        ];
        assert_eq!(
            select_release(&Version::parse("0.4.0-rc.5").unwrap(), &releases)
                .unwrap()
                .pre
                .as_str(),
            ""
        );
        assert!(select_release(&Version::parse("0.4.0+build.1").unwrap(), &releases).is_none());
        assert!(select_release(&Version::parse("0.4.0").unwrap(), &[]).is_none());
        assert!(select_release(
            &Version::parse("0.3.0").unwrap(),
            &[release("v0.5.0-rc.1", false, false)]
        )
        .is_none());
    }
}
