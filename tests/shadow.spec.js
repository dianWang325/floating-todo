import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const KEY = 'floating-todo/snapshot';
async function boot(page) {
  await page.addInitScript(key => {
    const d = new Date();
    const old = {
      itemsByDay: { today: [{ id: 'a', title: '检查圆角与分类', detail: '', time: null, completed: false, projectId: 'p', tagIds: ['t'] }], tomorrow: [], dayAfterTomorrow: [] },
      recurringItems: [], selectedDay: 'today', lastActiveDate: `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`,
      projects: [{ id: 'p', name: '桌面工具', color: '#397fe5' }], tags: [{ id: 't', name: '重要', color: '#ae65d6' }],
      settings: { appearance: 'light', opacity: .5 },
    };
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(old));
    window.__legacyBackup = old;
    window.__TAURI__ = { core: { invoke: async (cmd, args) => {
      if (cmd === 'export_data') window.__backup = args.json;
      if (cmd === 'import_data') return window.__import;
    } } };
  }, KEY);
  await page.goto('/'); await expect(page.locator('.row')).toBeVisible();
}
async function settings(page) { await page.locator('[data-act="settings"]').click(); }
async function closeSettings(page) { await page.locator('[data-s="close"]').click(); }
const shadow = page => page.locator('.panel').evaluate(el => getComputedStyle(el).boxShadow);

test('shadow defaults on for old data, persists off across reload, export and import', async ({ page }) => {
  await boot(page); await expect(page.locator('html')).toHaveAttribute('data-shadow', 'on');
  expect(await shadow(page)).not.toBe('none');
  await settings(page); const toggle = page.getByRole('switch', { name: '窗口阴影' });
  await expect(toggle).toHaveAttribute('aria-checked', 'true'); await toggle.click();
  expect(await shadow(page)).toBe('none'); await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await closeSettings(page); await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-shadow', 'off');
  await settings(page); await page.locator('[data-s="export"]').click();
  expect(await page.evaluate(() => JSON.parse(window.__backup).settings.shadowEnabled)).toBe(false);
  await page.getByRole('switch', { name: '窗口阴影' }).click();
  await page.evaluate(() => { window.__import = window.__backup; }); await page.locator('[data-s="import"]').click();
  expect(await shadow(page)).toBe('none');
  await settings(page); await page.evaluate(() => { window.__import = JSON.stringify(window.__legacyBackup); });
  await page.locator('[data-s="import"]').click(); await expect(page.locator('html')).toHaveAttribute('data-shadow', 'on');
});

test('rounded surface and overlays fit the transparent gutter in light/dark and compact layouts', async ({ page }) => {
  await boot(page);
  const output = resolve('test-results/shadow-previews'); mkdirSync(output, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await settings(page); await page.locator(`[data-ap="${theme}"]`).click(); await closeSettings(page);
    const panel = await page.locator('.panel').boundingBox();
    expect(panel.x).toBe(12); expect(panel.y).toBe(12); expect(panel.width).toBe(316);
    const surface = await page.locator('.panel').evaluate(el => ({ radius: getComputedStyle(el).borderRadius, clip: getComputedStyle(el, '::before').clipPath, blur: getComputedStyle(el, '::before').backdropFilter }));
    expect(surface.radius).toBe('26px'); expect(surface.clip).toBe('inset(0px round 26px)'); expect(surface.blur).toContain('blur(26px)');
    await page.screenshot({ path: `${output}/${theme}-on.png`, omitBackground: true });
    await settings(page);
    await expect(page.locator('.overlay')).toHaveCSS('border-radius', '26px');
    await expect(page.locator('.overlay')).toHaveCSS('overflow', 'hidden');
    await page.screenshot({ path: `${output}/${theme}-settings.png`, omitBackground: true });
    await page.getByRole('switch', { name: '窗口阴影' }).click(); await closeSettings(page);
    await page.screenshot({ path: `${output}/${theme}-off.png`, omitBackground: true });
    expect(await shadow(page)).toBe('none');
    await settings(page); await page.getByRole('switch', { name: '窗口阴影' }).click(); await closeSettings(page);
  }
  await settings(page); await page.locator('[data-s="categories"]').click();
  await page.setViewportSize({ width: 220, height: 180 });
  const dialog = await page.getByRole('dialog').boundingBox();
  expect(dialog.x).toBeGreaterThanOrEqual(12); expect(dialog.x + dialog.width).toBeLessThanOrEqual(208);
  expect(dialog.y + dialog.height).toBeLessThanOrEqual(168);
  expect(await page.getByRole('dialog').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: `${output}/compact-manager.png`, omitBackground: true });
});
