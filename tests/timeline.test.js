import test from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, currentEntities, projectView, commitView, mergeRevisions } from '../src/sync-model.js';
import { calendarRange, layoutTimedTasks, timelineItems, createTask, updateTask } from '../src/planner-model.js';

test('day, three-day and Monday-first week ranges cross month and year boundaries', () => {
  assert.deepEqual(calendarRange('2026-12-31', 'day'), ['2026-12-31']);
  assert.deepEqual(calendarRange('2026-12-31', 'three'), ['2026-12-31', '2027-01-01', '2027-01-02']);
  assert.deepEqual(calendarRange('2027-01-03', 'week'), ['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']);
  assert.equal(calendarRange('2026-02-28', 'month').length, 42);
});

test('overlap layout allocates lanes across connected groups without mutating task data', () => {
  const tasks = [{ id: 'a', start: 540, end: 600 }, { id: 'b', start: 570, end: 630 }, { id: 'c', start: 590, end: 620 }, { id: 'd', start: 630, end: 660 }];
  const before = structuredClone(tasks), layout = layoutTimedTasks(tasks);
  assert.deepEqual(tasks, before);
  assert.deepEqual(layout.map(t => [t.id, t.lane, t.lanes]), [['a', 0, 3], ['b', 1, 3], ['c', 2, 3], ['d', 0, 1]]);
  assert.deepEqual(layoutTimedTasks([...tasks].reverse()), layout);
});

test('cross-midnight tasks are clipped into segments retaining their original completion date', () => {
  const doc = newDocument();
  const id = createTask(doc, { title: '夜间工作', scheduledDate: '2026-12-31', time: '23:30', durationMinutes: 90 });
  const first = timelineItems(doc, '2026-12-31')[0], second = timelineItems(doc, '2027-01-01')[0];
  assert.deepEqual([first.start, first.end, first.continuesAfter], [1410, 1440, true]);
  assert.deepEqual([second.id, second.date, second.start, second.end, second.continuesBefore], [id, '2026-12-31', 0, 60, true]);
  assert.equal(timelineItems(doc, '2027-01-02').length, 0);
});

test('all-day tasks are excluded from time tracks, old timed tasks default to 30 minutes', () => {
  const doc = newDocument();
  createTask(doc, { title: '全天', scheduledDate: '2026-10-28' });
  const id = createTask(doc, { title: '定时', scheduledDate: '2026-10-28', time: '09:00' });
  const r = currentEntities(doc).get(`task:${id}`); delete r.payload.durationMinutes;
  const rows = timelineItems(doc, '2026-10-28');
  assert.equal(rows.length, 1); assert.equal(rows[0].end - rows[0].start, 30);
});

test('duration survives widget edits, daily projection, backup merge and date moves', () => {
  const doc = newDocument(), date = '2026-10-28';
  const id = createTask(doc, { title: '计划', scheduledDate: date, time: '09:00', durationMinutes: 90 });
  const base = { settings: {}, selectedDay: 'today', projects: [], tags: [], memo: {}, colorCounters: {} };
  const before = projectView(doc, base, date), after = structuredClone(before);
  after.itemsByDay.today[0].title = '修改标题'; commitView(doc, before, after);
  assert.equal(currentEntities(doc).get(`task:${id}`).payload.durationMinutes, 90);
  updateTask(doc, id, { kind: 'daily', scheduledDate: null });
  const daily = projectView(doc, base, date), edited = structuredClone(daily);
  edited.recurringItems[0].title = '每日安排'; commitView(doc, daily, edited);
  assert.equal(currentEntities(doc).get(`task:${id}`).payload.durationMinutes, 90);
  const copy = newDocument(); mergeRevisions(copy, doc.revisions);
  assert.equal(currentEntities(copy).get(`task:${id}`).payload.durationMinutes, 90);
});

test('invalid duration fails before a revision is written', () => {
  const doc = newDocument();
  for (const durationMinutes of [-1, 0, 4, 1441, 15.5, NaN]) assert.throws(() => createTask(doc, { title: '错误时长', scheduledDate: '2026-10-28', time: '08:00', durationMinutes }), /时长/);
  assert.equal(doc.revisions.length, 0);
});
