import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * Configuração do proxy corporativo a partir do login (usuário RACF + senha):
 *  - `http.proxy` no settings.json GLOBAL do VS Code (atualiza se já existir);
 *  - `export HTTP_PROXY/HTTPS_PROXY` no ~/.bashrc (criado se não existir) e no
 *    ~/.zshrc de quem tiver — entradas existentes são atualizadas no lugar;
 *  - process.env desta janela, para os MCPs/gateway usarem já nesta sessão.
 *
 * A pasta do usuário (homedir) já é a do RACF logado na máquina, tanto no
 * Windows (C:\Users\<RACF>) quanto no Mac — por isso os rc vão em os.homedir().
 * A senha nunca é persistida fora dos arquivos que o próprio usuário pediu
 * para configurar (settings.json e rc), e vai percent-encoded na URL.
 */

const PROXY_HOST = 'proxynew.itau:8080';

export function buildProxyUrl(username: string, password: string): string {
  return `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${PROXY_HOST}`;
}

export function proxyHost(): string {
  return PROXY_HOST;
}

const RC_MARKER = '# Proxy corporativo — gerenciado pelo AI Product BMAD Chat';
const RC_VARS = ['HTTP_PROXY', 'HTTPS_PROXY'] as const;

/** Atualiza os exports no conteúdo de um rc; acrescenta um bloco se não houver. */
function upsertRcContent(content: string, proxyUrl: string): string {
  let out = content;
  const missing: string[] = [];
  for (const name of RC_VARS) {
    const re = new RegExp(`^([ \\t]*export[ \\t]+${name}=).*$`, 'gm');
    if (re.test(out)) {
      out = out.replace(re, `$1"${proxyUrl}"`);
    } else {
      missing.push(name);
    }
  }
  if (missing.length) {
    const block = [RC_MARKER, ...missing.map((n) => `export ${n}="${proxyUrl}"`)].join('\n');
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
export function applyProxyToRcFiles(proxyUrl: string): RcUpdateResult {
  const home = os.homedir();
  const targets = [
    { file: path.join(home, '.bashrc'), createIfMissing: true },
    { file: path.join(home, '.zshrc'), createIfMissing: false },
  ];
  const updated: string[] = [];
  for (const { file, createIfMissing } of targets) {
    let content: string | undefined;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      if (!createIfMissing) continue;
      content = '';
    }
    const next = upsertRcContent(content, proxyUrl);
    if (next !== content || content === '') {
      fs.writeFileSync(file, next, 'utf8');
    }
    updated.push(file);
  }
  return { updated };
}

/** Grava http.proxy no settings.json global do VS Code (cria ou atualiza). */
export async function applyProxyToVsCode(proxyUrl: string): Promise<void> {
  await vscode.workspace
    .getConfiguration('http')
    .update('proxy', proxyUrl, vscode.ConfigurationTarget.Global);
}

/** Aplica na sessão atual: MCPs/gateway (netEnv) passam a usar sem reiniciar. */
export function applyProxyToProcessEnv(proxyUrl: string): void {
  process.env.HTTP_PROXY = proxyUrl;
  process.env.HTTPS_PROXY = proxyUrl;
}
