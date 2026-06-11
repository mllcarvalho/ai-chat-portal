import * as esbuild from 'esbuild';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

// A web UI buildada é servida estaticamente pela extensão a partir de media/.
const webDist = join(root, '..', 'web', 'dist');
const media = join(root, 'media');
if (existsSync(webDist)) {
  rmSync(media, { recursive: true, force: true });
  cpSync(webDist, media, { recursive: true });
  console.log('[esbuild] web/dist copiado para extension/media');
} else {
  console.warn('[esbuild] web/dist não existe — rode o build do web primeiro (a UI não será servida)');
}

const ctx = await esbuild.context({
  entryPoints: [join(root, 'src', 'extension.ts')],
  outfile: join(root, 'dist', 'extension.js'),
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
