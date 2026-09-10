import { isHosted } from '../api/server';

/**
 * Flags de funcionalidade da UI. O multiplayer (colaboração em rede, presença,
 * executor federado, convites) está PRONTO no código, mas escondido no uso
 * local — a rede corporativa do banco não permite máquinas se enxergarem pela
 * LAN.
 *
 * No portal hospedado (UI no CloudFront/S3 da empresa) ele liga sozinho: ali os
 * convidados chegam pelo relay, sem depender da LAN — é o caso que a rede
 * permite. Para forçar no uso local (dev), troque para `true`.
 *
 * O Quadro do squad e as Configurações-como-página continuam visíveis: são
 * úteis single-player e não expõem o multiplayer.
 */
export const MULTIPLAYER_UI = isHosted();
