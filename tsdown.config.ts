import { defineConfig } from 'tsdown'

/**
 * Single-source build (mbs-8g5.2.2.1): ESM + CommonJS + declarations from the
 * typed TypeScript boundary. M0 `.mjs` fixtures are frozen proof and are not
 * inputs here; proven M1 `.mjs` internals are wrapped incrementally, never
 * duplicated as a second behavior for artifacts.
 */
export default defineConfig({
  entry: {
    mod: 'mod.ts',
    protocol: 'src/protocol.ts',
    client: 'src/client.ts',
    server: 'src/server.ts',
    storage: 'src/storage.ts',
    canonical: 'src/canonical.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: false,
  clean: true,
  outDir: 'dist',
  platform: 'neutral',
  fixedExtension: false,
})
