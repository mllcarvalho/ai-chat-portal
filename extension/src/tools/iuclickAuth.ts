import { collectCookieHits } from './browserCookies';
import { captureCookiesViaBrowser } from './cdpCapture';
import { requestInitFor, resolveShellEnv } from './netEnv';
import { saveIuclickCredentials } from '../storage/iuclickStore';

/**
 * Captura/validação das credenciais do IUClick (ServiceNow) a partir do
 * navegador. Fica num módulo próprio (sem importar o mcpManager) para o
 * mcpManager poder re-detectar sozinho quando a sessão expira no meio do chat,
 * sem import circular.
 *
 * Ponto-chave que causava "token expired or invalid: 403": o cookie de sessão
 * (JSESSIONID) vem do banco do navegador e o X-UserToken (g_ck) de uma
 * requisição à página. Se essa página cair no login (sessão já expirada), ela
 * ainda traz um g_ck — mas ANÔNIMO — e salvá-lo garante o 403 no primeiro uso.
 * Aqui a gente (1) rejeita quando a resposta é a tela de login/SSO, e (2) usa
 * os cookies atualizados pelo Set-Cookie da própria resposta, garantindo que
 * cookie e token são do mesmo contexto autenticado.
 */

const SERVICENOW_DOMAIN = 'service-now.com';
const SERVICENOW_URL = 'https://itau.service-now.com/';

const GCK_PATTERNS = [
  /var\s+g_ck\s*=\s*['"]([^'"]+)['"]/,
  /g_ck\s*[:=]\s*['"]([^'"]+)['"]/,
  /"g_ck"\s*:\s*"([^"]+)"/,
];

export interface IuclickCapture {
  cookies: string;
  token: string;
  browser: string;
  profile: string;
}

/** A resposta é a tela de login/SSO (sessão inválida), não uma página logada? */
function isLoginPage(html: string, finalUrl: string): boolean {
  let host = '';
  try {
    host = new URL(finalUrl).hostname;
  } catch {
    // finalUrl estranho — decide pelo HTML abaixo
  }
  // redirecionou para fora do ServiceNow → provedor de identidade (SSO)
  if (host && !host.endsWith('service-now.com')) return true;
  if (/\/(login|sso|saml|oauth2?|auth)(\.do|\.jsp|\/|\?|$)/i.test(finalUrl)) return true;
  return /login\.do|id=["']user_name["']|name=["']user_password["']|SAMLRequest|sysparm_login|glide_sso|single sign-on/i.test(
    html,
  );
}

/** Une cookies base com os Set-Cookie da resposta (o mais novo vence; remove os apagados). */
function mergeCookies(base: string, setCookies: string[]): string {
  const map = new Map<string, string>();
  for (const part of base.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) map.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  for (const sc of setCookies) {
    const first = sc.split(';')[0] ?? '';
    const i = first.indexOf('=');
    if (i <= 0) continue;
    const name = first.slice(0, i).trim();
    const value = first.slice(i + 1).trim();
    const deleted = !value || /max-age=0/i.test(sc) || /expires=Thu, 01 Jan 1970/i.test(sc);
    if (deleted) map.delete(name);
    else map.set(name, value);
  }
  return [...map].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** Busca o g_ck numa página autenticada e devolve o par cookie+token consistente. */
async function fetchAuthSession(cookieString: string): Promise<{ token: string; cookies: string }> {
  const init = requestInitFor(SERVICENOW_URL, {
    Cookie: cookieString,
    'User-Agent': 'Mozilla/5.0',
    Accept: 'text/html',
  });
  let resp: Response;
  try {
    resp = await fetch(SERVICENOW_URL, init as RequestInit);
  } catch (err) {
    throw new Error(
      `Falha de conexão com o ServiceNow ao validar as credenciais: ${err instanceof Error ? err.message : err}. Confira VPN/proxy corporativo.`,
    );
  }
  const finalUrl = resp.url || SERVICENOW_URL;
  const html = await resp.text().catch(() => '');
  if (isLoginPage(html, finalUrl)) {
    throw new Error(
      'A sessão do ServiceNow no navegador expirou (a página caiu no login). Abra o itau.service-now.com já logado, recarregue (F5) e detecte de novo.',
    );
  }
  let token: string | undefined;
  for (const re of GCK_PATTERNS) {
    const m = re.exec(html);
    if (m?.[1]) {
      token = m[1];
      break;
    }
  }
  if (!token) {
    throw new Error(
      `Não encontrei o X-UserToken numa página autenticada do ServiceNow (HTTP ${resp.status}). Recarregue o itau.service-now.com logado e tente de novo.`,
    );
  }
  const headers = resp.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  return { token, cookies: mergeCookies(cookieString, setCookies) };
}

/** Valida uma Cookie string contra o ServiceNow e devolve o par cookie+token. */
async function sessionFromCookies(
  cookieString: string,
  browser: string,
  profile: string,
): Promise<IuclickCapture> {
  const { token, cookies } = await fetchAuthSession(cookieString);
  return { cookies, token, browser, profile };
}

/**
 * Obtém as credenciais do IUClick com dois caminhos, nesta ordem:
 *
 *  1) Leitura direta do banco de cookies (Chrome/Edge/Firefox) — rápida e sem
 *     abrir janela. Funciona no macOS (Keychain), no Firefox (texto puro) e no
 *     Chrome/Edge antigo (v10/DPAPI).
 *  2) Captura pelo próprio navegador via CDP (cdpCapture) — o plano para o
 *     Windows corporativo onde (1) não tem como funcionar: App-Bound Encryption
 *     (Chrome/Edge 127+) e/ou PowerShell bloqueado pelo EDR. Sobe Edge/Chrome
 *     num perfil limpo e deixa o SSO transparente logar.
 *
 * `viaBrowser` pula o passo 1 e vai direto ao navegador — usado pelo botão
 * "Detectar via navegador (SSO)" (e para testar o caminho 2 no macOS, onde o
 * passo 1 sempre venceria).
 */
export async function captureIuclickCredentials(
  opts: { viaBrowser?: boolean } = {},
): Promise<IuclickCapture> {
  await resolveShellEnv();
  const failures: string[] = [];

  if (!opts.viaBrowser) {
    const { hits, problems } = await collectCookieHits(SERVICENOW_DOMAIN);
    for (const hit of hits) {
      try {
        return await sessionFromCookies(hit.cookieString, hit.browser, hit.profile);
      } catch (err) {
        failures.push(`${hit.browser}/${hit.profile}: ${err instanceof Error ? err.message : err}`);
      }
    }
    // sem cookies decifráveis (ex.: App-Bound no Windows) o motivo vem dos problems
    if (!hits.length && problems.length) failures.push(...problems);
  }

  // passo 2: captura via navegador (SSO). Único caminho no Windows App-Bound.
  try {
    const cap = await captureCookiesViaBrowser(SERVICENOW_DOMAIN, SERVICENOW_URL);
    return await sessionFromCookies(cap.cookieString, cap.browser, cap.profile);
  } catch (err) {
    failures.push(`Navegador (SSO): ${err instanceof Error ? err.message : err}`);
  }

  throw new Error(
    'Não consegui obter uma sessão válida do ServiceNow. ' +
      'Abra o itau.service-now.com logado e detecte de novo — ou use o "Copy as cURL" abaixo.' +
      (failures.length ? `\n\nDetalhe:\n· ${failures.join('\n· ')}` : ''),
  );
}

/**
 * Re-detecta e salva as credenciais silenciosamente (best-effort). Usada pela
 * auto-recuperação do mcpManager quando o ServiceNow devolve 403 no meio do
 * chat — se o usuário ainda estiver logado no navegador, cura sozinho.
 */
export async function refreshIuclickCredentials(): Promise<boolean> {
  try {
    const cap = await captureIuclickCredentials();
    await saveIuclickCredentials(cap.cookies, cap.token);
    return true;
  } catch {
    return false;
  }
}
