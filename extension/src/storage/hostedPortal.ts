import * as vscode from 'vscode';
import { getConfig } from './configStore';

/**
 * Portal hospedado: a UI publicada pela empresa (CloudFront/S3) em vez de
 * servida pela extensão. Duas fontes, nesta ordem:
 *
 * 1. configuração do VS Code `aiChatPortal.hostedPortalUrl` — é o que uma
 *    política corporativa consegue empurrar para todas as máquinas;
 * 2. `hostedPortalUrl` no config.json do portal — editável pela tela de
 *    configurações e pelo bootstrap.
 *
 * Vazio nas duas = comportamento de sempre (a extensão serve a UI local).
 */
export function hostedPortalUrl(): string | undefined {
  const fromSetting = vscode.workspace.getConfiguration('aiChatPortal').get<string>('hostedPortalUrl');
  return normalizeOrigin(fromSetting) ?? normalizeOrigin(getConfig().hostedPortalUrl);
}

/** Origem válida (http/https), sem barra ou caminho; undefined para vazio/inválido. */
export function normalizeOrigin(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** URL que abre o portal hospedado já apontando para a extensão desta máquina. */
export function buildHostedUrl(origin: string, port: number, token: string): string {
  const server = encodeURIComponent(`http://127.0.0.1:${port}`);
  return `${origin}/?server=${server}&token=${token}`;
}
