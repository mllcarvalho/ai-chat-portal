import { secretStore } from './mcpProxyStore';

/**
 * Credenciais do MCP IUClick (ServiceNow Itaú): Cookie e X-UserToken capturados
 * do browser. São credenciais de sessão (expiram) e a doc interna proíbe
 * guardá-las em arquivo — ficam no SecretStorage do VS Code e entram como env
 * (IUCLICK_COOKIES / IUCLICK_TOKEN) só na hora de spawnar o servidor, sem
 * nunca tocar o mcp.json.
 */

export const IUCLICK_SERVER_NAME = 'iuclick';

const COOKIES_KEY = 'iuclick:cookies';
const TOKEN_KEY = 'iuclick:token';

export async function saveIuclickCredentials(cookies: string, token: string): Promise<void> {
  const secrets = secretStore();
  if (!secrets) throw new Error('SecretStorage indisponível — reinicie o VS Code');
  await secrets.store(COOKIES_KEY, cookies);
  await secrets.store(TOKEN_KEY, token);
}

export async function hasIuclickCredentials(): Promise<boolean> {
  const secrets = secretStore();
  if (!secrets) return false;
  return !!(await secrets.get(COOKIES_KEY)) && !!(await secrets.get(TOKEN_KEY));
}

/** Env para o spawn do servidor — undefined quando não há credenciais salvas. */
export async function getIuclickEnv(): Promise<Record<string, string> | undefined> {
  const secrets = secretStore();
  if (!secrets) return undefined;
  const cookies = await secrets.get(COOKIES_KEY);
  const token = await secrets.get(TOKEN_KEY);
  if (!cookies || !token) return undefined;
  return { IUCLICK_COOKIES: cookies, IUCLICK_TOKEN: token };
}

export async function clearIuclickCredentials(): Promise<void> {
  const secrets = secretStore();
  if (!secrets) return;
  try {
    await secrets.delete(COOKIES_KEY);
    await secrets.delete(TOKEN_KEY);
  } catch {
    // best-effort
  }
}
