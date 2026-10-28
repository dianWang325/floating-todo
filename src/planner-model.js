import { currentEntities, entityHeads, compareRevision, writeRevision, dateInZone, shiftDate } from './sync-model.js';

// All dates are explicit calendar dates in the document's configured zone.
export function tasksOnDate(doc, date, current = currentEntities(doc)) {
  const rows = [];
  for (const r of current.values()) {
    if (r.entityType !== 'task' || r.deleted) continue;
    const t = r.payload;
    if (t.kind === 'daily') {
      if (t.createdAt && date < dateInZone(doc.sync.timeZone, new Date(t.createdAt))) continue;
      const completion = current.get(`completion:${t.id}/${date}`)?.payload;
      rows.push({ ...t, date, completed: !!completion?.completed, completedAt: completion?.completedAt ?? null });
    } else if (t.scheduledDate === date) rows.push({ ...t, date });
  }
  return rows.sort((a, b) => Number(a.completed) - Number(b.completed) || (a.time || '24:00').localeCompare(b.time || '24:00') || b.createdAt - a.createdAt);
}

export function completionHistory(doc, { from = '0000-01-01', to = '9999-12-31', query = '', project = '' } = {}) {
  const current = currentEntities(doc), result = [];
  for (const r of current.values()) {
    if (r.entityType === 'task' && r.payload.kind === 'one_off' && r.payload.completed) {
      const t = r.payload;
      result.push({ ...t, date: t.completedDate || t.scheduledDate, unknownTime: t.completedAt == null, deleted: r.deleted });
    } else if (r.entityType === 'completion' && !r.deleted && r.payload.completed) {
      const task = current.get(`task:${r.payload.taskId}`);
      if (task) result.push({ ...task.payload, ...r.payload, id: r.payload.taskId, kind: 'daily', unknownTime: r.payload.completedAt == null, deleted: task.deleted });
    }
  }
  const needle = query.trim().toLocaleLowerCase();
  return result.filter(t => t.date >= from && t.date <= to && (!project || t.projectId === project) && (!needle || `${t.title} ${t.detail}`.toLocaleLowerCase().includes(needle)))
    .sort((a, b) => b.date.localeCompare(a.date) || (b.completedAt || 0) - (a.completedAt || 0));
}

export function taskEvents(doc, taskId) {
  // Follow the winning ancestry, excluding losing concurrent branches.
  const byId = new Map(doc.revisions.map(r => [r.revisionId, r]));
  const head = entityHeads(doc).get(`task:${taskId}`)?.at(-1);
  const seen = new Set(), pending = head ? [head] : [], revisions = [];
  while (pending.length) {
    const r = pending.pop(); if (seen.has(r.revisionId)) continue;
    seen.add(r.revisionId); revisions.push(r);
    for (const id of r.parentRevisionIds) if (byId.has(id)) pending.push(byId.get(id));
  }
  revisions.sort(compareRevision);
  return revisions.flatMap((r, index) => {
    const before = revisions[index - 1];
    if (r.deleted) return [{ at: r.modifiedAt, label: '删除' }];
    if (before && before.payload.completed !== r.payload.completed) return [{ at: r.modifiedAt, label: r.payload.completed ? '完成' : '重新打开' }];
    if (r.payload.archivedAt && !before?.payload.archivedAt) return [{ at: r.modifiedAt, label: '归档' }];
    return [];
  });
}

export function monthDates(month) {
  const first = month + '-01', weekday = new Date(first + 'T12:00:00Z').getUTCDay();
  const start = shiftDate(first, -(weekday + 6) % 7);
  return Array.from({ length: 42 }, (_, i) => shiftDate(start, i));
}

export function updateTask(doc, id, patch) {
  const r = currentEntities(doc).get(`task:${id}`);
  if (!r || r.deleted) throw new Error('任务已不存在，请刷新后重试');
  const payload = { ...r.payload, ...patch, id };
  if (!payload.title.trim()) throw new Error('请填写任务标题');
  if (!payload.completed) { delete payload.completedAt; delete payload.completedDate; delete payload.archivedAt; }
  return writeRevision(doc, 'task', id, payload);
}

export function toggleTask(doc, id, date, now = Date.now()) {
  const r = currentEntities(doc).get(`task:${id}`);
  if (!r || r.deleted) throw new Error('任务已不存在');
  if (r.payload.kind === 'daily') {
    const key = `${id}/${date}`, completed = !currentEntities(doc).get(`completion:${key}`)?.payload.completed;
    return writeRevision(doc, 'completion', key, { taskId: id, date, completed, ...(completed ? { completedAt: now } : {}) }, { now });
  }
  const completed = !r.payload.completed;
  return updateTask(doc, id, { completed, ...(completed ? { completedAt: now, completedDate: dateInZone(doc.sync.timeZone, new Date(now)) } : {}) });
}

export function createTask(doc, { title, scheduledDate, time = null, projectId = null, remindLeadMinutes = 0, durationMinutes = 30 }) {
  const id = crypto.randomUUID();
  if (!title.trim()) throw new Error('请填写任务标题');
  writeRevision(doc, 'task', id, { id, title: title.trim(), scheduledDate, time, projectId, remindLeadMinutes, durationMinutes, tagIds: [], detail: '', kind: 'one_off', completed: false, createdAt: Date.now() });
  return id;
}

export function calendarRange(date, view) {
  if (view === 'month') return monthDates(date.slice(0, 7));
  const start = view === 'week' ? shiftDate(date, -(new Date(date + 'T12:00:00Z').getUTCDay() + 6) % 7) : date;
  return Array.from({ length: view === 'week' ? 7 : view === 'three' ? 3 : 1 }, (_, i) => shiftDate(start, i));
}

export const minutesOfDay = time => { const [h, m] = time.split(':').map(Number); return h * 60 + m; };
export const formatMinutes = value => `${String(Math.floor(value / 60) % 24).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;

export function timelineItems(doc, date, current = currentEntities(doc)) {
  const rows = [];
  for (const origin of [shiftDate(date, -1), date]) {
    for (const task of tasksOnDate(doc, origin, current)) {
      if (!task.time) continue;
      const offset = origin === date ? 0 : -1440;
      const start = minutesOfDay(task.time) + offset;
      const end = start + (task.durationMinutes || 30);
      if (end <= 0 || start >= 1440) continue;
      rows.push({ ...task, displayDate: date, start: Math.max(0, start), end: Math.min(1440, end), continuesBefore: start < 0, continuesAfter: end > 1440 });
    }
  }
  return layoutTimedTasks(rows);
}

// Partition connected overlapping intervals, then give every task in a group
// the same column width. Touching endpoints do not count as overlap.
export function layoutTimedTasks(tasks) {
  const sorted = tasks.map(t => ({ ...t })).sort((a, b) => a.start - b.start || b.end - a.end || a.id.localeCompare(b.id));
  let group = [], ends = [], groupEnd = -1;
  const finish = () => { for (const task of group) task.lanes = ends.length; group = []; ends = []; };
  for (const task of sorted) {
    if (group.length && task.start >= groupEnd) finish();
    if (!group.length) groupEnd = -1;
    let lane = ends.findIndex(end => end <= task.start);
    if (lane < 0) lane = ends.length;
    ends[lane] = task.end; task.lane = lane; group.push(task);
    groupEnd = Math.max(groupEnd, task.end);
  }
  finish(); return sorted;
}
