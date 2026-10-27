import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, currentEntities, projectView, commitView, migrateSnapshot, mergeRevisions, writeRevision, shiftDate, dateInZone } from '../src/sync-model.js';
import { createTask, updateTask, toggleTask, tasksOnDate, completionHistory, monthDates } from '../src/planner-model.js';
import { dueReminders, createReminderRunner, snoozeReminder, zonedTime } from '../src/reminders.js';

const date = '2026-10-27', now = Date.parse(date + 'T02:00:00Z'); // 10:00 Shanghai
function doc() { const d = newDocument(); d.local.settings = {}; return d; }
function task(d, extra = {}) { return createTask(d, { title: '提交方案', scheduledDate: date, time: '10:00', ...extra }); }
const base = () => ({ settings: {}, selectedDay: 'today', projects: [], tags: [], memo: { text: '' }, colorCounters: {}, itemsByDay: {}, recurringItems: [] });

test('calendar supports arbitrary dates, Monday-first 42-cell month including year boundary', () => {
  const d = doc(), id = task(d, { scheduledDate: '2027-01-31' });
  assert.equal(tasksOnDate(d, date).length, 0);
  assert.equal(tasksOnDate(d, '2027-01-31')[0].id, id);
  const cells = monthDates('2027-01');
  assert.equal(cells.length, 42); assert.equal(cells[0], '2026-12-28'); assert.ok(cells.includes('2027-01-31'));
});

test('completion date differs from planned date; archive remains searchable, reopen removes completion', () => {
  const d = doc(), id = task(d, { scheduledDate: '2026-10-25', projectId: 'p' });
  toggleTask(d, id, date, now); updateTask(d, id, { archivedAt: now + 1 });
  assert.equal(completionHistory(d, { from: date, to: date, project: 'p', query: '方案' }).length, 1);
  assert.equal(completionHistory(d)[0].scheduledDate, '2026-10-25');
  assert.equal(completionHistory(d)[0].completedAt, now);
  assert.equal(projectView(d, base(), date).itemsByDay.today.length, 0);
  toggleTask(d, id, date, now + 2);
  assert.equal(completionHistory(d).length, 0);
  assert.equal(currentEntities(d).get(`task:${id}`).payload.archivedAt, undefined);
  assert.equal(projectView(d, base(), date).itemsByDay.today[0].scheduledDate, '2026-10-25');
});

test('habit per-day completions survive rollover, deletion and export-like merge', () => {
  const d = doc(), id = task(d);
  updateTask(d, id, { kind: 'daily', scheduledDate: null });
  toggleTask(d, id, date, now); toggleTask(d, id, shiftDate(date, 1), now + 86400000);
  assert.equal(completionHistory(d).length, 2);
  const r = currentEntities(d).get(`task:${id}`); writeRevision(d, 'task', id, r.payload, { deleted: true });
  assert.ok(completionHistory(d).every(t => t.deleted));
  const other = doc(); mergeRevisions(other, d.revisions);
  assert.deepEqual(completionHistory(other), completionHistory(d));
});

test('old completed tasks have unknown actual completion time; no fabricated timestamp', async () => {
  const b = { ...base(), lastActiveDate: date, itemsByDay: { today: [{ id: 'old', title: '旧任务', completed: true, createdAt: 1 }], tomorrow: [], dayAfterTomorrow: [] } };
  const d = await migrateSnapshot(b);
  assert.equal(completionHistory(d)[0].unknownTime, true);
  assert.equal(completionHistory(d)[0].date, date);
  d.local.reminders = { delivered: { x: { sentAt: now } } };
  const view = projectView(d, base(), date); commitView(d, view, structuredClone(view));
  assert.equal(d.local.reminders.delivered.x.sentAt, now);
});

test('lead reminder crosses midnight and time-zone conversion is explicit', () => {
  const d = doc(); task(d, { scheduledDate: '2026-10-28', time: '00:05', remindLeadMinutes: 10 });
  const at = Date.parse('2026-10-27T15:55:00Z');
  assert.equal(dueReminders(d, at - 1).length, 0); assert.equal(dueReminders(d, at).length, 1);
  assert.equal(zonedTime(date, '10:00', 'Asia/Shanghai'), now);
  assert.equal(dateInZone('Asia/Shanghai', new Date(at)), date);
});

test('permission denied and send failure never consume reminder; delivery persists and snooze fires once', async () => {
  const d = doc(); task(d); let allowed = false, fail = false, sends = 0, saves = 0, error;
  const check = createReminderRunner({ getDoc: () => d, permission: async () => allowed, send: async () => { if (fail) throw Error('blocked'); sends++; }, persist: async () => { saves++; }, onError: e => { error = e; } });
  await check(now); assert.match(error, /授权/); assert.equal(dueReminders(d, now).length, 1);
  allowed = true; fail = true; await check(now); assert.equal(dueReminders(d, now).length, 1);
  fail = false; await check(now); await check(now + 1); assert.equal(sends, 1); assert.equal(saves, 1);
  const item = Object.values(d.local.reminders.delivered)[0]; snoozeReminder(d, item, 10, now);
  await check(now + 599999); assert.equal(sends, 1);
  await check(now + 600000); await check(now + 600001); assert.equal(sends, 2);
  const restarted = JSON.parse(JSON.stringify(d)); assert.equal(dueReminders(restarted, now + 86400000).length, 0);
});

test('completion during permission request cancels notification; concurrent checks do not duplicate', async () => {
  const d = doc(), id = task(d); let release, sent = 0;
  const check = createReminderRunner({ getDoc: () => d, permission: () => new Promise(r => { release = r; }), send: async () => { sent++; }, persist: async () => {} });
  const pending = check(now); await check(now); toggleTask(d, id, date, now); release(true); await pending;
  assert.equal(sent, 0);
});

test('archived/completed/deleted tasks are not reminded, disabled reminders retain pending work', () => {
  const d = doc(), id = task(d); d.local.settings.remindersEnabled = false;
  assert.equal(dueReminders(d, now).length, 0); d.local.settings.remindersEnabled = true;
  toggleTask(d, id, date, now); updateTask(d, id, { archivedAt: now });
  assert.equal(dueReminders(d, now).length, 0);
});

test('failed persistence leaves notification eligible for retry', async () => {
  const d = doc(); task(d); let fail = true;
  const check = createReminderRunner({ getDoc: () => d, permission: async () => true, send: async () => {}, persist: async () => { if (fail) throw Error('disk full'); } });
  await check(now); assert.equal(dueReminders(d, now).length, 1);
  fail = false; await check(now); assert.equal(dueReminders(d, now).length, 0);
});
