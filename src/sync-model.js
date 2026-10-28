// Versioned domain model. No network or UI dependencies.
export const PROTOCOL_VERSION = 1;
export const DAY_KEYS = ['today', 'tomorrow', 'dayAfterTomorrow'];
const clone = value => structuredClone(value);
const compareText = (a, b) => a === b ? 0 : a < b ? -1 : 1;
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export async function digest(value) {
  const bytes = new TextEncoder().encode(typeof value === 'string' ? value : canonical(value));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
}
export function dateInZone(zone = 'Asia/Shanghai', now = new Date()) {
  const parts = new Intl.DateTimeFormat('en', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = type => parts.find(p => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function isoDate(value) {
  const [y, m, d] = String(value).split('-').map(Number);
  if (!y || !m || !d) throw new Error('日期格式不正确');
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
export function shiftDate(value, days) {
  const d = new Date(isoDate(value) + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10);
}
export function newDocument() {
  return { schemaVersion: 3, protocolVersion: 1, deviceId: crypto.randomUUID(), revisions: [], outbox: [], knownObjects: {}, clock: [0, 0], local: {}, receipts: {}, sync: { enabled: false, spaceId: 'default', timeZone: 'Asia/Shanghai', url: '', username: '', lastSuccess: null } };
}
export const entityKey = r => `${r.entityType}:${r.entityId}`;
export function compareRevision(a, b) {
  return a.modifiedAt - b.modifiedAt || a.logicalCounter - b.logicalCounter || compareText(a.deviceId, b.deviceId) || compareText(a.revisionId, b.revisionId);
}
export function categoryAliases(doc) {
  const parent = new Map(), names = new Map();
  const root = key => { while (parent.has(key)) key = parent.get(key); return key; };
  for (const r of doc.revisions) if (['projects', 'tags'].includes(r.entityType)) {
    const key = entityKey(r), name = r.entityType + ':' + r.payload.name.trim().normalize('NFKC').toLowerCase();
    if (names.has(name)) {
      const a = root(key), b = root(names.get(name));
      if (a !== b) parent.set([a, b].sort()[1], [a, b].sort()[0]);
    } else names.set(name, key);
  }
  return new Map(doc.revisions.filter(r => ['projects', 'tags'].includes(r.entityType)).map(r => [entityKey(r), root(entityKey(r))]));
}
export function entityHeads(doc) {
  const aliases = categoryAliases(doc);
  const keyOf = r => aliases.get(entityKey(r)) || entityKey(r);
  const byId = new Map(doc.revisions.map(r => [r.revisionId, r]));
  const valid = new Set(), dependencies = new Map(), children = new Map(), ready = [];
  for (const r of doc.revisions) {
    let missing = 0;
    for (const id of r.parentRevisionIds) {
      missing++;
      if (byId.has(id) && keyOf(byId.get(id)) === keyOf(r)) {
        if (!children.has(id)) children.set(id, []);
        children.get(id).push(r.revisionId);
      }
    }
    dependencies.set(r.revisionId, missing);
    if (!missing) ready.push(r.revisionId);
  }
  // Topological traversal avoids recursion limits for long histories and keeps
  // cyclic/incomplete graphs pending until their dependencies are available.
  for (let i = 0; i < ready.length; i++) {
    const id = ready[i]; valid.add(id);
    for (const child of children.get(id) || []) {
      dependencies.set(child, dependencies.get(child) - 1);
      if (dependencies.get(child) === 0) ready.push(child);
    }
  }
  const parents = new Set(doc.revisions.filter(r => valid.has(r.revisionId)).flatMap(r => r.parentRevisionIds));
  const groups = new Map();
  for (const r of doc.revisions) if (valid.has(r.revisionId) && !parents.has(r.revisionId)) {
    const key = keyOf(r); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(r);
  }
  for (const list of groups.values()) list.sort(compareRevision);
  return groups;
}
export function currentEntities(doc) {
  return new Map([...entityHeads(doc)].map(([key, heads]) => [key, heads.at(-1)]));
}
const revisionState = r => canonical([r.deleted, ['projects', 'tags'].includes(r.entityType) ? { ...r.payload, id: null } : r.payload]);
export function conflicts(doc) {
  return [...entityHeads(doc)].filter(([, heads]) => heads.length > 1 && new Set(heads.map(revisionState)).size > 1)
    .map(([key, heads]) => ({ key, heads, winner: heads.at(-1) }));
}
export function writeRevision(doc, type, id, payload, { deleted = false, resolve = false, now = Date.now() } = {}) {
  const aliases = categoryAliases(doc);
  const key = aliases.get(`${type}:${id}`) || `${type}:${id}`;
  if (['projects', 'tags'].includes(type)) { id = key.slice(type.length + 1); payload = { ...payload, id }; }
  const heads = entityHeads(doc).get(key) || [];
  const winner = heads.at(-1);
  if (!resolve && winner && winner.deleted === deleted && canonical(winner.payload) === canonical(payload)) return null;
  const time = Math.max(now, doc.clock[0]);
  const counter = time === doc.clock[0] ? doc.clock[1] + 1 : 0;
  doc.clock = [time, counter];
  const r = { revisionId: crypto.randomUUID(), entityType: type, entityId: id, parentRevisionIds: (resolve ? heads : winner ? heads.filter(r => revisionState(r) === revisionState(winner)) : []).map(r => r.revisionId), deviceId: doc.deviceId, modifiedAt: time, logicalCounter: counter, deleted, payload: clone(payload) };
  validateRevision(r); doc.revisions.push(r); doc.outbox.push(r.revisionId); return r;
}
const text = v => typeof v === 'string';
const validDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
export function validateRevision(r) {
  if (!r || !text(r.revisionId) || !r.revisionId || !text(r.entityId) || !r.entityId || !text(r.deviceId) || !Array.isArray(r.parentRevisionIds) || !r.parentRevisionIds.every(text) || !Number.isSafeInteger(r.modifiedAt) || r.modifiedAt < 0 || r.modifiedAt > 8640000000000000 || !Number.isSafeInteger(r.logicalCounter) || r.logicalCounter < 0 || typeof r.deleted !== 'boolean') throw new Error('同步版本格式不正确');
  const p = r.payload;
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('同步内容格式不正确');
  switch (r.entityType) {
    case 'task':
      if (p.id !== r.entityId || !text(p.title) || !text(p.detail) || !['daily', 'one_off'].includes(p.kind) || typeof p.completed !== 'boolean' || !Array.isArray(p.tagIds) || !p.tagIds.every(text) || !(p.projectId === null || text(p.projectId)) || !Number.isFinite(p.createdAt) || !(p.time === null || (text(p.time) && /^([01]\d|2[0-3]):[0-5]\d$/.test(p.time))) || (p.kind === 'one_off' && !validDate(p.scheduledDate))) throw new Error('同步任务格式不正确');
      if (p.legacyStreak && (!validDate(p.legacyStreak.date) || !Number.isSafeInteger(p.legacyStreak.count) || p.legacyStreak.count < 0)) throw new Error('历史打卡基线格式不正确');
      for (const key of ['completedAt', 'archivedAt']) if (p[key] != null && (!Number.isSafeInteger(p[key]) || p[key] < 0)) throw new Error('任务时间格式不正确');
      if (p.completedDate != null && !validDate(p.completedDate)) throw new Error('完成日期格式不正确');
      if (p.remindLeadMinutes != null && (!Number.isInteger(p.remindLeadMinutes) || p.remindLeadMinutes < 0 || p.remindLeadMinutes > 10080)) throw new Error('提前提醒时间格式不正确');
      if (p.durationMinutes != null && (!Number.isInteger(p.durationMinutes) || p.durationMinutes < 5 || p.durationMinutes > 1440)) throw new Error('任务时长需要在 5 分钟到 24 小时之间');
      break;
    case 'projects': case 'tags':
      if (p.id !== r.entityId || !text(p.name) || !p.name.trim() || !/^#[0-9a-f]{6}$/i.test(p.color)) throw new Error('同步分类格式不正确'); break;
    case 'completion':
      if (!text(p.taskId) || !validDate(p.date) || typeof p.completed !== 'boolean' || r.entityId !== `${p.taskId}/${p.date}` || (p.completedAt != null && (!Number.isSafeInteger(p.completedAt) || p.completedAt < 0))) throw new Error('打卡记录格式不正确'); break;
    case 'order': if (!Number.isFinite(p.position)) throw new Error('排序格式不正确'); break;
    case 'memo': if (!text(p.text)) throw new Error('备忘录格式不正确'); break;
    default: throw new Error('不支持的同步实体');
  }
}
export function mergeRevisions(doc, incoming) {
  if (!Array.isArray(incoming) || incoming.length > 50000) throw new Error('同步批次过大或格式不正确');
  const known = new Map(doc.revisions.map(r => [r.revisionId, r]));
  const added = [];
  for (const r of incoming) {
    validateRevision(r);
    if (known.has(r.revisionId)) {
      if (canonical(known.get(r.revisionId)) !== canonical(r)) throw new Error('同一版本 ID 的内容发生变化');
    } else { known.set(r.revisionId, r); added.push(clone(r)); }
  }
  // Commit only after the complete batch has passed validation.
  doc.revisions.push(...added);
  for (const r of added) if (r.modifiedAt > doc.clock[0] || (r.modifiedAt === doc.clock[0] && r.logicalCounter > doc.clock[1])) doc.clock = [r.modifiedAt, r.logicalCounter];
  return added.length;
}
function taskPayload(task, kind, date) {
  const payload = { id: task.id, kind, title: task.title, detail: task.detail || '', time: task.time || null, completed: kind === 'daily' ? false : !!task.completed, createdAt: task.createdAt || 0, scheduledDate: kind === 'daily' ? null : isoDate(task.scheduledDate || date), projectId: task.projectId || null, tagIds: [...(task.tagIds || [])].sort(), ...(task.legacyStreak ? { legacyStreak: task.legacyStreak } : {}) };
  for (const key of ['completedAt', 'completedDate', 'archivedAt', 'remindLeadMinutes', 'durationMinutes']) if (task[key] != null && (kind !== 'daily' || ['remindLeadMinutes', 'durationMinutes'].includes(key))) payload[key] = task[key];
  return payload;
}
function viewEntities(view) {
  const map = new Map();
  const put = (type, id, payload) => map.set(`${type}:${id}`, { type, id, payload });
  for (const kind of ['projects', 'tags']) for (const entry of view[kind]) put(kind, entry.id, { id: entry.id, name: entry.name, color: entry.color });
  const base = isoDate(view.lastActiveDate);
  DAY_KEYS.forEach((day, offset) => view.itemsByDay[day].forEach(task => put('task', task.id, taskPayload(task, 'one_off', shiftDate(base, offset)))));
  for (const task of view.recurringItems) {
    put('task', task.id, taskPayload(task, 'daily', null));
    put('completion', `${task.id}/${base}`, { taskId: task.id, date: base, completed: !!task.completed, ...(task.completedAt != null ? { completedAt: task.completedAt } : {}) });
  }
  put('memo', 'main', { text: view.memo.text });
  return map;
}
export async function migrateSnapshot(view) {
  const doc = newDocument(); doc.local = localFromView(view);
  const migrated = clone(view);
  for (const task of migrated.recurringItems) if (task.lastDone && task.streak > 0) task.legacyStreak = { date: isoDate(task.lastDone), count: task.streak };
  const entities = viewEntities(migrated);
  // A stable baseline deduplicates copies of the same pre-sync backup.
  for (const { type, id, payload } of entities.values()) {
    if (type === 'memo' && !payload.text) continue;
    const revisionId = 'migration-' + await digest({ type, id, payload });
    doc.revisions.push({ revisionId, entityType: type, entityId: id, parentRevisionIds: [], deviceId: 'migration', modifiedAt: 0, logicalCounter: 0, deleted: false, payload });
    doc.outbox.push(revisionId);
  }
  for (const [groupIndex, list] of [...DAY_KEYS.map(day => migrated.itemsByDay[day]), migrated.recurringItems].entries()) {
    for (const [position, task] of list.entries()) {
      const payload = { position: position + (2 - groupIndex) * 1000000 };
      const revisionId = 'migration-' + await digest({ type: 'order', id: task.id, payload });
      doc.revisions.push({ revisionId, entityType: 'order', entityId: task.id, parentRevisionIds: [], deviceId: 'migration', modifiedAt: 0, logicalCounter: 0, deleted: false, payload }); doc.outbox.push(revisionId);
    }
  }
  return doc;
}
function localFromView(view) {
  return { settings: clone(view.settings), selectedDay: view.selectedDay, memoExpanded: view.memo.expanded, colorCounters: clone(view.colorCounters) };
}
export function commitView(doc, before, after) {
  const previous = viewEntities(before), next = viewEntities(after);
  for (const [key, value] of next) if (!previous.has(key) || canonical(previous.get(key).payload) !== canonical(value.payload)) writeRevision(doc, value.type, value.id, value.payload);
  for (const [key, value] of previous) if (!next.has(key) && value.type !== 'completion') writeRevision(doc, value.type, value.id, value.payload, { deleted: true });
  // New tasks sort first, without generating edits for every existing task.
  const current = currentEntities(doc);
  const positions = [...current.values()].filter(r => r.entityType === 'order' && !r.deleted).map(r => r.payload.position);
  let min = Math.min(0, ...positions);
  const newTasks = [...next].filter(([key, v]) => v.type === 'task' && !previous.has(key)).map(([, v]) => v);
  for (const value of newTasks.reverse()) writeRevision(doc, 'order', value.id, { position: --min });
  doc.local = { ...doc.local, ...localFromView(after) };
  const date = isoDate(after.lastActiveDate);
  for (const task of [...DAY_KEYS.flatMap(day => after.itemsByDay[day]), ...after.recurringItems]) if (task.notified) doc.receipts[`${task.id}/${date}/${task.time}`] = true;
}
export function setTaskOrder(doc, ids, movedId) {
  const current = currentEntities(doc);
  const pos = id => current.get(`order:${id}`)?.payload.position ?? 0;
  const index = ids.indexOf(movedId); if (index < 0) return;
  const left = index ? pos(ids[index - 1]) : null, right = index < ids.length - 1 ? pos(ids[index + 1]) : null;
  const value = left === null ? (right ?? 0) - 1 : right === null ? left + 1 : (left + right) / 2;
  if ((left !== null && value <= left) || (right !== null && value >= right)) {
    ids.forEach((id, i) => writeRevision(doc, 'order', id, { position: i }));
  } else writeRevision(doc, 'order', movedId, { position: value });
}
export function projectView(doc, base, today = dateInZone(doc.sync.timeZone)) {
  const view = clone(base), current = currentEntities(doc);
  Object.assign(view, { schemaVersion: 2, itemsByDay: { today: [], tomorrow: [], dayAfterTomorrow: [] }, recurringItems: [], projects: [], tags: [], lastActiveDate: today });
  if (doc.local.settings) view.settings = clone(doc.local.settings);
  view.selectedDay = doc.local.selectedDay || view.selectedDay;
  view.memo = { text: current.get('memo:main')?.payload.text || '', expanded: !!doc.local.memoExpanded };
  const identityAliases = categoryAliases(doc);
  const aliases = new Map([...identityAliases].map(([key, value]) => [key, value.slice(value.indexOf(':') + 1)]));
  for (const kind of ['projects', 'tags']) {
    const groups = new Map();
    // Include historical names so deletion and renames preserve alias identity.
    const parent = new Map(); const root = id => { id = aliases.get(`${kind}:${id}`) || id; while (parent.has(id)) id = parent.get(id); return id; };
    const names = new Map();
    for (const r of doc.revisions.filter(r => r.entityType === kind)) {
      const name = r.payload.name.trim().normalize('NFKC').toLowerCase();
      if (names.has(name)) { const a = root(r.entityId), b = root(names.get(name)); if (a !== b) parent.set([a, b].sort()[1], [a, b].sort()[0]); } else names.set(name, r.entityId);
    }
    for (const r of current.values()) if (r.entityType === kind) { const id = root(r.entityId); aliases.set(`${kind}:${r.entityId}`, id); if (!groups.has(id)) groups.set(id, []); groups.get(id).push(r); }
    for (const [id, list] of groups) { list.sort(compareRevision); const winner = list.at(-1); if (!winner.deleted) view[kind].push({ ...winner.payload, id }); }
    view[kind].sort((a, b) => compareText(a.id, b.id));
  }
  const liveProject = new Set(view.projects.map(x => x.id)), liveTags = new Set(view.tags.map(x => x.id));
  const completions = new Map([...current.values()].filter(r => r.entityType === 'completion' && !r.deleted).map(r => [r.entityId, r.payload.completed]));
  for (const r of current.values()) {
    if (r.entityType !== 'task' || r.deleted) continue;
    const task = clone(r.payload), project = aliases.get(`projects:${task.projectId}`) || task.projectId;
    task.projectId = liveProject.has(project) ? project : null;
    task.tagIds = [...new Set(task.tagIds.map(id => aliases.get(`tags:${id}`) || id).filter(id => liveTags.has(id)))];
    task.notified = !!doc.receipts[`${task.id}/${today}/${task.time}`];
    if (task.kind === 'daily') {
      task.completed = completions.get(`${task.id}/${today}`) || false;
      task.completedAt = current.get(`completion:${task.id}/${today}`)?.payload.completedAt ?? null;
      let day = task.completed ? today : shiftDate(today, -1), streak = 0;
      while (completions.get(`${task.id}/${day}`)) { streak++; day = shiftDate(day, -1); }
      if (task.legacyStreak && !completions.has(`${task.id}/${day}`)) {
        const start = shiftDate(task.legacyStreak.date, 1 - task.legacyStreak.count);
        if (day >= start && day <= task.legacyStreak.date) {
          const cancelled = [...completions].filter(([key, done]) => !done && key.startsWith(task.id + '/') && key.slice(task.id.length + 1) >= start && key.slice(task.id.length + 1) <= day)
            .map(([key]) => key.slice(task.id.length + 1)).sort().at(-1);
          streak += Math.round((Date.parse(day) - Date.parse(cancelled || start)) / 86400000) + (cancelled ? 0 : 1);
        }
      }
      task.streak = streak; task.lastDone = streak ? (task.completed ? today : shiftDate(today, -1)) : null;
      view.recurringItems.push(task);
    } else {
      if (task.archivedAt) continue;
      const offset = Math.round((Date.parse(task.scheduledDate) - Date.parse(today)) / 86400000);
      if (offset < 0 && task.completed) continue;
      if (offset <= 2) view.itemsByDay[DAY_KEYS[Math.max(0, offset)]].push(task);
    }
  }
  const position = t => current.get(`order:${t.id}`)?.payload.position ?? -t.createdAt;
  for (const list of [...Object.values(view.itemsByDay), view.recurringItems]) list.sort((a, b) => Number(a.completed) - Number(b.completed) || position(a) - position(b) || b.createdAt - a.createdAt || compareText(a.id, b.id));
  view.colorCounters = { projects: Math.max(doc.local.colorCounters?.projects || 0, view.projects.length), tags: Math.max(doc.local.colorCounters?.tags || 0, view.tags.length) };
  return view;
}
export function resolveConflict(doc, key, revision, payload = revision.payload) {
  const heads = entityHeads(doc).get(key) || [];
  if (!heads.some(r => r.revisionId === revision.revisionId)) throw new Error('冲突状态已变化，请重新打开');
  return writeRevision(doc, revision.entityType, revision.entityId, payload, { deleted: revision.deleted, resolve: true });
}
export function exportDocument(doc, view) {
  return { ...clone(view), schemaVersion: 3, syncData: { protocolVersion: 1, revisions: clone(doc.revisions), timeZone: doc.sync.timeZone } };
}
export function importRevisionsAsEdits(doc, revisions) {
  const source = newDocument(); mergeRevisions(source, revisions);
  for (const r of currentEntities(source).values()) writeRevision(doc, r.entityType, r.entityId, r.payload, { deleted: r.deleted, resolve: true });
}
