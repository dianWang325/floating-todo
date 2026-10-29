import { currentEntities, writeRevision } from './sync-model.js';

// Keep the existing project identifiers and revision history for sync compatibility.
export const collections = doc => [...currentEntities(doc).values()]
  .filter(r => r.entityType === 'projects' && !r.deleted).map(r => r.payload)
  .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

export function saveCollection(doc, { id, name, color = '#6375e8' }) {
  name = name.trim();
  if (!name || name.length > 80) throw new Error('合集名称需要在 1 到 80 个字之间');
  if (collections(doc).some(c => c.id !== id && c.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('这个合集名称已经存在');
  if (id && !collections(doc).some(c => c.id === id)) throw new Error('合集已不存在，请刷新');
  id ||= crypto.randomUUID();
  writeRevision(doc, 'projects', id, { id, name, color });
  return id;
}

export function removeCollection(doc, id) {
  const entry = collections(doc).find(c => c.id === id);
  if (!entry) throw new Error('合集已不存在');
  // Removing a collection never removes its tasks or completion records.
  for (const r of currentEntities(doc).values()) {
    if (r.entityType === 'task' && !r.deleted && r.payload.projectId === id)
      writeRevision(doc, 'task', r.entityId, { ...r.payload, projectId: null });
  }
  writeRevision(doc, 'projects', id, entry, { deleted: true });
}

export function matchesCollection(task, id, doc) {
  if (!id) return true;
  if (id !== 'none') return task.projectId === id;
  return !task.projectId || !collections(doc).some(c => c.id === task.projectId);
}
