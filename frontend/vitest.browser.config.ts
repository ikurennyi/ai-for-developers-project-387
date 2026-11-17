import { defineConfig, mergeConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'
import viteConfig from './vite.config.ts'

const evidenceDir =
  process.env.SMOKE_EVIDENCE_ENABLED === '1' && process.env.SMOKE_BROWSER_EVIDENCE_DIR
    ? `${process.env.SMOKE_BROWSER_EVIDENCE_DIR}/${process.env.SMOKE_EVIDENCE_LABEL}`
    : undefined

export default mergeConfig(
  viteConfig,
  defineConfig({
    cacheDir: process.env.SMOKE_RUNTIME_DIR
      ? `${process.env.SMOKE_RUNTIME_DIR}/vite-cache`
      : undefined,
    test: {
      reporters: evidenceDir ? ['default', 'json'] : ['default'],
      outputFile: evidenceDir ? `${evidenceDir}/results.json` : undefined,
      provide: {
        emptyMeetingTypes: process.env.SMOKE_EMPTY_MEETING_TYPES === '1',
        occupiedCalendar: process.env.SMOKE_OCCUPIED_CALENDAR === '1',
      },
      attachmentsDir: evidenceDir
        ? `${evidenceDir}/attachments`
        : process.env.SMOKE_RUNTIME_DIR
          ? `${process.env.SMOKE_RUNTIME_DIR}/attachments`
          : undefined,
      include: ['browser/**/*.spec.ts'],
      testTimeout: 15000,
      expect: { poll: { timeout: 10000 } },
      browser: {
        enabled: true,
        headless: true,
        api: {
          host: '127.0.0.1',
          port: Number(process.env.SMOKE_BROWSER_PORT || 63315),
          strictPort: true,
        },
        screenshotFailures: Boolean(evidenceDir),
        screenshotDirectory: evidenceDir ? `${evidenceDir}/screenshots` : undefined,
        trace: evidenceDir
          ? {
              mode: 'on',
              tracesDir: `${evidenceDir}/traces`,
              screenshots: true,
              snapshots: true,
            }
          : 'off',
        provider: playwright({ contextOptions: { timezoneId: 'America/Los_Angeles' } }),
        instances: [{ browser: 'chromium' }],
      },
    },
  }),
)
