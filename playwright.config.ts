import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    launchOptions: { executablePath: '/opt/pw-browsers/chromium' },
    ...devices['Desktop Chrome'],
  },
  webServer: {
    // Demo mode is enabled EXPLICITLY for the e2e suite — it is the
    // sanctioned development/test fallback, never an implicit default.
    command: 'npm run dev -- --port 5173',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 30_000,
    env: { VITE_DEMO_MODE: 'true' },
  },
});
