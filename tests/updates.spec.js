import { test, expect } from '@playwright/test';

async function boot(page, fail = false) {
  await page.addInitScript(({ fail }) => {
    window.updateCalls = 0;
    window.updateFail = fail;
    window.openedUrls = [];
    window.__TAURI__ = {
      core: { invoke: async name => {
        if (name === 'installed_version') return '0.4.0-rc.5';
        if (name !== 'check_for_updates') return;
        window.updateCalls++;
        if (window.updateFail) throw new Error('无法连接 GitHub，请检查网络后重试');
        return { currentVersion: '0.4.0-rc.5', version: '0.4.0-rc.10', url: 'https://github.com/dianWang325/floating-todo/releases/tag/v0.4.0-rc.10' };
      } },
      opener: { openUrl: async url => window.openedUrls.push(url) },
    };
  }, { fail });
  await page.goto('/');
  await expect(page.locator('#main-input')).toBeVisible();
}

test('automatically discovers releases, persists indicator across renders and opens release', async ({ page }) => {
  await boot(page);
  await expect(page.locator('body')).toHaveClass(/update-available/, { timeout: 10000 });
  await page.locator('[data-act="settings"]').click();
  await expect(page.locator('[data-update-status]')).toContainText('0.4.0-rc.10');
  await expect(page.locator('[data-installed-version]')).toHaveText('0.4.0-rc.5');
  await page.locator('[data-update-open]').click();
  expect(await page.evaluate(() => window.openedUrls)).toEqual(['https://github.com/dianWang325/floating-todo/releases/tag/v0.4.0-rc.10']);
  await page.locator('[data-s="close"]').click();
  await expect(page.locator('body')).toHaveClass(/update-available/);
});

test('failed checks are retryable without losing todo input', async ({ page }) => {
  await boot(page, true);
  await page.locator('#main-input').fill('未提交的草稿');
  await page.locator('[data-act="settings"]').click();
  await expect(page.locator('[data-installed-version]')).toHaveText('0.4.0-rc.5');
  await page.locator('[data-update-check]').click();
  await expect(page.locator('[data-update-status]')).toContainText('检查失败');
  await expect(page.locator('[data-installed-version]')).toHaveText('0.4.0-rc.5');
  await page.evaluate(() => { window.updateFail = false; });
  await page.locator('[data-update-check]').click();
  await expect(page.locator('[data-update-status]')).toContainText('发现新版本');
  await page.locator('[data-s="close"]').click();
  await expect(page.locator('#main-input')).toHaveValue('未提交的草稿');
});

test('checker coalesces requests and repeats after six hours', async ({ page }) => {
  await page.goto('/');
  await page.clock.install();
  await page.evaluate(async () => {
    const { createUpdateChecker } = await import('/update-ui.js');
    window.checks = 0;
    window.checker = createUpdateChecker({
      invoke: () => { window.checks++; return new Promise(resolve => { window.finishUpdate = resolve; }); },
      openExternal: () => {}, notice: () => {},
    });
    window.checker.start();
  });
  await page.clock.fastForward(5000);
  await page.evaluate(() => { window.checker.check(); window.checker.check(); });
  expect(await page.evaluate(() => window.checks)).toBe(1);
  await page.evaluate(async () => {
    window.finishUpdate({ currentVersion: '0.4.0', version: null });
    await window.checker.check();
  });
  await page.clock.fastForward(6 * 60 * 60 * 1000);
  expect(await page.evaluate(() => window.checks)).toBe(2);
  await page.evaluate(() => window.checker.stop());
});
