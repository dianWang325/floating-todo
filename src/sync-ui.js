import { conflicts, resolveConflict, writeRevision } from './sync-model.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const typeName = { task: '待办', projects: '项目', tags: '标签', memo: '备忘录', completion: '打卡', order: '排序' };
function panel(title) {
  const overlay = document.createElement('div'); overlay.className = 'overlay sync-overlay';
  overlay.innerHTML = `<div class="settings sync-settings"><h2>${esc(title)}</h2><div data-sync-body></div><button type="button" class="link-btn" data-sync-close>关闭</button></div>`;
  overlay.addEventListener('click', e => { if (e.target === overlay || e.target.closest('[data-sync-close]')) overlay.remove(); });
  document.body.append(overlay); return overlay;
}
function message(overlay, text, error = false) { const element = overlay.querySelector('[data-sync-message]'); element.textContent = text; element.classList.toggle('sync-error', error); }
export function openSyncSettings(store) {
  const overlay = panel('WebDAV 同步'), s = store.doc.sync;
  overlay.querySelector('[data-sync-body]').innerHTML = `
    <p class="sync-help">本地保存，联网后合并。两台设备填写相同的地址和空间名称。时区：Asia/Shanghai。</p>
    <label class="sync-field">WebDAV 地址<input type="url" data-sync-url placeholder="https://服务器/dav/" value="${esc(s.url)}" autocomplete="off"></label>
    <label class="sync-field">用户名<input data-sync-user value="${esc(s.username)}" autocomplete="username"></label>
    <label class="sync-field">密码／应用专用密码<input data-sync-password type="password" placeholder="留空保留已保存密码" autocomplete="new-password"></label>
    <label class="sync-field">同步空间<input data-sync-space value="${esc(s.spaceId)}" maxlength="80"></label>
    <label class="sync-check"><input data-sync-enabled type="checkbox" ${s.enabled ? 'checked' : ''}>自动同步</label>
    <p class="sync-help">密码保存到系统凭据存储。远端 JSON 未加密，服务端可以读取内容。更换空间会合并本机数据与目标空间数据。</p>
    <div class="sync-actions"><button class="data-btn" data-sync-save>保存设置</button><button class="data-btn" data-sync-test>测试连接</button><button class="data-btn" data-sync-now>立即同步</button></div>
    <p class="sync-status" data-sync-status role="status"></p><p class="sync-error" data-sync-message role="alert"></p>
    <button class="data-btn" data-sync-conflicts>查看同步冲突</button>`;
  const update = () => {
    if (!overlay.isConnected) return;
    const status = store.status();
    overlay.querySelector('[data-sync-status]').textContent = `${status.busy ? '正在同步' : status.enabled ? '自动同步已开启' : '自动同步已关闭'} · 待上传 ${status.pending} · 冲突 ${status.conflicts}\n上次成功：${status.lastSuccess ? new Date(status.lastSuccess).toLocaleString('zh-CN', { hour12: false }) : '尚未同步'}${status.error ? '\n' + status.error : ''}`;
  };
  const listener = () => update(); window.addEventListener('todo-sync-status', listener);
  const observer = new MutationObserver(() => { if (!overlay.isConnected) { window.removeEventListener('todo-sync-status', listener); observer.disconnect(); } }); observer.observe(document.body, { childList: true });
  update();
  const save = async () => {
    await store.configure({ url: overlay.querySelector('[data-sync-url]').value.trim(), username: overlay.querySelector('[data-sync-user]').value.trim(), spaceId: overlay.querySelector('[data-sync-space]').value.trim(), enabled: overlay.querySelector('[data-sync-enabled]').checked }, overlay.querySelector('[data-sync-password]').value);
    overlay.querySelector('[data-sync-password]').value = '';
  };
  overlay.addEventListener('click', async e => {
    const button = e.target.closest('[data-sync-save], [data-sync-test], [data-sync-now], [data-sync-conflicts]'); if (!button) return;
    if (button.hasAttribute('data-sync-conflicts')) { overlay.remove(); openConflicts(store); return; }
    button.disabled = true; message(overlay, '');
    try {
      await save();
      if (button.hasAttribute('data-sync-test')) {
        const response = await store.request('', 'PROPFIND');
        if (response.status !== 207) throw new Error(`连接测试失败（${response.status}）`);
        message(overlay, '连接及目录读取成功；创建和写入权限将在同步时验证。');
      } else if (button.hasAttribute('data-sync-now')) { await store.sync(true); message(overlay, '同步完成'); }
      else message(overlay, '设置已保存');
    } catch (error) { message(overlay, String(error.message || error), true); }
    finally { button.disabled = false; update(); }
  });
}
function describe(r, store) {
  const p = r.payload;
  if (r.entityType === 'task') return `${p.title}\n${p.detail || ''}\n${p.kind === 'daily' ? '每天' : p.scheduledDate} ${p.time || ''}\n${p.completed ? '已完成' : '未完成'}\n项目：${store.view.projects.find(x => x.id === p.projectId)?.name || (p.projectId ? '已删除项目' : '无')}\n标签：${p.tagIds.map(id => store.view.tags.find(x => x.id === id)?.name || '已删除标签').join('、') || '无'}`;
  if (r.entityType === 'memo') return p.text;
  if (r.entityType === 'completion') return `${p.date} ${p.completed ? '已打卡' : '未打卡'}`;
  if (r.entityType === 'order') return `排序位置：${p.position}`;
  return `${p.name} · ${p.color}`;
}
export function openConflicts(store) {
  const overlay = panel('同步冲突'), body = overlay.querySelector('[data-sync-body]');
  const list = conflicts(store.doc);
  body.innerHTML = '<p class="sync-help">最新修改已生效。其他版本保留，可替换、编辑或另存。正常的先后编辑不会显示在这里。</p><p data-sync-message class="sync-error" role="alert"></p>';
  if (!list.length) body.insertAdjacentHTML('beforeend', '<p>暂无待处理冲突。</p>');
  for (const conflict of list) {
    const group = document.createElement('section'); group.className = 'sync-conflict';
    group.innerHTML = `<h3>${esc(typeName[conflict.winner.entityType])} · ${esc(conflict.winner.payload.title || conflict.winner.payload.name || conflict.winner.payload.date || '')}</h3>`;
    for (const r of [...conflict.heads].reverse()) {
      const card = document.createElement('article'); card.className = 'sync-version';
      card.innerHTML = `<strong>${r.revisionId === conflict.winner.revisionId ? '当前生效' : '其他版本'}${r.deleted ? ' · 已删除' : ''}</strong><p class="sync-help">${r.modifiedAt ? esc(new Date(r.modifiedAt).toLocaleString('zh-CN', { hour12: false })) : '旧版迁移，修改时间未知'} · ${esc(r.deviceId.slice(0, 8))}</p><pre>${esc(describe(r, store))}</pre><div class="sync-actions"><button class="link-btn" data-resolve>${r.revisionId === conflict.winner.revisionId ? '保留此版本' : '替换为此版本'}</button><button class="link-btn" data-edit>编辑后保存</button>${r.entityType === 'task' ? '<button class="link-btn" data-copy>另存为新任务</button>' : ''}</div>`;
      card.addEventListener('click', async e => {
        const action = e.target.closest('[data-resolve], [data-edit], [data-copy]'); if (!action) return;
        try {
          if (action.hasAttribute('data-edit')) { editVersion(store, conflict, r, () => { overlay.remove(); openConflicts(store); }); return; }
          if (action.hasAttribute('data-copy')) {
            const payload = { ...structuredClone(r.payload), id: crypto.randomUUID(), createdAt: Date.now() };
            writeRevision(store.doc, 'task', payload.id, payload);
          } else {
            const latest = conflicts(store.doc).find(c => c.key === conflict.key);
            if (!latest || latest.heads.map(r => r.revisionId).sort().join() !== conflict.heads.map(r => r.revisionId).sort().join()) throw new Error('冲突状态已变化，请重新打开');
            resolveConflict(store.doc, conflict.key, r);
          }
          await store.changed(); overlay.remove(); openConflicts(store);
        } catch (error) { message(overlay, String(error.message || error), true); }
      }); group.append(card);
    }
    body.append(group);
  }
}
function editVersion(store, conflict, revision, done) {
  const overlay = panel('编辑冲突版本'), body = overlay.querySelector('[data-sync-body]'), p = revision.payload;
  const field = (name, label, value, type = 'text') => `<label class="sync-field">${label}<input data-field="${name}" type="${type}" value="${esc(value)}"></label>`;
  let fields = '';
  if (revision.entityType === 'task') {
    fields = field('title', '标题', p.title) + `<label class="sync-field">详情<textarea data-field="detail">${esc(p.detail)}</textarea></label>` + (p.kind === 'one_off' ? field('scheduledDate', '日期', p.scheduledDate, 'date') : '') + field('time', '提醒时间', p.time, 'time');
    fields += `<label class="sync-field">项目<select data-field="projectId"><option value="">无项目</option>${store.view.projects.map(x => `<option value="${esc(x.id)}" ${x.id === p.projectId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>`;
    fields += `<label class="sync-field">标签（可多选）<select multiple data-field="tagIds">${store.view.tags.map(x => `<option value="${esc(x.id)}" ${p.tagIds.includes(x.id) ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>`;
  } else if (revision.entityType === 'memo') fields = `<label class="sync-field">正文<textarea data-field="text">${esc(p.text)}</textarea></label>`;
  else if (['projects', 'tags'].includes(revision.entityType)) fields = field('name', '名称', p.name) + field('color', '颜色', p.color, 'color');
  else if (revision.entityType === 'order') fields = field('position', '排序位置', p.position, 'number');
  if (revision.entityType === 'completion' || (revision.entityType === 'task' && p.kind === 'one_off')) fields += `<label class="sync-check"><input data-field="completed" type="checkbox" ${p.completed ? 'checked' : ''}>已完成</label>`;
  body.innerHTML = fields + '<p class="sync-help">保存后会替换当前内容，并处理此事项已显示的冲突。</p><p data-sync-message class="sync-error"></p><button class="data-btn" data-save-version>保存并同步</button>';
  body.querySelector('[data-save-version]').onclick = async () => {
    try {
      const latest = conflicts(store.doc).find(c => c.key === conflict.key);
      if (!latest || latest.heads.map(r => r.revisionId).sort().join() !== conflict.heads.map(r => r.revisionId).sort().join()) throw new Error('冲突状态已变化，请重新打开');
      const payload = structuredClone(p);
      body.querySelectorAll('[data-field]').forEach(input => { payload[input.dataset.field] = input.dataset.field === 'tagIds' ? [...input.selectedOptions].map(option => option.value) : input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value; });
      if ('projectId' in payload && !payload.projectId) payload.projectId = null;
      if ('title' in payload && !payload.title.trim()) throw new Error('标题不能为空');
      if ('time' in payload && !payload.time) payload.time = null;
      writeRevision(store.doc, revision.entityType, revision.entityId, payload, { resolve: true });
      await store.changed(); overlay.remove(); done();
    } catch (error) { message(overlay, String(error.message || error), true); }
  };
}
export function confirmImport(counts, apply) {
  const overlay = panel('导入备份预览');
  overlay.querySelector('[data-sync-body]').innerHTML = `<p>新增 ${counts.added} 项，修改 ${counts.updated} 项，删除 ${counts.deleted} 项。</p><p class="sync-help">统计包含任务、分类、打卡和排序记录。备份内容作为新的修改合并，本机独有事项保留，设备设置保留。</p><p data-sync-message class="sync-error"></p><button class="data-btn" data-import-confirm>确认导入</button>`;
  overlay.querySelector('[data-import-confirm]').onclick = async e => {
    e.target.disabled = true;
    try { await apply(); overlay.remove(); } catch (error) { message(overlay, String(error.message || error), true); e.target.disabled = false; }
  };
}
