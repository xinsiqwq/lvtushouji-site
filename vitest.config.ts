import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: {
              bindings: {
                SESSION_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
                SETUP_TOKEN: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
                TIANDITU_KEY: '',
              },
            },
          }),
        ],
        test: {
          name: 'workers',
          include: ['tests/unit/**/*.test.ts'],
          exclude: ['tests/unit/fonts.test.ts'],
        },
      },
      {
        test: {
          name: 'assets',
          environment: 'node',
          include: ['tests/unit/fonts.test.ts'],
        },
      },
    ],
  },
});
