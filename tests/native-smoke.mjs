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
  const identifier = await page.evaluate(() => window.__TAURI__.app.getIdentifier());
  if (process.env.GITHUB_ACTIONS !== 'true' && !identifier.endsWith('.native-smoke')) {
    throw new Error('Local native smoke requires an isolated .native-smoke application identifier to protect existing tasks');
  }
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForSelector('.workspace-sidebar');
  assert.equal(await page.locator('.planner-grid').count(), 1);
  assert.equal(await page.title(), '待办清单');
  assert.equal(await page.locator('.workspace-brand strong').textContent(), '待办清单');
  assert.equal(await page.evaluate(() => window.__TAURI__.window.getCurrentWindow().title()), '待办清单');
  assert.equal(await page.evaluate(() => window.__TAURI__.window.getCurrentWindow().isDecorated()), true);
  await page.evaluate(() => window.__TAURI__.window.getCurrentWindow().minimize());
  await page.waitForFunction(async () => await window.__TAURI__.window.getCurrentWindow().isMinimized(), null, { polling: 100 });
  await page.evaluate(async () => { const win = window.__TAURI__.window.getCurrentWindow(); await win.unminimize(); await win.setFocus(); });
  await page.waitForFunction(async () => !await window.__TAURI__.window.getCurrentWindow().isMinimized(), null, { polling: 100 });
  await page.evaluate(() => window.__TAURI__.window.getCurrentWindow().close());
  await page.waitForFunction(async () => !await window.__TAURI__.window.getCurrentWindow().isVisible(), null, { polling: 100 });
  await page.evaluate(async () => { const win = window.__TAURI__.window.getCurrentWindow(); await win.show(); await win.setFocus(); });
  await page.waitForFunction(async () => await window.__TAURI__.window.getCurrentWindow().isVisible(), null, { polling: 100 });
  await page.getByRole('button', { name: '新建合集', exact: true }).click();
  await page.locator('.collection-editor [name="name"]').fill('原生验证合集');
  await page.getByRole('button', { name: '保存合集', exact: true }).click();
  await page.locator('.workspace-collection[aria-pressed="true"]').filter({ hasText: '原生验证合集' }).waitFor();
  await page.locator('.workspace-collection[aria-pressed="true"]').click({ button: 'right' });
  await page.getByRole('menuitemradio', { name: '蓝色', exact: true }).click();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.workspace-collection[aria-pressed="true"] i')).backgroundColor === 'rgb(0, 122, 255)');
  await page.screenshot({ path: join(output, 'workspace.png'), omitBackground: true });
  await page.getByRole('button', { name: '管理当前合集' }).click();
  await page.getByRole('button', { name: '删除合集', exact: true }).click();
  await page.getByRole('button', { name: '确认删除合集，保留全部任务' }).click();
  await page.locator('.workspace-collection[aria-pressed="true"]').filter({ hasText: '未分类' }).waitFor();
  await page.locator('[data-p="collection"][data-id=""]').click();
  await page.locator('[data-p="close"]').click();
  await page.waitForSelector('[data-act="collapse"]');
  await page.waitForFunction(async () => !await window.__TAURI__.window.getCurrentWindow().isDecorated(), null, { polling: 100 });
  // Decorations finish changing before the async workspace-to-widget resize.
  await page.waitForFunction(() => Math.abs(innerWidth - 420) <= 1 && Math.abs(innerHeight - 680) <= 1, null, { polling: 100 });
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
  await page.evaluate(() => window.__TAURI__.window.getCurrentWindow().toggleMaximize());
  await page.waitForFunction(async () => window.__TAURI__.window.getCurrentWindow().isMaximized());
  await page.evaluate(() => window.__TAURI__.window.getCurrentWindow().toggleMaximize());
  await page.waitForFunction(async () => !await window.__TAURI__.window.getCurrentWindow().isMaximized());
  await page.screenshot({ path: join(output, 'calendar.png'), omitBackground: true });
  await page.locator('[data-view="day"]').click();
  assert.equal(await page.locator('.time-day-canvas').count(), 1);
  await page.locator('.time-grid-scroll').evaluate(e => { e.scrollTop = 12 * 72; });
  const canvas = await page.locator('.time-day-canvas').boundingBox();
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + 14 * 72);
  await page.mouse.down();
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + 15.5 * 72, { steps: 8 });
  assert.equal(await page.locator('.time-selection').textContent(), '14:00 — 15:30');
  await page.screenshot({ path: join(output, 'time-selection.png'), omitBackground: true });
  await page.mouse.up();
  await page.locator('[data-p-form="add"]').waitFor();
  assert.equal(await page.locator('[data-p-form="add"] [name="time"]').inputValue(), '14:00');
  assert.equal(await page.locator('[data-p-form="add"] [name="duration"]').inputValue(), '90');
  await page.locator('[data-p-form="add"] [name="title"]').fill('验证原生日历');
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
  const completedRow = page.locator('[data-planner-task]').filter({ hasText: '验证原生日历' });
  await completedRow.getByRole('button', { name: '删除 验证原生日历', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await completedRow.getByRole('button', { name: '删除 验证原生日历', exact: true }).count(), 1);
  await completedRow.getByRole('button', { name: '删除 验证原生日历', exact: true }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-planner-task]')].some(e => e.textContent.includes('验证原生日历') && e.textContent.includes('已删除')));
  await page.screenshot({ path: join(output, 'deleted-history.png'), omitBackground: true });
  await page.locator('[data-mode="calendar"]').click();
  await page.locator('[data-view="month"]').click();
  await page.locator('[data-p="new"]').click();
  const rangeForm = page.locator('.planner-add');
  await rangeForm.locator('[name="title"]').fill('原生跨天验证');
  const rangeStart = await rangeForm.locator('[name="date"]').inputValue();
  const rangeEnd = new Date(Date.parse(rangeStart) + 5 * 86400000).toISOString().slice(0,10);
  await rangeForm.getByLabel('设置时间段').check();
  await rangeForm.locator('[name="endDate"]').fill(rangeEnd);
  await rangeForm.locator('[type="submit"]').click();
  await page.locator('.calendar-span').filter({hasText:'原生跨天验证'}).first().waitFor();
  assert.ok(await page.locator('.calendar-span').filter({hasText:'原生跨天验证'}).count() >= 1);
  await page.screenshot({path:join(output,'range-month.png')});
  await page.locator('.calendar-span').filter({hasText:'原生跨天验证'}).first().click();
  const rangeEditor = page.locator('.planner-editor');
  assert.equal(await rangeEditor.locator('[name="endDate"]').inputValue(),rangeEnd);
  await rangeEditor.getByLabel('全天',{exact:true}).uncheck();
  await rangeEditor.locator('[type="submit"]').click();
  await page.locator('[data-view="three"]').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.time-block')].filter(e => e.textContent.includes('原生跨天验证')).length === 3);
  await page.screenshot({path:join(output,'range-timeline.png')});
  await page.locator('[data-mode="projects"]').click();
  await page.locator('[data-p="work-project-new"]').click();
  await page.locator('[data-p-form="work-project-create"] [name="name"]').fill('原生项目验证');
  await page.locator('[data-p-form="work-project-create"] [type="submit"]').click();
  await page.locator('.project-plan [name="description"]').fill('尚未拆分任务的想法，先研究方案');
  await page.locator('.project-plan [name="milestones"]').fill('先验证，再规划执行节点');
  await page.locator('.project-plan [name="targetDate"]').fill(rangeEnd);
  await page.locator('.project-plan [type="submit"]').click();
  await page.waitForFunction(()=>document.querySelector('.project-draft-status')?.textContent==='已保存');
  await page.locator('[data-p="project-task-new"]').click();
  assert.equal(await page.locator('.planner-add [name="workProjects"]:checked').count(),1);
  await page.locator('.planner-add [name="title"]').fill('原生项目子任务');
  await page.locator('.planner-add [type="submit"]').click();
  await page.locator('[data-mode="projects"]').click();
  await page.locator('.work-project-card').filter({hasText:'原生项目验证'}).click();
  await page.locator('.work-project-task').filter({hasText:'原生项目子任务'}).waitFor();
  assert.equal(await page.locator('.project-plan [name="description"]').inputValue(),'尚未拆分任务的想法，先研究方案');
  await page.screenshot({path:join(output,'projects.png')});
  await page.getByRole('button', { name: '▧ 悬浮窗模式', exact: true }).click();
  await page.waitForFunction(size => innerWidth === size.width && innerHeight === size.height, original);
  assert.deepEqual(errors, []);
  console.log('PASS: native maximize/restore, mini/capture, day/three-day/week timelines, completion history, cross-day ranges, project planning, and geometry restoration');
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
