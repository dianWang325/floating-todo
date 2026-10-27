export const RELEASES_URL = 'https://github.com/dianWang325/floating-todo/releases';
const INTERVAL = 6 * 60 * 60 * 1000;

export function createUpdateChecker({ invoke, openExternal, notice }) {
  let result = null;
  let installedVersion = '';
  let versionRequest = null;
  let versionError = false;
  let pending = null;
  let error = '';
  let notifiedVersion = '';
  let timer;
  const panels = new Set();

  function refresh() {
    document.body.classList.toggle('update-available', !!result?.version);
    for (const panel of panels) {
      if (!panel.isConnected) { panels.delete(panel); continue; }
      panel.querySelector('[data-installed-version]').textContent = installedVersion || (
        !invoke ? '仅桌面应用可用' : versionError ? '读取失败，请重新打开设置' : '读取中…');
      panel.querySelector('[data-update-status]').textContent = pending ? '正在检查更新…' : error || (
        result?.version ? `发现新版本 ${result.version}` :
          result ? '暂无更新' : '启动时及每 6 小时自动检查');
      panel.querySelector('[data-update-check]').disabled = !!pending || !invoke;
      panel.querySelector('[data-update-open]').textContent = result?.version ? '前往下载新版' : '查看 Releases';
    }
  }

  function check() {
    if (pending) return pending;
    if (!invoke) { error = '请在桌面应用中检查更新'; refresh(); return Promise.resolve(); }
    error = '';
    pending = Promise.resolve().then(() => invoke('check_for_updates')).then(value => {
      if (!value || typeof value.currentVersion !== 'string') throw new Error('更新信息不可用');
      result = value;
      if (result.version && result.version !== notifiedVersion) {
        notifiedVersion = result.version;
        notice(`发现新版本 ${result.version}，可在设置 → 应用更新中下载`);
      }
    }).catch(reason => {
      error = `检查失败：${String(reason?.message || reason)}`;
    }).finally(() => { pending = null; refresh(); });
    refresh();
    return pending;
  }

  function loadInstalledVersion() {
    if (!invoke || installedVersion || versionRequest) return;
    versionError = false;
    versionRequest = Promise.resolve().then(() => invoke('installed_version')).then(version => {
      if (typeof version !== 'string' || !version) throw new Error('版本信息不可用');
      installedVersion = version;
    }).catch(() => { versionError = true; }).finally(() => {
      versionRequest = null;
      refresh();
    });
  }

  function mount(panel) {
    panel.innerHTML = `<h3>应用更新</h3>
      <div class="set-row"><span>当前安装版本</span><span data-installed-version style="user-select:text;overflow-wrap:anywhere"></span></div>
      <p data-update-status role="status" style="font-size:12px;overflow-wrap:anywhere"></p>
      <p style="font-size:11px;color:var(--text-secondary)">更新来源：dianWang325/floating-todo Releases</p>
      <div class="set-row" style="gap:8px">
        <button class="data-btn" data-update-check>检查更新</button>
        <button class="data-btn" data-update-open>查看 Releases</button>
      </div>`;
    panels.add(panel);
    loadInstalledVersion();
    panel.querySelector('[data-update-check]').onclick = check;
    panel.querySelector('[data-update-open]').onclick = () => openExternal(result?.url || RELEASES_URL);
    refresh();
  }

  return {
    mount, check,
    start() {
      if (!invoke || timer) return;
      // Give application startup and storage migration time to finish first.
      timer = setTimeout(() => { check(); timer = setInterval(check, INTERVAL); }, 5000);
    },
    stop() { clearTimeout(timer); clearInterval(timer); timer = null; },
  };
}
