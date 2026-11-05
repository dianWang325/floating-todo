import {test} from 'node:test';
import assert from 'node:assert/strict';
import {newDocument,currentEntities,mergeRevisions,projectView,commitView} from '../src/sync-model.js';
import {createTask,updateTask,tasksOnDate,timelineItems,calendarSpans,monthDates,toggleTask,completionHistory} from '../src/planner-model.js';
import {dueReminders} from '../src/reminders.js';
const make = (doc, extra={}) => createTask(doc,{title:'跨天作业',scheduledDate:'2026-11-05',endDate:'2026-11-10',...extra});
test('all-day ranges include both dates, split at week boundaries and avoid occupied lanes',()=>{
 const doc=newDocument(),id=make(doc); const other=make(doc,{scheduledDate:'2026-11-06',endDate:'2026-11-09'});
 for(const d of ['2026-11-05','2026-11-08','2026-11-10']) assert.ok(tasksOnDate(doc,d).some(t=>t.id===id));
 assert.equal(tasksOnDate(doc,'2026-11-11').length,0); assert.equal(tasksOnDate(doc,'2026-11-04').length,0);
 const dates=monthDates('2026-11');
 const segments=[]; for(let w=0;w<6;w++){ const days=dates.slice(w*7,w*7+7);segments.push(...calendarSpans(days.flatMap(d=>tasksOnDate(doc,d)),days)); }
 const bars=segments.filter(t=>t.id===id); assert.equal(bars.length,2);
 assert.deepEqual(bars.map(t=>[t.column,t.last,t.continuesBefore,t.continuesAfter]),[[3,6,false,true],[0,1,true,false]]);
 assert.ok(segments.filter(t=>t.id===other).every(t=>t.lane===1));
 assert.equal(calendarSpans(tasksOnDate(doc,'2026-11-05'),['2027-01-01']).length,0);
});
test('timed ranges clip every day, exclude midnight endpoints and remind once at start',()=>{
 const doc=newDocument(),id=make(doc,{time:'22:00',endTime:'00:00',endDate:'2026-11-08'});
 assert.equal(currentEntities(doc).get(`task:${id}`).payload.durationMinutes,3000);
 assert.deepEqual(['2026-11-05','2026-11-06','2026-11-07','2026-11-08'].map(d=>timelineItems(doc,d).map(t=>[t.start,t.end])),[[[1320,1440]],[[0,1440]],[[0,1440]],[]]);
 assert.equal(tasksOnDate(doc,'2026-11-08').length,0);
 assert.equal(dueReminders(doc,Date.parse('2026-11-05T14:00:00Z')).length,1);
 updateTask(doc,id,{scheduledDate:'2026-12-30',time:'23:00'});
 const t=currentEntities(doc).get(`task:${id}`).payload; assert.equal(t.endDate,'2027-01-02'); assert.equal(t.endTime,'01:00'); assert.equal(t.durationMinutes,3000);
 toggleTask(doc,id,'2027-01-01'); assert.equal(completionHistory(doc).length,1);
});
test('range validation rejects invalid ends without modifying revisions; range fields survive widget edits and sync',()=>{
 const doc=newDocument();
 for(const extra of [{endDate:'2026-11-04'},{time:'10:00',endTime:'09:00',endDate:'2026-11-05'},{time:'09:00',endTime:null},{endDate:'2026-02-30'},{endTime:'10:00'}]){
  assert.throws(()=>make(doc,extra)); assert.equal(doc.revisions.length,0);
 }
 const id=make(doc,{time:'09:00',endTime:'10:00'});
 const base={settings:{},selectedDay:'today',projects:[],tags:[],memo:{text:''},colorCounters:{},itemsByDay:{},recurringItems:[]};
 const before=projectView(doc,base,'2026-11-05'),after=structuredClone(before);after.itemsByDay.today[0].title='保留区间';commitView(doc,before,after);
 const copy=newDocument();mergeRevisions(copy,doc.revisions); const t=currentEntities(copy).get(`task:${id}`).payload;
 assert.equal(t.endDate,'2026-11-10');assert.equal(t.endTime,'10:00'); assert.equal(t.title,'保留区间');
 updateTask(copy,id,{endDate:null,endTime:null,durationMinutes:30}); assert.equal(tasksOnDate(copy,'2026-11-06').length,0);
});

test('widget rescheduling moves the full interval and retains the explicit end on later edits',()=>{
 const doc=newDocument(),id=make(doc,{time:'09:00',endTime:'10:00'});
 const base={settings:{},selectedDay:'today',projects:[],tags:[],memo:{text:''},colorCounters:{},itemsByDay:{},recurringItems:[]};
 let before=projectView(doc,base,'2026-11-05'),after=structuredClone(before);
 after.itemsByDay.today[0].scheduledDate='2026-11-06';after.itemsByDay.today[0].time='11:00';commitView(doc,before,after);
 let t=currentEntities(doc).get(`task:${id}`).payload;assert.equal(t.endDate,'2026-11-11');assert.equal(t.endTime,'12:00');assert.equal(t.durationMinutes,7260);
 before=projectView(doc,base,'2026-11-06');after=structuredClone(before);after.itemsByDay.today[0].time=null;commitView(doc,before,after);
 t=currentEntities(doc).get(`task:${id}`).payload;assert.equal(t.endDate,'2026-11-11');assert.equal(t.endTime,null);
});
