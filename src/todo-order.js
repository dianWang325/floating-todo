// Keep completed todos at the bottom, preserving manual order in both groups.
export function reorderItems(items, orderedIds) {
  const byId = new Map(items.map((item) => [item.id, item]));
  if (orderedIds.length !== items.length || new Set(orderedIds).size !== items.length ||
      orderedIds.some((id) => !byId.has(id))) return items;
  const ordered = orderedIds.map((id) => byId.get(id));
  return [...ordered.filter((item) => !item.completed), ...ordered.filter((item) => item.completed)];
}

// Reorder only visible slots, retaining filtered-out tasks and their metadata.
export function reorderVisibleItems(items, orderedIds) {
  const ids = new Set(orderedIds);
  const byId = new Map(items.map(item => [item.id, item]));
  if (ids.size !== orderedIds.length || orderedIds.some(id => !byId.has(id))) return items;
  if (!orderedIds.length) return items;
  let index = 0;
  const merged = items.map(item => ids.has(item.id) ? orderedIds[index++] : item.id);
  return reorderItems(items, merged);
}
