import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, currentEntities, writeRevision, mergeRevisions } from '../src/sync-model.js';
import { collections, saveCollection, removeCollection, matchesCollection } from '../src/collections.js';
import { createTask, toggleTask } from '../src/planner-model.js';

test('existing projects become collections with stable identifiers, duplicate names rejected', () => {
  const doc = newDocument();
  writeRevision(doc, 'projects', 'old', { id: 'old', name: '工作', color: '#123456' });
  assert.equal(collections(doc)[0].id, 'old');
  saveCollection(doc, { id: 'old', name: '工作计划', color: '#abcdef' });
  assert.equal(collections(doc)[0].name, '工作计划');
  assert.throws(() => saveCollection(doc, { name: ' 工作计划 ' }), /已经存在/);
  assert.throws(() => saveCollection(doc, { name: ' ' }), /名称/);
});

test('deleting a collection retains tasks, daily completion and sync history', () => {
  const doc = newDocument(), id = saveCollection(doc, { name: '生活' });
  const task = createTask(doc, { title: '安排', scheduledDate: '2026-10-29', projectId: id });
  toggleTask(doc, task, '2026-10-29');
  const completedAt = currentEntities(doc).get(`task:${task}`).payload.completedAt;
  removeCollection(doc, id);
  const current = currentEntities(doc).get(`task:${task}`);
  assert.equal(current.deleted, false); assert.equal(current.payload.projectId, null);
  assert.equal(current.payload.completedAt, completedAt);
  assert.equal(collections(doc).length, 0);
  assert.ok(matchesCollection(current.payload, 'none', doc));
  const other = newDocument(); mergeRevisions(other, doc.revisions);
  assert.equal(currentEntities(other).get(`task:${task}`).payload.completed, true);
  assert.equal(collections(other).length, 0);
});

test('synced category aliases filter and delete together; recreating a name returns its actual identifier', () => {
  const a = newDocument(), b = newDocument();
  writeRevision(a, 'projects', 'a', { id: 'a', name: '工作', color: '#123456' });
  writeRevision(b, 'projects', 'b', { id: 'b', name: '工作', color: '#abcdef' });
  const task = createTask(b, { title: '另一台设备的任务', scheduledDate: '2026-10-29', projectId: 'b' });
  mergeRevisions(a, b.revisions);
  assert.equal(collections(a).length, 1); assert.equal(collections(a)[0].id, 'a');
  assert.ok(matchesCollection(currentEntities(a).get(`task:${task}`).payload, 'a', a));
  removeCollection(a, 'a');
  assert.equal(currentEntities(a).get(`task:${task}`).payload.projectId, null);
  const recreated = saveCollection(a, { name: '工作' });
  assert.equal(recreated, 'a'); assert.equal(collections(a)[0].id, recreated);
  assert.equal(collections(a).length, 1);
});
