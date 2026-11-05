import {test} from 'node:test';
import assert from 'node:assert/strict';
import {newDocument,writeRevision,currentEntities,projectView,commitView,mergeRevisions,migrateSnapshot,exportDocument,importRevisionsAsEdits,dateInZone,conflicts} from '../src/sync-model.js';
import {normalizeSnapshot} from '../src/classification.js';
import {workProjects,saveWorkProject,projectTasks,classifyPlannerTask,workProjectId} from '../src/work-projects.js';
import {createTask,updateTask,deleteTask,toggleTask} from '../src/planner-model.js';
const base=()=>({schemaVersion:2,itemsByDay:{today:[],tomorrow:[],dayAfterTomorrow:[]},recurringItems:[],projects:[],tags:[],settings:{},memo:{text:''},colorCounters:{projects:0,tags:0},lastActiveDate:dateInZone()});
test('existing # identifiers aggregate tasks across collections and arbitrary dates without migration',()=>{
 const doc=newDocument();writeRevision(doc,'tags','p',{id:'p',name:'性能优化',color:'#397fe5'});
 const a=createTask(doc,{title:'方案',scheduledDate:'2026-11-01',tagIds:['p'],projectId:'work'}),b=createTask(doc,{title:'实现',scheduledDate:'2027-01-01',tagIds:['p'],projectId:'learn'});
 const revisions=doc.revisions.length;assert.deepEqual(new Set(projectTasks(doc,'p').map(t=>t.id)),new Set([a,b]));assert.equal(workProjects(doc)[0].id,'p');assert.equal(doc.revisions.length,revisions);
 updateTask(doc,a,{completed:true,archivedAt:Date.now()});assert.equal(projectTasks(doc,'p').filter(t=>t.completed).length,1);deleteTask(doc,b);assert.equal(projectTasks(doc,'p').length,1);
});
test('project planning records never generate tasks, and metadata survives widget edits, backup and sync',async()=>{
 const doc=newDocument(),p=saveWorkProject(doc,{name:'事项',description:'未拆分的想法\n<不执行>',milestones:'11/15 做首次验证',targetDate:'2026-12-01'});
 const id=createTask(doc,{title:'唯一任务',scheduledDate:dateInZone(),tagIds:[p]});
 let before=projectView(doc,base()),after=structuredClone(before);after.tags[0].name='事项二';after.itemsByDay.today[0].title='更新任务';commitView(doc,before,after);
 assert.equal(workProjects(doc)[0].description,'未拆分的想法\n<不执行>');assert.equal(projectTasks(doc,p).length,1);
 const normalized=normalizeSnapshot(projectView(doc,base()),base()),migrated=await migrateSnapshot(normalized);assert.equal(workProjects(migrated)[0].milestones,'11/15 做首次验证');
 const copy=newDocument();importRevisionsAsEdits(copy,exportDocument(doc,projectView(doc,base())).syncData.revisions);
 assert.equal(workProjects(copy)[0].targetDate,'2026-12-01');assert.equal(projectTasks(copy,p)[0].id,id);
});
test('calendar # parsing supports multiple projects independently of + collection and ignores C# and URL fragments',()=>{
 const doc=newDocument(),first=saveWorkProject(doc,{name:'已有项目',description:'保留记录'});
 const value=classifyPlannerTask(doc,'实现功能 #已有项目 #"跨端 同步" +研发',[first]);assert.equal(value.title,'实现功能');assert.equal(value.tagIds.length,2);assert.ok(value.projectId);
 assert.equal(workProjects(doc).find(p=>p.id===first).description,'保留记录');
 assert.equal(classifyPlannerTask(doc,'学习 C# https://example.com/#foo').title,'学习 C# https://example.com/#foo');
 assert.throws(()=>classifyPlannerTask(doc,'#空项目'),/标题/);assert.equal(workProjects(doc).length,2);
});
test('daily project state counts today once and metadata edits do not alter task completion history',()=>{
 const doc=newDocument(),p=saveWorkProject(doc,{name:'日常推进'}),id=createTask(doc,{title:'每天记录',scheduledDate:dateInZone(),tagIds:[p]});updateTask(doc,id,{kind:'daily',scheduledDate:null});
 toggleTask(doc,id,dateInZone());const before=doc.revisions.filter(r=>r.entityType!=='tags');assert.equal(projectTasks(doc,p)[0].completed,true);
 saveWorkProject(doc,{id:p,name:'日常推进',description:'继续记录'});assert.deepEqual(doc.revisions.filter(r=>r.entityType!=='tags'),before);
});
test('aliases retain project identity and concurrent note edits remain conflict-resolvable',()=>{
 const doc=newDocument();writeRevision(doc,'tags','z',{id:'z',name:'同名',color:'#397fe5'});const peer=structuredClone(doc);peer.deviceId='peer';
 saveWorkProject(doc,{id:'z',name:'同名',description:'本机版本'});saveWorkProject(peer,{id:'z',name:'同名',description:'远端版本'});mergeRevisions(doc,peer.revisions);assert.equal(conflicts(doc).filter(c=>c.key==='tags:z').length,1);
 const duplicate=newDocument();writeRevision(duplicate,'tags','a',{id:'a',name:'同名',color:'#397fe5'});mergeRevisions(doc,duplicate.revisions);
 assert.equal(workProjects(doc).length,1);assert.equal(workProjectId(doc,'z'),'a');
 const id=createTask(doc,{title:'旧ID关联',scheduledDate:'2026-11-01',tagIds:['z']});assert.equal(projectTasks(doc,'a')[0].id,id);
});
test('invalid project metadata is rejected before any revision or task is added',()=>{
 const doc=newDocument();for(const extra of [{name:''},{name:'a',description:123},{name:'a',description:'a'.repeat(20001)},{name:'a',milestones:'a'.repeat(10001)},{name:'a',targetDate:'2026-02-30'}]){assert.throws(()=>saveWorkProject(doc,extra));assert.equal(doc.revisions.length,0);}
 const p=saveWorkProject(doc,{name:'a'});saveWorkProject(doc,{id:p,name:'b'});assert.equal(saveWorkProject(doc,{name:'b'}),p);assert.equal(workProjects(doc).length,1);
});
