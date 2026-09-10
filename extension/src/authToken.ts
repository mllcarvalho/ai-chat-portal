import type { RuntimeInfo } from '@aiportal/shared';
import { readJson, writeJsonAtomic, deleteFile } from './storage/jsonStore';
import { RUNTIME_PATH } from './storage/paths';
import { buildHostedUrl, hostedPortalUrl } from './storage/hostedPortal';

export function buildLocalUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/?token=${token}`;
}

/**
 * URL que abre o portal: a local, ou — se a empresa publica a UI num
 * endereço próprio — a hospedada com ?server= apontando para esta máquina.
 */
export function buildPortalUrl(port: number, token: string): string {
  const hosted = hostedPortalUrl();
  return hosted ? buildHostedUrl(hosted, port, token) : buildLocalUrl(port, token);
}

/** runtime.json é como o script de setup e o usuário descobrem a URL do portal. */
export function writeRuntime(port: number, token: string, version: string): RuntimeInfo {
  const info: RuntimeInfo = {
    port,
    portalUrl: buildPortalUrl(port, token),
    localUrl: buildLocalUrl(port, token),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    version,
  };
  writeJsonAtomic(RUNTIME_PATH, info);
  return info;
}

export function readRuntime(): RuntimeInfo | undefined {
  return readJson<RuntimeInfo>(RUNTIME_PATH);
}

export function clearRuntime(): void {
  const current = readRuntime();
  // só apaga se foi este processo que escreveu (evita corrida entre janelas)
  if (current && current.pid === process.pid) deleteFile(RUNTIME_PATH);
}
