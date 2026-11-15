import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  use: {
    locale: 'pl-PL',
    baseURL: process.env.TEST_WEB_URL ?? 'http://127.0.0.1:3000',
    storageState: { cookies: [], origins: [{ origin: process.env.TEST_WEB_URL ?? 'http://127.0.0.1:3000', localStorage: [{ name: 'first-launch-seen', value: '1' }, { name: 'direction-map', value: 'off' }] }] },
    permissions: ['geolocation'],
    viewport: { width: 390, height: 844 },
    trace: 'retain-on-failure'
  }
});
