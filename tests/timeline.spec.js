import { test, expect } from '@playwright/test';
import { newDocument, writeRevision, dateInZone, shiftDate } from '../src/sync-model.js';

const today = () => dateInZone();
function documentWithTasks() {
  const doc = newDocument(); doc.local.settings = { appearance: 'light' };
  for (const [id, title, time, durationMinutes] of [['all', '全天安排', null, 30], ['a', '方案讨论', '09:00', 90], ['b', '代码评审', '09:30', 60], ['c', '整理笔记', '11:00', 30]]) {
    writeRevision(doc, 'task', id, { id, title, kind: 'one_off', scheduledDate: today(), time, durationMinutes, detail: '', completed: false, createdAt: Date.now(), projectId: null, tagIds: [] });
  }
  return doc;
}
async function boot(page, { native = false, doc = documentWithTasks() } = {}) {
  await page.setViewportSize({ width: native ? 420 : 1380, height: native ? 680 : 940 });
  if (native) await page.exposeFunction('__resizeViewport', size => page.setViewportSize(size));
  await page.addInitScript(({ native, doc }) => {
    if (!localStorage.getItem('floating-todo/v3-preview')) localStorage.setItem('floating-todo/v3-preview', JSON.stringify(doc));
    window.__TAURI__ = { core: { invoke: async () => {} }, notification: { isPermissionGranted: async () => true, sendNotification: async () => {} } };
    if (!native) return;
    const n = window.__geometry = { width: 420, height: 680, x: 100, y: 50, max: false, calls: [], listeners: {} };
    class PhysicalSize { constructor(width, height) { this.width = width; this.height = height; } }
    class LogicalSize extends PhysicalSize {}
    class PhysicalPosition { constructor(x, y) { this.x = x; this.y = y; } }
    const maximize = async () => { n.max = true; n.calls.push('maximize'); await window.__resizeViewport({ width: 1600, height: 1000 }); };
    const unmaximize = async () => { if (n.max) { n.max = false; n.calls.push('unmaximize'); await window.__resizeViewport({ width: n.width, height: n.height }); } };
    const win = {
      isMaximized: async () => n.max, maximize, unmaximize,
      toggleMaximize: async () => n.max ? unmaximize() : maximize(),
      innerSize: async () => new PhysicalSize(innerWidth, innerHeight),
      outerPosition: async () => new PhysicalPosition(n.x, n.y), scaleFactor: async () => 1,
      setSize: async size => { n.width = size.width; n.height = size.height; await window.__resizeViewport(size); },
      setPosition: async p => { n.x = p.x; n.y = p.y; },
      setMaxSize: async size => { n.calls.push(['maxSize', size]); },
      setMinSize: async size => { n.calls.push(['minSize', size.width, size.height]); },
      setResizable: async () => {}, setAlwaysOnTop: async () => {}, setIgnoreCursorEvents: async () => {},
      startDragging: async () => {}, startResizeDragging: async () => {},
    };
    window.__TAURI__.window = { getCurrentWindow: () => win, LogicalSize, PhysicalSize, PhysicalPosition, currentMonitor: async () => ({ scaleFactor: 1, workArea: { position: { x: 0, y: 0 }, size: { width: 1600, height: 1000 } } }) };
    window.__TAURI__.event = { listen: async (name, cb) => { n.listeners[name] = cb; return () => {}; } };
  }, { native, doc });
  await page.goto('/'); await expect(page.locator('#main-input')).toBeVisible();
}
const readDoc = page => page.evaluate(() => JSON.parse(localStorage.getItem('floating-todo/v3-preview')));

test('day, three-day and week timelines show timed and all-day tasks separately, with collision columns', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await boot(page); await page.locator('[data-act="planner"]').click();
  for (const [view, count] of [['day', 1], ['three', 3], ['week', 7]]) {
    await page.locator(`[data-view="${view}"]`).click();
    await expect(page.locator('.time-day-canvas')).toHaveCount(count);
    await expect(page.locator('.time-block')).toHaveCount(3);
    await expect(page.locator('.allday-task')).toHaveText(['全天安排']);
    await expect(page.locator('.time-now')).toHaveCount(1);
  }
  const positions = await page.locator('.time-block[data-task-id="a"], .time-block[data-task-id="b"]').evaluateAll(rows => rows.map(r => ({ left: r.offsetLeft, width: r.offsetWidth, top: r.offsetTop, height: r.offsetHeight })));
  expect(positions[1].left).toBeGreaterThanOrEqual(positions[0].left + positions[0].width);
  expect(positions[0].top).toBe(648); expect(positions[0].height).toBe(108);
  const first = await page.locator('.time-day-canvas').first().getAttribute('data-date');
  expect(new Date(first + 'T12:00:00Z').getUTCDay()).toBe(1);
  await page.getByRole('button', { name: '下周', exact: true }).click();
  expect(await page.locator('.time-day-canvas').first().getAttribute('data-date')).toBe(shiftDate(first, 7));
  expect(errors).toEqual([]);
});

test('selecting or adding on the third day keeps the three-day range anchored', async ({ page }) => {
  await boot(page); await page.locator('[data-act="planner"]').click(); await page.locator('[data-view="three"]').click();
  const start = await page.locator('.time-day-canvas').first().getAttribute('data-date');
  await page.locator('.time-date').nth(2).click();
  expect(await page.locator('.time-day-canvas').first().getAttribute('data-date')).toBe(start);
  await page.locator('[data-p-form="add"] [name="title"]').fill('第三天的任务');
  await page.locator('[data-p-form="add"] button[type="submit"]').click();
  expect((await readDoc(page)).revisions.find(r => r.payload.title === '第三天的任务').payload.scheduledDate).toBe(shiftDate(start, 2));
  expect(await page.locator('.time-day-canvas').first().getAttribute('data-date')).toBe(start);
});

test('clicking a time slot creates a task at the correct minute, then edits and completes it', async ({ page }) => {
  await boot(page); await page.locator('[data-act="planner"]').click(); await page.locator('[data-view="day"]').click();
  await page.locator('.time-grid-scroll').evaluate(e => { e.scrollTop = 8 * 72; });
  const canvas = page.locator('.time-day-canvas');
  const box = await canvas.boundingBox();
  await page.mouse.click(box.x + 200, box.y + 13.25 * 72);
  await expect(page.locator('[data-p-form="add"] [name="time"]')).toHaveValue('13:15');
  await page.locator('[data-p-form="add"] [name="title"]').fill('下午阅读');
  await page.locator('[data-p-form="add"] [name="duration"]').fill('45');
  await page.locator('[data-p-form="add"] button[type="submit"]').click();
  const revision = (await readDoc(page)).revisions.find(r => r.entityType === 'task' && r.payload.title === '下午阅读');
  expect(revision.payload).toMatchObject({ time: '13:15', durationMinutes: 45, scheduledDate: today() });
  await page.locator('.time-block').filter({ hasText: '下午阅读' }).locator('.time-block-open').click();
  await page.locator('[data-p-form="edit"] [name="time"]').fill('14:30');
  await page.locator('[data-p-form="edit"] [name="duration"]').fill('90');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.locator('.time-block').filter({ hasText: '下午阅读' })).toContainText('14:30 — 16:00');
  await page.locator('.time-block').filter({ hasText: '下午阅读' }).getByRole('button', { name: '完成 下午阅读', exact: true }).click();
  await expect(page.locator('.time-block').filter({ hasText: '下午阅读' })).toHaveClass(/done/);
  await page.locator('[data-mode="history"]').click(); await expect(page.locator('.planner-history')).toContainText('下午阅读');
});

test('range and zoom preferences persist, new-task drafts survive view changes', async ({ page }) => {
  await boot(page); await page.locator('[data-act="planner"]').click();
  await page.locator('[data-p-form="add"] [name="title"]').fill('尚未保存的安排');
  await page.locator('[data-view="three"]').click();
  await page.locator('[data-p="new"]').click();
  await expect(page.locator('[data-p-form="add"] [name="title"]')).toHaveValue('尚未保存的安排');
  await page.locator('[data-p-form="add"] [name="time"]').fill('15:45');
  await page.locator('[data-view="week"]').click();
  await expect(page.locator('[data-p-form="add"] [name="time"]')).toHaveValue('15:45');
  await page.getByRole('button', { name: '放大时间轴', exact: true }).click();
  expect((await readDoc(page)).local.plannerPrefs).toMatchObject({ view: 'week', hourHeight: 84 });
  await page.keyboard.press('Escape'); await page.reload(); await page.locator('[data-act="planner"]').click();
  await expect(page.locator('[data-view="week"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.time-day-canvas')).toHaveCount(7);
});

test('dragging an owned timed task changes its schedule, external drops are ignored', async ({ page }) => {
  await boot(page); await page.locator('[data-act="planner"]').click(); await page.locator('[data-view="three"]').click();
  await page.locator('.time-grid-scroll').evaluate(e => { e.scrollTop = 10 * 72; });
  const target = page.locator('.time-day-canvas').nth(1), before = (await readDoc(page)).revisions.length;
  const point = await target.boundingBox(), clientY = point.y + 13.5 * 72;
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await target.dispatchEvent('drop', { dataTransfer, clientY });
  expect((await readDoc(page)).revisions.length).toBe(before);
  await page.locator('.time-block[data-task-id="a"]').dispatchEvent('dragstart', { dataTransfer });
  await target.dispatchEvent('drop', { dataTransfer, clientY });
  await expect.poll(async () => (await readDoc(page)).revisions.filter(r => r.entityId === 'a').at(-1).payload.time).toBe('13:30');
  expect((await readDoc(page)).revisions.filter(r => r.entityId === 'a').at(-1).payload.scheduledDate).toBe(shiftDate(today(), 1));
});

test('maximization works in widget and planner; closing restores original geometry and state', async ({ page }) => {
  await boot(page, { native: true });
  await page.locator('[data-act="planner"]').click();
  await expect.poll(() => page.viewportSize().width).toBe(1360);
  await page.locator('[data-p="maximize"]').click(); await expect.poll(() => page.viewportSize().width).toBe(1600);
  await page.locator('[data-p="close"]').click(); await expect.poll(() => page.viewportSize()).toEqual({ width: 420, height: 680 });
  await page.locator('[data-act="maximize"]').click(); await expect.poll(() => page.viewportSize().width).toBe(1600);
  await page.locator('[data-act="planner"]').click(); await page.locator('[data-p="maximize"]').click();
  await page.locator('[data-p="close"]').click(); await expect.poll(() => page.evaluate(() => __geometry.max)).toBe(true);
  await page.locator('[data-act="maximize"]').click(); await expect.poll(() => page.viewportSize()).toEqual({ width: 420, height: 680 });
  await page.locator('[data-act="maximize"]').click(); await page.locator('[data-act="collapse"]').click();
  await expect.poll(() => page.viewportSize().width).toBe(188);
  await page.locator('.mini-count').click(); await expect.poll(() => page.evaluate(() => __geometry.max)).toBe(true);
});

test('timeline visual layouts in light/dark and narrow windows remain scrollable', async ({ page }, testInfo) => {
  await boot(page); await page.locator('[data-act="planner"]').click();
  for (const view of ['day', 'three', 'week', 'month']) {
    await page.locator(`[data-view="${view}"]`).click();
    if (view !== 'month') await page.locator('.time-grid-scroll').evaluate(e => { e.scrollTop = 8 * 72; });
    await page.screenshot({ path: testInfo.outputPath(`calendar-${view}-light.png`) });
    expect(await page.locator('.planner-shell').evaluate(e => e.scrollWidth > e.clientWidth + 1)).toBe(false);
  }
  await page.locator('[data-view="week"]').click(); await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.locator('.time-grid-scroll').evaluate(e => { e.scrollTop = 8 * 72; });
  await page.screenshot({ path: testInfo.outputPath('calendar-week-dark.png') });
  await page.setViewportSize({ width: 420, height: 680 });
  expect(await page.locator('.time-grid-scroll').evaluate(e => e.scrollWidth > e.clientWidth)).toBe(true);
  expect(await page.locator('.planner-shell').evaluate(e => e.scrollWidth > e.clientWidth + 1)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('calendar-week-small.png') });
});
