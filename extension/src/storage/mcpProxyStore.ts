import type { McpProxyConfig } from '@aiportal/shared';
import { readJson, writeJsonAtomic } from './jsonStore';
import { mcpProxiesPath } from './paths';

/**
 * Armazena as configs dos proxies MCP OAuth2. A parte não-sensível (nome,
 * URLs, clientId, scope) vai num JSON em portal-data/; o client_secret vai no
 * SecretStorage do VS Code (keychain do SO, cifrado em repouso) e nunca volta
 * ao front.
 */

/** Subconjunto do vscode.SecretStorage — injetado na ativação para não acoplar a vscode aqui. */
export interface SecretStore {
  get(key: string): Thenable<string | undefined> | Promise<string | undefined>;
  store(key: string, value: string): Thenable<void> | Promise<void>;
  delete(key: string): Thenable<void> | Promise<void>;
}

let secrets: SecretStore | undefined;

export function setSecretStore(store: SecretStore): void {
  secrets = store;
}

function secretKey(name: string): string {
  return `mcp-proxy-secret:${name}`;
}

interface ProxyFile {
  proxies: Record<string, McpProxyConfig>;
}

function readFile(): ProxyFile {
  return readJson<ProxyFile>(mcpProxiesPath()) ?? { proxies: {} };
}

function writeFile(data: ProxyFile): void {
  writeJsonAtomic(mcpProxiesPath(), data);
}

export function listProxies(): McpProxyConfig[] {
  return Object.values(readFile().proxies);
}

export function getProxy(name: string): McpProxyConfig | undefined {
  return readFile().proxies[name];
}

export function isProxy(name: string): boolean {
  return !!readFile().proxies[name];
}

/** Cria ou atualiza um proxy. O secret só é regravado quando informado. */
export async function saveProxy(
  config: McpProxyConfig,
  clientSecret?: string,
): Promise<McpProxyConfig> {
  if (!secrets) throw new Error('SecretStorage indisponível — reinicie o VS Code');
  const name = config.name.trim();
  if (!name) throw new Error('Informe o nome do proxy');
  if (!config.tokenUrl?.trim()) throw new Error('Informe o Token URL');
  if (!config.gatewayUrl?.trim()) throw new Error('Informe o MCP Gateway URL');
  if (!config.clientId?.trim()) throw new Error('Informe o Client ID');

  const clean: McpProxyConfig = {
    name,
    tokenUrl: config.tokenUrl.trim(),
    gatewayUrl: config.gatewayUrl.trim(),
    clientId: config.clientId.trim(),
    scope: config.scope?.trim() || undefined,
  };

  const file = readFile();
  const isNew = !file.proxies[name];
  if (isNew && clientSecret === undefined) {
    throw new Error('Informe o Client Secret');
  }
  file.proxies[name] = clean;
  writeFile(file);
  if (clientSecret !== undefined && clientSecret !== '') {
    await secrets.store(secretKey(name), clientSecret);
  }
  return clean;
}

export async function getProxySecret(name: string): Promise<string | undefined> {
  if (!secrets) return undefined;
  return secrets.get(secretKey(name));
}

export async function deleteProxy(name: string): Promise<void> {
  const file = readFile();
  if (file.proxies[name]) {
    delete file.proxies[name];
    writeFile(file);
  }
  if (secrets) {
    try {
      await secrets.delete(secretKey(name));
    } catch {
      // best-effort
    }
  }
}
