import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/credentials.ts', 'src/pairing.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  dts: true,
  sourcemap: true,
  clean: true,
});
