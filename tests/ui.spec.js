import { test, expect } from '@playwright/test';
const KEY = 'floating-todo/snapshot';
const date = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`; };
const snapshot = (extra = {}) => ({ selectedDay: 'today', itemsByDay: { today: [], tomorrow: [], dayAfterTomorrow: [] }, recurringItems: [], settings: { appearance: 'light', opacity: .5, memoEnabled: true }, memo: { text: '记录临时想法、链接、会议号', expanded: true }, lastActiveDate: date(), ...extra });
const item = (id, title, extra = {}) => ({ id, title, detail: '', time: null, completed: false, notified: false, createdAt: 1, ...extra });
const read = (page) => page.evaluate(key => JSON.parse(localStorage.getItem(key)), KEY);
async function boot(page, seed) {
  await page.addInitScript(({ key, seed }) => {
    if (seed && !localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(seed));
    window.__notifications = [];
    window.__exported = null;
    window.__TAURI__ = {
      core: { invoke: async (name, args) => { if (name === 'export_data') window.__exported = args.json; if (name === 'import_data') return window.__imported; } },
      notification: { isPermissionGranted: async () => true, sendNotification: n => window.__notifications.push(n) },
    };
  }, { key: KEY, seed });
  await page.goto('/'); await expect(page.locator('#main-input')).toBeVisible();
}
async function add(page, value) { await page.locator('#main-input').fill(value); await page.locator('[data-act="submit"]').click(); }
async function manager(page, kind = 'projects') { await page.locator('[data-act="settings"]').click(); await page.locator('[data-s="categories"]').click(); await page.locator(`[data-kind="${kind}"]`).click(); }
async function closePanel(page) { await page.getByRole('button', { name: '关闭', exact: true }).click(); }

test('complete workflow: capture, dates, filters, rename, color, deletion, reload and backup', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await boot(page, snapshot());
  await add(page, '提交设计稿 +官网改版 #设计 #重要');
  await add(page, '明天 审阅设计 +官网改版 #设计');
  await expect(page.locator('.day-seg.sel')).toContainText('明天');
  await expect(page.locator('.row .title')).toHaveText('审阅设计');
  let s = await read(page); expect(s.projects).toHaveLength(1); expect(s.tags).toHaveLength(2);
  await page.locator('[data-class-ui="filter-projects"]').click();
  await page.locator(`[data-filter-project="${s.projects[0].id}"]`).click();
  await page.locator('[data-act="day"][data-day="today"]').click();
  await expect(page.locator('.row')).toHaveCount(1); await expect(page.locator('.row .tag-dot')).toHaveCount(2);
  await expect(page.locator('.row')).toHaveAttribute('data-project-color', '');
  await manager(page);
  await page.locator('[data-entry-name]').fill('网站升级'); await page.locator('[data-entry-name]').press('Enter');
  await page.locator('[data-palette="#4a9b74"]').click();
  await closePanel(page);
  await expect(page.locator('[data-class-ui="filter-projects"]')).toContainText('网站升级');
  await expect(page.locator('.row')).toHaveAttribute('style', '--project-rgb:74,155,116');
  await manager(page, 'tags');
  await page.locator('[data-entry]').filter({ has: page.locator('input[value="重要"]') }).locator('[data-entry-delete]').click();
  await closePanel(page);
  s = await read(page); expect(s.tags).toHaveLength(1); expect(s.itemsByDay.today).toHaveLength(1);
  await page.reload(); await expect(page.locator('.row .tag-dot')).toHaveCount(1);
  await page.locator('[data-act="settings"]').click(); await page.locator('[data-s="export"]').click();
  const exported = await page.evaluate(() => window.__exported);
  expect(JSON.parse(exported).projects[0].name).toBe('网站升级');
  await page.evaluate(json => { window.__imported = json; }, exported);
  await page.locator('[data-s="import"]').click();
  expect((await read(page)).projects[0].color).toBe('#4a9b74');
  await expect(page.locator('.row .title')).toHaveText('提交设计稿');
  expect(errors).toEqual([]);
});

test('autocomplete keyboard, cursor replacement, no confirmation, IME and empty title', async ({ page }) => {
  await boot(page, snapshot());
  await add(page, '已有任务 +工作 #重要');
  const input = page.locator('#main-input');
  await input.fill('新任务 #重');
  await expect(page.getByRole('listbox')).toBeVisible();
  await input.press('Tab'); await expect(input).toHaveValue('新任务 #重要 ');
  await input.press('End'); await input.pressSequentially('+网站');
  await expect(page.getByRole('option')).toContainText('新建');
  await input.press('Enter'); expect((await read(page)).projects).toHaveLength(1);
  await input.press('Enter'); expect((await read(page)).projects).toHaveLength(2);
  await expect(page.locator('.row')).toHaveCount(2);
  await input.fill('输入法 #标签');
  await input.dispatchEvent('compositionstart');
  await input.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true });
  await expect(page.locator('.row')).toHaveCount(2);
  await input.dispatchEvent('compositionend');
  await input.press('Escape'); await expect(input).toHaveValue('输入法 #标签');
  await add(page, '#孤立标签 +孤立项目');
  const s = await read(page); expect(s.tags.map(t => t.name)).not.toContain('孤立标签'); expect(s.projects.map(p => p.name)).not.toContain('孤立项目');
  await input.fill('仅预览 #取消的新标签'); await input.press('Escape'); await input.fill('');
  expect((await read(page)).tags.map(t => t.name)).not.toContain('取消的新标签');
});

test('editing preserves classification and reminder; metadata can be removed independently', async ({ page }) => {
  await boot(page, snapshot()); await add(page, '15:00 任务 +工作 #重要');
  await page.locator('.row .body').click();
  await expect(page.locator('#main-input')).toHaveValue('任务 +工作 #重要');
  await add(page, '改名 +工作 #重要');
  let s = await read(page); expect(s.itemsByDay.today[0].time).toBe('15:00');
  await page.locator('.task-categories').click();
  await page.locator('[data-metadata-project]').selectOption('');
  await page.locator('[data-metadata-tag]').uncheck();
  await page.locator('[data-save-metadata]').click();
  s = await read(page); expect(s.itemsByDay.today[0].projectId).toBeNull(); expect(s.itemsByDay.today[0].tagIds).toEqual([]);
  await expect(page.locator('.row')).not.toHaveAttribute('data-project-color');
});

test('filters are date intersections, label OR, and clear-completed affects only visible tasks', async ({ page }) => {
  await boot(page, snapshot());
  await add(page, '甲 +工作 #重要'); await add(page, '乙 +生活 #日常'); await add(page, '丙 +工作 #日常');
  await page.locator('.check').nth(0).click(); await page.locator('.check').nth(0).click();
  let s = await read(page); const work = s.projects.find(p => p.name === '工作');
  await page.locator('[data-class-ui="filter-projects"]').click(); await page.locator(`[data-filter-project="${work.id}"]`).click();
  await page.locator('[data-class-ui="filter-tags"]').click();
  for (const checkbox of await page.locator('.category-options input').all()) await checkbox.check(); await closePanel(page);
  await expect(page.locator('.row')).toHaveCount(2);
  await page.locator('[data-act="clear"]').click();
  s = await read(page); expect(s.itemsByDay.today.map(t => t.title)).toEqual(expect.arrayContaining(['甲', '乙'])); expect(s.itemsByDay.today.map(t => t.title)).not.toContain('丙');
  await page.locator('[data-act="day"][data-day="tomorrow"]').click(); await expect(page.locator('.empty')).toContainText('没有符合条件');
  await add(page, '隐藏任务 +生活'); await expect(page.locator('.classification-notice')).toContainText('当前筛选');
  await page.locator('.classification-notice [data-class-ui="clear"]').click(); await expect(page.locator('.row .title')).toHaveText('隐藏任务');
});

for (const mode of ['keep', 'tasks', 'cancel']) test(`project deletion ${mode} covers all dates and recurring tasks`, async ({ page }) => {
  const linked = { projectId: 'p', tagIds: ['t'] };
  await boot(page, snapshot({ projects: [{ id: 'p', name: '工作', color: '#397fe5' }], tags: [{ id: 't', name: '重要', color: '#ae65d6' }], itemsByDay: { today: [item('a', '今天', linked)], tomorrow: [item('b', '明天', linked)], dayAfterTomorrow: [item('c', '后天', linked)] }, recurringItems: [item('d', '每天', linked)] }));
  await manager(page); await page.locator('[data-entry-delete]').click();
  await expect(page.getByRole('dialog')).toContainText('4 个任务');
  await page.locator(`[data-delete="${mode}"]`).click();
  const s = await read(page);
  expect(s.projects.length).toBe(mode === 'cancel' ? 1 : 0);
  for (const tasks of [...Object.values(s.itemsByDay), s.recurringItems]) { expect(tasks.length).toBe(mode === 'tasks' ? 0 : 1); if (mode === 'keep') expect(tasks[0].projectId).toBeNull(); }
});

test('rollover, move, pin/unpin, habit streak and reminder retain metadata', async ({ page }) => {
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate()-1);
  const yesterdayStr = `${yesterday.getFullYear()}-${yesterday.getMonth()+1}-${yesterday.getDate()}`;
  const linked = { projectId: 'p', tagIds: ['t'], time: '00:00' };
  await boot(page, snapshot({ lastActiveDate: yesterdayStr, projects: [{ id: 'p', name: '工作', color: '#397fe5' }], tags: [{ id: 't', name: '重要', color: '#ae65d6' }], itemsByDay: { today: [item('a', '顺延', linked)], tomorrow: [item('b', '计划', linked)], dayAfterTomorrow: [] }, recurringItems: [item('d', '打卡', { ...linked, streak: 3, lastDone: yesterdayStr, completed: true })] }));
  const s = await read(page); expect(s.itemsByDay.today.map(t => t.id)).toEqual(['b','a']); expect(s.recurringItems[0].completed).toBe(false);
  await expect.poll(() => page.evaluate(() => window.__notifications.length)).toBe(3);
  await page.locator('[data-act="rtoggle"]').click(); expect((await read(page)).recurringItems[0].streak).toBe(4);
  await page.locator('[data-act="menu"][data-id="a"]').click(); await page.locator('[data-m="move:tomorrow"]').click();
  await page.locator('[data-act="day"][data-day="tomorrow"]').click();
  await page.locator('[data-act="menu"][data-id="a"]').click(); await page.locator('[data-m="pin"]').click();
  await page.locator('[data-act="day"][data-day="today"]').click();
  await page.locator('[data-act="unpin"][data-id="a"]').click();
  expect((await read(page)).itemsByDay.today.find(t => t.id === 'a')).toMatchObject(linked);
});

test('old backup imports, invalid backup leaves state intact, migration snapshot is retained', async ({ page }) => {
  const old = snapshot({ itemsByDay: { today: [item('legacy', '旧任务')], tomorrow: [], dayAfterTomorrow: [] } });
  await boot(page, old);
  expect(await page.evaluate(key => !!localStorage.getItem(key + '/before-v2'), KEY)).toBe(true);
  await add(page, '新任务 +工作 #重要');
  await page.locator('[data-act="settings"]').click();
  await page.evaluate(() => { window.__imported = '{"itemsByDay":{"today":{}}}'; });
  await page.locator('[data-s="import"]').click(); await expect(page.locator('.classification-notice')).toContainText('导入失败');
  expect((await read(page)).projects).toHaveLength(1);
  await page.evaluate(data => { window.__imported = JSON.stringify(data); }, old);
  await page.locator('[data-s="import"]').click();
  expect((await read(page)).itemsByDay.today[0]).toMatchObject({ projectId: null, tagIds: [] });
  await expect(page.locator('.row .title')).toHaveText('旧任务');
});

test('light/dark and compact layouts keep controls and modals inside the window', async ({ page }) => {
  await boot(page, snapshot()); await add(page, '任务 +网站改版 #设计 #重要 #讨论 #待办 #第五个');
  await expect(page.locator('.tag-overflow')).toHaveText('+1');
  for (const theme of ['light', 'dark']) {
    await page.locator('[data-act="settings"]').click(); await page.locator(`[data-ap="${theme}"]`).click(); await page.locator('[data-s="close"]').click();
    const color = await page.locator('.row .title').evaluate(el => getComputedStyle(el).color); expect(color).toBe(theme === 'light' ? 'rgb(24, 35, 58)' : 'rgb(238, 242, 251)');
    const inputBox = await page.locator('#main-input').boundingBox(); expect(inputBox.x + inputBox.width).toBeLessThanOrEqual(340);
  }
  await page.setViewportSize({ width: 220, height: 180 });
  await page.locator('[data-class-ui="filter-projects"]').click();
  const box = await page.getByRole('dialog').boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(220); expect(box.y + box.height).toBeLessThanOrEqual(180);
  await closePanel(page); await page.setViewportSize({ width: 340, height: 734 }); await expect(page.locator('#main-input')).toBeVisible();
});

test('recurring capture and editing keep classification and streak; duplicate rename is rejected', async ({ page }) => {
  await boot(page, snapshot({ recurringItems: [item('habit', '喝水', { streak: 4, lastDone: date() })] }));
  await page.locator('[data-act="raddtoggle"]').click();
  await page.locator('#recur-input').fill('23:59 阅读 +学习 #每天');
  await page.locator('[data-act="raddsubmit"]').click();
  let s = await read(page); const reading = s.recurringItems.find(t => t.title === '阅读');
  expect(reading.time).toBe('23:59'); expect(reading.projectId).toBe(s.projects[0].id); expect(reading.tagIds).toHaveLength(1);
  await page.locator(`[data-act="redit"][data-id="${reading.id}"]`).click();
  await expect(page.locator('#recur-input')).toHaveValue('阅读 +学习 #每天');
  await page.locator('#recur-input').fill('读书 +学习 #每天'); await page.locator('[data-act="raddsubmit"]').click();
  expect((await read(page)).recurringItems.find(t => t.id === reading.id).time).toBe('23:59');
  await add(page, '写作 +工作'); await manager(page);
  const row = page.locator('[data-entry]').filter({ has: page.locator('input[value="学习"]') });
  await row.locator('[data-entry-name]').fill('工作'); await row.locator('[data-entry-name]').press('Enter');
  await expect(page.locator('.category-error')).toHaveText('已有同名分类');
  expect((await read(page)).projects.map(p => p.name)).toContain('学习');
  await row.locator('[data-entry-name]').fill('读书计划'); await row.locator('[data-entry-name]').press('Enter');
  await expect(row.locator('[data-entry-name]')).not.toHaveAttribute('aria-invalid');
});

test('capture preserves the cursor during periodic refresh and defers refresh during IME', async ({ page }) => {
  await page.clock.install();
  await boot(page, snapshot());
  await page.locator('#main-input').fill('正在编辑的内容');
  await page.locator('#main-input').evaluate(el => el.setSelectionRange(2, 4));
  await page.clock.fastForward(5 * 60 * 1000);
  expect(await page.locator('#main-input').evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([2, 4]);
  await page.locator('#main-input').dispatchEvent('compositionstart');
  await page.locator('#main-input').evaluate(el => { el.dataset.imeOriginal = 'yes'; });
  await page.clock.fastForward(5 * 60 * 1000);
  await expect(page.locator('#main-input')).toHaveAttribute('data-ime-original', 'yes');
  await page.locator('#main-input').dispatchEvent('compositionend');
});

test('visual previews at reference size, normal size, settings, completion and compact mode', async ({ page }, testInfo) => {
  const output = (name) => process.env.PREVIEW_DIR ? `${process.env.PREVIEW_DIR}/${name}.png` : testInfo.outputPath(`${name}.png`);
  await boot(page, snapshot());
  await add(page, 'DCP+k3+gqa PR 检视 +模型优化 #代码 #重要');
  await add(page, 'o proj 重构 PR 检视 +桌面工具 #代码');
  await add(page, '整理周末阅读清单 +学习 #阅读');
  // A neutral desktop-like backing makes the transparent widget readable in PNGs.
  await page.evaluate(() => { document.documentElement.style.background = '#86a9c3'; });
  await page.screenshot({ path: output('projects-tags-light') });
  await page.locator('#main-input').fill('提交评审 +模');
  await expect(page.getByRole('listbox')).toBeVisible();
  const candidate = await page.getByRole('listbox').boundingBox(); expect(candidate.y).toBeGreaterThanOrEqual(0);
  await page.screenshot({ path: output('projects-tags-autocomplete') });
  await page.locator('#main-input').fill(''); await manager(page);
  await page.screenshot({ path: output('projects-tags-manager') });
  await page.locator('[data-kind="tags"]').click(); await page.screenshot({ path: output('projects-tags-tag-manager') });
  await closePanel(page);
  await page.setViewportSize({ width: 340, height: 560 });
  await page.screenshot({ path: output('projects-tags-default-size') });
  await page.locator('[data-act="settings"]').click(); await page.locator('[data-ap="dark"]').click(); await page.locator('[data-s="close"]').click();
  await page.screenshot({ path: output('projects-tags-dark') });
  await page.setViewportSize({ width: 220, height: 180 });
  await expect(page.locator('html')).toHaveClass(/compact/);
  await page.screenshot({ path: output('projects-tags-compact') });
  const overflow = await page.evaluate(() => document.querySelector('.panel').scrollWidth > document.querySelector('.panel').clientWidth); expect(overflow).toBe(false);
});
