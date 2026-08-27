import * as crypto from 'node:crypto';
import * as os from 'node:os';
import type { CollabConfig, CollabGuest, CollabIdentity } from '@aiportal/shared';
import { emitBus } from '../events/bus';
import { getConfig, patchConfig } from './configStore';
import { tokenMatches } from '../server/tokenCheck';

/** Paleta de cores estáveis dos convidados (contraste ok no fundo claro). */
const GUEST_COLORS = ['#1d4fa0', '#178246', '#c93a2c', '#7c3aed', '#a87900', '#0e7490'];
/** Cor do host na presença/autoria. */
export const HOST_COLOR = '#ec7000';

export function collabConfig(): CollabConfig {
  return getConfig().collab ?? { enabled: false, guests: [] };
}

export function collabEnabled(): boolean {
  return collabConfig().enabled;
}

function saveCollab(collab: CollabConfig): void {
  patchConfig({ collab });
  emitBus('collab_changed', {});
}

export function setCollabEnabled(enabled: boolean): CollabConfig {
  const collab = { ...collabConfig(), enabled };
  saveCollab(collab);
  return collab;
}

export function setHostName(hostName: string): CollabConfig {
  const collab = { ...collabConfig(), hostName: hostName.trim() || undefined };
  saveCollab(collab);
  return collab;
}

export function addGuest(name: string): CollabGuest {
  const collab = collabConfig();
  const guest: CollabGuest = {
    id: crypto.randomUUID(),
    name: name.trim(),
    // token menor que o do host (vai em URL falada/colada), ainda impraticável
    // de adivinhar: 16 bytes = 128 bits
    token: crypto.randomBytes(16).toString('hex'),
    color: GUEST_COLORS[collab.guests.length % GUEST_COLORS.length],
    createdAt: new Date().toISOString(),
  };
  saveCollab({ ...collab, guests: [...collab.guests, guest] });
  return guest;
}

/** Revoga o token (o registro fica para histórico); `purge` remove de vez. */
export function revokeGuest(id: string, purge = false): boolean {
  const collab = collabConfig();
  const guest = collab.guests.find((g) => g.id === id);
  if (!guest) return false;
  const guests = purge
    ? collab.guests.filter((g) => g.id !== id)
    : collab.guests.map((g) => (g.id === id ? { ...g, revoked: true } : g));
  saveCollab({ ...collab, guests });
  return true;
}

/**
 * Identidade de quem apresentou este token: host (token do config) ou um
 * convidado ativo. undefined = token inválido/revogado.
 */
export function identityForToken(token: unknown): CollabIdentity | undefined {
  const config = getConfig();
  if (tokenMatches(token, config.token)) {
    return { role: 'host', name: hostDisplayName(), color: HOST_COLOR };
  }
  // convidados só valem com a colaboração ligada: desligar o modo host
  // desliga todos os acessos de uma vez, sem revogar convite por convite
  const collab = config.collab;
  if (!collab?.enabled) return undefined;
  for (const guest of collab.guests) {
    if (guest.revoked) continue;
    if (tokenMatches(token, guest.token)) {
      return { role: 'guest', guestId: guest.id, name: guest.name, color: guest.color };
    }
  }
  return undefined;
}

let cachedAccountLabel: string | undefined;

/** Rótulo da conta GitHub do host (best effort; setado pela rota /api/me). */
export function setHostAccountLabel(label: string): void {
  cachedAccountLabel = label;
}

export function hostDisplayName(): string {
  return collabConfig().hostName || cachedAccountLabel || os.userInfo().username || 'Host';
}

/** IPv4 da máquina na(s) rede(s) local(is) — é por onde o squad entra. */
export function lanAddresses(): string[] {
  const addresses: string[] = [];
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      addresses.push(info.address);
    }
  }
  return addresses;
}
