#!/usr/bin/env node
// Reinjeta scripts/bootstrap-itau.sh dentro de scripts/setup-itau.html
// (bloco <script type="text/plain" id="bootstrap-sh">). Rode sempre que
// alterar o bootstrap:  node scripts/build-setup-page.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const shUrl = new URL('./bootstrap-itau.sh', import.meta.url);
const htmlUrl = new URL('./setup-itau.html', import.meta.url);

let sh = readFileSync(shUrl, 'utf8');
if (sh.includes('</script')) {
  console.error('bootstrap-itau.sh contém "</script" — isso quebraria o HTML. Ajuste o script.');
  process.exit(1);
}
if (!sh.endsWith('\n')) sh += '\n';

const html = readFileSync(htmlUrl, 'utf8');
const re = /(<script type="text\/plain" id="bootstrap-sh">\n)[\s\S]*?(<\/script>)/;
if (!re.test(html)) {
  console.error('Não achei o bloco id="bootstrap-sh" em setup-itau.html.');
  process.exit(1);
}
const out = html.replace(re, (_, open, close) => open + sh + close);
writeFileSync(htmlUrl, out);

const kb = (out.length / 1024).toFixed(1);
console.log(`✓ setup-itau.html atualizado com bootstrap-itau.sh embutido (${kb} KB).`);
