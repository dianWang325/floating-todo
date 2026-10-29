import { currentEntities, writeRevision, categoryAliases } from './sync-model.js';

// Keep the existing project identifiers and revision history for sync compatibility.
const cache = new WeakMap();
function collectionState(doc) {
  let state = cache.get(doc);
  if (!state || state.revisions !== doc.revisions || state.length !== doc.revisions.length) {
    state = { revisions: doc.revisions, length: doc.revisions.length, aliases: categoryAliases(doc),
      entries: [...currentEntities(doc)].filter(([, r]) => r.entityType === 'projects' && !r.deleted)
        .map(([key, r]) => ({ ...r.payload, id: key.slice('projects:'.length) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')) };
    cache.set(doc, state);
  }
  return state;
}
export const collections = doc => collectionState(doc).entries;
export const collectionId = (doc, id) => id ? (collectionState(doc).aliases.get(`projects:${id}`)?.slice('projects:'.length) || id) : null;

export function saveCollection(doc, { id, name, color = '#6375e8' }) {
  name = name.trim();
  if (!name || name.length > 80) throw new Error('合集名称需要在 1 到 80 个字之间');
  if (collections(doc).some(c => c.id !== id && c.name.normalize('NFKC').toLocaleLowerCase() === name.normalize('NFKC').toLocaleLowerCase())) throw new Error('这个合集名称已经存在');
  const historical = doc.revisions.find(r => r.entityType === 'projects' && r.payload.name.trim().normalize('NFKC').toLocaleLowerCase() === name.normalize('NFKC').toLocaleLowerCase() && collectionId(doc, r.entityId) !== id && collections(doc).some(c => c.id === collectionId(doc, r.entityId)));
  if (historical) throw new Error('这个名称曾用于现有合集，请使用其他名称');
  if (id && !collections(doc).some(c => c.id === id)) throw new Error('合集已不存在，请刷新');
  const previous = doc.revisions.find(r => r.entityType === 'projects' && r.payload.name.trim().normalize('NFKC').toLocaleLowerCase() === name.normalize('NFKC').toLocaleLowerCase());
  id ||= previous ? collectionId(doc, previous.entityId) : crypto.randomUUID();
  const revision = writeRevision(doc, 'projects', id, { id, name, color });
  return collectionId(doc, revision?.entityId || id);
}

export function removeCollection(doc, id) {
  const entry = collections(doc).find(c => c.id === id);
  if (!entry) throw new Error('合集已不存在');
  // Removing a collection never removes its tasks or completion records.
  for (const r of currentEntities(doc).values()) {
    if (r.entityType === 'task' && !r.deleted && collectionId(doc, r.payload.projectId) === id)
      writeRevision(doc, 'task', r.entityId, { ...r.payload, projectId: null });
  }
  writeRevision(doc, 'projects', id, entry, { deleted: true });
}

export function matchesCollection(task, id, doc) {
  if (!id) return true;
  const project = collectionId(doc, task.projectId);
  if (id !== 'none') return project === id;
  return !project || !collections(doc).some(c => c.id === project);
}
