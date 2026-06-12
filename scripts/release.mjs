#!/usr/bin/env node
/**
 * Lança uma versão para usuários finais:
 *   npm run release
 * Builda tudo, empacota o .vsix, embute no instalador npx e publica no npm.
 * Pré-requisito: npm login feito (uma vez só).
 */
import { execSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd) => execSync(cmd, { stdio: 'inherit', cwd: root });
const quiet = (cmd) => execSync(cmd, { stdio: 'pipe', cwd: root });
const fail = (msg) => {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
};

const version = JSON.parse(
  readFileSync(join(root, 'extension', 'package.json'), 'utf8'),
).version;

try {
  quiet('npm whoami');
} catch {
  fail('Você não está logado no npm — rode npm login primeiro.');
}

// versões no npm são imutáveis: não deixa republicar uma que já existe
let alreadyPublished = false;
try {
  quiet(`npm view ai-product-bmad-chat@${version} version`);
  alreadyPublished = true;
} catch {
  // 404 esperado quando a versão é nova
}
if (alreadyPublished) {
  fail(
    `A versão ${version} já está publicada no npm.\n` +
      '  Suba a "version" em extension/package.json e rode npm run release de novo.',
  );
}

console.log(`\x1b[36m▸\x1b[0m Lançando ai-product-bmad-chat@${version}…`);
run('npm run package');

copyFileSync(
  join(root, 'extension', `ai-chat-portal-extension-${version}.vsix`),
  join(root, 'installer', 'ai-product-bmad-chat.vsix'),
);

// o instalador sempre publica com a mesma versão da extensão
const installerPkgPath = join(root, 'installer', 'package.json');
const installerPkg = JSON.parse(readFileSync(installerPkgPath, 'utf8'));
installerPkg.version = version;
writeFileSync(installerPkgPath, JSON.stringify(installerPkg, null, 2) + '\n');

run('npm publish -w ai-product-bmad-chat');

console.log(`\n\x1b[32m✦ ai-product-bmad-chat@${version} publicado!\x1b[0m`);
console.log('  Quem for usar roda: npx ai-product-bmad-chat@latest\n');
