import {test,expect} from '@playwright/test';
import {newDocument,dateInZone,shiftDate,writeRevision} from '../src/sync-model.js';
const today=()=>dateInZone();
async function boot(page){
 await page.setViewportSize({width:1450,height:960}); const doc=newDocument();doc.local.settings={appearance:'light'};writeRevision(doc,'projects','work',{id:'work',name:'作业',color:'#28a745'});
 await page.addInitScript(doc=>{window.__TAURI__={core:{invoke:async()=>{}}};if(!localStorage.getItem('floating-todo/v3-preview'))localStorage.setItem('floating-todo/v3-preview',JSON.stringify(doc));},doc);
 await page.goto('/');await expect(page.locator('.planner-add')).toBeVisible();
}
const latest=page=>page.evaluate(()=>JSON.parse(localStorage.getItem('floating-todo/v3-preview')).revisions.filter(r=>r.entityType==='task').at(-1)?.payload);
test('all-day range creates continuous bars across weeks, edits, recolors, and survives reload',async({page})=>{
 await boot(page);const form=page.locator('.planner-add');
 await form.locator('[name="title"]').fill('跨周作业');await form.locator('[name="date"]').fill('2026-11-05');
 await form.getByLabel('设置时间段').check();await form.locator('[name="endDate"]').fill('2026-11-10');
 await form.locator('[name="project"]').selectOption('work');await form.locator('[type="submit"]').click();expect(await latest(page)).toMatchObject({scheduledDate:'2026-11-05',endDate:'2026-11-10',time:null,endTime:null});
 // Open November regardless of the execution date.
 await page.locator('.mini-day[data-date="2026-11-05"]').click();
 const bars=page.locator('.month-span-layer .calendar-span');await expect(bars).toHaveCount(2);
 expect(await bars.evaluateAll(rows=>rows.map(r=>[r.style.gridColumn,r.style.gridRow]))).toEqual([['4 / 8','1'],['1 / 3','1']]);
 const geometry=await bars.evaluateAll(rows=>rows.map(r=>({width:r.getBoundingClientRect().width,day:r.closest('.month-week').querySelector('.planner-day').getBoundingClientRect().width})));
 expect(geometry[0].width).toBeGreaterThan(geometry[0].day*3.8);
 await page.screenshot({path:'test-results/range-month.png'});
 const oldColor=await bars.first().evaluate(e=>getComputedStyle(e).backgroundColor);
 await page.locator('.workspace-collection[data-id="work"]').click({button:'right'});await page.getByRole('menuitemradio',{name:'紫色',exact:true}).click();
 expect(await bars.first().evaluate(e=>getComputedStyle(e).backgroundColor)).not.toBe(oldColor);
 await bars.first().click();await expect(page.locator('.planner-editor [name="endDate"]')).toHaveValue('2026-11-10');
 await page.locator('.planner-editor [name="endDate"]').fill('2026-11-12');await page.locator('.planner-editor [type="submit"]').click();
 await page.reload();await expect(page.locator('.month-span-layer .calendar-span')).toHaveCount(2);
 await page.locator('[data-view="week"]').click();await expect(page.locator('.allday-span')).toHaveCount(1);
 await page.locator('[data-view="three"]').click();await expect(page.locator('.allday-span')).toHaveCount(1);
 await page.locator('[data-view="day"]').click();await expect(page.locator('.allday-span')).toHaveCount(1);
});
test('timed range spans three days, clips at midnight and keeps one task on completion',async({page})=>{
 await boot(page);await page.locator('[data-view="three"]').click();await page.locator('[data-p="new"]').click();
 const form=page.locator('.planner-add');await form.locator('[name="title"]').fill('连续调试');await form.getByLabel('全天',{exact:true}).uncheck();
 await form.locator('[name="time"]').fill('22:00');await form.getByLabel('设置时间段').check();
 await form.locator('[name="endDate"]').fill(shiftDate(today(),2));await form.locator('[name="endTime"]').fill('10:00');
 await form.locator('[type="submit"]').click();expect(await latest(page)).toMatchObject({endDate:shiftDate(today(),2),endTime:'10:00',durationMinutes:2160});
 await expect(page.locator('.time-block')).toHaveCount(3);
 expect(await page.locator('.time-block').evaluateAll(rows=>rows.map(r=>[r.style.top,r.style.height]))).toEqual([['1584px','144px'],['0px','1728px'],['0px','720px']]);
 await page.locator('.time-block-open').last().click();const edit=page.locator('.planner-editor');await expect(edit.locator('[name="date"]')).toHaveValue(today());
 await page.screenshot({path:'test-results/range-editor.png'});
 await edit.getByLabel('设置时间段').uncheck();await edit.locator('[name="duration"]').fill('45');await edit.locator('[type="submit"]').click();
 await expect(page.locator('.time-block')).toHaveCount(1);expect(await latest(page)).toMatchObject({endDate:null,endTime:null,durationMinutes:45});
});
test('invalid timed end leaves the draft and task data intact',async({page})=>{
 await boot(page);const form=page.locator('.planner-add');await form.locator('[name="title"]').fill('检查错误时间');await form.getByLabel('全天',{exact:true}).uncheck();await form.getByLabel('设置时间段').check();
 await form.locator('[name="endTime"]').fill('08:00');await form.locator('[type="submit"]').click();await expect(page.locator('.classification-notice')).toContainText('结束时间');
 expect(await latest(page)).toBeUndefined();await expect(form.locator('[name="title"]')).toHaveValue('检查错误时间');
 await form.locator('[name="endTime"]').fill('11:00');await form.locator('[type="submit"]').click();expect((await latest(page)).durationMinutes).toBe(120);
});
