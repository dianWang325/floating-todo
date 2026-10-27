import { test, expect } from '@playwright/test';
import { newDocument, writeRevision, mergeRevisions, dateInZone } from '../src/sync-model.js';
const task = (id, title) => ({ id, title, kind: 'one_off', detail: '详情', time: null, scheduledDate: dateInZone(), completed: false, createdAt: 1, projectId: null, tagIds: [] });
async function boot(page, document = newDocument()) {
  await page.addInitScript(({ document }) => {
    if (!localStorage.getItem('test-native-db')) localStorage.setItem('test-native-db', JSON.stringify(document));
    window.__TAURI_INTERNALS__ = {};
    const files = new Map(), dirs = new Set(['']); let password = '';
    window.__TAURI__ = { core: { invoke: async (name, args = {}) => {
      if (name === 'storage_load') return localStorage.getItem('test-native-db');
      if (name === 'storage_save') {
        const current = JSON.parse(localStorage.getItem('test-native-db'));
        if ((current.localGeneration || 0) !== args.expectedGeneration) throw new Error('stale generation');
        const saved = JSON.parse(args.json); saved.localGeneration = args.expectedGeneration + 1;
        localStorage.setItem('test-native-db', JSON.stringify(saved)); return saved.localGeneration;
      }
      if (name === 'sync_set_password') { password = args.password; return; }
      if (name === 'export_data') { window.__backup = args.json; return true; }
      if (name === 'dav_request') {
        if (!password) throw new Error('缺少密码');
        const { method, path, body } = args;
        if (method === 'MKCOL') { const exists = dirs.has(path); dirs.add(path); return { status: exists ? 405 : 201 }; }
        if (method === 'GET') return { status: files.has(path) ? 200 : 404, body: files.get(path) };
        if (method === 'PUT') { if (files.has(path)) return { status: 412 }; files.set(path, body); return { status: 201 }; }
        if (method === 'PROPFIND') return { status: 207, entries: [...dirs, ...files.keys()].filter(p => p !== path && p.startsWith(path) && !p.slice(path.length).replace(/\/$/, '').includes('/')).map(path => ({ path, collection: dirs.has(path) })) };
      }
    } } };
  }, { document });
  await page.goto('/'); await expect(page.locator('#main-input')).toBeVisible();
}
async function syncSettings(page) { await page.locator('[data-act="settings"]').click(); await page.locator('[data-s="sync"]').click(); }

test('native reminder waits for IPC success before persisting its delivery receipt', async ({ page }) => {
  const document = newDocument();
  writeRevision(document, 'task', 'notify', { ...task('notify', '验证原生通知'), time: '00:00' });
  await boot(page, document);
  await page.evaluate(() => {
    const original = window.__TAURI__.core.invoke;
    window.nativeNotificationFails = true; window.nativeNotifications = [];
    window.__TAURI__.notification = { isPermissionGranted: async () => true, sendNotification: () => { throw Error('void wrapper must not be used'); } };
    window.__TAURI__.core.invoke = async (name, args) => {
      if (name === 'plugin:notification|notify') {
        if (window.nativeNotificationFails) throw Error('native notification failed');
        window.nativeNotifications.push(args.options); return;
      }
      return original(name, args);
    };
    window.dispatchEvent(new Event('focus'));
  });
  await expect(page.locator('.classification-notice')).toContainText('native notification failed');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('test-native-db')).local.reminders?.delivered || {})).toEqual({});
  await page.evaluate(() => { window.nativeNotificationFails = false; window.dispatchEvent(new Event('focus')); });
  await expect.poll(() => page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('test-native-db')).local.reminders?.delivered || {}).length)).toBe(1);
  expect(await page.evaluate(() => window.nativeNotifications.length)).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect(await page.evaluate(() => window.nativeNotifications.length)).toBe(1);
});
test('native persistence tracks first edit, WebDAV settings synchronize, secrets stay out of backups', async ({ page }) => {
  await boot(page); await page.locator('#main-input').fill('同步任务'); await page.locator('[data-act="submit"]').click();
  await page.reload(); await expect(page.locator('.row .title')).toHaveText('同步任务');
  await syncSettings(page);
  await page.locator('[data-sync-url]').fill('https://dav.example.test/'); await page.locator('[data-sync-user]').fill('alice'); await page.locator('[data-sync-password]').fill('secret-test-password');
  await page.locator('[data-sync-test]').click(); await expect(page.locator('[data-sync-message]')).toContainText('连接及目录读取成功');
  await page.locator('[data-sync-now]').click(); await expect(page.locator('[data-sync-message]')).toHaveText('同步完成');
  await expect(page.locator('[data-sync-status]')).toContainText('待上传 0');
  await page.screenshot({ path: 'test-results/sync-settings.png' });
  await page.locator('[data-sync-close]').click(); await page.locator('[data-act="settings"]').click(); await page.locator('[data-s="export"]').click();
  const saved = await page.evaluate(() => [window.__backup, localStorage.getItem('test-native-db')]);
  expect(saved.every(text => !text.includes('secret-test-password'))).toBe(true);
  expect(JSON.parse(saved[0]).schemaVersion).toBe(3);
});
test('conflict screen restores another version and the resolution survives reload', async ({ page }) => {
  const doc = newDocument(); writeRevision(doc, 'task', 'task', task('task', '原始标题'), { now: 1 });
  const peer = structuredClone(doc); peer.deviceId = crypto.randomUUID();
  writeRevision(doc, 'task', 'task', task('task', '本地标题'), { now: 2 }); writeRevision(peer, 'task', 'task', task('task', '远端标题'), { now: 3 }); mergeRevisions(doc, peer.revisions);
  await boot(page, doc); await expect(page.locator('.row .title')).toHaveText('远端标题');
  await syncSettings(page); await page.locator('[data-sync-conflicts]').click();
  await expect(page.locator('.sync-version')).toHaveCount(2); await page.screenshot({ path: 'test-results/sync-conflicts.png' });
  await page.getByRole('button', { name: '替换为此版本' }).click(); await expect(page.locator('[data-sync-body]')).toContainText('暂无待处理冲突');
  await page.locator('[data-sync-close]').click(); await expect(page.locator('.row .title')).toHaveText('本地标题');
  await page.reload(); await expect(page.locator('.row .title')).toHaveText('本地标题');
});
test('conflict editing validates and saves a new version', async ({ page }) => {
  const doc = newDocument(), peer = newDocument();
  writeRevision(doc, 'memo', 'main', { text: '本地备忘录' }, { now: 1 }); writeRevision(peer, 'memo', 'main', { text: '另一份正文' }, { now: 2 }); mergeRevisions(doc, peer.revisions);
  await boot(page, doc); await syncSettings(page); await page.locator('[data-sync-conflicts]').click();
  await page.getByRole('button', { name: '编辑后保存' }).first().click(); await page.locator('[data-field="text"]').fill('合并后的正文'); await page.locator('[data-save-version]').click();
  await expect(page.locator('[data-sync-body]')).toContainText('暂无待处理冲突');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('test-native-db')));
  expect(saved.revisions.at(-1).payload.text).toBe('合并后的正文'); expect(saved.revisions.at(-1).parentRevisionIds).toHaveLength(2);
});
test('automatic synchronization proceeds while the new-task input retains focus', async ({ page }) => {
  await boot(page); await syncSettings(page);
  await page.locator('[data-sync-url]').fill('https://dav.example.test/'); await page.locator('[data-sync-user]').fill('alice'); await page.locator('[data-sync-password]').fill('test-password');
  await page.locator('[data-sync-enabled]').check(); await page.locator('[data-sync-save]').click(); await expect(page.locator('[data-sync-message]')).toHaveText('设置已保存');
  await page.locator('[data-sync-close]').click(); await page.locator('#main-input').fill('自动同步'); await page.locator('#main-input').press('Enter');
  await expect(page.locator('#main-input')).toBeFocused();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('test-native-db')).sync.lastSuccess), { timeout: 10000 }).toBeTruthy();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('test-native-db'))); expect(saved.outbox).toHaveLength(0);
});
