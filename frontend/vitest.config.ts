/**
 * frontend/vitest.config.ts
 * ═════════════════════════
 * Vitest configuration — kept separate from vite.config.ts so the heavy
 * Cesium/TailwindCSS vite plugins don't load during test runs.
 *
 * All test files live under src/engine/testing/ and match *.test.ts.
 * The jsdom environment lets tests access browser-like globals (URL,
 * fetch, etc.) without a real browser.
 */

import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    /**
     * jsdom provides a browser-like DOM environment.
     * The engine tests don't render anything, but some modules import
     * cesium types that expect a globalThis.window to exist.
     */
    environment: 'jsdom',

    /**
     * Only collect tests from the dedicated testing directory.
     * The glob must be relative to the project root (not src/).
     */
    include: ['src/engine/testing/**/*.test.ts'],

    /**
     * Global test setup — mock modules that require browser APIs
     * Cesium can't run in jsdom; stub it at the module level.
     */
    setupFiles: ['src/engine/testing/__setup__/mocks.ts'],

    /**
     * Coverage via v8 — matches ts source files in engine/
     */
    coverage: {
      provider: 'v8',
      include: ['src/engine/**/*.ts'],
      exclude: ['src/engine/testing/**'],
    },

    /**
     * Individual test timeout (ms).  The StartupTest previously waited
     * 20s for a live backend — now it's hermetic so 5s is ample.
     */
    testTimeout: 10_000,
  },
  resolve: {
    alias: {
      /**
       * Mirror the '@/' alias so any future imports using it resolve
       * correctly inside tests too.
       */
      '@': resolve(__dirname, 'src'),
    },
  },
});
