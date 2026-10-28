import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const executable = process.argv[2];
if (!executable) throw new Error('Usage: npm run test:native -- <path-to-executable>');
const output = resolve('test-results/native');
await mkdir(output, { recursive: true });
const profile = process.env.FLOATING_TODO_SMOKE_PROFILE || await mkdtemp(join(tmpdir(), 'floating-todo-smoke-'));
const child = spawn(resolve(executable), [], {
  windowsHide: true,
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222', WEBVIEW2_USER_DATA_FOLDER: profile },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const logs = [];
child.stdout.on('data', chunk => logs.push(chunk.toString()));
child.stderr.on('data', chunk => logs.push(chunk.toString()));
let startupError;
child.on('error', error => { startupError = error; });
let browser;
let page;
try {
  const deadline = Date.now() + 60_000;
  let connectionError;
  while (!browser && Date.now() < deadline) {
    if (startupError) throw startupError;
    if (child.exitCode !== null) throw new Error(`Application exited with code ${child.exitCode}`);
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 2000 }); }
    catch (error) { connectionError = error; await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  if (!browser) throw new Error('WebView2 debugging endpoint did not become available', { cause: connectionError });
  while (!page && Date.now() < deadline) {
    page = browser.contexts().flatMap(context => context.pages()).find(candidate => /tauri\.localhost|tauri:\/\/localhost/.test(candidate.url()));
    if (!page) await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!page) throw new Error('Tauri application page not found');
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForSelector('[data-act="collapse"]');
  await page.evaluate(async () => {
    const api = window.__TAURI__.window;
    await window.__TAURI__.core.invoke('set_window_screen_position', { x: 80, y: 80 });
    await api.getCurrentWindow().setFocus();
  });
  const original = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await page.locator('[data-act="maximize"]').click();
  await page.waitForFunction(async () => window.__TAURI__.window.getCurrentWindow().isMaximized());
  await page.locator('[data-act="maximize"]').click();
  await page.waitForFunction(async () => !await window.__TAURI__.window.getCurrentWindow().isMaximized());
  const count = Number(await page.locator('[data-act="collapse"]').textContent());
  await page.locator('[data-act="collapse"]').click();
  await page.waitForFunction(() => document.documentElement.dataset.windowMode === 'mini' && innerWidth === 188 && innerHeight === 68);
  await page.screenshot({ path: join(output, 'mini.png'), omitBackground: true });
  await page.locator('.mini-add').click();
  await page.waitForFunction(() => document.documentElement.dataset.windowMode === 'quick' && innerWidth === 340 && innerHeight === 252);
  await page.locator('#quick-input').fill('验证原生悬浮栏');
  await page.screenshot({ path: join(output, 'capture.png'), omitBackground: true });
  await page.locator('#quick-input').press('Enter');
  await page.waitForFunction(() => document.documentElement.dataset.windowMode === 'mini' && innerWidth === 188);
  assert.equal(Number(await page.locator('.mini-count strong').textContent()), count + 1);
  await page.locator('.mini-count').click();
  await page.waitForFunction(size => document.documentElement.dataset.windowMode === 'panel' && innerWidth === size.width && innerHeight === size.height, original);
  assert.equal(await page.locator('.row .title').filter({ hasText: '验证原生悬浮栏' }).count(), 1);
  await page.screenshot({ path: join(output, 'expanded.png'), omitBackground: true });
  await page.locator('[data-act="planner"]').click();
  await page.waitForFunction(() => innerWidth > 460);
  await page.waitForSelector('.planner-grid');
  await page.locator('[data-p="maximize"]').click();
  await page.waitForFunction(async () => window.__TAURI__.window.getCurrentWindow().isMaximized());
  await page.locator('[data-p="maximize"]').click();
  await page.waitForFunction(async () => !await window.__TAURI__.window.getCurrentWindow().isMaximized());
  await page.screenshot({ path: join(output, 'calendar.png'), omitBackground: true });
  await page.locator('[data-view="day"]').click();
  assert.equal(await page.locator('.time-day-canvas').count(), 1);
  await page.locator('[data-p="new"]').click();
  await page.locator('[data-p-form="add"] [name="title"]').fill('验证原生日历');
  await page.locator('[data-p-form="add"] [name="time"]').fill('14:00');
  await page.locator('[data-p-form="add"] [name="duration"]').fill('90');
  await page.locator('[data-p-form="add"] button[type="submit"]').click();
  await page.locator('.time-block').filter({ hasText: '验证原生日历' }).waitFor({ state: 'attached' });
  assert.equal(await page.locator('.time-block').filter({ hasText: '验证原生日历' }).count(), 1);
  await page.locator('.time-block').filter({ hasText: '验证原生日历' }).getByRole('button', { name: '完成 验证原生日历', exact: true }).click();
  await page.locator('.time-block').filter({ hasText: '验证原生日历' }).getByRole('button', { name: '重新打开 验证原生日历', exact: true }).waitFor({ state: 'attached' });
  await page.locator('[data-view="three"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.time-day-canvas').length === 3);
  assert.equal(await page.locator('.time-day-canvas').count(), 3);
  await page.locator('[data-view="week"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.time-day-canvas').length === 7);
  assert.equal(await page.locator('.time-day-canvas').count(), 7);
  await page.screenshot({ path: join(output, 'week.png'), omitBackground: true });
  await page.locator('[data-mode="history"]').click();
  await page.locator('.planner-history strong').filter({ hasText: '验证原生日历' }).waitFor({ state: 'attached' });
  assert.equal(await page.locator('.planner-history strong').filter({ hasText: '验证原生日历' }).count(), 1);
  await page.screenshot({ path: join(output, 'history.png'), omitBackground: true });
  await page.getByRole('button', { name: '关闭日历与回顾', exact: true }).click();
  await page.waitForFunction(size => innerWidth === size.width && innerHeight === size.height, original);
  assert.deepEqual(errors, []);
  console.log('PASS: native maximize/restore, mini/capture, day/three-day/week timelines, completion history, and geometry restoration');
} catch (error) {
  logs.push(error.stack || String(error));
  if (page) {
    await page.screenshot({ path: join(output, 'failure.png'), omitBackground: true }).catch(() => {});
    logs.push(await page.evaluate(() => JSON.stringify({ mode: document.documentElement.dataset.windowMode, width: innerWidth, height: innerHeight, text: document.body.innerText })).catch(() => 'Page unavailable'));
  }
  throw error;
} finally {
  await writeFile(join(output, 'application.log'), logs.join(''), 'utf8');
  await browser?.close().catch(() => {});
  if (child.exitCode === null) child.kill();
}
