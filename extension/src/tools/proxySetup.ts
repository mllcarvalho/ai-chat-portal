import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * Configuração do proxy corporativo a partir do login (usuário RACF + senha):
 *  - `http.proxy` no settings.json GLOBAL do VS Code (atualiza se já existir);
 *  - `export HTTP_PROXY/HTTPS_PROXY` no ~/.bashrc (criado se não existir) e no
 *    ~/.zshrc de quem tiver — entradas existentes são atualizadas no lugar;
 *  - `strict-ssl/always-auth/cafile` no ~/.npmrc (criado se não existir);
 *  - process.env desta janela, para os MCPs/gateway usarem já nesta sessão.
 *
 * Os mesmos valores ficam em config.network (httpProxy/httpsProxy/extraCaCerts)
 * e podem ser editados na tela de Configurações — salvar lá regrava estes
 * mesmos arquivos, mantendo tudo em sincronia.
 *
 * A pasta do usuário (homedir) já é a do RACF logado na máquina, tanto no
 * Windows (C:\Users\<RACF>) quanto no Mac — por isso os rc vão em os.homedir().
 * A senha nunca é persistida fora dos arquivos que o próprio usuário pediu
 * para configurar, e vai percent-encoded na URL.
 */

const PROXY_HOST = 'proxynew.itau:8080';

export function buildProxyUrl(username: string, password: string): string {
  return `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${PROXY_HOST}`;
}

export function proxyHost(): string {
  return PROXY_HOST;
}

const RC_MARKER = '# Proxy corporativo — gerenciado pelo AI Product BMAD Chat';

/** Atualiza os exports no conteúdo de um rc; acrescenta um bloco se não houver. */
function upsertRcContent(content: string, vars: Record<string, string>): string {
  let out = content;
  const missing: string[] = [];
  for (const [name, value] of Object.entries(vars)) {
    const re = new RegExp(`^([ \\t]*export[ \\t]+${name}=).*$`, 'gm');
    if (re.test(out)) {
      out = out.replace(re, `$1"${value}"`);
    } else {
      missing.push(name);
    }
  }
  if (missing.length) {
    const block = [RC_MARKER, ...missing.map((n) => `export ${n}="${vars[n]}"`)].join('\n');
    out = `${out.replace(/\n*$/, '')}${out.trim() ? '\n\n' : ''}${block}\n`;
  }
  return out;
}

export interface RcUpdateResult {
  /** Arquivos efetivamente gravados (caminho absoluto). */
  updated: string[];
}

/**
 * Grava os exports de proxy nos rc do usuário: ~/.bashrc sempre (cria se
 * preciso) e ~/.zshrc apenas se o arquivo já existir.
 */
export function applyProxyToRcFiles(httpProxy: string, httpsProxy: string): RcUpdateResult {
  const home = os.homedir();
  const targets = [
    { file: path.join(home, '.bashrc'), createIfMissing: true },
    { file: path.join(home, '.zshrc'), createIfMissing: false },
  ];
  const vars = { HTTP_PROXY: httpProxy, HTTPS_PROXY: httpsProxy };
  const updated: string[] = [];
  for (const { file, createIfMissing } of targets) {
    let content: string | undefined;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      if (!createIfMissing) continue;
      content = '';
    }
    const next = upsertRcContent(content, vars);
    if (next !== content || content === '') {
      fs.writeFileSync(file, next, 'utf8');
    }
    updated.push(file);
  }
  return { updated };
}

const NPMRC_MARKER = '# npm — gerenciado pelo AI Product BMAD Chat';

/**
 * Garante no ~/.npmrc (criado se não existir) as chaves que o npm precisa para
 * funcionar atrás do proxy corporativo: strict-ssl=false, always-auth=true e,
 * quando o campo "CA interna" está preenchido, cafile apontando para o PEM.
 * Linhas existentes são atualizadas no lugar. IMPORTANTE: sem um cafile
 * informado, NÃO tocamos numa linha `cafile=` já existente — o usuário pode ter
 * configurado o certificado dele à mão, e blanká-lo quebrava o npm dele.
 */
export function applyNpmrcSettings(cafile: string | undefined): string {
  const file = path.join(os.homedir(), '.npmrc');
  let content = '';
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    // sem .npmrc ainda — será criado
  }
  const entries: Record<string, string> = {
    'strict-ssl': 'false',
    'always-auth': 'true',
  };
  // só gerencia o cafile quando há um caminho; senão preserva o do usuário
  if (cafile?.trim()) entries.cafile = cafile.trim();
  let out = content;
  const missing: string[] = [];
  for (const [key, value] of Object.entries(entries)) {
    const re = new RegExp(`^([ \\t]*${key}[ \\t]*=).*$`, 'gm');
    if (re.test(out)) {
      out = out.replace(re, `$1${value}`);
    } else {
      missing.push(key);
    }
  }
  if (missing.length) {
    const block = [NPMRC_MARKER, ...missing.map((k) => `${k}=${entries[k]}`)].join('\n');
    out = `${out.replace(/\n*$/, '')}${out.trim() ? '\n\n' : ''}${block}\n`;
  }
  if (out !== content || content === '') {
    fs.writeFileSync(file, out, 'utf8');
  }
  return file;
}

/** Lê o cafile já configurado no ~/.npmrc (se houver), para exibir/reaproveitar. */
export function detectNpmrcCafile(): string | undefined {
  try {
    const content = fs.readFileSync(path.join(os.homedir(), '.npmrc'), 'utf8');
    const m = /^[ \t]*cafile[ \t]*=[ \t]*(.+?)[ \t]*$/m.exec(content);
    return m?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Grava http.proxy no settings.json global do VS Code (cria ou atualiza). */
export async function applyProxyToVsCode(proxyUrl: string): Promise<void> {
  await vscode.workspace
    .getConfiguration('http')
    .update('proxy', proxyUrl, vscode.ConfigurationTarget.Global);
}

/** Aplica na sessão atual: MCPs/gateway (netEnv) passam a usar sem reiniciar. */
export function applyProxyToProcessEnv(httpProxy: string, httpsProxy: string): void {
  process.env.HTTP_PROXY = httpProxy;
  process.env.HTTPS_PROXY = httpsProxy;
}
