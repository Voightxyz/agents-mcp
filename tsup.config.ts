import { defineConfig } from 'tsup'

// One ESM bin with a shebang. Runtime dependencies are bundled in, so an
// `npx` install pulls exactly one package and no transitive tree.
export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  dts: false,
  sourcemap: false,
  clean: true,
  minify: false,
  noExternal: [/.*/],
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __voightCreateRequire } from 'node:module'",
      'const require = __voightCreateRequire(import.meta.url)',
    ].join('\n'),
  },
})
