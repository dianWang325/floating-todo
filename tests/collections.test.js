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
