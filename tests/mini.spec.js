import { test, expect } from '@playwright/test';

const KEY = 'floating-todo/snapshot';

async function boot(page, { width = 340, height = 560, scale = 1, selectedDay = 'today', taskCount = 2 } = {}) {
  await page.setViewportSize({ width, height });
  await page.exposeFunction('__setNativeViewport', async (size) => { await page.setViewportSize(size); });
  await page.addInitScript(({ key, width, height, scale, selectedDay, taskCount }) => {
    const date = new Date();
    const task = (id, title) => ({ id, title, detail: '', time: null, completed: false, notified: false, createdAt: 1 });
    localStorage.setItem(key, JSON.stringify({ selectedDay,
      itemsByDay: { today: Array.from({ length: taskCount }, (_, i) => task(`task-${i}`, `待办 ${i + 1}`)), tomorrow: [task('c', '准备评审')], dayAfterTomorrow: [] },
      recurringItems: [task('habit', '喝水')], settings: { appearance: 'light', opacity: .78 },
      lastActiveDate: `${date.getFullYear()}-${date.getMonth()+1}-${date.getDate()}`,
    }));
    const native = window.__native = {
      x: 1000, y: 80, width: width * scale, height: height * scale, scale, min: { width: 220, height: 180 },
      resizable: true, calls: [], listeners: {}, failNextSize: false,
    };
    class PhysicalSize { constructor(width, height) { this.width = width; this.height = height; } }
    class PhysicalPosition { constructor(x, y) { this.x = x; this.y = y; } }
    class LogicalSize extends PhysicalSize {}
    const win = {
      outerPosition: async () => ({ x: native.x, y: native.y }),
      innerSize: async () => ({ width: native.width, height: native.height }),
      scaleFactor: async () => scale,
      setSize: async size => {
        native.calls.push(['size', size.width, size.height]);
        if (native.failNextSize) { native.failNextSize = false; throw new Error('resize failed'); }
        native.width = size.width; native.height = size.height;
        await window.__setNativeViewport({ width: Math.round(size.width / scale), height: Math.round(size.height / scale) });
      },
      setPosition: async p => { native.x = p.x; native.y = p.y; native.calls.push(['position', p.x, p.y]); },
      setMinSize: async size => { native.min = size; },
      setResizable: async value => { native.resizable = value; },
      setIgnoreCursorEvents: async () => {}, setAlwaysOnTop: async () => {},
      startDragging: async () => { native.calls.push(['drag']); },
      startResizeDragging: async direction => { native.calls.push(['resize', direction]); },
    };
    window.__TAURI__ = {
      core: { invoke: async (command, args) => {
        if (command === 'set_window_screen_position') {
          native.x = args.x; native.y = args.y; native.calls.push(['screenPosition', args.x, args.y]);
        }
      } },
      event: { listen: (name, cb) => { native.listeners[name] = cb; return Promise.resolve(() => {}); } },
      window: { getCurrentWindow: () => win, PhysicalSize, PhysicalPosition, LogicalSize,
        currentMonitor: async () => ({ workArea: { position: { x: -2000, y: 0 }, size: { width: 6000, height: 3000 } } }),
        cursorPosition: async () => {
          if (native.pauseCursor) {
            native.pauseCursor = false;
            await new Promise(resolve => { native.resumeCursor = resolve; });
          }
          return native.cursor;
        },
      },
    };
  }, { key: KEY, width, height, scale, selectedDay, taskCount });
  await page.addInitScript(() => {
    if (!localStorage.getItem('floating-todo/v3-preview') && !localStorage.getItem('floating-todo/snapshot')) localStorage.setItem('floating-todo/snapshot', JSON.stringify({ itemsByDay: {}, settings: { startupView: 'widget' } }));
    for (const key of ['floating-todo/v3-preview', 'floating-todo/snapshot']) {
      const raw = localStorage.getItem(key); if (!raw) continue;
      const doc = JSON.parse(raw), local = key.endsWith('v3-preview') ? (doc.local ||= {}) : doc;
      (local.settings ||= {}).startupView = 'widget'; localStorage.setItem(key, JSON.stringify(doc));
    }
  });
  await page.goto('/');
  await expect(page.locator('[data-act="collapse"]')).toBeVisible();
}
const mode = (page, value) => expect(page.locator('html')).toHaveAttribute('data-window-mode', value);
const snapshot = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), KEY);
async function collapse(page) { await page.locator('[data-act="collapse"]').click(); await mode(page, 'mini'); await expect.poll(() => page.viewportSize().width).toBe(188); }

test('native bar dimensions, right anchor and full geometry round-trip retain day and draft', async ({ page }) => {
  await boot(page, { width: 400, height: 650, scale: 1.5, selectedDay: 'tomorrow' });
  await page.locator('#main-input').fill('尚未提交的草稿');
  const before = await page.evaluate(() => ({ x: __native.x, y: __native.y }));
  await collapse(page);
  await expect(page.locator('.mini-count')).toContainText('明天');
  await expect(page.locator('.mini-count strong')).toHaveText('1');
  expect(await page.evaluate(() => __native.resizable)).toBe(false);
  expect(await page.evaluate(() => __native.x + __native.width)).toBe(before.x + 600);
  expect(await page.evaluate(() => __native.calls.some(call => call[0] === 'screenPosition'))).toBe(true);
  expect(await page.evaluate(() => __native.calls.some(call => call[0] === 'position'))).toBe(false);
  await page.locator('.mini-count').click();
  await expect(page.locator('#main-input')).toHaveValue('尚未提交的草稿');
  await expect.poll(() => page.viewportSize()).toEqual({ width: 400, height: 650 });
  expect(await page.evaluate(() => [__native.x, __native.y, __native.min.width, __native.min.height, __native.resizable])).toEqual([before.x, before.y, 220, 180, true]);
  await expect(page.locator('.day-seg.sel')).toContainText('明天');
});

test('expansion restores long-list scroll and the active project filter', async ({ page }) => {
  await boot(page, { taskCount: 30 });
  await page.locator('[data-class-ui="filter-projects"]').click();
  await page.locator('[data-filter-project="none"]').click();
  await page.locator('.list').evaluate(el => { el.scrollTop = 600; });
  const scroll = await page.locator('.list').evaluate(el => el.scrollTop);
  await collapse(page);
  await page.locator('.mini-count').click();
  await expect.poll(() => page.viewportSize()).toEqual({ width: 340, height: 560 });
  await expect(page.locator('[data-class-ui="filter-projects"]')).toContainText('无项目');
  await expect.poll(() => page.locator('.list').evaluate(el => el.scrollTop)).toBe(scroll);
});

test('clicking outside the quick editor preserves the draft and queued state changes settle', async ({ page }) => {
  await boot(page); await collapse(page); await page.locator('.mini-add').click();
  await expect(page.locator('#quick-input')).toBeFocused();
  await page.locator('#quick-input').fill('稍后继续');
  await page.mouse.click(16, 30);
  await mode(page, 'mini');
  await page.locator('.mini-add').click();
  await expect(page.locator('#quick-input')).toHaveValue('稍后继续');
  await page.evaluate(() => {
    document.querySelector('[data-act="quick-close"]').click();
    document.querySelector('.mini-count').click();
  });
  await mode(page, 'panel');
  await expect.poll(() => page.viewportSize()).toEqual({ width: 340, height: 560 });
  await expect(page.locator('#main-input')).toBeVisible();
});

test('quick capture supports natural dates, reminders and categories and returns to the bar', async ({ page }) => {
  await boot(page); await collapse(page);
  await page.locator('.mini-add').click();
  await expect(page.locator('#quick-input')).toBeFocused();
  await page.locator('#quick-input').fill('明天 15:30 提交方案 +工作 #重要 ');
  await page.locator('#quick-input').press('Enter');
  await mode(page, 'mini');
  const saved = await snapshot(page);
  expect(saved.itemsByDay.tomorrow[0]).toMatchObject({ title: '提交方案', time: '15:30', projectId: saved.projects[0].id, tagIds: [saved.tags[0].id] });
  await expect(page.locator('.mini-count strong')).toHaveText('2');
  await page.locator('.mini-add').click();
  await page.locator('#quick-input').fill('新待办');
  await page.locator('[data-act="quick-submit"]').click();
  await expect(page.locator('.mini-count strong')).toHaveText('3');
  await expect(page.locator('html')).not.toHaveClass(/compact/);
});

test('quick capture retains draft, validates empty parsed titles and protects IME input', async ({ page }) => {
  await boot(page); await collapse(page); await page.locator('.mini-add').click();
  await expect(page.locator('[data-act="quick-submit"]')).toBeDisabled();
  await page.locator('#quick-input').fill('保留的草稿');
  await page.locator('#quick-input').press('Escape'); await mode(page, 'mini');
  await page.locator('.mini-add').click(); await expect(page.locator('#quick-input')).toHaveValue('保留的草稿');
  await page.locator('#quick-input').fill('明天 15:00 +工作 #重要 #评审');
  await page.locator('[data-act="quick-submit"]').click();
  await expect(page.locator('.quick-error')).toHaveText('请填写任务标题');
  const submit = await page.locator('[data-act="quick-submit"]').boundingBox();
  expect(submit.y + submit.height).toBeLessThanOrEqual(240);
  await page.locator('#quick-input').fill('中文输入中');
  await page.locator('#quick-input').dispatchEvent('compositionstart');
  await page.locator('#quick-input').dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  await mode(page, 'quick');
  expect((await snapshot(page)).itemsByDay.today).toHaveLength(2);
  await page.locator('#quick-input').dispatchEvent('compositionend');
  await page.locator('#quick-input').press('Enter'); await mode(page, 'mini');
});

test('global shortcut opens quick capture from the bar, and empty days remain expandable', async ({ page }) => {
  await boot(page, { selectedDay: 'dayAfterTomorrow' }); await collapse(page);
  await expect(page.locator('.mini-count strong')).toHaveText('0');
  await page.evaluate(() => __native.listeners['quick-capture']());
  await expect(page.locator('#quick-input')).toBeFocused();
  await page.locator('[data-act="quick-close"]').click();
  await page.locator('.mini-count').click();
  await expect(page.locator('#main-input')).toBeVisible();
});

test('failed native size change restores the panel and permits a later retry', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { __native.failNextSize = true; });
  await page.locator('[data-act="collapse"]').click();
  await expect(page.locator('.classification-notice')).toContainText('窗口切换失败');
  await mode(page, 'panel');
  await expect(page.locator('#main-input')).toBeVisible();
  await collapse(page);
});

test('captured southwest resize keeps compact after a single crossing and collapses in the upper-right quadrant', async ({ page }) => {
  await boot(page);
  await page.mouse.move(4, 556); await page.mouse.down();
  const sample = async (x, y) => {
    await page.evaluate(({ x, y }) => { __native.cursor = { x, y }; }, { x, y });
    await page.locator('.resize.sw').dispatchEvent('pointermove', { pointerId: 1, buttons: 1 });
  };
  await sample(1124, 256);
  await expect.poll(() => page.viewportSize()).toEqual({ width: 220, height: 180 });
  await expect(page.locator('html')).toHaveClass(/compact/);
  // center=(1230,170): right only, then above only, then both.
  await sample(1240, 230); await expect.poll(() => page.evaluate(() => __native.x)).toBe(1120);
  await mode(page, 'panel');
  await sample(1140, 160); await mode(page, 'panel');
  await sample(1240, 160); await mode(page, 'mini');
  await page.mouse.up();
  await expect.poll(() => page.viewportSize()).toEqual({ width: 188, height: 68 });
  await page.locator('.mini-count').click();
  await expect.poll(() => page.viewportSize()).toEqual({ width: 340, height: 560 });
});

for (const cancel of [true, false]) {
  test(`pending native drag sample ${cancel ? 'is cancelled by blur' : 'finishes after pointer release'}`, async ({ page }) => {
    await boot(page);
    await page.mouse.move(4, 556); await page.mouse.down();
    await page.evaluate(() => { __native.pauseCursor = true; __native.cursor = { x: 1240, y: 160 }; });
    await page.locator('.resize.sw').dispatchEvent('pointermove', { pointerId: 1, buttons: 1 });
    await expect.poll(() => page.evaluate(() => typeof __native.resumeCursor)).toBe('function');
    if (cancel) await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.mouse.up();
    await page.evaluate(() => __native.resumeCursor());
    await mode(page, cancel ? 'panel' : 'mini');
    await expect.poll(() => page.viewportSize()).toEqual(cancel ? { width: 340, height: 560 } : { width: 188, height: 68 });
  });
}

test('mini and quick layouts fit the window in both themes', async ({ page }, testInfo) => {
  await boot(page); await collapse(page);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.screenshot({ path: testInfo.outputPath(`mini-${theme}.png`), omitBackground: true });
    const bar = await page.locator('.mini-bar').boundingBox();
    expect(bar.width).toBe(164); expect(bar.height).toBe(44); expect(bar.x).toBe(12);
    await page.locator('.mini-add').click();
    await expect.poll(() => page.viewportSize()).toEqual({ width: 340, height: 252 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const editor = await page.locator('.quick-capture').boundingBox();
    expect(editor.y + editor.height).toBeLessThanOrEqual(240);
    await page.screenshot({ path: testInfo.outputPath(`quick-${theme}.png`), omitBackground: true });
    await page.locator('[data-act="quick-close"]').click(); await mode(page, 'mini');
  }
});
