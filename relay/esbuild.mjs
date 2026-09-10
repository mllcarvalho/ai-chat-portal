import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

// Bundle único e autossuficiente: a imagem Docker leva só o dist/server.cjs.
await esbuild.build({
  entryPoints: [join(root, 'src', 'server.ts')],
  outfile: join(root, 'dist', 'server.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  // aceleradores nativos opcionais do ws: sem eles o ws usa JS puro
  external: ['bufferutil', 'utf-8-validate'],
  sourcemap: false,
  logLevel: 'info',
});
