import { currentEntities, dateInZone, shiftDate } from './sync-model.js';
import { tasksOnDate, completionHistory, monthDates, toggleTask, createTask, updateTask, taskEvents } from './planner-model.js';
import { snoozeReminder } from './reminders.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const leads = value => [0, 5, 10, 15, 30, 60, 1440].map(n => `<option value="${n}" ${n === value ? 'selected' : ''}>${n ? `提前 ${n === 1440 ? '1 天' : n + ' 分钟'}` : '到点提醒'}</option>`).join('');

// One authoritative store: expanding the existing window avoids competing SQLite writers.
export function createPlanner({ store, beforeOpen, notify, nativeWindow, windowApi }) {
  let host, mode = 'calendar', date, month, from, to, query = '', project = '', busy = false, editing = null, restoreSize, restorePosition, previousFocus;
  const today = () => dateInZone(store.doc.sync.timeZone);
  const projects = value => `<option value="">${value === undefined ? '全部项目' : '无项目'}</option>` + [...currentEntities(store.doc).values()].filter(r => r.entityType === 'projects' && !r.deleted).map(r => `<option value="${esc(r.entityId)}" ${r.entityId === value ? 'selected' : ''}>${esc(r.payload.name)}</option>`).join('');
  const stamp = t => t.completedAt ? new Intl.DateTimeFormat('zh-CN', { timeZone: store.doc.sync.timeZone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(t.completedAt)) : '旧记录：完成时间未知';

  function row(t, history = false) {
    return `<article class="planner-task ${t.completed || history ? 'is-done' : ''}" data-planner-task="${esc(t.id)}">
      <button type="button" class="planner-check" data-p="toggle" data-id="${esc(t.id)}" data-date="${esc(t.date)}" aria-label="${t.completed || history ? '重新打开' : '完成'} ${esc(t.title)}" ${t.deleted ? 'disabled' : ''}>${t.completed || history ? '✓' : '○'}</button>
      <div class="planner-task-body"><strong>${esc(t.title)}</strong><small>${history ? `${esc(t.date)} · ${esc(stamp(t))}` : `${t.time || '全天'}${t.kind === 'daily' ? ' · 每天打卡' : ''}`}${t.archivedAt ? ' · 已归档' : ''}${t.deleted ? ' · 已删除' : ''}</small>${t.detail ? `<p>${esc(t.detail)}</p>` : ''}</div>
      ${t.deleted ? '' : `<button type="button" data-p="edit" data-id="${esc(t.id)}" aria-label="编辑 ${esc(t.title)}">编辑</button>`}
    </article>`;
  }

  function render() {
    if (!host) return;
    host.innerHTML = `<section class="planner-shell" role="dialog" aria-modal="true" aria-label="日历与回顾">
      <header class="planner-header"><div><h2>日历与回顾</h2><p>安排未来，也看见每一天的进展</p></div><button type="button" data-p="close" aria-label="关闭日历与回顾">返回待办 ×</button></header>
      <nav class="planner-tabs" aria-label="视图"><button data-p="mode" data-mode="calendar" aria-pressed="${mode === 'calendar'}">日历</button><button data-p="mode" data-mode="history" aria-pressed="${mode === 'history'}">完成记录</button><button data-p="mode" data-mode="reminders" aria-pressed="${mode === 'reminders'}">提醒中心</button></nav>
      <div class="planner-content">${mode === 'calendar' ? calendar() : mode === 'history' ? history() : reminders()}</div>
      <p class="planner-status" role="status"></p>
      <footer class="planner-footer">日期时区：${esc(store.doc.sync.timeZone)} · 历史记录从保留的数据起算，旧版已丢弃的任务无法自动恢复。</footer>
    </section>`;
    host.querySelectorAll('button').forEach(b => { if (busy) b.disabled = true; });
  }

  function calendar() {
    const current = currentEntities(store.doc), dates = monthDates(month), rows = tasksOnDate(store.doc, date, current);
    return `<div class="planner-calendar-layout"><section><div class="planner-month-nav"><button data-p="month" data-step="-1" aria-label="上个月">‹</button><h3>${esc(month)}</h3><button data-p="month" data-step="1" aria-label="下个月">›</button><button data-p="today">今天</button></div>
      <div class="planner-weekdays">${['一', '二', '三', '四', '五', '六', '日'].map(d => `<span>${d}</span>`).join('')}</div>
      <div class="planner-grid">${dates.map(d => {
        const items = tasksOnDate(store.doc, d, current), done = items.filter(t => t.completed).length;
        return `<button class="planner-day ${d.slice(0, 7) !== month ? 'outside' : ''} ${d === today() ? 'today' : ''}" data-p="date" data-date="${d}" aria-pressed="${d === date}" aria-label="${d}，${done} 已完成，${items.length - done} 未完成"><span>${Number(d.slice(-2))}</span>${items.length ? `<small>${done} 完 / ${items.length - done} 待办</small>` : '<small> </small>'}</button>`;
      }).join('')}</div><p class="planner-help">按计划日期展示；完成记录按实际完成日期统计。</p></section>
      <section class="planner-agenda"><h3>${esc(date)} <small>${rows.filter(t => t.completed).length} / ${rows.length} 完成</small></h3>
      <form data-p-form="add" class="planner-add"><label>新待办<input name="title" required maxlength="500" placeholder="这一天想完成什么？"></label><div class="planner-form-row"><label>时间<input name="time" type="time" aria-label="新任务时间"></label><label>提醒<select name="lead">${leads(0)}</select></label></div><label>项目<select name="project">${projects(null)}</select></label><button type="submit">添加到 ${esc(date)}</button></form>
      ${editing ? editor(current.get(`task:${editing}`)?.payload) : ''}
      <div class="planner-tasks">${rows.length ? rows.map(t => row(t)).join('') : '<p class="planner-empty">这一天还没有任务，留一点空间给自己。</p>'}</div></section></div>`;
  }

  function history() {
    const rows = completionHistory(store.doc, { from, to, query, project }), days = new Map();
    for (const t of rows) days.set(t.date, (days.get(t.date) || 0) + 1);
    return `<form data-p-form="filter" class="planner-filters"><label>起始日期<input name="from" type="date" value="${from}" required></label><label>结束日期<input name="to" type="date" value="${to}" required></label><label>搜索<input name="query" value="${esc(query)}" placeholder="标题或描述"></label><label>项目<select name="project">${projects(project || undefined)}</select></label><button type="submit">查询</button><button type="button" data-p="week">近 7 天</button></form>
      <div class="planner-summary"><strong>${rows.length}<span>次完成</span></strong><strong>${days.size}<span>个活跃日</span></strong><strong>${rows.filter(t => t.kind === 'daily').length}<span>次打卡</span></strong></div>
      <p class="planner-help">同一普通任务按当前完成状态计一次，重新打开后不计入；打卡按每天计一次。旧记录没有准确时间时按计划日期展示并标注。</p>
      ${editing ? editor(currentEntities(store.doc).get(`task:${editing}`)?.payload) : ''}
      <div class="planner-history">${rows.length ? [...days].map(([day, count]) => `<section><h3>${day}<small>${count} 次完成</small></h3>${rows.filter(t => t.date === day).map(t => row(t, true)).join('')}</section>`).join('') : '<p class="planner-empty">这个范围暂无完成记录。</p>'}</div>`;
  }

  function editor(t) {
    if (!t) { editing = null; return ''; }
    const events = taskEvents(store.doc, t.id);
    return `<form data-p-form="edit" class="planner-editor"><h4>编辑任务</h4><label>标题<input name="title" value="${esc(t.title)}" required maxlength="500"></label><label>描述<textarea name="detail">${esc(t.detail)}</textarea></label><div class="planner-form-row">${t.kind !== 'daily' ? `<label>计划日期<input name="date" type="date" value="${t.scheduledDate}" required></label>` : ''}<label>时间<input name="time" type="time" value="${t.time || ''}"></label></div><div class="planner-form-row"><label>提醒<select name="lead">${leads(t.remindLeadMinutes || 0)}</select></label><label>项目<select name="project">${projects(t.projectId)}</select></label></div><div class="planner-form-row"><button type="submit">保存修改</button><button type="button" data-p="cancel-edit">取消</button></div>${events.length ? `<details><summary>状态变更记录</summary>${events.map(e => `<p>${esc(new Date(e.at).toLocaleString('zh-CN', { timeZone: store.doc.sync.timeZone }))} · ${e.label}</p>`).join('')}</details>` : ''}</form>`;
  }

  function reminders() {
    const local = store.doc.local.reminders || {}, entries = Object.values(local.delivered || {}).sort((a, b) => b.sentAt - a.sentAt).slice(0, 50), current = currentEntities(store.doc);
    return `<section class="planner-reminders"><h3>本机提醒</h3><p>请保持应用在托盘运行，并允许系统通知。休眠或退出期间不能准时提醒，恢复运行后检查遗漏。系统免打扰可能隐藏通知。</p><label class="planner-enable"><input type="checkbox" data-p="reminders-enabled" ${store.doc.local.settings?.remindersEnabled !== false ? 'checked' : ''}>启用本机提醒</label><button data-p="test-notification">发送测试通知</button><p class="planner-help">提前提醒在日历中编辑任务时设置。以下是最近 50 条已发送提醒，可稍后 10 分钟再次提醒。</p>
      ${entries.length ? entries.map(item => `<article class="planner-task"><div class="planner-task-body"><strong>${esc(item.title)}</strong><small>${esc(item.date)} ${esc(item.time)} · ${esc(new Date(item.sentAt).toLocaleString('zh-CN', { timeZone: store.doc.sync.timeZone }))} 已发送</small></div><button data-p="snooze" data-key="${esc(item.key)}" ${!current.get(`task:${item.taskId}`) || current.get(`task:${item.taskId}`).deleted || current.get(`task:${item.taskId}`).payload.completed ? 'disabled' : ''}>${local.snoozes?.[item.key] ? '已延后 10 分钟' : '稍后 10 分钟'}</button></article>`).join('') : '<p class="planner-empty">还没有已发送的提醒。</p>'}</section>`;
  }

  async function mutate(action) {
    if (busy) return;
    busy = true;
    const before = structuredClone(store.doc);
    try { action(); await store.changed(); }
    catch (error) { store.doc = before; store.refresh(); notify(`保存失败：${error.message || error}`); }
    finally { busy = false; render(); }
  }

  async function close() {
    if (busy || !host) return;
    host.remove(); host = null;
    document.documentElement.classList.remove('planner-open');
    document.getElementById('panel').inert = false;
    try {
      if (nativeWindow && restoreSize) {
        await nativeWindow.setSize(restoreSize);
        await nativeWindow.setMaxSize(new windowApi.LogicalSize(460, 760));
        if (restorePosition) await nativeWindow.setPosition(restorePosition);
      }
    } catch (error) { notify(`窗口恢复失败：${error}`); }
    (previousFocus?.isConnected ? previousFocus : document.getElementById('main-input'))?.focus();
  }

  async function open(next = 'calendar') {
    if (host) return;
    beforeOpen(); mode = next; date = today(); month = date.slice(0, 7); from = shiftDate(date, -6); to = date; editing = null;
    previousFocus = document.activeElement;
    if (nativeWindow) {
      try {
        restoreSize = await nativeWindow.innerSize(); restorePosition = await nativeWindow.outerPosition();
        await nativeWindow.setMaxSize(new windowApi.LogicalSize(1200, 900));
        const monitor = await windowApi.currentMonitor();
        const scale = monitor?.scaleFactor || 1, area = monitor?.workArea || monitor;
        const width = Math.min(920, (area?.size.width || 1000 * scale) / scale - 40), height = Math.min(740, (area?.size.height || 820 * scale) / scale - 40);
        await nativeWindow.setSize(new windowApi.LogicalSize(width, height));
        if (area) await nativeWindow.setPosition(new windowApi.PhysicalPosition(area.position.x + Math.round((area.size.width - width * scale) / 2), area.position.y + Math.round((area.size.height - height * scale) / 2)));
      } catch (error) { notify(`日历以当前窗口尺寸显示：${error}`); }
    }
    host = document.createElement('div'); host.className = 'planner-overlay'; document.body.append(host);
    host.addEventListener('mousedown', event => { if (event.button === 0 && event.target.closest('.planner-header') && !event.target.closest('button')) nativeWindow?.startDragging().catch(error => notify(String(error))); });
    document.documentElement.classList.add('planner-open'); document.getElementById('panel').inert = true;
    host.addEventListener('click', async event => {
      const b = event.target.closest('[data-p]'); if (!b || busy) return;
      try {
        switch (b.dataset.p) {
          case 'close': await close(); break;
          case 'mode': mode = b.dataset.mode; editing = null; render(); break;
          case 'month': { const d = new Date(month + '-01T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + Number(b.dataset.step)); month = d.toISOString().slice(0, 7); render(); break; }
          case 'date': date = b.dataset.date; editing = null; render(); break;
          case 'today': date = today(); month = date.slice(0, 7); render(); break;
          case 'week': from = shiftDate(today(), -6); to = today(); render(); break;
          case 'toggle': await mutate(() => toggleTask(store.doc, b.dataset.id, b.dataset.date)); break;
          case 'edit': editing = b.dataset.id; render(); host.querySelector('.planner-editor input')?.focus(); break;
          case 'cancel-edit': editing = null; render(); break;
          case 'snooze': await mutate(() => snoozeReminder(store.doc, store.doc.local.reminders.delivered[b.dataset.key])); break;
          case 'test-notification': window.dispatchEvent(new Event('todo-test-notification')); break;
          case 'reminders-enabled': await mutate(() => { store.doc.local.settings.remindersEnabled = b.checked; }); break;
        }
      } catch (error) { notify(error.message || String(error)); }
    });
    host.addEventListener('submit', async event => {
      event.preventDefault(); if (busy) return;
      const form = event.target, data = Object.fromEntries(new FormData(form));
      if (form.dataset.pForm === 'filter') {
        if (data.from > data.to) { host.querySelector('.planner-status').textContent = '起始日期不能晚于结束日期'; return; }
        ({ from, to, query, project } = data); render(); return;
      }
      const values = { title: data.title, time: data.time || null, remindLeadMinutes: Number(data.lead), projectId: data.project || null };
      if (form.dataset.pForm === 'add') await mutate(() => createTask(store.doc, { ...values, scheduledDate: date }));
      else if (form.dataset.pForm === 'edit') await mutate(() => { updateTask(store.doc, editing, { ...values, detail: data.detail, ...(data.date ? { scheduledDate: data.date } : {}) }); editing = null; });
    });
    render(); host.querySelector('[data-p="close"]').focus();
  }
  document.addEventListener('keydown', event => {
    if (!host) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
    if (event.key === 'Tab') {
      const list = [...host.querySelectorAll('button, input, select, textarea, summary')].filter(e => !e.disabled && e.getClientRects().length);
      const first = list[0], last = list.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }, true);
  return { open, close, refresh: () => { if (host && !host.contains(document.activeElement)) render(); }, get active() { return !!host; } };
}
