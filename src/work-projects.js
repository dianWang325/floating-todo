import { currentEntities, categoryAliases, writeRevision, dateInZone } from './sync-model.js';
import { nameKey, parseClassification } from './classification.js';
import { collections, saveCollection } from './collections.js';

// # names retain their existing tag identifiers; + names remain collections.
const cache = new WeakMap();
function projectState(doc) {
  let state = cache.get(doc);
  if (!state || state.revisions !== doc.revisions || state.length !== doc.revisions.length) {
    const current = currentEntities(doc);
    state = {revisions:doc.revisions,length:doc.revisions.length,current,aliases:categoryAliases(doc),entries:[...current].filter(([,r])=>r.entityType==='tags' && !r.deleted).map(([key,r])=>({...r.payload,id:key.slice(5)})).sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'))};
    cache.set(doc,state);
  }
  return state;
}
export const workProjectId = (doc, id) => projectState(doc).aliases.get(`tags:${id}`)?.slice(5) || id;
export const workProjects = doc => projectState(doc).entries;
export function saveWorkProject(doc, { id, name, color, description, milestones, targetDate } = {}) {
  name = String(name || '').trim().replace(/\s+/g,' ');
  if (!name || name.length > 80) throw new Error('项目名称需要在 1 到 80 个字之间');
  const entries = workProjects(doc), existing = id ? entries.find(p => p.id === workProjectId(doc,id)) : entries.find(p => nameKey(p.name) === nameKey(name));
  if (id && !existing) throw new Error('项目已不存在，请刷新');
  if (entries.some(p => p.id !== existing?.id && nameKey(p.name) === nameKey(name))) throw new Error('这个项目名称已经存在');
  // Historical names are aliases. Avoid merging two live projects during rename.
  if (id && doc.revisions.some(r => r.entityType === 'tags' && nameKey(r.payload.name) === nameKey(name) && workProjectId(doc,r.entityId) !== existing.id)) throw new Error('这个名称曾用于其他项目，请使用其他名称');
  const previous = doc.revisions.find(r => r.entityType === 'tags' && nameKey(r.payload.name) === nameKey(name));
  id = existing?.id || (previous ? workProjectId(doc,previous.entityId) : crypto.randomUUID());
  const saved = existing || currentEntities(doc).get(`tags:${id}`)?.payload;
  const payload = { ...(saved || {}), id, name, color:color || saved?.color || '#397fe5' };
  for (const [key,value] of Object.entries({description,milestones,targetDate})) if (value !== undefined) payload[key] = key === 'targetDate' ? value || null : value;
  writeRevision(doc,'tags',id,payload);
  return workProjectId(doc,id);
}
export function projectTasks(doc, id) {
  const current = projectState(doc).current, day = dateInZone(doc.sync.timeZone), project = workProjectId(doc,id);
  return [...current.values()].filter(r => r.entityType === 'task' && !r.deleted && r.payload.tagIds.some(tag => workProjectId(doc,tag) === project)).map(r => {
    const t = r.payload;
    return t.kind === 'daily' ? {...t,date:day,completed:!!current.get(`completion:${t.id}/${day}`)?.payload.completed} : {...t,date:t.scheduledDate};
  }).sort((a,b)=>Number(a.completed)-Number(b.completed) || (a.scheduledDate || '9999').localeCompare(b.scheduledDate || '9999') || a.title.localeCompare(b.title,'zh-CN'));
}
export function classifyPlannerTask(doc, text, tagIds = [], projectId = null) {
  const parsed = parseClassification(text);
  if (!parsed.title) throw new Error('请填写任务标题');
  const tags = tagIds.map(id => workProjectId(doc,id));
  for (const token of parsed.tokens) {
    if (token.kind === 'tags') tags.push(saveWorkProject(doc,{name:token.name}));
    else projectId = collections(doc).find(c => nameKey(c.name) === nameKey(token.name))?.id || saveCollection(doc,{name:token.name});
  }
  return {title:parsed.title,tagIds:[...new Set(tags)],projectId};
}
