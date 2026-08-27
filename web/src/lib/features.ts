/**
 * Flags de funcionalidade da UI. O multiplayer (colaboração em rede, presença,
 * executor federado, convites) está PRONTO no código, mas escondido por
 * enquanto — a rede corporativa do banco não permite o uso entre máquinas.
 * Ligar de novo é trocar este valor para true (o servidor já respeita o
 * collab.enabled do config, que segue desligado por padrão).
 *
 * O Quadro do squad e as Configurações-como-página continuam visíveis: são
 * úteis single-player e não expõem o multiplayer.
 */
export const MULTIPLAYER_UI = false;
