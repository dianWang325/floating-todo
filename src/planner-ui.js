import { currentEntities, dateInZone, shiftDate } from './sync-model.js';
import { tasksOnDate, completionHistory, monthDates, toggleTask, createTask, updateTask, taskEvents, calendarRange, timelineItems, formatMinutes, minutesOfDay, layoutTimedTasks } from './planner-model.js';
import { collections, saveCollection, removeCollection, matchesCollection, collectionId } from './collections.js';
import { snoozeReminder } from './reminders.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const collectionColors = [['红色','#ff3b30'],['橙色','#ff9500'],['黄色','#b58a00'],['绿色','#28a745'],['蓝色','#007aff'],['紫色','#af52de'],['灰色','#8e8e93']];
const leads = value => [0, 5, 10, 15, 30, 60, 1440].map(n => `<option value="${n}" ${n === value ? 'selected' : ''}>${n ? `提前 ${n === 1440 ? '1 天' : n + ' 分钟'}` : '到点提醒'}</option>`).join('');

// One authoritative store: expanding the existing window avoids competing SQLite writers.
export function createPlanner({ store, beforeOpen, notify, nativeWindow, windowApi, onModeChange = () => {} }) {
  let host, mode = 'calendar', date, month, from, to, query = '', project = '', busy = false, editing = null, restoreSize, restorePosition, restoreMaximized = false, previousFocus, opening = false;
  let view = 'month', rangeAnchor, hourHeight = 72, inspectorOpen = false, timelineScroll = null, maximizeBusy = false, activeDrag = null;
  const emptyDraft = () => ({ title: '', time: '', duration: '30', lead: '0', project: '' });
  let addDraft = emptyDraft(), editDraft = null, selectedCollection = '', collectionEditor = null, deletingCollection = false, contextMenu = null;
  const selectedTasks = (day, current) => tasksOnDate(store.doc, day, current).filter(t => matchesCollection(t, selectedCollection, store.doc));
  const selectedTimeline = (day, current) => layoutTimedTasks(timelineItems(store.doc, day, current).filter(t => matchesCollection(t, selectedCollection, store.doc)));
  const taskColor = task => collections(store.doc).find(c => c.id === collectionId(store.doc, task.projectId))?.color || '#8e8e93';
  const today = () => dateInZone(store.doc.sync.timeZone);
  const projects = value => `<option value="">${value === undefined ? '全部合集' : '未分类'}</option>` + collections(store.doc).map(c => `<option value="${esc(c.id)}" ${c.id === collectionId(store.doc, value) ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  const stamp = t => t.completedAt ? new Intl.DateTimeFormat('zh-CN', { timeZone: store.doc.sync.timeZone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(t.completedAt)) : '旧记录：完成时间未知';
  const weekday = d => new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', weekday: 'short' }).format(new Date(d + 'T12:00:00Z'));
  const persistPrefs = () => {
    store.doc.local.plannerPrefs = { ...store.doc.local.plannerPrefs, view, hourHeight };
    store.persist().catch(error => notify(`日历偏好保存失败：${error}`));
  };
  function captureDrafts() {
    const add = host?.querySelector('[data-p-form="add"]'), edit = host?.querySelector('[data-p-form="edit"]');
    if (add) addDraft = Object.fromEntries(new FormData(add));
    const collection = host?.querySelector('[data-p-form="collection"]');
    if (collection && collectionEditor) collectionEditor = { ...collectionEditor, ...Object.fromEntries(new FormData(collection)) };
    if (edit) editDraft = { ...Object.fromEntries(new FormData(edit)), id: editing };
  }

  function row(t, history = false) {
    return `<article class="planner-task ${t.completed || history ? 'is-done' : ''}" data-planner-task="${esc(t.id)}">
      <button type="button" class="planner-check" data-p="toggle" data-id="${esc(t.id)}" data-date="${esc(t.date)}" aria-label="${t.completed || history ? '重新打开' : '完成'} ${esc(t.title)}" ${t.deleted ? 'disabled' : ''}>${t.completed || history ? '✓' : '○'}</button>
      <div class="planner-task-body"><strong>${esc(t.title)}</strong><small>${history ? `${esc(t.date)} · ${esc(stamp(t))}` : `${t.time || '全天'}${t.kind === 'daily' ? ' · 每天打卡' : ''}`}${t.archivedAt ? ' · 已归档' : ''}${t.deleted ? ' · 已删除' : ''}</small>${t.detail ? `<p>${esc(t.detail)}</p>` : ''}</div>
      ${t.deleted ? '' : `<button type="button" data-p="edit" data-id="${esc(t.id)}" aria-label="编辑 ${esc(t.title)}">编辑</button>`}
    </article>`;
  }

  function sidebar() {
    const entries = collections(store.doc), current = currentEntities(store.doc);
    const count = id => [...current.values()].filter(r => r.entityType === 'task' && !r.deleted && !r.payload.completed && matchesCollection(r.payload, id, store.doc)).length;
    const item = (id, name, color) => `<button class="workspace-collection" data-p="collection" data-id="${esc(id)}" aria-pressed="${selectedCollection === id}" title="${esc(name)}" ${color ? 'aria-haspopup="menu"' : ''}>${color ? `<i style="background:${color}"></i>` : '<span>▤</span>'}<span>${esc(name)}</span><small>${count(id)}</small></button>`;
    return `<aside class="workspace-sidebar" aria-label="合集侧边栏"><div class="workspace-brand"><span>✓</span><strong>悬浮待办</strong></div>
      <nav class="workspace-nav" aria-label="主导航">${[['calendar','▦','日历'],['history','◷','完成记录'],['reminders','♧','提醒中心']].map(([key,icon,name]) => `<button data-p="mode" data-mode="${key}" aria-pressed="${mode === key}"><span>${icon}</span>${name}</button>`).join('')}</nav>
      <div class="workspace-collections-title"><strong>合集</strong><button data-p="collection-new" aria-label="新建合集">＋</button></div>
      <div class="workspace-collections">${item('', '全部任务')}${item('none', '未分类')}${entries.map(c => item(c.id,c.name,c.color)).join('')}</div>
      ${selectedCollection && selectedCollection !== 'none' ? '<button class="collection-manage" data-p="collection-edit">管理当前合集</button>' : ''}
      ${collectionEditor ? `<form data-p-form="collection" class="collection-editor"><strong>${collectionEditor.id ? '编辑合集' : '新建合集'}</strong><label>合集名称<input name="name" required maxlength="80" value="${esc(collectionEditor.name)}"></label><label>合集颜色<input name="color" type="color" value="${esc(collectionEditor.color)}"></label><div><button type="submit">保存合集</button><button type="button" data-p="collection-cancel">取消</button></div>${collectionEditor.id ? `<button type="button" data-p="collection-delete">${deletingCollection ? '确认删除合集，保留全部任务' : '删除合集'}</button>` : ''}</form>` : ''}
      <div class="workspace-mini-calendar">${miniCalendar(current)}</div><div class="workspace-sidebar-bottom"><button data-p="close">▧ 悬浮窗模式</button><button data-p="settings">⚙ 设置与同步</button></div></aside>`;
  }

  function contextMenuHTML() {
    if (!contextMenu) return '';
    const entry = collections(store.doc).find(c => c.id === contextMenu.id);
    if (!entry) { contextMenu = null; return ''; }
    return `<div class="collection-context" role="menu" aria-label="${esc(entry.name)}的颜色"><div class="collection-context-title">合集颜色 · ${esc(entry.name)}</div><div class="collection-color-options">${collectionColors.map(([name,color]) => `<button role="menuitemradio" aria-checked="${entry.color.toLowerCase() === color}" aria-label="${name}" data-p="collection-color" data-color="${color}"><i style="background:${color}">${entry.color.toLowerCase() === color ? '✓' : ''}</i><span>${name}</span></button>`).join('')}</div><label class="collection-custom-color">自定义颜色<input type="color" aria-label="自定义合集颜色" value="${entry.color}"></label></div>`;
  }
  function positionContextMenu() {
    const menu = host?.querySelector('.collection-context'); if (!menu || !contextMenu) return;
    menu.style.left = `${Math.max(12, Math.min(contextMenu.x, innerWidth - menu.offsetWidth - 12))}px`;
    menu.style.top = `${Math.max(12, Math.min(contextMenu.y, innerHeight - menu.offsetHeight - 12))}px`;
  }
  function dismissContextMenu(focus = false) {
    const id = contextMenu?.id; contextMenu = null; host?.querySelector('.collection-context')?.remove();
    if (focus && id) [...host.querySelectorAll('.workspace-collection')].find(b => b.dataset.id === id)?.focus();
  }
  function openContextMenu(button, x, y) {
    if (busy || !collections(store.doc).some(c => c.id === button.dataset.id)) return;
    captureDrafts(); contextMenu = { id: button.dataset.id, x, y };
    render(); host.querySelector('.collection-context button')?.focus();
  }
  async function changeCollectionColor(color) {
    const id = contextMenu?.id;
    const entry = collections(store.doc).find(c => c.id === id);
    if (!entry) { dismissContextMenu(); return; }
    captureDrafts(); dismissContextMenu();
    await mutate(() => saveCollection(store.doc, { ...entry, color }), () => {
      if (collectionEditor?.id === id) collectionEditor.color = color;
    });
    [...host.querySelectorAll('.workspace-collection')].find(b => b.dataset.id === id)?.focus();
  }

  function render(resetScroll = false) {
    if (!host) return;
    const scroll = host.querySelector('.time-grid-scroll');
    if (scroll && !resetScroll) timelineScroll = { top: scroll.scrollTop, left: scroll.scrollLeft };
    if (resetScroll) timelineScroll = null;
    if (selectedCollection && selectedCollection !== 'none' && !collections(store.doc).some(c => c.id === selectedCollection)) selectedCollection = '';
    host.innerHTML = `${sidebar()}<section class="planner-shell" role="main" aria-label="任务主页面">
      <header class="planner-header"><div><h2>${mode === 'calendar' ? (collections(store.doc).find(c => c.id === selectedCollection)?.name || (selectedCollection === 'none' ? '未分类' : '日历')) : mode === 'history' ? '完成记录' : '提醒中心'}</h2><p>安排未来，也看见每一天的进展</p></div><div class="planner-window-actions"><button type="button" data-p="maximize" aria-label="最大化或还原窗口" title="最大化 / 还原">□</button><button type="button" data-p="hide" aria-label="隐藏到托盘">×</button></div></header>

      <div class="planner-content ${mode === 'calendar' ? 'calendar-content' : ''}">${mode === 'calendar' ? calendar() : mode === 'history' ? history() : reminders()}</div>
      <p class="planner-status" role="status"></p>
      <footer class="planner-footer">${esc(store.doc.sync.timeZone)} · ${mode === 'calendar' && view !== 'month' ? '点击空白时间安排任务，拖动普通任务可调整日期和时间。' : '选择日期安排任务，完成记录按实际完成日期统计。'}</footer>
    </section>${contextMenuHTML()}`;
    positionContextMenu();
    host.querySelectorAll('button').forEach(b => { if (busy) b.disabled = true; });
    const nextScroll = host.querySelector('.time-grid-scroll');
    if (nextScroll) {
      nextScroll.scrollTop = timelineScroll?.top ?? Math.max(0, (calendarRange(rangeAnchor, view).includes(today()) ? Math.max(8, currentMinutes() / 60 - 1) : 8) * hourHeight - 10);
      nextScroll.scrollLeft = timelineScroll?.left || 0;
    }
  }

  function calendar() {
    const current = currentEntities(store.doc), dates = calendarRange(rangeAnchor, view);
    const period = view === 'month' ? `${month.slice(0, 4)}年${Number(month.slice(5))}月` : dates.length === 1 ? date : `${dates[0]} — ${dates.at(-1)}`;
    const unit = { month: '个月', week: '周', three: '三日', day: '日' }[view];
    return `<div class="calendar-toolbar"><div class="planner-month-nav"><button data-p="navigate" data-step="-1" aria-label="上${unit}">‹</button><button data-p="today">今天</button><button data-p="navigate" data-step="1" aria-label="下${unit}">›</button><h3>${period}</h3></div><div class="calendar-toolbar-right"><div class="calendar-views" role="group" aria-label="日历范围">${[['day', '日'], ['three', '三日'], ['week', '周'], ['month', '月']].map(([key, label]) => `<button data-p="view" data-view="${key}" aria-pressed="${view === key}">${label}</button>`).join('')}</div>${view !== 'month' ? `<button data-p="zoom" data-step="-12" aria-label="缩小时间轴">−</button><button data-p="zoom" data-step="12" aria-label="放大时间轴">＋</button>` : ''}<button class="calendar-new" data-p="new">＋ 新建任务</button></div></div>
      <div class="calendar-body ${view === 'month' ? 'is-month' : 'is-timeline'} ${inspectorOpen || view === 'month' ? 'has-inspector' : ''}">
      ${view === 'month' ? monthCalendar(current) : timeCalendar(current, dates)}
      ${view === 'month' || inspectorOpen ? inspector(current) : ''}</div>`;
  }

  function monthCalendar(current) {
    return `<section class="planner-month-surface">
      <div class="planner-weekdays">${['一', '二', '三', '四', '五', '六', '日'].map(d => `<span>${d}</span>`).join('')}</div>
      <div class="planner-grid">${monthDates(month).map(d => {
        const items = selectedTasks(d, current), done = items.filter(t => t.completed).length;
        return `<button class="planner-day ${d.slice(0, 7) !== month ? 'outside' : ''} ${d === today() ? 'today' : ''}" data-p="date" data-date="${d}" aria-pressed="${d === date}" aria-label="${d}，${done} 已完成，${items.length - done} 未完成"><span>${Number(d.slice(-2))}</span>${items.length ? `<small>${done} 完 / ${items.length - done} 待办</small><div class="month-previews">${items.slice(0, 3).map(t => `<div class="month-event ${t.completed ? 'done' : ''}" style="--task-color:${taskColor(t)}">${t.time ? t.time + ' ' : ''}${esc(t.title)}</div>`).join('')}${items.length > 3 ? `<div class="month-more">还有 ${items.length - 3} 项</div>` : ''}</div>` : '<small> </small>'}</button>`;
      }).join('')}</div></section>`;
  }

  function addForm() {
    return `<form data-p-form="add" class="planner-add"><label>新待办<input name="title" required maxlength="500" placeholder="这一天想完成什么？" value="${esc(addDraft.title)}"></label><div class="planner-form-row"><label>时间<input name="time" type="time" aria-label="新任务时间" value="${esc(addDraft.time)}"></label><label>时长（分钟）<input name="duration" type="number" min="5" max="1440" required value="${esc(addDraft.duration || 30)}"></label></div><label>提醒<select name="lead">${leads(Number(addDraft.lead))}</select></label><label>合集<select name="project">${projects(addDraft.project || null)}</select></label><button type="submit">添加到 ${esc(date)}</button></form>`;
  }

  function inspector(current) {
    const rows = selectedTasks(date, current);
    return `<section class="planner-agenda planner-inspector"><div class="inspector-heading"><h3>${esc(date)} <small>${rows.filter(t => t.completed).length} / ${rows.length} 完成</small></h3>${view !== 'month' ? '<button data-p="hide-inspector" aria-label="收起任务详情">×</button>' : ''}</div>
      ${editing ? editor(current.get(`task:${editing}`)?.payload) : addForm()}
      <div class="planner-tasks">${rows.length ? rows.map(t => row(t)).join('') : '<p class="planner-empty">这一天还没有任务，留一点空间给自己。</p>'}</div></section>`;
  }

  function miniCalendar(current) {
    return `<div class="mini-month-nav"><button data-p="mini-month" data-step="-1" aria-label="小日历上个月">‹</button><strong>${month}</strong><button data-p="mini-month" data-step="1" aria-label="小日历下个月">›</button></div><div class="mini-month-grid">${['一', '二', '三', '四', '五', '六', '日'].map(d => `<span>${d}</span>`).join('')}${monthDates(month).map(d => `<button class="mini-day ${d.slice(0, 7) !== month ? 'outside' : ''} ${d === today() ? 'today' : ''}" data-p="date" data-date="${d}" aria-label="跳转到 ${d}" aria-pressed="${d === date}">${Number(d.slice(-2))}${selectedTasks(d, current).length ? '<i></i>' : ''}</button>`).join('')}</div>`;
  }

  function currentMinutes() {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: store.doc.sync.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()).split(':').map(Number);
    return parts[0] * 60 + parts[1];
  }

  function timeCalendar(current, dates) {
    const height = 24 * hourHeight;
    const projectColor = taskColor;
    return `<section class="timeline-panel" aria-label="${{ day: '日', three: '三日', week: '周' }[view]}时间轴"><div class="time-grid-scroll"><div class="time-grid" style="--days:${dates.length};--hour-height:${hourHeight}px;--grid-height:${height}px">
      <div class="time-grid-sticky"><div class="time-date-row"><div class="time-zone-label">GMT${new Intl.DateTimeFormat('en', { timeZone: store.doc.sync.timeZone, timeZoneName: 'shortOffset' }).formatToParts(new Date()).find(p => p.type === 'timeZoneName').value.replace('GMT', '')}</div>${dates.map(d => `<button class="time-date ${d === today() ? 'today' : ''}" data-p="select-day" data-date="${d}" aria-pressed="${d === date}"><span>${weekday(d)}</span><strong>${Number(d.slice(-2))}</strong></button>`).join('')}</div>
      <div class="time-allday-row"><span class="time-allday-label">全天</span>${dates.map(d => `<div class="time-allday-cell" data-date="${d}">${selectedTasks(d, current).filter(t => !t.time).map(t => `<button class="allday-task ${t.completed ? 'done' : ''}" data-p="edit" data-id="${esc(t.id)}" data-date="${d}" title="${esc(t.title)}" style="--task-color:${projectColor(t)}">${t.completed ? '✓ ' : ''}${esc(t.title)}</button>`).join('')}<button class="allday-add" data-p="slot" data-date="${d}" data-time="" aria-label="${d} 添加全天任务">＋</button></div>`).join('')}</div></div>
      <div class="time-hours-row"><div class="time-ruler" style="height:${height}px">${Array.from({ length: 24 }, (_, h) => `<span style="top:${h * hourHeight}px">${String(h).padStart(2, '0')}:00</span>`).join('')}</div>${dates.map(d => `<div class="time-day-canvas ${d === today() ? 'today' : ''}" data-date="${d}" style="height:${height}px" aria-label="${d} 时间轨">${selectedTimeline(d, current).map(t => `<article class="time-block ${t.completed ? 'done' : ''} ${(t.end - t.start) * hourHeight / 60 < 36 ? 'short' : ''}" data-task-id="${esc(t.id)}" data-origin-date="${t.date}" draggable="${t.kind === 'one_off'}" style="top:${t.start * hourHeight / 60}px;height:${Math.max(12, (t.end - t.start) * hourHeight / 60)}px;left:calc(${t.lane * 100 / t.lanes}% + 3px);width:calc(${100 / t.lanes}% - 6px);--task-color:${projectColor(t)}"><button class="time-block-open" data-p="edit" data-id="${esc(t.id)}" data-date="${t.date}" aria-label="编辑 ${esc(t.title)}" title="${esc(t.title)} · ${t.time} — ${formatMinutes((minutesOfDay(t.time) + (t.durationMinutes || 30)) % 1440)}"><strong>${esc(t.title)}</strong><small>${t.continuesBefore ? '承接前一天' : t.time} — ${formatMinutes(t.end % 1440)}${t.continuesAfter ? '（续）' : ''}</small></button><button class="time-block-check" data-p="toggle" data-id="${esc(t.id)}" data-date="${t.date}" aria-label="${t.completed ? '重新打开' : '完成'} ${esc(t.title)}">${t.completed ? '✓' : '○'}</button></article>`).join('')}${d === today() ? `<div class="time-now" style="top:${currentMinutes() * hourHeight / 60}px" aria-label="当前时间 ${formatMinutes(currentMinutes())}"><i></i></div>` : ''}</div>`).join('')}</div>
      </div></div></section>`;
  }

  function history() {
    const rows = completionHistory(store.doc, { from, to, query }).filter(t => matchesCollection(t, project, store.doc) && matchesCollection(t, selectedCollection, store.doc)), days = new Map();
    for (const t of rows) days.set(t.date, (days.get(t.date) || 0) + 1);
    return `<form data-p-form="filter" class="planner-filters"><label>起始日期<input name="from" type="date" value="${from}" required></label><label>结束日期<input name="to" type="date" value="${to}" required></label><label>搜索<input name="query" value="${esc(query)}" placeholder="标题或描述"></label><label>合集<select name="project">${projects(project || undefined)}</select></label><button type="submit">查询</button><button type="button" data-p="week">近 7 天</button></form>
      <div class="planner-summary"><strong>${rows.length}<span>次完成</span></strong><strong>${days.size}<span>个活跃日</span></strong><strong>${rows.filter(t => t.kind === 'daily').length}<span>次打卡</span></strong></div>
      <p class="planner-help">同一普通任务按当前完成状态计一次，重新打开后不计入；打卡按每天计一次。旧记录没有准确时间时按计划日期展示并标注。</p>
      ${editing ? editor(currentEntities(store.doc).get(`task:${editing}`)?.payload) : ''}
      <div class="planner-history">${rows.length ? [...days].map(([day, count]) => `<section><h3>${day}<small>${count} 次完成</small></h3>${rows.filter(t => t.date === day).map(t => row(t, true)).join('')}</section>`).join('') : '<p class="planner-empty">这个范围暂无完成记录。</p>'}</div>`;
  }

  function editor(t) {
    if (!t) { editing = null; return ''; }
    if (editDraft?.id !== t.id) editDraft = { id: t.id, title: t.title, detail: t.detail, date: t.scheduledDate, time: t.time || '', duration: String(t.durationMinutes || 30), lead: String(t.remindLeadMinutes || 0), project: t.projectId || '' };
    const draft = editDraft;
    const events = taskEvents(store.doc, t.id);
    return `<form data-p-form="edit" class="planner-editor"><h4>编辑任务${t.kind === 'daily' ? ' · 每天重复' : ''}</h4><label>标题<input name="title" value="${esc(draft.title)}" required maxlength="500"></label><label>描述<textarea name="detail">${esc(draft.detail)}</textarea></label><div class="planner-form-row">${t.kind !== 'daily' ? `<label>计划日期<input name="date" type="date" value="${draft.date}" required></label>` : ''}<label>时间<input name="time" type="time" value="${draft.time}"></label></div><label>时长（分钟）<input name="duration" type="number" min="5" max="1440" required value="${draft.duration}"></label><div class="planner-form-row"><label>提醒<select name="lead">${leads(Number(draft.lead))}</select></label><label>合集<select name="project">${projects(draft.project || null)}</select></label></div><div class="planner-form-row"><button type="submit">保存修改</button><button type="button" data-p="cancel-edit">取消</button></div>${events.length ? `<details><summary>状态变更记录</summary>${events.map(e => `<p>${esc(new Date(e.at).toLocaleString('zh-CN', { timeZone: store.doc.sync.timeZone }))} · ${e.label}</p>`).join('')}</details>` : ''}</form>`;
  }

  function reminders() {
    const local = store.doc.local.reminders || {}, entries = Object.values(local.delivered || {}).sort((a, b) => b.sentAt - a.sentAt).slice(0, 50), current = currentEntities(store.doc);
    return `<section class="planner-reminders"><h3>本机提醒</h3><p>请保持应用在托盘运行，并允许系统通知。休眠或退出期间不能准时提醒，恢复运行后检查遗漏。系统免打扰可能隐藏通知。</p><label class="planner-enable"><input type="checkbox" data-p="reminders-enabled" ${store.doc.local.settings?.remindersEnabled !== false ? 'checked' : ''}>启用本机提醒</label><button data-p="test-notification">发送测试通知</button><p class="planner-help">提前提醒在日历中编辑任务时设置。以下是最近 50 条已发送提醒，可稍后 10 分钟再次提醒。</p>
      ${entries.length ? entries.map(item => `<article class="planner-task"><div class="planner-task-body"><strong>${esc(item.title)}</strong><small>${esc(item.date)} ${esc(item.time)} · ${esc(new Date(item.sentAt).toLocaleString('zh-CN', { timeZone: store.doc.sync.timeZone }))} 已发送</small></div><button data-p="snooze" data-key="${esc(item.key)}" ${!current.get(`task:${item.taskId}`) || current.get(`task:${item.taskId}`).deleted || current.get(`task:${item.taskId}`).payload.completed ? 'disabled' : ''}>${local.snoozes?.[item.key] ? '已延后 10 分钟' : '稍后 10 分钟'}</button></article>`).join('') : '<p class="planner-empty">还没有已发送的提醒。</p>'}</section>`;
  }

  async function mutate(action, onSuccess = () => {}) {
    if (busy) return;
    busy = true;
    const before = structuredClone(store.doc);
    try { action(); await store.changed(); onSuccess(); }
    catch (error) { store.doc = before; store.refresh(); notify(`保存失败：${error.message || error}`); }
    finally { busy = false; render(); }
  }

  async function toggleMaximize() {
    if (!nativeWindow || maximizeBusy) return;
    maximizeBusy = true;
    try { await nativeWindow.toggleMaximize(); }
    catch (error) { notify(`窗口最大化失败：${error}`); }
    finally { maximizeBusy = false; }
  }

  function navigate(step) {
    if (view === 'month') {
      const d = new Date(month + '-01T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + step);
      month = d.toISOString().slice(0, 7); date = month + '-01';
    } else {
      date = shiftDate(rangeAnchor, step * (view === 'week' ? 7 : view === 'three' ? 3 : 1)); month = date.slice(0, 7);
    }
    rangeAnchor = date;
    editing = null; editDraft = null; render(true);
  }

  const slotTime = (canvas, y) => formatMinutes(Math.max(0, Math.min(1425, Math.round((y - canvas.getBoundingClientRect().top) / hourHeight * 4) * 15)));
  function openSlot(day, time) {
    captureDrafts(); date = day; month = date.slice(0, 7); editing = null; editDraft = null;
    inspectorOpen = true; addDraft.time = time; render(); host.querySelector('.planner-add input')?.focus();
  }

  async function close() {
    if (busy || !host) return;
    captureDrafts(); contextMenu = null;
    try {
      if (nativeWindow && !await nativeWindow.isMaximized()) {
        store.doc.local.plannerPrefs = { ...store.doc.local.plannerPrefs, width: innerWidth, height: innerHeight };
        store.persist().catch(error => notify(`窗口尺寸保存失败：${error}`));
      }
    } catch (error) { notify(`窗口状态读取失败：${error}`); }
    host.remove(); host = null;
    document.documentElement.classList.remove('planner-open');
    document.getElementById('panel').inert = false;
    onModeChange(false);
    try { await nativeWindow?.setSkipTaskbar?.(true); } catch (error) { console.warn('Taskbar mode unavailable', error); }
    try {
      if (nativeWindow && restoreSize) {
        await nativeWindow.setMinSize(new windowApi.LogicalSize(220, 180));
        if (restoreMaximized) await nativeWindow.maximize();
        else {
          await nativeWindow.unmaximize();
          await nativeWindow.setSize(restoreSize);
          if (restorePosition) await nativeWindow.setPosition(restorePosition);
        }
      }
    } catch (error) { notify(`窗口恢复失败：${error}`); }
    (previousFocus?.isConnected ? previousFocus : document.getElementById('main-input'))?.focus();
  }

  async function open(next = 'calendar') {
    if (host || opening) return;
    opening = true;
    await beforeOpen(); mode = next; date = today(); rangeAnchor = date; month = date.slice(0, 7); from = shiftDate(date, -6); to = date; editing = null; editDraft = null; inspectorOpen = false; timelineScroll = null;
    const prefs = store.doc.local.plannerPrefs || {};
    view = ['day', 'three', 'week', 'month'].includes(prefs.view) ? prefs.view : 'month';
    hourHeight = [48, 60, 72, 84, 96].includes(prefs.hourHeight) ? prefs.hourHeight : 72;
    previousFocus = document.activeElement;
    if (nativeWindow) {
      try {
        restoreMaximized = await nativeWindow.isMaximized();
        restoreSize = await nativeWindow.innerSize(); restorePosition = await nativeWindow.outerPosition();
        await nativeWindow.setMaxSize(null);
        const monitor = await windowApi.currentMonitor();
        const scale = monitor?.scaleFactor || 1, area = monitor?.workArea || monitor;
        const width = Math.min(prefs.width || 1360, (area?.size.width || 1440 * scale) / scale - 40), height = Math.min(prefs.height || 900, (area?.size.height || 980 * scale) / scale - 40);
        await nativeWindow.setMinSize(new windowApi.LogicalSize(Math.min(600, width), Math.min(460, height)));
        if (!restoreMaximized) {
          await nativeWindow.setSize(new windowApi.LogicalSize(width, height));
          if (area) await nativeWindow.setPosition(new windowApi.PhysicalPosition(area.position.x + Math.round((area.size.width - width * scale) / 2), area.position.y + Math.round((area.size.height - height * scale) / 2)));
        }
      } catch (error) { notify(`日历以当前窗口尺寸显示：${error}`); }
    }
    host = document.createElement('div'); host.className = 'planner-overlay'; document.body.append(host);
    opening = false;
    host.addEventListener('mousedown', event => { if (event.button === 0 && event.target.closest('.planner-header') && !event.target.closest('button')) nativeWindow?.startDragging().catch(error => notify(String(error))); });
    host.addEventListener('dblclick', event => { if (event.target.closest('.planner-header') && !event.target.closest('button')) toggleMaximize(); });
    host.addEventListener('contextmenu', event => {
      const button = event.target.closest('.workspace-collection');
      if (!button || !button.dataset.id || button.dataset.id === 'none') return;
      event.preventDefault(); openContextMenu(button, event.clientX, event.clientY);
    });
    host.addEventListener('change', event => {
      if (event.target.matches('.collection-custom-color input') && !busy) changeCollectionColor(event.target.value);
    });
    host.addEventListener('input', captureDrafts);
    host.addEventListener('change', captureDrafts);
    document.documentElement.classList.add('planner-open'); document.getElementById('panel').inert = true;
    onModeChange(true);
    try { await nativeWindow?.setSkipTaskbar?.(false); } catch (error) { console.warn('Taskbar mode unavailable', error); }
    host.addEventListener('click', async event => {
      const b = event.target.closest('[data-p]'); if (!b || busy) return;
      captureDrafts();
      try {
        switch (b.dataset.p) {
          case 'collection-color': await changeCollectionColor(b.dataset.color); break;
          case 'close': await close(); break;
          case 'hide': await nativeWindow?.hide(); break;
          case 'settings': window.dispatchEvent(new Event('todo-workspace-settings')); break;
          case 'collection': selectedCollection = b.dataset.id; project = ''; editing = null; editDraft = null; addDraft.project = selectedCollection === 'none' ? '' : selectedCollection; collectionEditor = null; render(); break;
          case 'collection-new': collectionEditor = { name: '', color: '#6375e8' }; deletingCollection = false; render(); host.querySelector('.collection-editor input')?.focus(); break;
          case 'collection-edit': collectionEditor = { ...collections(store.doc).find(c => c.id === selectedCollection) }; deletingCollection = false; render(); break;
          case 'collection-cancel': collectionEditor = null; deletingCollection = false; render(); break;
          case 'collection-delete': if (!deletingCollection) { deletingCollection = true; render(); } else { await mutate(() => removeCollection(store.doc, collectionEditor.id), () => { selectedCollection = 'none'; collectionEditor = null; deletingCollection = false; addDraft.project = ''; }); } break;
          case 'maximize': await toggleMaximize(); break;
          case 'mode': mode = b.dataset.mode; editing = null; editDraft = null; render(); break;
          case 'view': view = b.dataset.view; rangeAnchor = date; editing = null; editDraft = null; persistPrefs(); render(true); break;
          case 'navigate': navigate(Number(b.dataset.step)); break;
          case 'mini-month': { const d = new Date(month + '-01T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + Number(b.dataset.step)); month = d.toISOString().slice(0, 7); render(); break; }
          case 'date': date = b.dataset.date; rangeAnchor = date; month = date.slice(0, 7); editing = null; editDraft = null; render(true); break;
          case 'select-day': date = b.dataset.date; editing = null; editDraft = null; inspectorOpen = true; render(); break;
          case 'today': date = today(); rangeAnchor = date; month = date.slice(0, 7); render(true); break;
          case 'new': inspectorOpen = true; editing = null; editDraft = null; render(); host.querySelector('.planner-add input')?.focus(); break;
          case 'hide-inspector': inspectorOpen = false; editing = null; editDraft = null; render(); break;
          case 'slot': openSlot(b.dataset.date, b.dataset.time); break;
          case 'zoom': { const previous = hourHeight; hourHeight = Math.max(48, Math.min(96, hourHeight + Number(b.dataset.step))); const scroller = host.querySelector('.time-grid-scroll'); if (scroller) scroller.scrollTop = scroller.scrollTop * hourHeight / previous; persistPrefs(); render(); break; }
          case 'week': from = shiftDate(today(), -6); to = today(); render(); break;
          case 'toggle': await mutate(() => toggleTask(store.doc, b.dataset.id, b.dataset.date)); break;
          case 'edit': editing = b.dataset.id; date = b.dataset.date || date; month = date.slice(0, 7); editDraft = null; inspectorOpen = true; render(); host.querySelector('.planner-editor input')?.focus(); break;
          case 'cancel-edit': editing = null; editDraft = null; render(); break;
          case 'snooze': await mutate(() => snoozeReminder(store.doc, store.doc.local.reminders.delivered[b.dataset.key])); break;
          case 'test-notification': window.dispatchEvent(new Event('todo-test-notification')); break;
          case 'reminders-enabled': await mutate(() => { store.doc.local.settings.remindersEnabled = b.checked; }); break;
        }
      } catch (error) { notify(error.message || String(error)); }
    });
    host.addEventListener('click', event => {
      const canvas = event.target.closest('.time-day-canvas');
      if (!canvas || event.target.closest('.time-block') || busy) return;
      openSlot(canvas.dataset.date, slotTime(canvas, event.clientY));
    });
    host.addEventListener('dragstart', event => {
      const block = event.target.closest('.time-block[draggable="true"]'); if (!block) return;
      captureDrafts(); activeDrag = block.dataset.taskId;
      event.dataTransfer.setData('text/plain', activeDrag); event.dataTransfer.effectAllowed = 'move';
    });
    host.addEventListener('dragover', event => { if (activeDrag && event.target.closest('.time-day-canvas')) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } });
    host.addEventListener('dragend', () => { activeDrag = null; });
    host.addEventListener('drop', async event => {
      const canvas = event.target.closest('.time-day-canvas'); if (!canvas || !activeDrag || busy) return;
      event.preventDefault(); const id = activeDrag; activeDrag = null;
      const time = slotTime(canvas, event.clientY);
      await mutate(() => updateTask(store.doc, id, { scheduledDate: canvas.dataset.date, time }));
    });
    host.addEventListener('submit', async event => {
      event.preventDefault(); if (busy) return;
      const form = event.target, data = Object.fromEntries(new FormData(form));
      if (form.dataset.pForm === 'filter') {
        if (data.from > data.to) { host.querySelector('.planner-status').textContent = '起始日期不能晚于结束日期'; return; }
        ({ from, to, query, project } = data); render(); return;
      }
      if (form.dataset.pForm === 'collection') {
        await mutate(() => { selectedCollection = saveCollection(store.doc, { ...data, id: collectionEditor.id }); }, () => { collectionEditor = null; addDraft.project = selectedCollection; });
        return;
      }
      const values = { title: data.title, time: data.time || null, durationMinutes: Number(data.duration), remindLeadMinutes: Number(data.lead), projectId: data.project || null };
      if (form.dataset.pForm === 'add') await mutate(() => createTask(store.doc, { ...values, scheduledDate: date }), () => { addDraft = { ...emptyDraft(), project: selectedCollection === 'none' ? '' : selectedCollection }; });
      else if (form.dataset.pForm === 'edit') await mutate(() => updateTask(store.doc, editing, { ...values, detail: data.detail, ...(data.date ? { scheduledDate: data.date } : {}) }), () => { editing = null; editDraft = null; });
    });
    render(); host.querySelector('[data-p="mode"]').focus();
  }
  document.addEventListener('keydown', event => {
    if (!host || document.querySelector('.overlay')) return;
    const collectionButton = event.target.closest?.('.workspace-collection[aria-haspopup="menu"]');
    if (collectionButton && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
      event.preventDefault(); event.stopImmediatePropagation(); const rect = collectionButton.getBoundingClientRect(); openContextMenu(collectionButton, rect.left + 20, rect.bottom); return;
    }
    if (contextMenu) {
      if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopImmediatePropagation(); dismissContextMenu(true); return; }
      if (['ArrowDown','ArrowUp','ArrowRight','ArrowLeft','Home','End'].includes(event.key)) {
        event.preventDefault(); event.stopImmediatePropagation();
        const buttons = [...host.querySelectorAll('.collection-context button, .collection-context input')];
        const index = buttons.indexOf(document.activeElement), step = ['ArrowDown','ArrowRight'].includes(event.key) ? 1 : -1;
        buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + step + buttons.length) % buttons.length]?.focus(); return;
      }
    }
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); if (collectionEditor) { collectionEditor = null; render(); } else if (editing || inspectorOpen) { editing = null; editDraft = null; inspectorOpen = false; render(); } }
    if (event.key === 'Tab') {
      const list = [...host.querySelectorAll('button, input, select, textarea, summary')].filter(e => !e.disabled && e.getClientRects().length);
      const first = list[0], last = list.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }, true);
  document.addEventListener('pointerdown', event => {
    if (contextMenu && !event.target.closest('.collection-context')) dismissContextMenu();
  }, true);
  window.addEventListener('resize', () => dismissContextMenu());
  window.addEventListener('blur', () => { if (!document.activeElement?.matches('.collection-custom-color input')) dismissContextMenu(); });
  const nowTimer = setInterval(() => {
    if (!host) return;
    for (const canvas of host.querySelectorAll('.time-day-canvas')) {
      let line = canvas.querySelector('.time-now');
      if (canvas.dataset.date !== today()) { line?.remove(); continue; }
      if (!line) { line = document.createElement('div'); line.className = 'time-now'; line.innerHTML = '<i></i>'; canvas.append(line); }
      line.style.top = `${currentMinutes() * hourHeight / 60}px`;
      line.setAttribute('aria-label', `当前时间 ${formatMinutes(currentMinutes())}`);
    }
  }, 60000);
  window.addEventListener('beforeunload', () => clearInterval(nowTimer));
  return { open, close, refresh: () => { if (host && !host.contains(document.activeElement)) render(); }, get active() { return !!host; } };
}
