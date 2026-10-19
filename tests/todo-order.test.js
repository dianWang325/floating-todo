import test from "node:test";
import assert from "node:assert/strict";
import { reorderItems, reorderVisibleItems } from "../src/todo-order.js";

test("manual order is preserved without mutating todos or their metadata", () => {
  const items = [
    { id: "a", completed: false, title: "A", time: "09:00", notified: true },
    { id: "b", completed: false, detail: "https://example.com", streak: 4, lastDone: "2026-10-12" },
    { id: "c", completed: false },
  ];
  const result = reorderItems(items, ["b", "c", "a"]);
  assert.deepEqual(result.map((item) => item.id), ["b", "c", "a"]);
  assert.deepEqual(items.map((item) => item.id), ["a", "b", "c"]);
  assert.equal(result[0], items[1]);
  assert.equal(result[2], items[0]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), [items[1], items[2], items[0]]);
});

test("completed todos stay last while both groups retain their manual order", () => {
  const items = [
    { id: "a", completed: false }, { id: "b", completed: false },
    { id: "c", completed: true }, { id: "d", completed: true },
  ];
  assert.deepEqual(reorderItems(items, ["d", "b", "c", "a"]).map((item) => item.id), ["b", "a", "d", "c"]);
});

test("a stale or invalid drag cannot remove or duplicate todos", () => {
  const items = [{ id: "a" }, { id: "b" }];
  for (const ids of [["a"], ["a", "a"], ["a", "unknown"], ["a", "b", "c"]]) {
    assert.equal(reorderItems(items, ids), items);
  }
});

test("empty and single-item lists remain valid", () => {
  assert.deepEqual(reorderItems([], []), []);
  const item = { id: "a", completed: true };
  assert.deepEqual(reorderItems([item], ["a"]), [item]);
});

test('filtered reordering changes only visible slots, preserving categories and hidden tasks', () => {
  const items = ['a', 'hidden', 'b', 'c', 'done'].map(id => ({ id, completed: id === 'done', projectId: 'project', tagIds: ['tag'] }));
  const result = reorderVisibleItems(items, ['c', 'a', 'b']);
  assert.deepEqual(result.map(item => item.id), ['c', 'hidden', 'a', 'b', 'done']);
  assert.equal(result[0], items[3]); assert.equal(result[1], items[1]);
  assert.equal(result[4], items[4]);
  for (const invalid of [['a', 'unknown'], ['a', 'a']]) assert.equal(reorderVisibleItems(items, invalid), items);
  assert.equal(reorderVisibleItems(items, []), items);
});
