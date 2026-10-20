import { defineConfig } from '@playwright/test';
process.env.TZ = 'Asia/Shanghai';
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.js',
  fullyParallel: true,
  workers: 2,
  retries: 0,
  use: { timezoneId: 'Asia/Shanghai', baseURL: 'http://127.0.0.1:4173', viewport: { width: 340, height: 734 }, deviceScaleFactor: 2, channel: process.env.PLAYWRIGHT_CHANNEL || undefined, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'node tests/serve.mjs', url: 'http://127.0.0.1:4173', reuseExistingServer: false },
});
