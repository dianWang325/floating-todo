import { test, expect } from '@playwright/test';
import { newDocument, writeRevision, dateInZone } from '../src/sync-model.js';

async function boot(page) {
  await page.setViewportSize({ width: 1450, height: 940 });
  const doc = newDocument(); doc.local.settings = { appearance: 'light', clickThrough: true };
  writeRevision(doc, 'projects', 'old', { id: 'old', name: '原有合集', color: '#d77c44' });
  writeRevision(doc, 'task', 'task', { id: 'task', title: '原有任务', detail: '', kind: 'one_off', scheduledDate: dateInZone(), time: '09:00', completed: false, createdAt: Date.now(), projectId: 'old', tagIds: [] });
  await page.addInitScript(doc => {
    window.__TAURI__ = { core: { invoke: async () => {} }, notification: { isPermissionGranted: async () => true, sendNotification: async () => {} } };
    if (!localStorage.getItem('floating-todo/v3-preview')) localStorage.setItem('floating-todo/v3-preview', JSON.stringify(doc));
  }, doc);
  await page.goto('/'); await expect(page.locator('.workspace-sidebar')).toBeVisible();
}

test('startup opens calendar workspace; existing collections filter every calendar view', async ({ page }) => {
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await boot(page);
  await expect(page.locator('#panel')).toHaveAttribute('inert', '');
  await page.locator('[data-p="collection"][data-id="old"]').click();
  for(const view of ['day','three','week','month']) {
    await page.locator(`[data-view="${view}"]`).click();
    await expect(page.locator(view==='month'?'.month-previews':'.time-block').filter({hasText:'原有任务'})).toHaveCount(1);
  }
  await page.screenshot({path:'test-results/workspace-month.png'});
  await page.locator('[data-p="collection"][data-id="none"]').click();
  await expect(page.locator('.month-previews')).toHaveCount(0);
  await page.reload();await expect(page.locator('.workspace-sidebar')).toBeVisible();
  expect(errors).toEqual([]);
});

test('create, rename, recolor and remove a collection without losing its tasks', async ({ page }) => {
  await boot(page);
  await page.getByRole('button',{name:'新建合集',exact:true}).click();
  await page.locator('.collection-editor [name="name"]').fill('学习');
  await page.getByRole('button',{name:'保存合集',exact:true}).click();
  await expect(page.locator('.workspace-collection[aria-pressed="true"]')).toContainText('学习');
  await page.locator('.planner-add [name="title"]').fill('学习计划');
  await page.locator('.planner-add [name="time"]').fill('10:00');
  await page.locator('.planner-add [type="submit"]').click();
  await expect(page.locator('.planner-task').filter({hasText:'学习计划'})).toHaveCount(1);
  await page.getByRole('button',{name:'管理当前合集'}).click();
  await page.locator('.collection-editor [name="name"]').fill('读书');
  await page.locator('.collection-editor [name="color"]').fill('#55aa77');
  await page.getByRole('button',{name:'保存合集',exact:true}).click();
  await expect(page.locator('.workspace-collection[aria-pressed="true"]')).toContainText('读书');
  await page.reload();
  await page.locator('.workspace-collection').filter({hasText:'读书'}).click();
  await page.getByRole('button',{name:'管理当前合集'}).click();
  await page.getByRole('button',{name:'删除合集',exact:true}).click();
  await page.getByRole('button',{name:'确认删除合集，保留全部任务'}).click();
  await expect(page.locator('.workspace-collection[aria-pressed="true"]')).toContainText('未分类');
  await expect(page.locator('.planner-task').filter({hasText:'学习计划'})).toHaveCount(1);
  await page.locator('[data-p="close"]').click();
  await expect(page.locator('#main-input')).toBeVisible();
  await page.locator('[data-act="planner"]').click();
  await expect(page.locator('.workspace-sidebar')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.workspace-sidebar')).toBeVisible();
});

test('workspace sidebar and settings remain usable at small sizes', async ({ page }) => {
  await boot(page);await page.setViewportSize({width:620,height:800});
  expect(await page.locator('.planner-overlay').evaluate(e=>e.scrollWidth>e.clientWidth+1)).toBe(false);
  await page.getByRole('button',{name:'⚙ 设置与同步'}).click();
  await expect(page.locator('#startup-view')).toBeVisible();
  await page.screenshot({path:'test-results/workspace-small.png'});
});

test('right-click palette persists color, preserves the active filter and task draft, and recolors all views', async ({ page }) => {
  await boot(page);
  await page.locator('[data-id="none"]').click();
  await page.locator('.planner-add [name="title"]').fill('尚未提交的安排');
  const taskBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('floating-todo/v3-preview')).revisions.filter(r => r.entityType === 'task'));
  const entry = page.locator('.workspace-collection[data-id="old"]');
  await entry.click({button:'right'});
  await expect(page.getByRole('menu',{name:'原有合集的颜色'})).toBeVisible();
  await expect(page.locator('.workspace-collection[aria-pressed="true"]')).toContainText('未分类');
  await page.getByRole('menuitemradio',{name:'红色',exact:true}).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.locator('.planner-add [name="title"]')).toHaveValue('尚未提交的安排');
  await expect(entry.locator('i')).toHaveCSS('background-color','rgb(255, 59, 48)');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('floating-todo/v3-preview')).revisions.filter(r => r.entityType === 'task'))).toEqual(taskBefore);
  await entry.click();
  await expect(page.locator('.month-event')).toHaveCSS('--task-color','#ff3b30');
  await page.locator('[data-view="day"]').click();
  await expect(page.locator('.time-block')).toHaveCSS('--task-color','#ff3b30');
  await page.reload();
  await expect(entry.locator('i')).toHaveCSS('background-color','rgb(255, 59, 48)');
  await entry.click({button:'right'});
  await expect(page.getByRole('menuitemradio',{name:'红色',exact:true})).toHaveAttribute('aria-checked','true');
  await page.getByLabel('自定义合集颜色').fill('#55aa77');
  await expect(entry.locator('i')).toHaveCSS('background-color','rgb(85, 170, 119)');
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('collection color menu supports keyboard, Escape, outside click and viewport boundaries', async ({ page }) => {
  await boot(page);
  const entry = page.locator('.workspace-collection[data-id="old"]');
  await entry.focus(); await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menuitemradio',{name:'红色',exact:true})).toBeFocused();
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect(entry.locator('i')).toHaveCSS('background-color','rgb(255, 149, 0)');
  await expect(entry).toBeFocused();
  await page.keyboard.press('Shift+F10');await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);await expect(entry).toBeFocused();
  await entry.click({button:'right'});await page.locator('.planner-header').click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await page.setViewportSize({width:340,height:620});
  await entry.dispatchEvent('contextmenu',{clientX:337,clientY:615});
  const box=await page.getByRole('menu').boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x+box.width).toBeLessThanOrEqual(340);expect(box.y+box.height).toBeLessThanOrEqual(620);
});

test('calendar appearance uses neutral surfaces, red today and collection-colored event chips in both themes', async ({ page }) => {
  await boot(page);
  for (const theme of ['light','dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme=theme,theme);
    await expect(page.locator('.planner-day.today > span')).toHaveCSS('color','rgb(255, 255, 255)');
    await expect(page.locator('.planner-day.today > span')).toHaveCSS('background-color',theme==='light'?'rgb(220, 57, 53)':'rgb(255, 98, 89)');
    await page.screenshot({path:`test-results/calendar-apple-${theme}-month.png`});
    await page.locator('[data-view="week"]').click();
    await page.screenshot({path:`test-results/calendar-apple-${theme}-week.png`});
    await page.locator('.workspace-collection[data-id="old"]').click({button:'right'});
    await page.screenshot({path:`test-results/calendar-apple-${theme}-menu.png`});
    await page.keyboard.press('Escape');await page.locator('[data-view="month"]').click();
  }
});
