/* 悬浮待办 · 跨平台前端逻辑 (Tauri v2 + 原生 JS) */
import { SCHEMA_VERSION, normalizeSnapshot, parseClassification, resolveClassification, editText } from './classification.js';
import { createClassificationUI } from './classification-ui.js';
import { reorderVisibleItems } from './todo-order.js';
import { createWindowController } from './window-controller.js';
import { SyncStore } from './sync-store.js';
import { dateInZone, shiftDate, setTaskOrder } from './sync-model.js';
import { openSyncSettings, confirmImport } from './sync-ui.js';
import { openLanSettings } from './lan-ui.js';
import { createUpdateChecker } from './update-ui.js';
import { createPlanner } from './planner-ui.js';
import { createReminderRunner } from './reminders.js';
let syncStore = null;
let memoSaveTimer = null;

const TAURI = window.__TAURI__;
const appWindow = TAURI?.window?.getCurrentWindow?.();
const isWindows = /Windows/i.test(navigator.userAgent);

async function openExternal(url) {
  try {
    if (TAURI?.opener?.openUrl) await TAURI.opener.openUrl(url);
    else await TAURI.core.invoke("plugin:opener|open_url", { url });
  } catch (e) {
    window.open(url, "_blank");
  }
}

/* ---------------- 数据模型 ---------------- */

const DAYS = ["today", "tomorrow", "dayAfterTomorrow"];
const DAY_TITLE = { today: "今天", tomorrow: "明天", dayAfterTomorrow: "后天" };
const STORAGE_KEY = "floating-todo/snapshot";

const uid = () =>
  crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random());

function todayStr(d = new Date()) {
  return dateInZone(syncStore?.doc?.sync.timeZone || 'Asia/Shanghai', d);
}


function dateLabel(offset) {
  const [, month, day] = shiftDate(todayStr(), offset).split('-').map(Number);
  return `${month}月${day}日`;
}

const pad = (n) => String(n).padStart(2, "0");
function yesterdayStr() { return shiftDate(todayStr(), -1); }
function nowHHMM() {
  return new Intl.DateTimeFormat('en-GB', { timeZone: syncStore?.doc?.sync.timeZone || 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
}

/* 从输入里解析时间，如 15:00 / 下午3点半 / 晚上8点30 / 9点 */
function parseTime(s) {
  let m = s.match(/(\d{1,2}):(\d{2})/);
  if (m) {
    return { time: pad(Math.min(23, +m[1])) + ":" + pad(Math.min(59, +m[2])), match: m[0] };
  }
  m = s.match(/(上午|早上|凌晨|下午|晚上|中午)?\s*(\d{1,2})\s*点\s*(半|\d{1,2})?\s*分?/);
  if (m && (m[1] || m[3] !== undefined || /点/.test(m[0]))) {
    let h = +m[2];
    let mm = 0;
    if (m[3] === "半") mm = 30;
    else if (m[3]) mm = Math.min(59, +m[3]);
    const p = m[1];
    if ((p === "下午" || p === "晚上") && h < 12) h += 12;
    if (p === "中午" && h < 12) h = 12;
    if ((p === "凌晨" || p === "早上" || p === "上午") && h === 12) h = 0;
    return { time: pad(Math.min(23, h)) + ":" + pad(mm), match: m[0] };
  }
  return null;
}

/* 自然语言：识别「明天/后天/今天」分组和时间，返回 {day, time, title} */
function parseQuickInput(text, defaultDay) {
  let title = text.trim();
  let day = defaultDay;
  if (/^(今天|今日)/.test(title)) { day = "today"; title = title.replace(/^(今天|今日)\s*/, ""); }
  else if (/^明天/.test(title)) { day = "tomorrow"; title = title.replace(/^明天\s*/, ""); }
  else if (/^后天/.test(title)) { day = "dayAfterTomorrow"; title = title.replace(/^后天\s*/, ""); }

  let time = null;
  const t = parseTime(title);
  if (t) { time = t.time; title = title.replace(t.match, " ").replace(/\s+/g, " ").trim(); }
  return { day, time, title: title.trim() };
}

function defaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    projects: [],
    tags: [],
    colorCounters: { projects: 0, tags: 0 },
    selectedDay: "today",
    itemsByDay: { today: [], tomorrow: [], dayAfterTomorrow: [] },
    recurringItems: [],
    settings: {
      alwaysOnTop: true,
      showOnDesktop: false,
      opacity: 0.78,
      appearance: "system",
      customBg: null,
      memoEnabled: false,
      clickThrough: false,
      shadowEnabled: true,
    },
    memo: { text: "", expanded: false },
    lastActiveDate: todayStr(),
  };
}

let startupNotice = '';
function load() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return defaultState();
  let state;
  try {
    const parsed = JSON.parse(raw);
    state = normalizeSnapshot(parsed, defaultState());
    if ((parsed.schemaVersion || 1) < SCHEMA_VERSION && !localStorage.getItem(STORAGE_KEY + '/before-v2')) {
      localStorage.setItem(STORAGE_KEY + '/before-v2', raw);
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    // Keep the original snapshot recoverable before any subsequent save.
    localStorage.setItem(STORAGE_KEY + '/recovery/' + Date.now(), raw);
    startupNotice = '本地数据未能加载，原始快照已保留：' + error.message;
    return defaultState();
  }
  if (isWindows && state.settings.showOnDesktop) state.settings.alwaysOnTop = false;
  return state;
}

const legacyRaw = localStorage.getItem(STORAGE_KEY);
let state = load();
syncStore = new SyncStore({
  invoke: (name, args) => TAURI.core.invoke(name, args),
  native: !!window.__TAURI_INTERNALS__,
  onChange: view => { state = view; render(); },
  onStatus: () => window.dispatchEvent(new Event('todo-sync-status')),
});
try {
  state = await syncStore.init(state, legacyRaw);
} catch (error) {
  document.getElementById('app').textContent = `本地数据库无法打开，已停止写入以保留数据。请重启或恢复备份。${error}`;
  throw error;
}
function save() {
  clearTimeout(memoSaveTimer); memoSaveTimer = null;
  syncStore.commit(state);
}

/* 跨天只更新展示，历史完成状态和删除记录留在数据库中。 */
function rollOverIfNeeded() {
  if (state.lastActiveDate !== todayStr()) { save(); state = syncStore.refresh(false); }
}

/* ---------------- 业务操作 ---------------- */

const stableSort = (arr) => [
  ...arr.filter((i) => !i.completed),
  ...arr.filter((i) => i.completed),
];

function items(day = state.selectedDay) {
  return state.itemsByDay[day] || [];
}
function incompleteCount(day = state.selectedDay) {
  return items(day).filter((i) => !i.completed).length;
}
function completedCount(day = state.selectedDay) {
  return items(day).filter((i) => i.completed).length;
}

function addItem(title, day = state.selectedDay, time = null, classification = { projectId: null, tagIds: [] }) {
  rollOverIfNeeded();
  const t = title.trim();
  if (!t) return null;
  const it = { id: uid(), title: t, detail: "", time, completed: false, notified: false, createdAt: Date.now(), ...classification };
  state.itemsByDay[day].unshift(it);
  save();
  return it;
}
function toggleItem(id, day) {
  const arr = state.itemsByDay[day];
  const it = arr.find((i) => i.id === id);
  if (!it) return;
  it.completed = !it.completed;
  if (it.completed) { it.completedAt = Date.now(); it.completedDate = todayStr(); }
  else { delete it.completedAt; delete it.completedDate; delete it.archivedAt; }
  state.itemsByDay[day] = stableSort(arr);
  save();
}
function deleteItem(id, day) {
  state.itemsByDay[day] = state.itemsByDay[day].filter((i) => i.id !== id);
  save();
}
function updateItem(id, day, title, detail) {
  const it = state.itemsByDay[day].find((i) => i.id === id);
  if (!it) return;
  if (title !== undefined && title.trim()) it.title = title.trim();
  if (detail !== undefined) it.detail = detail.trim();
  save();
}
function moveItem(id, from, to) {
  const arr = state.itemsByDay[from];
  const idx = arr.findIndex((i) => i.id === id);
  if (idx < 0) return;
  const [it] = arr.splice(idx, 1);
  it.scheduledDate = shiftDate(todayStr(), DAYS.indexOf(to));
  state.itemsByDay[to].unshift(it);
  setTaskOrder(syncStore.doc, state.itemsByDay[to].map(task => task.id), it.id);
  save();
}
function clearCompleted(day) {
  for (const item of state.itemsByDay[day]) if (item.completed && classificationUI.filtered(item)) item.archivedAt = Date.now();
  save();
  state = syncStore.refresh(false);
}

/* 常驻「每天」待办 */
function addRecurring(title, time = null, classification = { projectId: null, tagIds: [] }) {
  rollOverIfNeeded();
  const t = title.trim();
  if (!t) return;
  state.recurringItems.unshift({
    id: uid(),
    title: t,
    detail: "",
    time,
    completed: false,
    notified: false,
    streak: 0,
    lastDone: null,
    createdAt: Date.now(),
    ...classification,
  });
  save();
  return state.recurringItems[0];
}
function toggleRecurring(id) {
  rollOverIfNeeded();
  const it = state.recurringItems.find((i) => i.id === id);
  if (!it) return;
  const today = todayStr();
  if (!it.completed) {
    it.completed = true;
    it.completedAt = Date.now();
    it.notified = true;
    if (it.lastDone === today) {
      // 今天已计入连胜
    } else if (it.lastDone === yesterdayStr()) {
      it.streak = (it.streak || 0) + 1;
    } else {
      it.streak = 1;
    }
    it.lastDone = today;
  } else {
    it.completed = false;
    delete it.completedAt;
    if (it.lastDone === today) {
      it.streak = Math.max(0, (it.streak || 0) - 1);
      it.lastDone = it.streak > 0 ? yesterdayStr() : null;
    }
  }
  state.recurringItems = stableSort(state.recurringItems);
  save();
}
function deleteRecurring(id) {
  state.recurringItems = state.recurringItems.filter((i) => i.id !== id);
  save();
}
function updateRecurringTitle(id, title) {
  const it = state.recurringItems.find((i) => i.id === id);
  if (it && title.trim()) it.title = title.trim();
  save();
}
function pinAsRecurring(id, from) {
  const arr = state.itemsByDay[from];
  const idx = arr.findIndex((i) => i.id === id);
  if (idx < 0) return;
  const [it] = arr.splice(idx, 1);
  it.completed = false;
  state.recurringItems.unshift(it);
  setTaskOrder(syncStore.doc, state.recurringItems.map(task => task.id), it.id);
  save();
}
function unpinRecurring(id) {
  const idx = state.recurringItems.findIndex((i) => i.id === id);
  if (idx < 0) return;
  const [it] = state.recurringItems.splice(idx, 1);
  it.scheduledDate = todayStr();
  state.itemsByDay.today.unshift(it);
  setTaskOrder(syncStore.doc, state.itemsByDay.today.map(task => task.id), it.id);
  save();
}

/* ---------------- 工具 ---------------- */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
function linkify(s) {
  const escaped = esc(s);
  return escaped.replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a data-link="$1">$1</a>'
  );
}

const ICONS = {
  gear: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  dots: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  send: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2 4.5 20l7.5-3.5L19.5 20z" transform="rotate(0 12 12)"/></svg>',
  arrowUp: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><polyline points="8.5 11.8 12 8.2 15.5 11.8"/><line x1="12" y1="8.5" x2="12" y2="16"/></svg>',
  x: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><line x1="14.8" y1="9.2" x2="9.2" y2="14.8"/><line x1="9.2" y1="9.2" x2="14.8" y2="14.8"/></svg>',
  repeat: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
  note: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  expand: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
  pinOff: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="2" x2="22" y2="22"/><path d="M12 17v5"/><path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11"/><path d="M15 9.34V6h1a2 2 0 0 0 0-4H7.89"/></svg>',
  arrowRight: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>',
  clock: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:2px"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>',
  download: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  upload: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
  grip: '<svg viewBox="0 0 12 18" width="11" height="16" fill="currentColor"><circle cx="3.5" cy="3.5" r="1.25"/><circle cx="8.5" cy="3.5" r="1.25"/><circle cx="3.5" cy="9" r="1.25"/><circle cx="8.5" cy="9" r="1.25"/><circle cx="3.5" cy="14.5" r="1.25"/><circle cx="8.5" cy="14.5" r="1.25"/></svg>',
};

/* ---------------- 渲染 ---------------- */

const app = document.getElementById("app");
const classificationUI = createClassificationUI({ getState: () => state, save, render, openSettings });
const windowUI = createWindowController({
  api: TAURI?.window,
  moveToScreen: (x, y) => TAURI.core.invoke('set_window_screen_position', { x, y }),
  onChange: () => { updateCompact(false); render(); },
  onError: (error) => { console.error('Failed to change floating window', error); classificationUI.showNotice('窗口切换失败，请重试'); },
});
let compact = false;
let activeMenu = null; // { id, day, kind }
let appliedWindowMode = null;
let pendingWindowMode = null;
let windowModeTask = Promise.resolve();

function applyWindowMode() {
  if (!appWindow) return;

  const requestedMode =
    isWindows && state.settings.showOnDesktop
      ? "desktop"
      : state.settings.alwaysOnTop
        ? "topmost"
        : "normal";
  if (appliedWindowMode === requestedMode || pendingWindowMode === requestedMode) return;

  pendingWindowMode = requestedMode;
  windowModeTask = windowModeTask
    .then(async () => {
      if (pendingWindowMode !== requestedMode) return;

      if (requestedMode === "desktop") {
        await appWindow.setAlwaysOnTop(false);
        await TAURI.core.invoke("set_desktop_mode", { enabled: true });
      } else {
        if (isWindows) await TAURI.core.invoke("set_desktop_mode", { enabled: false });
        await appWindow.setAlwaysOnTop(requestedMode === "topmost");
      }

      appliedWindowMode = requestedMode;
      if (pendingWindowMode === requestedMode) pendingWindowMode = null;
    })
    .catch((error) => {
      console.error("Failed to update window mode", error);
      if (pendingWindowMode === requestedMode) pendingWindowMode = null;
      appliedWindowMode = null;
      if (requestedMode === "desktop" && state.settings.showOnDesktop) {
        state.settings.showOnDesktop = false;
        save();
        render();
      }
    });
}

function applyWindowChrome() {
  const root = document.documentElement;
  root.dataset.theme = state.settings.appearance;
  root.dataset.shadow = state.settings.shadowEnabled ? "on" : "off";
  root.style.setProperty("--opacity", state.settings.opacity);
  if (state.settings.customBg) {
    root.style.setProperty("--panel-top", state.settings.customBg);
    root.style.setProperty("--panel-bottom", state.settings.customBg);
  } else {
    root.style.removeProperty("--panel-top");
    root.style.removeProperty("--panel-bottom");
  }
  if (appWindow) {
    appWindow.setIgnoreCursorEvents(!!state.settings.clickThrough).catch(() => {});
  }
  applyWindowMode();
}

function rowHtml(it, day, kind) {
  const badge = kind === "recurring" && compact ? `<span class="badge">${ICONS.repeat}</span>` : "";
  const detail =
    !compact && it.detail
      ? `<div class="detail">${linkify(it.detail)}</div>`
      : "";
  let actions = "";
  if (!compact) {
    if (kind === "recurring") {
      actions = `<div class="actions">
        <button class="icon-btn sm" data-class-ui="task" data-task="${esc(it.id)}" title="项目与标签">#</button>
        <button class="icon-btn sm" data-act="unpin" data-id="${it.id}" title="取消每天">${ICONS.pinOff}</button>
        <button class="icon-btn sm" data-act="rdel" data-id="${it.id}" title="删除">${ICONS.trash}</button>
      </div>`;
    } else {
      actions = `<div class="actions">
        <button class="icon-btn sm" data-act="menu" data-id="${it.id}" data-day="${day}" title="更多">${ICONS.dots}</button>
        <button class="icon-btn sm" data-act="del" data-id="${it.id}" data-day="${day}" title="删除">${ICONS.trash}</button>
      </div>`;
    }
  }
  const editAct = kind === "recurring" ? "redit" : "edit";
  const timeChip = it.time ? `<span class="time-chip">${ICONS.clock}${it.time}</span>` : "";
  const streakChip =
    kind === "recurring" && it.streak > 0
      ? `<span class="streak-chip" title="已连续 ${it.streak} 天">🔥${it.streak}</span>`
      : "";
  return `<div class="row ${it.completed ? "done" : ""}" data-row="${it.id}" data-kind="${kind}" data-day="${day}"${classificationUI.rowStyle(it)}>
    <div class="check ${it.completed ? "on" : ""}" data-act="${kind === "recurring" ? "rtoggle" : "toggle"}" data-id="${it.id}" data-day="${day}">${it.completed ? ICONS.check : ""}</div>
    <div class="body" data-act="${editAct}" data-id="${it.id}" data-day="${day}">
      <div class="title">${esc(it.title)}${timeChip}${streakChip}</div>
      ${classificationUI.rowMetadata(it)}
      ${detail}
    </div>
    ${badge}${actions}
    <button type="button" class="drag-handle" title="拖拽排序（Alt + ↑ / ↓）" aria-label="拖拽排序：${esc(it.title)}" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"><svg viewBox="0 0 12 18" width="12" height="18" fill="currentColor" aria-hidden="true"><circle cx="3" cy="3" r="1.2"/><circle cx="9" cy="3" r="1.2"/><circle cx="3" cy="9" r="1.2"/><circle cx="9" cy="9" r="1.2"/><circle cx="3" cy="15" r="1.2"/><circle cx="9" cy="15" r="1.2"/></svg></button>
  </div>`;
}

function render() {
  if (classificationUI.isComposing()) return;
  // Re-rendering cancels an unfinished drag before replacing its DOM.
  finishTodoDrag(false, false);
  const oldInput = document.activeElement;
  const restoreInput = oldInput?.matches?.('#main-input, #quick-input, #recur-input, #memo-input')
    ? { id: oldInput.id, start: oldInput.selectionStart, end: oldInput.selectionEnd } : null;
  rollOverIfNeeded();
  applyWindowChrome();
  document.documentElement.dataset.windowMode = windowUI.mode;
  if (!windowUI.transitioning && app.querySelector('.list')) listScrollTop = app.querySelector('.list').scrollTop;
  if (windowUI.floating) {
    renderFloating(restoreInput);
    return;
  }

  const day = compact ? "today" : state.selectedDay;
  const recurring = state.recurringItems.filter(classificationUI.filtered);
  const showRecurring = day === "today" && (recurring.length > 0 || recurringComposerOpen);
  const cnt = incompleteCount();

  let html = "";

  if (!compact) {
    const sub =
      cnt === 0 ? "这一页已经清空" : `${DAY_TITLE[state.selectedDay]}还有 ${cnt} 件事`;
    html += `<div class="header">
      <div class="titles"><h1>悬浮待办</h1><p>${sub}</p></div>
      <div class="spacer"></div>
      <button class="count-pill ${cnt === 0 ? "zero" : ""}" data-act="collapse" title="收起为悬浮栏" aria-label="${cnt} 件待办，收起为悬浮栏">${cnt > 99 ? '99+' : cnt}</button>
      <button class="icon-btn" data-act="maximize" title="最大化 / 还原" aria-label="最大化或还原窗口">□</button>
      <button class="icon-btn" data-act="settings" title="设置">${ICONS.gear}</button>
    </div>`;

    html += `<div class="planner-launch"><button data-act="planner">日历与回顾 <span>↗</span></button><button data-act="reminder-center" title="查看提醒与稍后提醒">${ICONS.clock} 提醒</button></div>`;
    html += `<div class="day-picker">`;
    DAYS.forEach((d, i) => {
      html += `<div class="day-seg ${state.selectedDay === d ? "sel" : ""}" data-act="day" data-day="${d}">
        <span class="t">${DAY_TITLE[d]}</span><span class="d">${dateLabel(i)}</span>
      </div>`;
    });
    html += `</div>`;
  }

  html += classificationUI.filterBar();

  if (showRecurring) {
    html += `<div class="recurring"><div class="head">
      <span class="ic">${ICONS.repeat}</span><span>每天</span><div class="spacer"></div>`;
    if (!compact)
      html += `<button class="icon-btn sm" data-act="raddtoggle" title="添加每天常驻待办">${ICONS.plus}</button>`;
    html += `</div>`;
    recurring.forEach((it) => (html += rowHtml(it, "today", "recurring")));
    if (!compact && recurringComposerOpen) {
      html += `<div class="composer sm"><span class="ic">${ICONS.repeat}</span>
        <input id="recur-input" placeholder="添加每天常驻待办" value="${esc(recurDraft)}"/>
        <button class="send" data-act="raddsubmit">${ICONS.arrowUp}</button></div>`;
    }
    html += `</div>`;
  }

  // 列表
  const list = items(day).filter(classificationUI.filtered);
  if (list.length === 0) {
    const a = classificationUI.hasFilters() ? '没有符合条件的任务' : showRecurring ? `${DAY_TITLE[day]}没有临时待办` : `${DAY_TITLE[day]}还没有待办`;
    const b = classificationUI.hasFilters() ? '<button class="link-btn" data-class-ui="clear">清除筛选</button>' : showRecurring ? "上方是每天常驻的事" : "写下一件真正要推进的事";
    html += `<div class="empty"><div class="ic">${ICONS.note}</div><div class="a">${a}</div><div class="b">${b}</div></div>`;
  } else {
    html += `<div class="list">`;
    list.forEach((it) => (html += rowHtml(it, day, "normal")));
    html += `</div>`;
  }

  if (!compact) {
    const visibleCompleted = list.filter(it => it.completed).length;
    if (visibleCompleted > 0) {
      html += `<div class="clear-bar"><button data-act="clear" data-day="${day}">${ICONS.trash}<span>归档已完成（${visibleCompleted}）</span></button></div>`;
    }
    // 输入框
    const editing = composerEditId;
    html += `<div class="composer">
      <span class="ic">${editing ? ICONS.pencil : ICONS.plus}</span>
      <input id="main-input" placeholder="${editing ? "编辑待办标题" : "添加" + DAY_TITLE[state.selectedDay] + "待办"}" value="${esc(draft)}"/>
      ${editing ? `<button class="icon-btn sm" data-act="canceledit">${ICONS.x}</button>` : ""}
      <button class="send ${draft.trim() ? "" : "off"}" data-act="submit">${editing ? ICONS.arrowUp : ICONS.arrowUp}</button>
    </div>`;

    // 备忘录
    if (state.settings.memoEnabled) {
      html += `<div class="memo"><div class="head" data-act="memotoggle">
        <span class="ic">${ICONS.note}</span><span>全局备忘录</span><div class="spacer"></div>
        <span style="transform:rotate(${state.memo.expanded ? 180 : 0}deg);transition:.2s">${ICONS.chevron}</span></div>`;
      if (state.memo.expanded) {
        html += `<textarea id="memo-input" placeholder="记录临时想法、链接、会议号">${esc(state.memo.text)}</textarea>`;
      }
      html += `</div>`;
    }
  }

  // 紧凑模式放大按钮
  if (compact) {
    html += `<button class="icon-btn expand-btn" data-act="expand" title="放大">${ICONS.expand}</button>`;
  }

  app.innerHTML = html;
  if (app.querySelector('.list')) app.querySelector('.list').scrollTop = listScrollTop;
  classificationUI.afterRender();
  if (restoreInput && !focusMain && !focusRecur) {
    const field = document.getElementById(restoreInput.id);
    field?.focus(); field?.setSelectionRange(restoreInput.start, restoreInput.end);
  }

  // 头部可拖动
  const header = app.querySelector(".header");
  if (header) header.addEventListener("mousedown", onDragStart);

  // 保持输入焦点
  if (focusMain) {
    const mi = document.getElementById("main-input");
    if (mi) { mi.focus(); mi.setSelectionRange(mi.value.length, mi.value.length); }
    focusMain = false;
  }
  if (focusRecur) {
    const ri = document.getElementById("recur-input");
    if (ri) ri.focus();
    focusRecur = false;
  }
}

/* ---------------- 交互状态 ---------------- */

let draft = "";
let composerEditId = null;
let composerEditDay = null;
let recurDraft = "";
let recurringComposerOpen = false;
let recurEditId = null;
let focusMain = false;
let focusRecur = false;
let quickDraft = '';
let quickDay = state.selectedDay;
let quickError = '';
let quickMessage = '';
let listScrollTop = 0;

function renderFloating(restoreInput) {
  const count = incompleteCount();
  const capturing = windowUI.mode === 'quick';
  app.innerHTML = `<div class="mini-bar" aria-label="悬浮待办栏">
    <span class="mini-grip" title="拖动悬浮栏" aria-hidden="true">${ICONS.grip}</span>
    <button class="mini-count ${count === 0 ? 'zero' : ''}" data-act="expand" title="展开待办面板" aria-label="${DAY_TITLE[state.selectedDay]} ${count} 件待办，展开完整面板"><span>${DAY_TITLE[state.selectedDay]}</span><strong>${count > 99 ? '99+' : count}</strong></button>
    <span class="mini-divider" aria-hidden="true"></span>
    <button class="mini-add" data-act="quick-toggle" title="快速新增待办" aria-label="快速新增待办" aria-expanded="${capturing}">${ICONS.plus}</button>
    <span class="mini-sr-only" role="status">${esc(quickMessage)}</span>
  </div>${capturing ? `<section class="quick-capture" aria-label="快速新增待办">
    <div class="quick-heading"><span>记下一件事</span><button class="icon-btn sm" data-act="quick-close" aria-label="收起输入框" title="收起并保留草稿">${ICONS.x}</button></div>
    <div class="composer quick-composer"><input id="quick-input" placeholder="接下来要做什么？" value="${esc(quickDraft)}" /></div>
    <div class="quick-error" role="alert" ${quickError ? '' : 'hidden'}>${esc(quickError)}</div>
    <div class="quick-footer"><select id="quick-day" aria-label="新待办的日期">${DAYS.map(day => `<option value="${day}" ${day === quickDay ? 'selected' : ''}>${DAY_TITLE[day]}</option>`).join('')}</select><span>Enter 添加</span><button class="send" data-act="quick-submit" aria-label="保存待办" ${quickDraft.trim() ? '' : 'disabled'}>${ICONS.arrowUp}</button></div>
  </section>` : ''}`;
  app.querySelector('.mini-bar').addEventListener('mousedown', onDragStart);
  classificationUI.afterRender();
  if (capturing && restoreInput?.id === 'quick-input') {
    const field = document.getElementById('quick-input');
    field.focus(); field.setSelectionRange(restoreInput.start, restoreInput.end);
  }
}

async function collapseWindow() {
  if (app.querySelector('.list')) listScrollTop = app.querySelector('.list').scrollTop;
  closeMenu();
  classificationUI.closeAutocomplete();
  document.querySelector('.classification-notice')?.remove();
  if (await windowUI.setMode('mini')) app.querySelector('.mini-count')?.focus({ preventScroll: true });
}

async function openQuickCapture() {
  if (!quickDraft.trim()) quickDay = state.selectedDay;
  quickError = ''; quickMessage = '';
  if (await windowUI.setMode('quick')) document.getElementById('quick-input')?.focus();
}

async function closeQuickCapture() {
  classificationUI.closeAutocomplete();
  if (await windowUI.setMode('mini')) app.querySelector('.mini-add')?.focus({ preventScroll: true });
}

async function commitQuick() {
  if (!quickDraft.trim() || classificationUI.isComposing()) return;
  const parsed = parseClassification(quickDraft.trim());
  const { day, time, title } = parseQuickInput(parsed.title, quickDay);
  if (!title) { quickError = '请填写任务标题'; render(); return; }
  addItem(title, day, time, resolveClassification(state, parsed.tokens));
  quickDraft = ''; quickError = ''; quickMessage = `已添加到${DAY_TITLE[day]}`;
  await closeQuickCapture();
}

function onDragStart(e) {
  if (e.button !== 0 || e.target.closest("button, input, select, textarea")) return;
  appWindow?.startDragging().catch(() => {});
}

/* ---------------- 待办排序（指针事件兼容 Tauri WebView） ---------------- */

let todoDrag = null;
let suppressDragClick = false;

function dragItems(row) {
  return row.dataset.kind === "recurring" ? state.recurringItems : items(row.dataset.day);
}

function commitTodoOrder(row, orderedIds) {
  const ordered = reorderVisibleItems(dragItems(row), orderedIds);
  setTaskOrder(syncStore.doc, ordered.map(item => item.id), row.dataset.row);
  if (row.dataset.kind === "recurring") state.recurringItems = ordered;
  else state.itemsByDay[row.dataset.day] = ordered;
  save();
}

function updateTodoDrag() {
  const drag = todoDrag;
  if (!drag?.active) return;
  drag.ghost.style.top = `${drag.y - drag.offsetY}px`;
  drag.ghost.style.left = `${drag.x - drag.offsetX}px`;
  const bounds = drag.container.getBoundingClientRect();
  if (drag.x < bounds.left || drag.x > bounds.right || drag.y < bounds.top - 24 || drag.y > bounds.bottom + 24) return;
  // A completed todo can only move among completed todos, and vice versa.
  const peers = [...drag.container.querySelectorAll(":scope > .row")]
    .filter((row) => row !== drag.row && row.classList.contains("done") === drag.row.classList.contains("done"));
  const next = peers.find((row) => {
    const rect = row.getBoundingClientRect();
    return drag.y < rect.top + rect.height / 2;
  });
  if (next) drag.container.insertBefore(drag.row, next);
  else if (peers.length) peers.at(-1).after(drag.row);
}

function scrollTodoDrag() {
  const drag = todoDrag;
  if (!drag?.active) return;
  const bounds = drag.container.getBoundingClientRect();
  if (drag.x >= bounds.left && drag.x <= bounds.right) {
    const edge = 28;
    const speed = drag.y < bounds.top + edge ? -8 : drag.y > bounds.bottom - edge ? 8 : 0;
    if (speed) { drag.container.scrollTop += speed; updateTodoDrag(); }
  }
  drag.frame = requestAnimationFrame(scrollTodoDrag);
}

function finishTodoDrag(commit = false, redraw = true) {
  const drag = todoDrag;
  if (!drag) return;
  if (drag.viewportWidth !== innerWidth || drag.viewportHeight !== innerHeight) commit = false;
  todoDrag = null;
  if (drag.frame) cancelAnimationFrame(drag.frame);
  drag.ghost?.remove();
  drag.row.classList.remove("drag-placeholder");
  document.documentElement.classList.remove("sorting");
  if (app.hasPointerCapture(drag.pointerId)) app.releasePointerCapture(drag.pointerId);
  if (!drag.active) return;
  suppressDragClick = true;
  setTimeout(() => { suppressDragClick = false; }, 0);
  if (commit) {
    commitTodoOrder(drag.row, [...drag.container.querySelectorAll(":scope > .row")].map((row) => row.dataset.row));
  }
  if (redraw) {
    const scrollTop = drag.container.scrollTop;
    const id = drag.row.dataset.row;
    render();
    const row = [...app.querySelectorAll("[data-row]")].find((row) => row.dataset.row === id);
    if (row) {
      row.parentElement.scrollTop = scrollTop;
      row.querySelector(".drag-handle")?.focus({ preventScroll: true });
    }
  }
}

app.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || todoDrag) return;
  const row = e.target.closest(".row");
  if (!row || e.target.closest(".check, .actions, a, input, textarea")) return;
  if (e.target.closest("button") && !e.target.closest(".drag-handle")) return;
  const bounds = row.getBoundingClientRect();
  todoDrag = { row, container: row.parentElement, pointerId: e.pointerId,
    viewportWidth: innerWidth, viewportHeight: innerHeight,
    startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY,
    offsetX: e.clientX - bounds.left, offsetY: e.clientY - bounds.top, active: false };
  // Capture only after movement so ordinary title clicks still edit normally.
});

app.addEventListener("pointermove", (e) => {
  const drag = todoDrag;
  if (!drag || drag.pointerId !== e.pointerId) return;
  drag.x = e.clientX; drag.y = e.clientY;
  if (!drag.active) {
    if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 5) return;
    drag.active = true;
    closeMenu();
    app.setPointerCapture(e.pointerId);
    const bounds = drag.row.getBoundingClientRect();
    drag.ghost = drag.row.cloneNode(true);
    drag.ghost.classList.add("drag-ghost");
    drag.ghost.inert = true;
    drag.ghost.setAttribute("aria-hidden", "true");
    drag.ghost.style.width = `${bounds.width}px`;
    // Keep compact typography when the clone is outside #app.
    document.body.appendChild(drag.ghost);
    drag.row.classList.add("drag-placeholder");
    document.documentElement.classList.add("sorting");
    scrollTodoDrag();
  }
  e.preventDefault();
  updateTodoDrag();
});

document.addEventListener("pointerup", (e) => {
  if (todoDrag?.pointerId === e.pointerId) finishTodoDrag(true);
});
document.addEventListener("pointercancel", () => finishTodoDrag(false));
app.addEventListener("lostpointercapture", () => finishTodoDrag(false));
window.addEventListener("blur", () => finishTodoDrag(false));
window.addEventListener("resize", () => finishTodoDrag(false));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && todoDrag) { e.preventDefault(); finishTodoDrag(false); }
});

app.addEventListener("click", (e) => {
  if (!suppressDragClick) return;
  e.preventDefault(); e.stopImmediatePropagation();
}, true);

app.addEventListener("keydown", (e) => {
  if (!e.target.closest(".drag-handle") || !e.altKey || !["ArrowUp", "ArrowDown"].includes(e.key)) return;
  e.preventDefault();
  const row = e.target.closest(".row");
  const arr = dragItems(row);
  const selected = arr.find((item) => item.id === row.dataset.row);
  if (!selected) return;
  const peers = arr.filter((item) => classificationUI.filtered(item) && !!item.completed === !!selected.completed);
  const index = peers.findIndex((item) => item.id === row.dataset.row);
  const target = peers[index + (e.key === "ArrowUp" ? -1 : 1)];
  if (!target) return;
  const ids = arr.map((item) => item.id);
  const from = ids.indexOf(row.dataset.row), to = ids.indexOf(target.id);
  [ids[from], ids[to]] = [ids[to], ids[from]];
  commitTodoOrder(row, ids);
  const id = row.dataset.row;
  render();
  [...app.querySelectorAll("[data-row]")].find((row) => row.dataset.row === id)?.querySelector(".drag-handle")?.focus();
});

/* 事件委托 */
app.addEventListener("click", (e) => {
  if (e.target.closest('[data-class-ui]')) return;
  const link = e.target.closest("a[data-link]");
  if (link) { e.preventDefault(); openExternal(link.dataset.link); return; }

  const el = e.target.closest("[data-act]");
  if (!el) return;
  const act = el.dataset.act;
  const id = el.dataset.id;
  const day = el.dataset.day;

  switch (act) {
    case "day": state.selectedDay = day; listScrollTop = 0; app.querySelector('.list')?.scrollTo(0, 0); save(); render(); break;
    case "toggle": {
      const wasOpen = !state.itemsByDay[day].find((i) => i.id === id)?.completed;
      toggleItem(id, day);
      if (wasOpen) celebrate(el);
      render();
      break;
    }
    case "rtoggle": {
      const wasOpen = !state.recurringItems.find((i) => i.id === id)?.completed;
      toggleRecurring(id);
      if (wasOpen) celebrate(el);
      render();
      break;
    }
    case "del": deleteItem(id, day); render(); break;
    case "rdel": deleteRecurring(id); render(); break;
    case "unpin": unpinRecurring(id); render(); break;
    case "clear": clearCompleted(day); render(); break;
    case "edit": startEdit(id, day); break;
    case "redit": startRecurEdit(id); break;
    case "submit": commitMain(); break;
    case "canceledit": cancelEdit(); break;
    case "raddtoggle": recurringComposerOpen = !recurringComposerOpen; focusRecur = recurringComposerOpen; render(); break;
    case "raddsubmit": commitRecur(); break;
    case "expand": expandWindow(); break;
    case "collapse": collapseWindow(); break;
    case "quick-toggle": windowUI.mode === 'quick' ? closeQuickCapture() : openQuickCapture(); break;
    case "quick-close": closeQuickCapture(); break;
    case "quick-submit": commitQuick(); break;
    case "settings": openSettings(); break;
    case "maximize": appWindow?.toggleMaximize().catch(error => classificationUI.showNotice(`窗口最大化失败：${error}`)); break;
    case "planner": planner.open(); break;
    case "reminder-center": planner.open('reminders'); break;
    case "memotoggle": state.memo.expanded = !state.memo.expanded; save(); render(); break;
    case "menu": openRowMenu(id, day, el); break;
  }
});

/* 输入框事件（委托 input/keydown） */
app.addEventListener("input", (e) => {
  if (e.target.id === 'quick-input') {
    quickDraft = e.target.value; quickError = '';
    app.querySelector('[data-act="quick-submit"]').disabled = !quickDraft.trim();
    app.querySelector('.quick-error').hidden = true;
  } else if (e.target.id === "main-input") {
    draft = e.target.value;
    const send = app.querySelector('[data-act="submit"]');
    if (send) send.classList.toggle("off", !draft.trim());
  } else if (e.target.id === "recur-input") {
    recurDraft = e.target.value;
  } else if (e.target.id === "memo-input") {
    state.memo.text = e.target.value;
    clearTimeout(memoSaveTimer); memoSaveTimer = setTimeout(save, 400);
  }
});
app.addEventListener('change', (e) => { if (e.target.id === 'quick-day') quickDay = e.target.value; });
app.addEventListener('scroll', (e) => {
  if (!windowUI.transitioning && e.target.matches?.('.list')) listScrollTop = e.target.scrollTop;
}, true);
app.addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Enter" && !e.shiftKey) {
    if (e.target.id === 'quick-input') { e.preventDefault(); commitQuick(); }
    else if (e.target.id === "main-input") { e.preventDefault(); commitMain(); }
    else if (e.target.id === "recur-input") { e.preventDefault(); commitRecur(); }
  }
  if (e.key === "Escape" && e.target.id === "main-input") {
    if (composerEditId) cancelEdit();
    else collapseWindow();
  }
  if (e.key === 'Escape' && windowUI.mode === 'quick') { e.preventDefault(); closeQuickCapture(); }
});

function commitMain() {
  const t = draft.trim();
  if (!t) return;
  const parsed = parseClassification(t);
  let savedTask;
  if (composerEditId) {
    if (!parsed.title) { classificationUI.showNotice('请填写任务标题'); return; }
    savedTask = state.itemsByDay[composerEditDay].find(it => it.id === composerEditId);
    if (!savedTask) { cancelEdit(); return; }
    Object.assign(savedTask, resolveClassification(state, parsed.tokens));
    updateItem(composerEditId, composerEditDay, parsed.title, undefined);
    composerEditId = null; composerEditDay = null;
  } else {
    const { day, time, title } = parseQuickInput(parsed.title, state.selectedDay);
    if (!title) { classificationUI.showNotice('请填写任务标题'); return; }
    savedTask = addItem(title, day, time, resolveClassification(state, parsed.tokens));
    if (day !== state.selectedDay) state.selectedDay = day;
  }
  draft = ""; focusMain = true; render();
  save();
  if (savedTask && !classificationUI.filtered(savedTask)) classificationUI.showNotice('任务已保存，当前筛选未包含它', true);
}
function startEdit(id, day) {
  const it = state.itemsByDay[day].find((i) => i.id === id);
  if (!it) return;
  state.selectedDay = day;
  composerEditId = id; composerEditDay = day; draft = editText(state, it); focusMain = true;
  render();
}
function cancelEdit() {
  composerEditId = null; composerEditDay = null; draft = ""; focusMain = true; render();
}
function commitRecur() {
  const t = recurDraft.trim();
  if (!t) return;
  const classified = parseClassification(t);
  let savedTask;
  if (!classified.title) { classificationUI.showNotice('请填写任务标题'); return; }
  if (recurEditId) {
    savedTask = state.recurringItems.find(it => it.id === recurEditId);
    if (savedTask) { Object.assign(savedTask, resolveClassification(state, classified.tokens)); updateRecurringTitle(recurEditId, classified.title); }
    recurEditId = null;
  }
  else {
    const parsed = parseTime(classified.title);
    const time = parsed ? parsed.time : null;
    const title = parsed ? classified.title.replace(parsed.match, " ").replace(/\s+/g, " ").trim() : classified.title;
    if (!title) { classificationUI.showNotice('请填写任务标题'); return; }
    savedTask = addRecurring(title, time, resolveClassification(state, classified.tokens));
  }
  recurDraft = ""; focusRecur = true; render();
  if (savedTask && !classificationUI.filtered(savedTask)) classificationUI.showNotice('任务已保存，当前筛选未包含它', true);
}
function startRecurEdit(id) {
  const it = state.recurringItems.find((i) => i.id === id);
  if (!it) return;
  recurringComposerOpen = true; recurEditId = id; recurDraft = editText(state, it); focusRecur = true;
  render();
}

/* ---------------- 行浮层菜单 ---------------- */

function closeMenu() {
  document.querySelector(".menu")?.remove();
  document.querySelector(".menu-mask")?.remove();
}
function openRowMenu(id, day, anchorEl) {
  closeMenu();
  const it = state.itemsByDay[day].find((i) => i.id === id);
  if (!it) return;
  const others = DAYS.filter((d) => d !== day);
  const mask = document.createElement("div");
  mask.className = "menu-mask";
  mask.style.cssText = "position:absolute;inset:0;z-index:55";
  mask.addEventListener("click", closeMenu);
  document.body.appendChild(mask);

  const menu = document.createElement("div");
  menu.className = "menu";
  menu.innerHTML =
    `<button data-m="edit">${ICONS.pencil}<span>编辑</span></button>` +
    `<button data-m="detail">${ICONS.note}<span>${it.detail ? "编辑描述" : "添加描述"}</span></button>` +
    `<button data-m="categories">#<span>项目与标签</span></button>` +
    `<button data-m="pin">${ICONS.repeat}<span>设为每天</span></button>` +
    `<div class="sep"></div>` +
    others.map((d) => `<button data-m="move:${d}">${ICONS.arrowRight}<span>移到${DAY_TITLE[d]}</span></button>`).join("") +
    `<div class="sep"></div>` +
    `<button class="danger" data-m="del">${ICONS.trash}<span>删除</span></button>`;
  document.body.appendChild(menu);

  const r = anchorEl.getBoundingClientRect();
  const mw = 160, mh = menu.offsetHeight;
  let left = Math.min(r.right - mw, window.innerWidth - mw - 8);
  left = Math.max(8, left);
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = r.top - mh - 6;
  menu.style.left = left + "px";
  menu.style.top = top + "px";

  menu.addEventListener("click", (e) => {
    const b = e.target.closest("[data-m]");
    if (!b) return;
    const m = b.dataset.m;
    closeMenu();
    if (m === "edit") startEdit(id, day);
    else if (m === "detail") openDetailEditor(id, day);
    else if (m === "categories") classificationUI.openTaskCategories(it);
    else if (m === "pin") { pinAsRecurring(id, day); render(); }
    else if (m === "del") { deleteItem(id, day); render(); }
    else if (m.startsWith("move:")) { moveItem(id, day, m.slice(5)); render(); }
  });
}

/* 描述编辑弹窗 */
function openDetailEditor(id, day) {
  const it = state.itemsByDay[day].find((i) => i.id === id);
  if (!it) return;
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.innerHTML = `<div class="settings" style="margin-top:40px;gap:12px">
    <h2>${DAY_TITLE[day]}待办详情</h2>
    <div><div style="font-size:11px;color:var(--text-secondary);margin-bottom:5px">标题</div>
    <div class="composer sm"><input id="de-title" value="${esc(it.title)}"/></div></div>
    <div><div style="font-size:11px;color:var(--text-secondary);margin-bottom:5px">描述</div>
    <div class="memo"><textarea id="de-detail" style="border-top:none">${esc(it.detail)}</textarea></div></div>
    ${classificationUI.metadataFields(it)}
    <div class="set-row"><button class="link-btn" data-de="cancel">取消</button>
    <button class="link-btn" style="color:var(--accent);font-weight:600" data-de="save">保存详情</button></div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
    const b = e.target.closest("[data-de]");
    if (!b) return;
    if (b.dataset.de === "cancel") overlay.remove();
    else {
      if (!overlay.querySelector("#de-title").value.trim()) return;
      Object.assign(it, classificationUI.readMetadata(overlay));
      updateItem(id, day, overlay.querySelector("#de-title").value, overlay.querySelector("#de-detail").value);
      overlay.remove();
      render();
    }
  });
  overlay.querySelector("#de-title")?.focus();
}

/* ---------------- 设置面板 ---------------- */

const updateChecker = createUpdateChecker({
  invoke: TAURI?.core?.invoke ? name => TAURI.core.invoke(name) : null,
  openExternal,
  notice: text => classificationUI.showNotice(text),
});

function openSettings() {
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  const s = state.settings;
  const bgHex = s.customBg ? rgbToHex(s.customBg) : "#dceaff";
  overlay.innerHTML = `<div class="settings">
    <h2>小组件设置</h2>
    <section class="settings-group" aria-labelledby="settings-window-title">
      <h3 id="settings-window-title">窗口与行为</h3>
      <div class="set-row"><span>始终置顶</span><div class="switch ${s.alwaysOnTop ? "on" : ""}" data-s="alwaysOnTop"></div></div>
      ${isWindows ? `<div class="set-row"><span>固定在桌面（Win+D 后仍显示）</span><div class="switch ${s.showOnDesktop ? "on" : ""}" data-s="showOnDesktop"></div></div>` : ""}
      <div class="set-row"><span>鼠标穿透（点击落到下层）</span><div class="switch ${s.clickThrough ? "on" : ""}" data-s="clickThrough"></div></div>
      <div class="set-row"><span>开机自启动</span><div class="switch" id="autostart-sw" data-s="autostart"></div></div>
      <div class="set-row"><span>开启备忘录</span><div class="switch ${s.memoEnabled ? "on" : ""}" data-s="memoEnabled"></div></div>
    </section>
    <section class="settings-group" aria-labelledby="settings-appearance-title">
      <h3 id="settings-appearance-title">外观</h3>
      <div>
        <div style="font-size:13px;font-weight:500;margin-bottom:6px">主题</div>
        <div class="seg-control">
          <button class="${s.appearance === "system" ? "on" : ""}" data-ap="system">跟随系统</button>
          <button class="${s.appearance === "light" ? "on" : ""}" data-ap="light">浅色</button>
          <button class="${s.appearance === "dark" ? "on" : ""}" data-ap="dark">深色</button>
        </div>
      </div>
      <div class="set-row"><span>背景色</span>
        <div style="display:flex;align-items:center;gap:8px">
          <input type="color" id="bg-color" value="${bgHex}"/>
          <button class="link-btn" data-s="resetBg" ${s.customBg ? "" : 'style="opacity:.45"'}>恢复默认</button>
        </div>
      </div>
      <div>
        <div class="set-row"><span>透明度</span><span style="color:var(--text-secondary)">${Math.round(s.opacity * 100)}%</span></div>
        <input type="range" id="op-range" min="0.2" max="0.95" step="0.01" value="${s.opacity}"/>
      </div>
      <div class="set-row"><span>窗口阴影</span><button type="button" class="switch ${s.shadowEnabled ? "on" : ""}" data-s="shadowEnabled" role="switch" aria-checked="${!!s.shadowEnabled}" aria-label="窗口阴影"></button></div>
    </section>
    <section class="settings-group" aria-labelledby="settings-categories-title">
      <h3 id="settings-categories-title">分类</h3>
      <button class="data-btn" data-s="categories"><span>项目与标签</span><span aria-hidden="true">›</span></button>
    </section>
    <section class="settings-group" aria-labelledby="settings-sync-title">
      <h3 id="settings-sync-title">同步与备份</h3>
      <button class="data-btn" data-s="lan"><span>局域网与 Tailscale 同步</span><span aria-hidden="true">›</span></button>
      <button class="data-btn" data-s="sync"><span>WebDAV 同步与冲突</span><span aria-hidden="true">›</span></button>
      <div class="set-row" style="gap:8px">
        <button class="data-btn" data-s="export">${ICONS.download}<span>导出备份</span></button>
        <button class="data-btn" data-s="import">${ICONS.upload}<span>导入备份</span></button>
      </div>
    </section>
    <section class="settings-group" data-update-panel></section>
    <section class="settings-group" aria-labelledby="settings-notifications-title">
      <h3 id="settings-notifications-title">通知</h3>
      <div class="set-row"><span>本机到点提醒</span><button class="switch ${s.remindersEnabled !== false ? "on" : ""}" data-s="remindersEnabled" aria-label="本机到点提醒"></button></div>
    </section>
    <div style="font-size:11px;color:var(--text-secondary);line-height:1.6">
      💡 全局快捷键 <b>${navigator.platform.includes("Mac") ? "⌘⇧Space" : "Ctrl+Shift+Space"}</b> 可在任意应用中唤起并聚焦输入框，快速记一笔。<br>
      ⏰ 输入「明天 15:00 开会」会自动识别日期与提醒时间。<br>
      输入 <b>#标签</b> 或 <b>+项目</b> 可分类，方向键选择、Tab / Enter 补全。<br>
      🖱️ 开启鼠标穿透后浮窗不再挡点击，可从<b>托盘菜单「切换鼠标穿透」</b>关回来。
    </div>
    <div class="set-row" style="justify-content:flex-end"><button class="link-btn" data-s="close">完成</button></div>
  </div>`;
  document.body.appendChild(overlay);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) { overlay.remove(); return; }
    const sw = e.target.closest("[data-s]");
    if (sw) {
      const key = sw.dataset.s;
      if (key === "alwaysOnTop") {
        state.settings.alwaysOnTop = !state.settings.alwaysOnTop;
        if (state.settings.alwaysOnTop) state.settings.showOnDesktop = false;
        sw.classList.toggle("on", state.settings.alwaysOnTop);
        overlay.querySelector('[data-s="showOnDesktop"]')?.classList.toggle("on", state.settings.showOnDesktop);
      }
      else if (key === "showOnDesktop") {
        state.settings.showOnDesktop = !state.settings.showOnDesktop;
        if (state.settings.showOnDesktop) state.settings.alwaysOnTop = false;
        sw.classList.toggle("on", state.settings.showOnDesktop);
        overlay.querySelector('[data-s="alwaysOnTop"]')?.classList.toggle("on", state.settings.alwaysOnTop);
      }
      else if (key === "shadowEnabled") {
        state.settings.shadowEnabled = !state.settings.shadowEnabled;
        sw.classList.toggle("on", state.settings.shadowEnabled);
        sw.setAttribute("aria-checked", String(state.settings.shadowEnabled));
      }
      else if (key === "memoEnabled") {
        state.settings.memoEnabled = !state.settings.memoEnabled;
        if (state.settings.memoEnabled) state.memo.expanded = true;
        sw.classList.toggle("on");
      }
      else if (key === "resetBg") { state.settings.customBg = null; overlay.remove(); save(); render(); openSettings(); return; }
      else if (key === "clickThrough") {
        state.settings.clickThrough = !state.settings.clickThrough;
        sw.classList.toggle("on");
        save();
        // 开启后浮窗不再响应点击，先关闭设置面板避免被困
        if (state.settings.clickThrough) overlay.remove();
        applyWindowChrome();
        return;
      }
      else if (key === "autostart") { toggleAutostart(sw); return; }
      else if (key === "lan") { overlay.remove(); openLanSettings(syncStore); return; }
      else if (key === "sync") { overlay.remove(); openSyncSettings(syncStore); return; }
      else if (key === "remindersEnabled") { state.settings.remindersEnabled = state.settings.remindersEnabled === false; sw.classList.toggle("on", state.settings.remindersEnabled); }
      else if (key === "export") { exportBackup(); return; }
      else if (key === "categories") { overlay.remove(); classificationUI.openManager(); return; }
      else if (key === "import") { importBackup(overlay); return; }
      else if (key === "close") { overlay.remove(); }
      save(); applyWindowChrome(); render();
    }
    const ap = e.target.closest("[data-ap]");
    if (ap) {
      state.settings.appearance = ap.dataset.ap;
      overlay.querySelectorAll("[data-ap]").forEach((b) => b.classList.toggle("on", b === ap));
      save(); applyWindowChrome();
    }
  });
  overlay.querySelector("#op-range").addEventListener("input", (e) => {
    state.settings.opacity = parseFloat(e.target.value);
    e.target.previousElementSibling.querySelector("span:last-child").textContent = Math.round(state.settings.opacity * 100) + "%";
    applyWindowChrome(); save();
  });
  overlay.querySelector("#bg-color").addEventListener("input", (e) => {
    state.settings.customBg = hexToRgb(e.target.value);
    applyWindowChrome(); save();
  });
  updateChecker.mount(overlay.querySelector("[data-update-panel]"));
  // 异步同步开机自启动开关的真实状态
  (async () => {
    try {
      const on = await TAURI?.autostart?.isEnabled();
      overlay.querySelector("#autostart-sw")?.classList.toggle("on", !!on);
    } catch (e) {}
  })();
}

async function toggleAutostart(sw) {
  try {
    const on = await TAURI.autostart.isEnabled();
    if (on) await TAURI.autostart.disable();
    else await TAURI.autostart.enable();
    sw.classList.toggle("on", !on);
  } catch (e) {}
}

async function exportBackup() {
  try {
    await TAURI.core.invoke("export_data", { json: JSON.stringify(syncStore.backup(state), null, 2) });
  } catch (e) {}
}

async function importBackup(overlay) {
  try {
    const content = await TAURI.core.invoke("import_data");
    if (!content) return;
    const parsed = JSON.parse(content);
    const revisions = await syncStore.prepareImport(parsed, normalizeSnapshot, defaultState());
    const counts = syncStore.previewImport(revisions);
    overlay?.remove();
    confirmImport(counts, async () => {
      await syncStore.import(revisions);
      classificationUI.filters.project = ''; classificationUI.filters.tags = [];
      draft = ''; recurDraft = ''; composerEditId = null; composerEditDay = null; recurEditId = null;
      applyWindowChrome(); render();
    });
  } catch (e) { classificationUI.showNotice('导入失败：' + e.message); }
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}
function rgbToHex(rgb) {
  const [r, g, b] = rgb.split(",").map((x) => parseInt(x.trim()));
  return "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/* ---------------- 完成撒花 ---------------- */

const CONFETTI_COLORS = ["#1573ff", "#29ab56", "#ffb020", "#ff5d8f", "#7c5cff"];
function celebrate(anchorEl) {
  const r = anchorEl.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  for (let i = 0; i < 14; i++) {
    const p = document.createElement("div");
    p.className = "confetti";
    p.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
    p.style.left = cx + "px";
    p.style.top = cy + "px";
    const ang = (Math.PI * 2 * i) / 14 + Math.random() * 0.6;
    const dist = 26 + Math.random() * 30;
    p.style.setProperty("--dx", Math.cos(ang) * dist + "px");
    p.style.setProperty("--dy", (Math.sin(ang) * dist - 18) + "px");
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 700);
  }
}

/* ---------------- 提醒通知 ---------------- */

async function ensureNotifyPermission() {
  try {
    const n = TAURI?.notification;
    if (!n) return false;
    let granted = await n.isPermissionGranted();
    if (!granted) granted = (await n.requestPermission()) === "granted";
    return granted;
  } catch (e) {
    return false;
  }
}

let reminderError = '';
function sendSystemNotification(options) {
  // The convenience sendNotification API returns void. Await native IPC so
  // permission/platform failures cannot silently consume a pending reminder.
  return window.__TAURI_INTERNALS__
    ? TAURI.core.invoke('plugin:notification|notify', { options })
    : TAURI.notification.sendNotification(options);
}
const runReminders = createReminderRunner({
  getDoc: () => syncStore.doc,
  permission: ensureNotifyPermission,
  send: sendSystemNotification,
  persist: () => syncStore.persist(),
  onDelivered: () => { planner.refresh(); },
  onError: message => {
    if (message && message !== reminderError) classificationUI.showNotice(message);
    reminderError = message;
  },
});
async function checkReminders() {
  rollOverIfNeeded();
  await runReminders();
}

/* ---------------- 窗口尺寸 / 缩放 ---------------- */

async function expandWindow() {
  classificationUI.closeAutocomplete();
  if (await windowUI.setMode('panel')) app.querySelector('[data-act="collapse"]')?.focus({ preventScroll: true });
}

document.addEventListener('pointerdown', event => {
  const handle = event.target.closest('.resize');
  if (handle && planner.active && event.button === 0) {
    event.preventDefault(); event.stopImmediatePropagation();
    appWindow?.startResizeDragging(handle.dataset.dir).catch(() => {});
  }
}, true);
document.querySelectorAll(".resize").forEach((h) => {
  if (h.dataset.dir === 'SouthWest') { windowUI.attachResize(h); return; }
  h.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || windowUI.floating || windowUI.transitioning) return;
    e.preventDefault();
    appWindow?.startResizeDragging(h.dataset.dir).catch(() => {});
  });
});

function updateCompact(redraw = true) {
  windowUI.observeSize();
  const w = window.innerWidth, hh = window.innerHeight;
  const c = !windowUI.floating && (w < 300 || hh < 280);
  if (c !== compact) { compact = c; document.documentElement.classList.toggle("compact", c); if (redraw) render(); }
  else { document.documentElement.classList.toggle("compact", c); }
}
window.addEventListener("resize", () => updateCompact());

document.addEventListener('pointerdown', (event) => {
  if (windowUI.mode === 'quick' && !event.target.closest('.quick-capture, .mini-bar, .category-suggestions')) closeQuickCapture();
});
window.addEventListener('blur', () => {
  setTimeout(() => {
    if (windowUI.mode === 'quick' && !windowUI.transitioning && !document.hasFocus() && document.activeElement?.tagName !== 'SELECT') closeQuickCapture();
  }, 80);
});

/* ---------------- 全局快捷键：快速捕获 ---------------- */

TAURI?.event?.listen?.("quick-capture", async () => {
  if (planner.active) await planner.close();
  closeMenu();
  document.querySelector(".overlay")?.remove();
  if (windowUI.floating) { await openQuickCapture(); return; }
  if (compact) await expandWindow();
  focusMain = true;
  render();
  setTimeout(() => {
    const mi = document.getElementById("main-input");
    if (mi) { mi.focus(); mi.select(); }
  }, 60);
});

// 托盘「切换鼠标穿透」：翻转穿透开关（穿透开启时浮窗点不动，这是唯一可靠的关闭入口）
TAURI?.event?.listen?.("toggle-passthrough", () => {
  state.settings.clickThrough = !state.settings.clickThrough;
  save();
  applyWindowChrome();
});

TAURI?.event?.listen?.("toggle-desktop-mode", () => {
  if (!isWindows) return;
  state.settings.showOnDesktop = !state.settings.showOnDesktop;
  if (state.settings.showOnDesktop) state.settings.alwaysOnTop = false;
  save();
  render();
});

const planner = createPlanner({
  store: syncStore, nativeWindow: appWindow, windowApi: TAURI?.window,
  beforeOpen: () => { save(); closeMenu(); classificationUI.closeAutocomplete(); },
  notify: text => classificationUI.showNotice(text),
});
window.addEventListener('todo-test-notification', async () => {
  try {
    if (!await ensureNotifyPermission()) throw new Error('请在系统设置中允许“悬浮待办”的通知');
    await sendSystemNotification({ title: '悬浮待办 · 测试通知', body: '通知已开启，请保持应用在托盘运行。' });
    classificationUI.showNotice('测试通知已发送');
  } catch (error) { classificationUI.showNotice(error.message || String(error)); }
});
window.addEventListener('focus', checkReminders);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkReminders(); });

/* ---------------- 启动 ---------------- */

updateCompact();
render();
applyWindowChrome();

// 跨午夜定期滚动 + 到点提醒
setInterval(() => render(), 5 * 60 * 1000);
setInterval(checkReminders, 30 * 1000);
checkReminders();
if (startupNotice) classificationUI.showNotice(startupNotice);

syncStore.notice = text => classificationUI.showNotice(text);
syncStore.canSync = () => !classificationUI.isComposing() && !memoSaveTimer && !composerEditId && !recurEditId &&
  !document.querySelector('.overlay:not(.sync-overlay)');
syncStore.start();
updateChecker.start();
window.addEventListener('beforeunload', () => updateChecker.stop());
window.addEventListener('beforeunload', () => syncStore.stop());

app.addEventListener('focusout', e => { if (e.target.id === 'memo-input' && memoSaveTimer) save(); });
window.addEventListener('pagehide', () => { if (memoSaveTimer) save(); });
let lastStorageError = '';
window.addEventListener('todo-sync-status', () => {
  if (syncStore.storageError && syncStore.storageError !== lastStorageError) classificationUI.showNotice(syncStore.error);
  lastStorageError = syncStore.storageError || '';
});
