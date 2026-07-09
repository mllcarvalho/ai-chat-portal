import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readTable } from './sqliteRead';
import { powerShellCandidates, spawnCwd } from './winPowerShell';

const execFileP = promisify(execFile);

/**
 * Lê cookies (inclusive HttpOnly, ex: JSESSIONID) direto do banco dos
 * navegadores — o que o JavaScript da página não alcança. Cobre dois motores:
 *
 *  - Chromium (Chrome/Edge/Brave): cookies num SQLite com os valores CIFRADOS;
 *    a chave e o algoritmo mudam por SO:
 *      · macOS: AES-128-CBC, chave derivada de uma senha no Keychain
 *        (serviço "<Browser> Safe Storage"); ler pode abrir um prompt "Permitir".
 *      · Windows: AES-256-GCM, chave em "Local State" (os_crypt.encrypted_key)
 *        protegida por DPAPI — decifrada via PowerShell. Cookies novos do Chrome
 *        com App-Bound Encryption (prefixo "v20") não são suportados.
 *      · Linux: AES-128-CBC, chave do keyring (fallback "peanuts").
 *  - Firefox: cookies em TEXTO PURO no moz_cookies — NÃO precisa de chave do SO,
 *    então é o caminho automático que sobra quando o Keychain/DPAPI falha
 *    (ex.: antivírus corporativo bloqueando o PowerShell → "spawn UNKNOWN").
 *
 * A estratégia é tentar TODOS os navegadores/perfis e devolver todos os
 * "hits"; quem chama valida cada um e fica com o primeiro que autentica.
 */

export interface CookieHit {
  browser: string;
  profile: string;
  cookieString: string;
  names: string[];
}

type Decryptor = (value: Buffer, key: Buffer) => string | undefined;

interface ChromiumTarget {
  label: string;
  /** Diretório-raiz dos perfis do navegador. */
  userDataDir: string;
  getKey: () => Promise<Buffer>;
  decrypt: Decryptor;
}

/** Processos filhos rodam a partir de um cwd garantido — ver spawnCwd(). */
const SPAWN_CWD = spawnCwd();

// --- decifradores por algoritmo -----------------------------------------------

/**
 * Remove o prefixo de 32 bytes (SHA-256 do domínio) que o Chrome recente
 * adiciona ao texto do cookie. Detecção determinística: um valor de cookie é
 * ASCII imprimível, então se QUALQUER um dos 32 primeiros bytes não for
 * imprimível é o hash (só o 1º byte não basta — um SHA-256 começa com byte
 * imprimível ~37% das vezes).
 */
function stripDomainHash(out: Buffer): Buffer {
  if (out.length <= 32) return out;
  for (let i = 0; i < 32; i++) {
    const b = out[i];
    if (b < 0x20 || b > 0x7e) return out.subarray(32);
  }
  return out;
}

/** macOS/Linux: v10 + AES-128-CBC, IV de 16 espaços. */
function decryptCbc(value: Buffer, key: Buffer): string | undefined {
  if (value.length <= 3) return undefined;
  const prefix = value.subarray(0, 3).toString('latin1');
  if (prefix !== 'v10' && prefix !== 'v11') return undefined;
  try {
    const iv = Buffer.alloc(16, 0x20);
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    decipher.setAutoPadding(false);
    let out = Buffer.concat([decipher.update(value.subarray(3)), decipher.final()]);
    const pad = out[out.length - 1];
    if (pad > 0 && pad <= 16) out = out.subarray(0, out.length - pad);
    return stripDomainHash(out).toString('utf8');
  } catch {
    return undefined;
  }
}

/** Prefixo de versão do valor cifrado ("v10", "v11", "v20"…) ou "" se não houver. */
function cookiePrefix(value: Buffer): string {
  if (value.length <= 3) return '';
  const prefix = value.subarray(0, 3).toString('latin1');
  return /^v\d\d$/.test(prefix) ? prefix : '';
}

/** Windows: v10 + AES-256-GCM (nonce 12B + ciphertext + tag 16B). */
function decryptGcm(value: Buffer, key: Buffer): string | undefined {
  if (value.length <= 3) return undefined;
  const prefix = value.subarray(0, 3).toString('latin1');
  if (prefix !== 'v10') return undefined; // v20 (App-Bound) fica de fora
  try {
    const nonce = value.subarray(3, 15);
    const tag = value.subarray(value.length - 16);
    const ciphertext = value.subarray(15, value.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return stripDomainHash(out).toString('utf8');
  } catch {
    return undefined;
  }
}

// --- obtenção da chave por SO -------------------------------------------------

async function macKey(service: string, account: string): Promise<Buffer> {
  // caminho absoluto do `security`: o PATH mínimo da GUI do VS Code é uma das
  // causas do "spawn UNKNOWN/ENOENT"
  const bin = '/usr/bin/security';
  const { stdout } = await execFileP(
    fs.existsSync(bin) ? bin : 'security',
    ['find-generic-password', '-w', '-s', service, '-a', account],
    { cwd: SPAWN_CWD },
  );
  const password = stdout.trim();
  if (!password) throw new Error('senha vazia do Keychain');
  return crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
}

/**
 * Roda um script no PowerShell, tentando cada candidato até um responder. Se
 * TODOS falharem (ex.: antivírus corporativo bloqueando a criação do processo
 * → "spawn UNKNOWN"), lança com o erro de CADA tentativa — só o do último
 * candidato (`pwsh`, que quase nunca existe) escondia a causa real.
 */
async function runPowerShell(script: string): Promise<string> {
  const errors: string[] = [];
  for (const exe of powerShellCandidates()) {
    try {
      const { stdout } = await execFileP(
        exe,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { windowsHide: true, maxBuffer: 1 << 20, cwd: SPAWN_CWD },
      );
      return stdout.trim();
    } catch (err) {
      // ENOENT (não existe / PATH capado) · UNKNOWN (EDR barrou) → tenta o próximo
      errors.push(`${path.basename(exe)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(
    `PowerShell indisponível para decifrar a chave. Tentativas — ${errors.join(' | ')}. ` +
      'Pode ser bloqueio do antivírus/EDR corporativo — abra o itau.service-now.com logado no Firefox (a detecção lê o Firefox sem PowerShell) ou use o "Copy as cURL".',
  );
}

/** DPAPI (CurrentUser) via PowerShell — evita módulo nativo no Windows. */
async function dpapiUnprotect(data: Buffer): Promise<Buffer> {
  const b64 = data.toString('base64');
  const script =
    `$b=[Convert]::FromBase64String('${b64}');` +
    'Add-Type -AssemblyName System.Security;' +
    "$d=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');" +
    '[Convert]::ToBase64String($d)';
  return Buffer.from(await runPowerShell(script), 'base64');
}

async function windowsKey(userDataDir: string): Promise<Buffer> {
  const localState = path.join(userDataDir, 'Local State');
  const parsed = JSON.parse(fs.readFileSync(localState, 'utf8')) as {
    os_crypt?: { encrypted_key?: string };
  };
  const encoded = parsed.os_crypt?.encrypted_key;
  if (!encoded) throw new Error('Local State sem os_crypt.encrypted_key');
  const raw = Buffer.from(encoded, 'base64');
  // prefixo "DPAPI" (5 bytes) antes da chave protegida
  const protectedKey = raw.subarray(0, 5).toString('latin1') === 'DPAPI' ? raw.subarray(5) : raw;
  return dpapiUnprotect(protectedKey);
}

/** Linux: keyring é complexo; fallback "peanuts" cobre o Chrome sem keyring. */
async function linuxKey(): Promise<Buffer> {
  return crypto.pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1');
}

// --- descoberta dos alvos Chromium por SO -------------------------------------

function macChromiumTargets(): ChromiumTarget[] {
  const appSupport = path.join(os.homedir(), 'Library', 'Application Support');
  const defs: Array<{ label: string; base: string; service: string; account: string }> = [
    { label: 'Chrome', base: 'Google/Chrome', service: 'Chrome Safe Storage', account: 'Chrome' },
    { label: 'Edge', base: 'Microsoft Edge', service: 'Microsoft Edge Safe Storage', account: 'Microsoft Edge' },
    { label: 'Brave', base: 'BraveSoftware/Brave-Browser', service: 'Brave Safe Storage', account: 'Brave' },
  ];
  return defs.map((d) => ({
    label: d.label,
    userDataDir: path.join(appSupport, d.base),
    getKey: () => macKey(d.service, d.account),
    decrypt: decryptCbc,
  }));
}

function windowsChromiumTargets(): ChromiumTarget[] {
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const defs: Array<{ label: string; base: string }> = [
    { label: 'Chrome', base: 'Google\\Chrome\\User Data' },
    { label: 'Edge', base: 'Microsoft\\Edge\\User Data' },
    { label: 'Brave', base: 'BraveSoftware\\Brave-Browser\\User Data' },
  ];
  return defs.map((d) => {
    const userDataDir = path.join(localAppData, d.base);
    return {
      label: d.label,
      userDataDir,
      getKey: () => windowsKey(userDataDir),
      decrypt: decryptGcm,
    };
  });
}

function linuxChromiumTargets(): ChromiumTarget[] {
  const config = path.join(os.homedir(), '.config');
  const defs: Array<{ label: string; base: string }> = [
    { label: 'Chrome', base: 'google-chrome' },
    { label: 'Chromium', base: 'chromium' },
    { label: 'Edge', base: 'microsoft-edge' },
    { label: 'Brave', base: 'BraveSoftware/Brave-Browser' },
  ];
  return defs.map((d) => ({
    label: d.label,
    userDataDir: path.join(config, d.base),
    getKey: linuxKey,
    decrypt: decryptCbc,
  }));
}

function chromiumTargets(): ChromiumTarget[] {
  if (process.platform === 'darwin') return macChromiumTargets();
  if (process.platform === 'win32') return windowsChromiumTargets();
  if (process.platform === 'linux') return linuxChromiumTargets();
  return [];
}

// --- descoberta dos alvos Firefox por SO --------------------------------------

/** Raízes onde ficam os perfis do Firefox (cada um com seu cookies.sqlite). */
function firefoxProfileRoots(): string[] {
  const home = os.homedir();
  if (process.platform === 'darwin')
    return [path.join(home, 'Library', 'Application Support', 'Firefox', 'Profiles')];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    return [path.join(appData, 'Mozilla', 'Firefox', 'Profiles')];
  }
  return [
    path.join(home, '.mozilla', 'firefox'),
    path.join(home, 'snap', 'firefox', 'common', '.mozilla', 'firefox'),
  ];
}

function firefoxDbs(): Array<{ profile: string; db: string }> {
  const out: Array<{ profile: string; db: string }> = [];
  for (const root of firefoxProfileRoots()) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const db = path.join(root, entry, 'cookies.sqlite');
      if (fs.existsSync(db)) out.push({ profile: entry, db });
    }
  }
  return out;
}

// --- leitura dos bancos -------------------------------------------------------

/** Copia o banco (o navegador aberto mantém lock/WAL) e devolve o caminho temp. */
function tempCopy(db: string): string {
  const tmp = path.join(os.tmpdir(), `aiportal-ck-${process.pid}-${Math.abs(hashString(db))}.sqlite`);
  fs.copyFileSync(db, tmp);
  return tmp;
}

function rmTemp(tmp: string): void {
  try {
    fs.unlinkSync(tmp);
  } catch {
    // temp some no reboot de qualquer forma
  }
}

/** Chromium: tabela `cookies` com encrypted_value (BLOB). */
function readChromiumRows(db: string): Array<{ host: string; name: string; value: Buffer }> {
  const tmp = tempCopy(db);
  try {
    return readTable(tmp, 'cookies')
      .map((r) => ({
        host: String(r.host_key ?? ''),
        name: String(r.name ?? ''),
        value: Buffer.isBuffer(r.encrypted_value) ? r.encrypted_value : Buffer.alloc(0),
      }))
      .filter((r) => r.name && r.value.length);
  } finally {
    rmTemp(tmp);
  }
}

/** Firefox: tabela `moz_cookies` com value em TEXTO PURO. */
function readFirefoxRows(db: string): Array<{ host: string; name: string; value: string }> {
  const tmp = tempCopy(db);
  try {
    return readTable(tmp, 'moz_cookies')
      .map((r) => ({
        host: String(r.host ?? ''),
        name: String(r.name ?? ''),
        value: r.value == null ? '' : String(r.value),
      }))
      .filter((r) => r.name && r.value);
  } finally {
    rmTemp(tmp);
  }
}

/** Hash estável (sem Math.random) para nomear o arquivo temporário. */
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** Perfis (Default, Profile 1…) com arquivo Cookies dentro do userDataDir. */
function chromiumCookieDbs(userDataDir: string): Array<{ profile: string; db: string }> {
  const out: Array<{ profile: string; db: string }> = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(userDataDir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry !== 'Default' && !/^Profile /.test(entry)) continue;
    for (const rel of [path.join('Network', 'Cookies'), 'Cookies']) {
      const db = path.join(userDataDir, entry, rel);
      if (fs.existsSync(db)) {
        out.push({ profile: entry, db });
        break;
      }
    }
  }
  return out;
}

function matchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(domain) || host.endsWith(`.${domain}`);
}

function hasSessionCookie(names: string[]): boolean {
  return names.some((n) => /^JSESSIONID$/i.test(n) || /glide_user/i.test(n));
}

// --- API ----------------------------------------------------------------------

/**
 * Coleta cookies do domínio de TODOS os navegadores/perfis (Chromium + Firefox)
 * onde houver algo. Devolve os hits (ordenados: quem tem cookie de sessão
 * primeiro) e a lista de problemas por navegador, para a UI orientar o plano B.
 * Nunca lança — mesmo sem nada devolve `{ hits: [], problems }`.
 */
export async function collectCookieHits(
  domain: string,
): Promise<{ hits: CookieHit[]; problems: string[] }> {
  const hits: CookieHit[] = [];
  const problems: string[] = [];

  // 1) Chromium (Chrome/Edge/Brave) — precisa da chave do SO
  for (const target of chromiumTargets()) {
    const dbs = chromiumCookieDbs(target.userDataDir);
    if (!dbs.length) continue;
    let key: Buffer;
    try {
      key = await target.getKey();
    } catch (err) {
      problems.push(`${target.label}: sem acesso à chave (${err instanceof Error ? err.message : err})`);
      continue;
    }
    for (const { profile, db } of dbs) {
      try {
        const rows = readChromiumRows(db).filter((r) => matchesDomain(r.host, domain));
        const pairs: string[] = [];
        const names: string[] = [];
        let appBound = 0;
        for (const row of rows) {
          const value = target.decrypt(row.value, key);
          if (value !== undefined && value !== '') {
            pairs.push(`${row.name}=${value}`);
            names.push(row.name);
          } else if (cookiePrefix(row.value) === 'v20') {
            appBound++;
          }
        }
        if (pairs.length)
          hits.push({ browser: target.label, profile, cookieString: pairs.join('; '), names });
        // Chrome/Edge 127+ podem cifrar com App-Bound Encryption (v20): a chave
        // é ligada ao binário do navegador, então nem o DPAPI do usuário abre.
        else if (appBound)
          problems.push(`${target.label}: cookies protegidos por App-Bound Encryption (Chrome/Edge 127+)`);
      } catch (err) {
        problems.push(`${target.label}/${profile}: falha ao ler o banco (${err instanceof Error ? err.message : err})`);
      }
    }
  }

  // 2) Firefox — texto puro, sem chave do SO (funciona quando o passo 1 falha)
  for (const { profile, db } of firefoxDbs()) {
    try {
      const rows = readFirefoxRows(db).filter((r) => matchesDomain(r.host, domain));
      const pairs = rows.map((r) => `${r.name}=${r.value}`);
      const names = rows.map((r) => r.name);
      if (pairs.length)
        hits.push({ browser: 'Firefox', profile, cookieString: pairs.join('; '), names });
    } catch (err) {
      problems.push(`Firefox/${profile}: falha ao ler o banco (${err instanceof Error ? err.message : err})`);
    }
  }

  // sessão válida costuma ter JSESSIONID/glide_user → tenta esses primeiro
  hits.sort((a, b) => Number(hasSessionCookie(b.names)) - Number(hasSessionCookie(a.names)));
  return { hits, problems };
}

/**
 * Mensagem de erro padrão quando nenhum navegador tinha cookies do domínio.
 * A orientação vem PRIMEIRO e os detalhes técnicos por último, resumidos: o
 * despejo cru de um erro por navegador produzia um parágrafo que ninguém lia.
 */
export function noCookiesError(domain: string, problems: string[]): Error {
  // Chrome e Edge falham pela mesma causa (o PowerShell), então o texto se
  // repetia inteiro; um erro por linha, sem repetir, e cada um encurtado.
  const seen = new Set<string>();
  const detail = problems
    .map((p) => (p.length > 160 ? `${p.slice(0, 157)}…` : p))
    .filter((p) => !seen.has(p) && seen.add(p))
    .join('\n· ');
  return new Error(
    `Não encontrei cookies de ${domain} em nenhum navegador. ` +
      'Abra o site logado no Chrome, Edge ou Firefox e clique em detectar de novo. ' +
      'Se não funcionar, use o "Copy as cURL" abaixo.' +
      (detail ? `\n\nO que cada navegador respondeu:\n· ${detail}` : ''),
  );
}

/** Primeiro navegador/perfil com cookies do domínio (compatibilidade). */
export async function readCookiesForDomain(domain: string): Promise<CookieHit> {
  const { hits, problems } = await collectCookieHits(domain);
  if (!hits.length) throw noCookiesError(domain, problems);
  return hits[0];
}
