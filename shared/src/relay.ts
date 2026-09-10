/**
 * Contrato do relay (portal hospedado). O relay é um serviço burro na nuvem
 * que só encaminha bytes: o convidado fala HTTPS com ele, e ele repassa cada
 * request para a ABA do host por WebSocket; a aba repete o request contra a
 * extensão local (127.0.0.1) e devolve a resposta em pedaços. Nenhum dado
 * fica no relay — storage, licença, ferramentas e MCPs seguem na máquina do
 * host.
 *
 * Caminhos (todos sob RELAY_PREFIX, roteados pelo CloudFront/ALB ao relay):
 *   WS   /relay/:room/host?key=…     aba do host (a ponte)
 *   ANY  /relay/:room/api/*          request de convidado, encaminhado à sala
 *   GET  /relay/health               target group do ALB
 *
 * A sala é auto-autenticada: room = sha256(key) truncado. O host guarda a
 * chave, e o relay só precisa conferir o hash — sem registro, sem banco.
 */

export const RELAY_PREFIX = '/relay';

/** Tamanho do id da sala (hex do sha256 truncado). */
export const RELAY_ROOM_ID_LENGTH = 32;

/** Corpo máximo de um request encaminhado (uploads de anexo passam por aqui). */
export const RELAY_MAX_BODY_BYTES = 25 * 1024 * 1024;

/** Mensagens relay → aba do host. Corpos vão em base64 (JSON é seguro para binário assim). */
export type RelayToHostMessage =
  | {
      t: 'req';
      id: string;
      method: string;
      /** Caminho já sem o prefixo da sala: começa em /api/. */
      path: string;
      headers: Record<string, string>;
      body?: string;
    }
  | { t: 'abort'; id: string };

/** Mensagens aba do host → relay. */
export type HostToRelayMessage =
  | { t: 'head'; id: string; status: number; headers: Record<string, string> }
  | { t: 'chunk'; id: string; data: string }
  | { t: 'end'; id: string }
  | { t: 'err'; id: string; message: string };

/**
 * Headers que a ponte repassa da requisição do convidado. O token vai junto:
 * é a extensão do host quem decide o papel de quem chamou — a ponte nunca
 * substitui pelo token do host.
 */
export const RELAY_FORWARDED_REQUEST_HEADERS = [
  'content-type',
  'accept',
  'x-portal-token',
  'x-portal-client',
] as const;

/** Headers da resposta local que voltam ao convidado. */
export const RELAY_FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'content-disposition',
  'cache-control',
] as const;

/** Monta a base da API de um convidado que entra pelo relay. */
export function relayApiBase(origin: string, roomId: string): string {
  return `${origin.replace(/\/+$/, '')}${RELAY_PREFIX}/${roomId}`;
}

/** URL do WebSocket da ponte (a aba do host). */
export function relayHostSocketUrl(origin: string, roomId: string, key: string): string {
  const ws = origin.replace(/\/+$/, '').replace(/^http/, 'ws');
  return `${ws}${RELAY_PREFIX}/${roomId}/host?key=${encodeURIComponent(key)}`;
}

/** Link de convite pelo portal hospedado. */
export function relayJoinUrl(origin: string, roomId: string, guestToken: string): string {
  return `${origin.replace(/\/+$/, '')}/?room=${roomId}&token=${guestToken}`;
}
