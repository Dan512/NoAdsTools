import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: '**/tests/browser/**/*.spec.js',
  // Never collect specs from session-local git worktrees or tooling dirs — a
  // stale `.claude/worktrees/*` checkout would otherwise run duplicate, stale
  // copies of every spec against the shared dev server and add phantom reds.
  testIgnore: ['**/.claude/**', '**/node_modules/**', '**/.tmp*/**'],
  fullyParallel: true,
  retries: 0,
  use: { baseURL: 'http://localhost:4173', trace: 'on-first-retry' },
  webServer: {
    command: 'npm run serve',
    url: 'http://localhost:4173/photo-editor/',
    reuseExistingServer: !process.env.CI,
    timeout: 15000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit',   use: { ...devices['Desktop Safari'] } },
    { name: 'firefox',  use: { ...devices['Desktop Firefox'] } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
    { name: 'mobile-safari', use: { ...devices['iPhone 14'] } },
  ],
});
