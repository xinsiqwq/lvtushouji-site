import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

/**
 * Resolve `tests/e2e` and repo root without relying on bare `__dirname` (fails under
 * ESM `"type": "module"`) or bare `import.meta.url` (fails in pre-M1 CJS mode).
 */
function resolveE2eDir(): string {
  const cwd = process.cwd();

  // 1. Explicit -c / --config CLI argument (works from any working directory)
  const argv = process.argv;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if ((arg === '-c' || arg === '--config') && argv[i + 1]) {
      const candidate = path.resolve(cwd, argv[i + 1]!);
      const dir = fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()
        ? candidate
        : path.dirname(candidate);
      if (fs.existsSync(path.join(dir, 'playwright.config.ts'))) {
        return dir;
      }
    } else if (arg.startsWith('--config=')) {
      const value = arg.slice('--config='.length);
      const candidate = path.resolve(cwd, value);
      const dir = fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()
        ? candidate
        : path.dirname(candidate);
      if (fs.existsSync(path.join(dir, 'playwright.config.ts'))) {
        return dir;
      }
    }
  }

  // 2. Walk up from CWD checking `<dir>/playwright.config.ts` and `<dir>/tests/e2e/playwright.config.ts`
  let cursor = cwd;
  for (let depth = 0; depth < 8; depth += 1) {
    if (fs.existsSync(path.join(cursor, 'playwright.config.ts'))) {
      return cursor;
    }
    const nested = path.join(cursor, 'tests', 'e2e');
    if (fs.existsSync(path.join(nested, 'playwright.config.ts'))) {
      return nested;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  return path.resolve(cwd, 'tests', 'e2e');
}

const e2eDir = resolveE2eDir();
const repoRoot = path.resolve(e2eDir, '..', '..');
const artifactsDir = path.join(e2eDir, '.artifacts');
const baseURL = process.env.E2E_BASE_URL || 'http://127.0.0.1:5173';

export default defineConfig({
  tsconfig: path.join(e2eDir, 'tsconfig.json'),
  testDir: path.join(e2eDir, 'specs'),
  outputDir: path.join(artifactsDir, 'results'),
  fullyParallel: true,
  workers: Number(process.env.E2E_WORKERS) || (process.env.CI ? 2 : 4),
  retries: 0,
  timeout: 25_000,
  expect: {
    timeout: 5_000,
  },
  reporter: [
    ['list'],
    ['json', { outputFile: path.join(artifactsDir, 'report.json') }],
    ['html', { outputFolder: path.join(artifactsDir, 'html-report'), open: 'never' }],
  ],
  use: {
    baseURL,
    browserName: 'chromium',
    channel: 'chrome',
    headless: true,
    launchOptions: {
      args: ['--enable-webgl', '--ignore-gpu-blocklist'],
    },
    trace: process.env.E2E_TRACE === '1' ? 'retain-on-failure' : 'off',
    screenshot: 'only-on-failure',
    video: process.env.E2E_VIDEO === '1' ? 'retain-on-failure' : 'off',
  },
  projects: [
    {
      name: 'desktop-light',
      use: {
        viewport: { width: 1440, height: 900 },
        colorScheme: 'light',
      },
    },
    {
      name: 'desktop-dark',
      use: {
        viewport: { width: 1440, height: 900 },
        colorScheme: 'dark',
      },
    },
    {
      name: 'mobile-light',
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
        colorScheme: 'light',
      },
    },
    {
      name: 'mobile-dark',
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
        colorScheme: 'dark',
      },
    },
  ],
  webServer:
    process.env.E2E_START_SERVER === '1'
      ? {
          command: 'npm run dev -- --port 5173 --host 127.0.0.1',
          cwd: repoRoot,
          url: baseURL,
          reuseExistingServer: process.env.E2E_REUSE_SERVER === '1',
          timeout: 120_000,
        }
      : undefined,
});
