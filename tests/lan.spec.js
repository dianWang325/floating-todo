import { test, expect } from '@playwright/test';
import { newDocument } from '../src/sync-model.js';
async function boot(page) {
  await page.addInitScript(({ doc }) => {
    let saved = JSON.stringify(doc), enabled = false, peers = [];
    window.__lanCalls = [];
    window.__TAURI_INTERNALS__ = {};
    window.__TAURI__ = { core: { invoke: async (name, args = {}) => {
      if (name === 'storage_load') return saved;
      if (name === 'storage_save') { saved = args.json; window.__saved = JSON.parse(saved); return args.expectedGeneration + 1; }
      if (name.startsWith('lan_')) window.__lanCalls.push({ ...args, name, deviceName: args.name });
      if (name === 'lan_device_name') return 'Office Mac mini';
      if (name === 'lan_start') enabled = true;
      if (name === 'lan_stop') enabled = false;
      if (name === 'lan_status' || name === 'lan_start') return { enabled, port: 47831, peers, candidates: enabled ? [{ id: 'peer', name: '<script>对方设备</script>', url: 'http://192.168.1.2:47831' }] : [] };
      if (name === 'lan_codes' || name === 'lan_rotate') return { dynamic: '123456', fixed: '12345678', expires: Date.now() + 60000 };
      if (name === 'lan_pair') { if (args.code !== '123456' && args.code !== '12345678') throw new Error('短码或配对认证失败'); peers = [{ id: 'peer', name: '对方设备', url: args.url, lastSuccess: Date.now() }]; }
      if (name === 'lan_revoke') peers = [];
      if (name === 'lan_pull') return [];
    } }, event: { listen: async (name, callback) => { if (name === 'lan-changed') window.__lanWake = callback; return () => {}; } } };
  }, { doc: newDocument() });
  await page.goto('/'); await expect(page.locator('#main-input')).toBeVisible();
  await page.locator('[data-act="settings"]').click(); await page.locator('[data-s="lan"]').click();
}
test('LAN enable, short-code pairing and revocation retain a clear local control flow', async ({ page }) => {
  await boot(page); await page.locator('[data-lan-enabled]').check(); await page.locator('[data-lan-name]').fill('办公室'); await page.locator('[data-lan-save]').click();
  await expect(page.locator('[data-lan-codes]')).toContainText('12345678');
  await page.locator('[data-lan-select]').click(); await page.locator('[data-lan-code]').fill('123456'); await page.locator('[data-lan-pair]').click();
  await expect(page.locator('[data-lan-message]')).toContainText('配对成功');
  expect(await page.evaluate(() => window.__lanCalls.find(c => c.name === 'lan_pair').mode)).toBe('dynamic');
  await expect(page.locator('[data-lan-code]')).toHaveValue(''); await expect(page.locator('[data-lan-peers]')).toContainText('对方设备');
  await page.locator('[data-lan-revoke]').click(); await expect(page.locator('[data-lan-peers]')).toContainText('暂无');
  await page.locator('[data-lan-enabled]').uncheck(); await page.locator('[data-lan-save]').click();
  await expect(page.locator('[data-lan-status]')).toHaveText('已关闭'); expect(await page.evaluate(() => window.__saved.lan.enabled)).toBe(false);
});
test('LAN wrong code is visible and fixed code uses its own pairing mode', async ({ page }) => {
  await boot(page); await page.locator('[data-lan-enabled]').check(); await page.locator('[data-lan-save]').click();
  await page.locator('[data-lan-select]').click(); await page.locator('[data-lan-code]').fill('00000000'); await page.locator('[data-lan-pair]').click();
  await expect(page.locator('[data-lan-message]')).toContainText('认证失败');
  await page.locator('[data-lan-code]').fill('12345678'); await page.locator('[data-lan-pair]').click(); await expect(page.locator('[data-lan-message]')).toContainText('配对成功');
  expect(await page.evaluate(() => window.__lanCalls.filter(c => c.name === 'lan_pair').at(-1).mode)).toBe('fixed');
  await page.screenshot({ path: 'test-results/lan-settings.png' });
});

test('LAN defaults to the computer name and uses it when the name is cleared', async ({ page }) => {
  await boot(page);
  await expect(page.locator('[data-lan-name]')).toHaveValue('Office Mac mini');
  await page.locator('[data-lan-name]').fill('');
  await page.locator('[data-lan-enabled]').check();
  await page.locator('[data-lan-save]').click();
  await expect(page.locator('[data-lan-status]')).toContainText('已开启');
  expect(await page.evaluate(() => window.__saved.lan.name)).toBe('Office Mac mini');
  expect(await page.evaluate(() => window.__lanCalls.find(c => c.name === 'lan_start').deviceName)).toBe('Office Mac mini');
});

test('native change events coalesce into one immediate pull', async ({ page }) => {
  await boot(page); await page.locator('[data-lan-enabled]').check(); await page.locator('[data-lan-save]').click();
  await expect.poll(() => page.evaluate(() => window.__lanCalls.filter(c => c.name === 'lan_pull').length)).toBe(1);
  await page.evaluate(() => { for (let i = 0; i < 20; i++) window.__lanWake(); });
  await expect.poll(() => page.evaluate(() => window.__lanCalls.filter(c => c.name === 'lan_pull').length)).toBe(2);
});
