#!/usr/bin/env node
/**
 * Lança uma versão para usuários finais:
 *   npm run release              → publica em `latest` (todo mundo recebe)
 *   npm run release -- --tag next → publica só na tag `next`
 *
 * A tag `next` existe para não expor ninguém antes de você testar: quem roda
 * `npx <pacote>` continua na versão anterior, e só quem pedir explicitamente
 * `npx <pacote>@next` recebe a nova. Depois de validar, promova com:
 *   npm dist-tag add <pacote>@<versão> latest
 *
 * Reverter uma versão ruim é a mesma operação ao contrário — repontar o
 * `latest` para a versão boa. NUNCA use `npm unpublish`: além de só funcionar
 * em 72h, ele queima o número da versão (o npm não deixa republicá-lo).
 *
 * Builda tudo, empacota o .vsix, publica no VS Code Marketplace, embute no
 * instalador npx e publica no npm.
 * Pré-requisitos (uma vez só): npm login e vsce login aichatportal
 * (ou a variável VSCE_PAT com o Personal Access Token do Marketplace).
 */
import { execSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd) => execSync(cmd, { stdio: 'inherit', cwd: root });

/** --tag <nome>: canal npm do lançamento (default `latest`). */
const tagIdx = process.argv.indexOf('--tag');
const distTag = tagIdx > -1 ? process.argv[tagIdx + 1] : undefined;
if (tagIdx > -1 && !distTag) {
  console.error('\x1b[31m✗ --tag exige um nome (ex: --tag next)\x1b[0m');
  process.exit(1);
}
const quiet = (cmd) => execSync(cmd, { stdio: 'pipe', cwd: root });
const fail = (msg) => {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
};

const version = JSON.parse(
  readFileSync(join(root, 'extension', 'package.json'), 'utf8'),
).version;

// o nome publicado vem do installer/package.json — a branch beta publica
// bmad-product-studio-beta sem tocar neste script
const pkgName = JSON.parse(
  readFileSync(join(root, 'installer', 'package.json'), 'utf8'),
).name;

try {
  quiet('npm whoami');
} catch {
  fail('Você não está logado no npm — rode npm login primeiro.');
}

// versões no npm são imutáveis: não deixa republicar uma que já existe
let alreadyPublished = false;
try {
  quiet(`npm view ${pkgName}@${version} version`);
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

console.log(
  `\x1b[36m▸\x1b[0m Lançando ${pkgName}@${version}${distTag ? ` na tag "${distTag}"` : ' em latest'}…`,
);
run('npm run package');

const vsixPath = join(root, 'extension', `ai-chat-portal-extension-${version}.vsix`);

// Marketplace antes do npm: se o npm publish falhar depois, rodar de novo é
// seguro — esta etapa detecta a versão já publicada e pula.
const extensionId = 'aichatportal.ai-chat-portal-extension';
let onMarketplace = false;
try {
  const shown = JSON.parse(quiet(`npx vsce show ${extensionId} --json`).toString());
  onMarketplace = (shown.versions ?? []).some((v) => v.version === version);
} catch {
  // extensão ainda não existe no Marketplace (primeira publicação) — segue
}
if (onMarketplace) {
  console.log(`\x1b[36m▸\x1b[0m Marketplace já tem a ${version} — pulando o vsce publish.`);
} else {
  console.log('\x1b[36m▸\x1b[0m Publicando no VS Code Marketplace…');
  run(`npx vsce publish --packagePath "${vsixPath}"`);
}

copyFileSync(vsixPath, join(root, 'installer', 'bmad-product-studio.vsix'));

// o instalador sempre publica com a mesma versão da extensão
const installerPkgPath = join(root, 'installer', 'package.json');
const installerPkg = JSON.parse(readFileSync(installerPkgPath, 'utf8'));
installerPkg.version = version;
writeFileSync(installerPkgPath, JSON.stringify(installerPkg, null, 2) + '\n');

run(`npm publish -w ${pkgName}${distTag ? ` --tag ${distTag}` : ''}`);

console.log(`\n\x1b[32m✦ ${pkgName}@${version} publicado!\x1b[0m`);
if (distTag) {
  console.log(`  Ninguém recebe ainda — quem roda "npx ${pkgName}" segue na versão anterior.`);
  console.log(`  Testar:   npx ${pkgName}@${distTag}`);
  console.log(`  Promover: npm dist-tag add ${pkgName}@${version} latest`);
} else {
  console.log(`  Já está valendo para todo mundo em "npx ${pkgName}".`);
  console.log(`  Reverter: npm dist-tag add ${pkgName}@<versão anterior> latest`);
}
console.log(`  Quem for usar roda: npx ${pkgName}@latest\n`);
