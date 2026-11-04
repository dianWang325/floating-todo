import { test, expect } from '@playwright/test';
import { newDocument, writeRevision, dateInZone, shiftDate } from '../src/sync-model.js';

const today = () => dateInZone();
async function boot(page) {
  const doc = newDocument(), now = Date.now(); doc.local.settings = { appearance: 'light' };
  for (const [id, title, time, kind, completed] of [['pending', '待删除任务', '10:00', 'one_off', false], ['done', '已完成任务', '12:00', 'one_off', true], ['daily', '重复练习', '11:00', 'daily', false], ['all', '全天待办', null, 'one_off', false], ['other', '保留任务', '14:00', 'one_off', false]]) {
    writeRevision(doc, 'task', id, { id, title, time, kind, completed, scheduledDate: kind === 'daily' ? null : today(), durationMinutes: 30, detail: '任务描述', tagIds: [], projectId: null, createdAt: now - 86400000, ...(completed ? { completedAt: now, completedDate: today() } : {}) });
  }
  writeRevision(doc, 'completion', `daily/${today()}`, { taskId: 'daily', date: today(), completed: true, completedAt: now });
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.addInitScript(doc => {
    if (!localStorage.getItem('floating-todo/v3-preview')) localStorage.setItem('floating-todo/v3-preview', JSON.stringify(doc));
    window.__TAURI__ = { core: { invoke: async () => {} } };
  }, doc);
  await page.goto('/'); await expect(page.locator('.workspace-sidebar')).toBeVisible();
}
const revisions = page => page.evaluate(() => JSON.parse(localStorage.getItem('floating-todo/v3-preview')).revisions);
const row = (page, id) => page.locator(`[data-planner-task="${id}"]`);

test('editor deletion requires confirmation, preserves drafts on cancellation, and survives reload and widget switch', async ({ page }) => {
  await boot(page); const before = await revisions(page);
  await row(page, 'pending').getByRole('button', { name: '编辑 待删除任务', exact: true }).click();
  await page.locator('.planner-editor [name="title"]').fill('尚未保存的编辑');
  await page.locator('.planner-editor').getByRole('button', { name: '删除待办', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: '删除待办' });
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(dialog.getByRole('button', { name: '确认删除' })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.planner-editor [name="title"]')).toHaveValue('尚未保存的编辑');
  expect(await revisions(page)).toEqual(before);
  await page.locator('.planner-editor').getByRole('button', { name: '删除待办', exact: true }).click();
  await dialog.getByRole('button', { name: '确认删除' }).click();
  await expect(row(page, 'pending')).toHaveCount(0);
  const after = await revisions(page);
  expect(after.at(-1)).toMatchObject({ entityType: 'task', entityId: 'pending', deleted: true, payload: { title: '待删除任务' } });
  for (const revision of before) expect(after).toContainEqual(revision);
  await page.reload(); await expect(row(page, 'pending')).toHaveCount(0);
  await expect(row(page, 'other')).toBeVisible();
  await page.locator('[data-p="close"]').click();
  await expect(page.locator('.row .title').filter({ hasText: '待删除任务' })).toHaveCount(0);
  await expect(page.locator('.row .title').filter({ hasText: '保留任务' })).toBeVisible();
});

test('time blocks, month previews and all-day tasks expose a delete context menu', async ({ page }) => {
  await boot(page); await page.locator('[data-view="day"]').click();
  await page.locator('.time-grid-scroll').evaluate(e => { e.scrollTop = 8 * 72; });
  const block = page.locator('[data-task-id="pending"] .time-block-open');
  await block.focus(); await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menu', { name: '待办操作' })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(block).toBeFocused();
  await block.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除待办', exact: true }).click();
  await page.getByRole('button', { name: '确认删除' }).click();
  await expect(page.locator('[data-task-id="pending"]')).toHaveCount(0);
  await page.locator('.allday-task').filter({ hasText: '全天待办' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除待办', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click();
  await page.locator('[data-view="month"]').click();
  await page.locator('.month-event').filter({ hasText: '全天待办' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除待办', exact: true }).click();
  await page.getByRole('button', { name: '确认删除' }).click();
  await expect(page.locator('.month-event').filter({ hasText: '全天待办' })).toHaveCount(0);
  await expect(row(page, 'other')).toBeVisible();
});

test('deleting completed and repeating tasks retains their history and stops future recurrence', async ({ page }) => {
  await boot(page); await row(page, 'daily').getByRole('button', { name: '删除 重复练习', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toContainText('停止所有日期的重复安排');
  await page.getByRole('button', { name: '确认删除' }).click();
  await page.locator('[data-mode="history"]').click();
  await expect(row(page, 'daily')).toContainText('已删除');
  await row(page, 'done').getByRole('button', { name: '删除 已完成任务', exact: true }).click();
  await page.getByRole('button', { name: '确认删除' }).click();
  await expect(row(page, 'done')).toContainText('已删除');
  await expect(row(page, 'done').getByRole('button')).toBeDisabled();
  await page.locator('[data-mode="calendar"]').click();
  await page.getByRole('button', { name: `跳转到 ${shiftDate(today(), 1)}`, exact: true }).click();
  await expect(row(page, 'daily')).toHaveCount(0);
});

test('failed deletion keeps the task and confirmation open and can be retried', async ({ page }) => {
  await boot(page); const before = await revisions(page);
  await row(page, 'pending').getByRole('button', { name: '删除 待删除任务', exact: true }).click();
  await page.evaluate(() => { window.__setItem = Storage.prototype.setItem; Storage.prototype.setItem = () => { throw new Error('disk full'); }; });
  await page.getByRole('button', { name: '确认删除' }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await expect(page.locator('.classification-notice')).toContainText('disk full');
  expect(await revisions(page)).toEqual(before);
  await page.evaluate(() => { Storage.prototype.setItem = window.__setItem; });
  await page.getByRole('button', { name: '确认删除' }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(row(page, 'pending')).toHaveCount(0);
  await expect(row(page, 'other')).toBeVisible();
});
