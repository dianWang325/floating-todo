import { test, expect } from '@playwright/test';

async function boot(page) {
  await page.addInitScript(() => {
    window.__notifications = [];
    window.__permission = true;
    window.__TAURI__ = { core: { invoke: async () => {} }, notification: {
      isPermissionGranted: async () => window.__permission,
      requestPermission: async () => window.__permission ? 'granted' : 'denied',
      sendNotification: async n => window.__notifications.push(n),
    } };
  });
  await page.addInitScript(() => {
    if (!localStorage.getItem('floating-todo/v3-preview') && !localStorage.getItem('floating-todo/snapshot')) localStorage.setItem('floating-todo/snapshot', JSON.stringify({ itemsByDay: {}, settings: { startupView: 'widget' } }));
    for (const key of ['floating-todo/v3-preview', 'floating-todo/snapshot']) {
      const raw = localStorage.getItem(key); if (!raw) continue;
      const doc = JSON.parse(raw), local = key.endsWith('v3-preview') ? (doc.local ||= {}) : doc;
      (local.settings ||= {}).startupView = 'widget'; localStorage.setItem(key, JSON.stringify(doc));
    }
  });
  await page.goto('/'); await expect(page.locator('#main-input')).toBeVisible();
}

test('calendar creates far-future tasks, edits dates, completes, archives and searches history', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await boot(page); await page.setViewportSize({ width: 940, height: 790 });
  await page.locator('[data-act="planner"]').click();
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: '下个月', exact: true }).click();
  const day = page.locator('.planner-day:not(.outside)').filter({ hasText: /^15/ });
  await day.click();
  const plannedDate = await day.getAttribute('data-date');
  await page.locator('[data-p-form="add"] [name="title"]').fill('下季度设计方案');
  await page.locator('[data-p-form="add"] [name="time"]').fill('15:00');
  await page.locator('[data-p-form="add"] [name="lead"]').selectOption('15');
  await page.locator('[data-p-form="add"] button[type="submit"]').click();
  await expect(page.locator('.planner-task strong')).toHaveText('下季度设计方案');
  await page.getByRole('button', { name: '编辑 下季度设计方案', exact: true }).click();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  await page.locator('[data-p-form="edit"] [name="date"]').fill(today);
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.getByRole('button', { name: '今天', exact: true }).click();
  await page.getByRole('button', { name: '完成 下季度设计方案', exact: true }).click();
  await page.getByRole('button', { name: '▧ 悬浮窗模式', exact: true }).click();
  await page.locator('[data-act="clear"]').click();
  await expect(page.locator('.row')).toHaveCount(0);
  await page.locator('[data-act="planner"]').click(); await page.locator('[data-mode="history"]').click();
  await expect(page.locator('.planner-history strong')).toHaveText('下季度设计方案');
  await expect(page.locator('.planner-history')).toContainText('已归档');
  await page.locator('[data-p-form="filter"] [name="query"]').fill('不存在');
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await expect(page.locator('.planner-empty')).toContainText('暂无完成');
  await page.locator('[data-p-form="filter"] [name="query"]').fill('方案'); await page.getByRole('button', { name: '查询', exact: true }).click();
  await page.getByRole('button', { name: '重新打开 下季度设计方案', exact: true }).click();
  await expect(page.locator('.planner-empty')).toContainText('暂无完成');
  await page.locator('[data-p="close"]').click(); await page.reload();
  await expect(page.locator('.row .title')).toContainText('下季度设计方案');
  expect(plannedDate).not.toBe(today); expect(errors).toEqual([]);
});

test('compact calendar remains scrollable, keyboard closes and reminder center sends test notification', async ({ page }) => {
  await boot(page); await page.locator('[data-act="planner"]').click();
  const box = await page.locator('.planner-shell').boundingBox(); expect(box.width).toBeLessThanOrEqual(340);
  await expect(page.locator('.planner-grid')).toBeVisible();
  await page.locator('[data-mode="reminders"]').click();
  await page.getByRole('button', { name: '发送测试通知', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__notifications.length)).toBe(1);
  await page.locator('[data-p="reminders-enabled"]').uncheck();
  await page.locator('[data-p="close"]').click(); await expect(page.locator('#main-input')).toBeFocused();
  await page.locator('[data-act="reminder-center"]').click();
  await expect(page.locator('[data-p="reminders-enabled"]')).not.toBeChecked();
});

test('calendar visual layouts fit light, dark and small windows', async ({ page }, testInfo) => {
  await boot(page);
  for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: 940, height: 790 });
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.locator('[data-act="planner"]').click();
    await page.locator('[data-p-form="add"] [name="title"]').fill('整理项目计划');
    await page.locator('[data-p-form="add"] button[type="submit"]').click();
    await page.screenshot({ path: testInfo.outputPath(`calendar-${theme}.png`) });
    const overflow = await page.locator('.planner-content').evaluate(e => e.scrollWidth > e.clientWidth + 1);
    expect(overflow).toBe(false);
    await page.locator('[data-p="close"]').click();
  }
  await page.setViewportSize({ width: 340, height: 560 });
  await page.locator('[data-act="planner"]').click();
  expect(await page.locator('.planner-content').evaluate(e => e.scrollWidth > e.clientWidth + 1)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('calendar-small.png') });
});
