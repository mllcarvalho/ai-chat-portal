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

// Servidor MCP do portal: processo à parte, spawnado pelas CLIs agênticas
// (Claude Code, Devin) para que elas enxerguem as ferramentas do portal com os
// mesmos nomes. Precisa ser um bundle próprio porque o .vsix não leva
// node_modules — o SDK do MCP tem que estar embutido no arquivo.
const mcpCtx = await esbuild.context({
  entryPoints: [join(root, 'src', 'mcp', 'portalMcpServer.ts')],
  outfile: join(root, 'dist', 'portal-mcp-server.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: false,
  logLevel: 'info',
});

if (watch) {
  await Promise.all([ctx.watch(), mcpCtx.watch()]);
} else {
  await Promise.all([ctx.rebuild(), mcpCtx.rebuild()]);
  await Promise.all([ctx.dispose(), mcpCtx.dispose()]);
}
