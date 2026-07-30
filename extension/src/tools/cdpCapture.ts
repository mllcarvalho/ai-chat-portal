import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { spawnCwd } from './winPowerShell';

/**
 * Captura de sessão pelo PRÓPRIO navegador (Edge/Chrome) via Chrome DevTools
 * Protocol — o plano para quando ler o banco de cookies não funciona: Windows
 * com App-Bound Encryption (Chrome/Edge 127+) e/ou PowerShell bloqueado pelo
 * EDR corporativo. Em vez de decifrar cookies offline (o que a Google/Microsoft
 * fecharam de propósito e o EDR trata como malware), a gente PERGUNTA ao
 * navegador: sobe uma instância num perfil novo e temporário, navega ao
 * itau.service-now.com, espera o SSO transparente (IWA/Kerberos, sem MFA na
 * rede Itaú) autenticar e então lê os cookies — inclusive o JSESSIONID
 * HttpOnly — via Network.getAllCookies.
 *
 * Transporte por PIPE (fds 3/4, mensagens JSON separadas por \0), NÃO WebSocket:
 * o Node 20 do host da extensão não tem WebSocket global e não vale puxar uma
 * dependência nova. É o mesmo canal que o Puppeteer usa com
 * --remote-debugging-pipe.
 *
 * Perfil novo e temporário é OBRIGATÓRIO: desde o Chrome M136 o
 * --remote-debugging-pipe/-port só é aceito quando o --user-data-dir aponta para
 * fora do perfil padrão. Como o perfil é limpo, a captura depende do SSO logar
 * sozinho — daí ser o caminho certo justamente na rede corporativa (Windows) e
 * um fallback manual (janela de login visível) fora dela.
 */

export interface BrowserCapture {
  cookieString: string;
  browser: string;
  profile: string;
}

interface CdpMessage {
  id?: number;
  result?: unknown;
  error?: { message?: string };
  method?: string;
  sessionId?: string;
}

interface CdpCookie {
  name: string;
  value: string;
  domain: string;
}

/** Cliente CDP mínimo sobre o pipe (fd3 = escrevemos, fd4 = lemos). */
class PipeCdp {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buf = Buffer.alloc(0);

  constructor(
    private readonly out: Writable,
    input: Readable,
  ) {
    input.on('data', (chunk: Buffer) => this.onData(chunk));
    input.on('error', () => this.rejectAll(new Error('pipe do navegador fechou')));
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    let idx: number;
    // mensagens CDP no pipe são JSON cru separados por um byte 0
    while ((idx = this.buf.indexOf(0)) >= 0) {
      const slice = this.buf.subarray(0, idx);
      this.buf = this.buf.subarray(idx + 1);
      if (!slice.length) continue;
      let msg: CdpMessage;
      try {
        msg = JSON.parse(slice.toString('utf8')) as CdpMessage;
      } catch {
        continue;
      }
      if (typeof msg.id === 'number') {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? 'erro CDP'));
        else p.resolve(msg.result);
      }
      // eventos (sem id) são ignorados — a captura funciona por polling
    }
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    const payload = JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.out.write(`${payload}\0`, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  rejectAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}

function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * Navegadores candidatos por SO, do mais indicado para o menos. No Windows o
 * Edge vem primeiro: está sempre presente e é o que melhor integra com o SSO
 * (IWA/Kerberos) do domínio. Caminhos absolutos são filtrados por existsSync;
 * no Linux (fora de escopo, mas cobrimos) deixamos o nome nu para o PATH.
 */
function browserCandidates(): Array<{ label: string; exe: string }> {
  const out: Array<{ label: string; exe: string }> = [];
  const add = (label: string, exe: string | undefined | false) => {
    if (exe && fileExists(exe)) out.push({ label, exe });
  };
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles;
    const pf86 = process.env['ProgramFiles(x86)'];
    const local = process.env.LOCALAPPDATA;
    add('Edge', pf86 && path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    add('Edge', pf && path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    add('Chrome', pf && path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    add('Chrome', pf86 && path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    add('Chrome', local && path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  } else if (process.platform === 'darwin') {
    add('Chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    add('Edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    add('Brave', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser');
  } else {
    for (const [label, exe] of [
      ['Chrome', 'google-chrome'],
      ['Chrome', 'google-chrome-stable'],
      ['Chromium', 'chromium'],
      ['Chromium', 'chromium-browser'],
      ['Edge', 'microsoft-edge'],
    ] as const) {
      out.push({ label, exe });
    }
  }
  return out;
}

const LAUNCH_FLAGS = [
  '--remote-debugging-pipe',
  '--no-first-run',
  '--no-default-browser-check',
  '--no-service-autorun',
  '--disable-sync',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-features=Translate,MediaRouter',
  '--window-size=520,640',
];

function domainMatches(cookieDomain: string, domain: string): boolean {
  const d = cookieDomain.replace(/^\./, '');
  return d === domain || d.endsWith(`.${domain}`);
}

/** Cookies do domínio → header Cookie. Dedup por nome, domínio mais específico vence. */
function buildCookieString(cookies: CdpCookie[], domain: string): string {
  const byName = new Map<string, CdpCookie>();
  for (const c of cookies) {
    if (!c.name || !domainMatches(c.domain, domain)) continue;
    const prev = byName.get(c.name);
    if (!prev || c.domain.replace(/^\./, '').length >= prev.domain.replace(/^\./, '').length) {
      byName.set(c.name, c);
    }
  }
  return [...byName.values()].map((c) => `${c.name}=${c.value}`).join('; ');
}

/**
 * Lê a sessão de UM navegador: sobe o processo com o pipe CDP, abre a aba no
 * startUrl e espera (polling) o cookie de sessão do domínio aparecer — sinal de
 * que o SSO concluiu. Devolve a Cookie string (inclui HttpOnly). Sempre encerra
 * o navegador e apaga o perfil temporário no finally.
 */
async function launchAndCapture(
  cand: { label: string; exe: string },
  domain: string,
  startUrl: string,
  timeoutMs: number,
  sessionCookie: RegExp,
  authExpression: string,
): Promise<BrowserCapture> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiportal-cdp-'));
  const child = spawn(cand.exe, [...LAUNCH_FLAGS, `--user-data-dir=${userDataDir}`, 'about:blank'], {
    // fds 3/4 = pipe CDP; a janela aparece (sem windowsHide) para o SSO/MFA
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    cwd: spawnCwd(),
  });
  const cdp = new PipeCdp(child.stdio[3] as Writable, child.stdio[4] as Readable);
  let stderr = '';
  child.stderr?.on('data', (c: Buffer) => {
    stderr = (stderr + c.toString()).slice(-2000);
  });

  const removeProfile = (): void => {
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* perfil some no reboot de qualquer forma */
    }
  };

  const cleanup = (): void => {
    cdp.rejectAll(new Error('captura encerrada'));
    void cdp.send('Browser.close').catch(() => {});
    try {
      child.kill();
    } catch {
      /* já morreu */
    }
    const hardKill = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* já morreu */
      }
    }, 1500);
    hardKill.unref();
    // apagar o perfil ENQUANTO o navegador ainda o segura falha (ele recria os
    // arquivos ao sair) — só remove depois que o processo realmente encerra
    if (child.exitCode !== null || child.signalCode !== null) removeProfile();
    else child.once('exit', removeProfile);
    const sweep = setTimeout(removeProfile, 4000);
    sweep.unref();
  };

  try {
    return await new Promise<BrowserCapture>((resolve, reject) => {
      let settled = false;
      let polling = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        fn();
      };
      const fail = (msg: string): void => finish(() => reject(new Error(msg)));

      child.on('error', (err) => fail(`falha ao abrir o ${cand.label} (${err.message})`));
      child.on('exit', (code) =>
        fail(`o ${cand.label} fechou antes de autenticar (código ${code}). ${stderr.slice(-160)}`),
      );

      const deadline = setTimeout(
        () =>
          fail(
            `tempo esgotado (${Math.round(timeoutMs / 1000)}s) esperando o login no ${domain}. ` +
              'Confirme que consegue abrir o itau.service-now.com logado neste navegador.',
          ),
        timeoutMs,
      );
      deadline.unref();

      let sessionId: string | undefined;
      const poll = setInterval(() => {
        if (settled || polling || !sessionId) return;
        polling = true;
        void (async () => {
          try {
            // prova de autenticação lida na própria aba: o SSO já voltou para o
            // service-now E há um g_ck longo (a página de login/IdP não tem).
            // Sem isso, um JSESSIONID anônimo setado no login resolveria cedo.
            const authed = await cdp.send<{ result?: { value?: boolean } }>(
              'Runtime.evaluate',
              { expression: authExpression, returnByValue: true },
              sessionId,
            );
            if (!authed.result?.value) return;
            const { cookies } = await cdp.send<{ cookies: CdpCookie[] }>('Network.getAllCookies', {}, sessionId);
            const relevant = cookies.filter((c) => domainMatches(c.domain, domain));
            if (relevant.some((c) => sessionCookie.test(c.name))) {
              clearInterval(poll);
              clearTimeout(deadline);
              finish(() =>
                resolve({
                  cookieString: buildCookieString(relevant, domain),
                  browser: cand.label,
                  profile: 'SSO',
                }),
              );
            }
          } catch {
            // navegador ainda subindo ou a aba trocou no redirect do IdP — tenta de novo
          } finally {
            polling = false;
          }
        })();
      }, 1000);

      void (async () => {
        // cria a aba já navegando e prende a sessão a ela (sobrevive ao redirect do SSO)
        const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: startUrl });
        const attached = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
          targetId,
          flatten: true,
        });
        sessionId = attached.sessionId;
        await cdp.send('Network.enable', {}, sessionId);
      })().catch((err) => fail(err instanceof Error ? err.message : String(err)));
    });
  } finally {
    cleanup();
  }
}

/**
 * Tenta capturar a sessão do domínio abrindo cada navegador candidato até um
 * conseguir. Lança com o motivo de cada tentativa se todos falharem.
 */
export async function captureCookiesViaBrowser(
  domain: string,
  startUrl: string,
  opts: { timeoutMs?: number; sessionCookie?: RegExp; authExpression?: string } = {},
): Promise<BrowserCapture> {
  const candidates = browserCandidates();
  if (!candidates.length) {
    throw new Error('Nenhum navegador (Edge/Chrome) encontrado para a captura via SSO.');
  }
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const sessionCookie = opts.sessionCookie ?? /^JSESSIONID$/i;
  // prova de sessão autenticada avaliada na aba: de volta ao domínio + g_ck longo
  const authExpression =
    opts.authExpression ??
    `location.hostname.endsWith(${JSON.stringify(domain)}) && typeof window.g_ck==='string' && window.g_ck.length>20`;
  const errors: string[] = [];
  for (const cand of candidates) {
    try {
      return await launchAndCapture(cand, domain, startUrl, timeoutMs, sessionCookie, authExpression);
    } catch (err) {
      errors.push(`${cand.label}: ${err instanceof Error ? err.message : err}`);
    }
  }
  throw new Error(`captura pelo navegador falhou — ${errors.join(' | ')}`);
}
