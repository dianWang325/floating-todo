import {test,expect} from '@playwright/test';
import {newDocument,writeRevision,dateInZone,shiftDate} from '../src/sync-model.js';
async function boot(page){
 await page.setViewportSize({width:1450,height:960});const doc=newDocument();doc.local.settings={appearance:'light'};
 for(const [id,name] of [['work','工作'],['learn','学习']])writeRevision(doc,'projects',id,{id,name,color:'#397fe5'});
 for(const [id,name] of [['p','性能优化'],['q','设计文档']])writeRevision(doc,'tags',id,{id,name,color:'#28a745'});
 for(const [id,title,projectId,tagIds,completed] of [['a','分析瓶颈','work',['p'],false],['b','阅读算法','learn',['p','q'],false],['c','已归档验证','work',['p'],true],['other','独立任务','learn',['q'],false]]){
  writeRevision(doc,'task',id,{id,title,projectId,tagIds,completed,kind:'one_off',scheduledDate:shiftDate(dateInZone(),id==='b'?45:0),time:null,detail:'任务详情',createdAt:Date.now(),...(completed?{completedAt:Date.now(),archivedAt:Date.now()}:{} )});
 }
 await page.addInitScript(doc=>{window.__TAURI__={core:{invoke:async()=>{}}};if(!localStorage.getItem('floating-todo/v3-preview'))localStorage.setItem('floating-todo/v3-preview',JSON.stringify(doc));},doc);
 await page.goto('/');await expect(page.locator('.workspace-sidebar')).toBeVisible();
}
async function openProject(page,id='p'){await page.locator('[data-mode="projects"]').click();await page.locator(`.work-project-card[data-id="${id}"]`).click();}
const doc=page=>page.evaluate(()=>JSON.parse(localStorage.getItem('floating-todo/v3-preview')));
test('project view reuses # associations across collections, dates and archived tasks, with independent filters',async({page})=>{
 await boot(page);const before=(await doc(page)).revisions;
 await page.locator('.workspace-collection[data-id="work"]').click();await openProject(page);
 await expect(page.locator('.work-project-task [data-planner-task]')).toHaveCount(3);
 await expect(page.locator('.work-project-heading')).toContainText('3 项任务 · 1 已完成');
 await expect(page.locator('.work-project-task').filter({hasText:'阅读算法'})).toContainText('学习');
 await page.locator('[data-p-form="project-filter"] [name="collection"]').selectOption('learn');await page.locator('[data-p-form="project-filter"] [type="submit"]').click();
 await expect(page.locator('.work-project-task [data-planner-task]')).toHaveCount(1);
 await page.locator('[data-p-form="project-filter"] [name="collection"]').selectOption('');await page.locator('[data-p-form="project-filter"] [name="status"]').selectOption('done');await page.locator('[data-p-form="project-filter"] [type="submit"]').click();
 await expect(page.locator('.work-project-task')).toHaveCount(1);await expect(page.locator('.work-project-task')).toContainText('已归档验证');
 expect((await doc(page)).revisions).toEqual(before);
});
test('planning notes preserve drafts across views, save without generating tasks and survive reload and widget edits',async({page})=>{
 await boot(page);await openProject(page);const taskRevisions=(await doc(page)).revisions.filter(r=>r.entityType==='task');
 const plan=page.locator('.project-plan');await plan.locator('[name="description"]').fill('目标：降低推理延迟\n待探索：也许需要改缓存，但暂不拆任务。\n<img src=x onerror=alert(1)>');await plan.locator('[name="milestones"]').fill('11/15 给出方案\n11/30 验证收益');await plan.locator('[name="targetDate"]').fill('2026-12-15');
 await expect(plan.locator('.project-draft-status')).toHaveText('未保存的修改');
 await page.locator('.work-project-card[data-id="q"]').click();await page.locator('.work-project-card[data-id="p"]').click();await expect(plan.locator('[name="description"]')).toContainText('暂不拆任务');
 await page.locator('[data-mode="calendar"]').click();await openProject(page);await expect(plan.locator('[name="targetDate"]')).toHaveValue('2026-12-15');
 await plan.locator('[type="submit"]').click();await expect(plan.locator('.project-draft-status')).toHaveText('已保存');
 expect((await doc(page)).revisions.filter(r=>r.entityType==='task')).toEqual(taskRevisions);
 await page.reload();await openProject(page);await expect(plan.locator('[name="milestones"]')).toHaveValue('11/15 给出方案\n11/30 验证收益');
 await expect(page.locator('.work-project-board img')).toHaveCount(0);
 await page.screenshot({path:'test-results/work-projects-light.png'});
 await page.locator('.work-project-task [data-planner-task="a"] [data-p="edit"]').click();await page.locator('.planner-editor [name="title"]').fill('分析瓶颈更新');await page.locator('.planner-editor [type="submit"]').click();
 await expect(plan.locator('[name="description"]')).toContainText('暂不拆任务');
 await page.locator('[data-p="close"]').click();await page.locator('[data-act="planner"]').click();await openProject(page);await expect(plan.locator('[name="targetDate"]')).toHaveValue('2026-12-15');
});
test('new projects can start with only ideas and project task creation links # names independently of collections',async({page})=>{
 await boot(page);await openProject(page);await page.locator('[data-p="work-project-new"]').click();await page.locator('[data-p-form="work-project-create"] [name="name"]').fill('跨端同步');await page.locator('[data-p-form="work-project-create"] [type="submit"]').click();
 await expect(page.locator('.work-project-heading')).toContainText('0 项任务');
 const before=(await doc(page)).revisions.filter(r=>r.entityType==='task').length;
 await page.locator('.project-plan [name="description"]').fill('先调研，还没有安排任务');await page.locator('.project-plan [type="submit"]').click();expect((await doc(page)).revisions.filter(r=>r.entityType==='task')).toHaveLength(before);
 await page.locator('[data-p="project-task-new"]').click();await expect(page.locator('.planner-add input[name="workProjects"]:checked')).toHaveCount(1);
 await page.locator('.planner-add [name="title"]').fill('调研方案 #性能优化');await page.locator('.planner-add [name="project"]').selectOption('learn');await page.locator('.planner-add [type="submit"]').click();
 const payload=(await doc(page)).revisions.filter(r=>r.entityType==='task').at(-1).payload;expect(payload.tagIds).toHaveLength(2);expect(payload.projectId).toBe('learn');expect(payload.title).toBe('调研方案');
 await openProject(page);await expect(page.locator('.work-project-task').filter({hasText:'调研方案'})).toHaveCount(1);
});
test('failed project save retains the notes and supports retry without modifying task data',async({page})=>{
 await boot(page);await openProject(page);const before=(await doc(page)).revisions;const plan=page.locator('.project-plan');await plan.locator('[name="description"]').fill('不能丢的想法');
 await page.evaluate(()=>{window.__setItem=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='floating-todo/v3-preview')throw new Error('disk full');return window.__setItem.call(this,key,value);};});
 await plan.locator('[type="submit"]').click();await expect(page.locator('.classification-notice')).toContainText('disk full');await expect(plan.locator('[name="description"]')).toHaveValue('不能丢的想法');expect((await doc(page)).revisions).toEqual(before);
 await page.evaluate(()=>{Storage.prototype.setItem=window.__setItem;});await plan.locator('[type="submit"]').click();await expect(plan.locator('.project-draft-status')).toHaveText('已保存');
});
test('project view remains usable in dark and narrow layouts',async({page})=>{
 await boot(page);await openProject(page);
 await page.evaluate(()=>{document.documentElement.dataset.appearance='dark';document.documentElement.dataset.theme='dark';});
 await page.screenshot({path:'test-results/work-projects-dark.png'});
 await page.setViewportSize({width:610,height:850});await expect(page.locator('.project-plan')).toBeVisible();
 expect(await page.locator('.planner-content').evaluate(e=>e.scrollWidth<=e.clientWidth+2)).toBe(true);
 await page.locator('.project-plan [name="description"]').fill('小窗输入');await page.locator('.project-plan [type="submit"]').click();await expect(page.locator('.project-draft-status')).toHaveText('已保存');
 await page.screenshot({path:'test-results/work-projects-narrow.png'});
});
