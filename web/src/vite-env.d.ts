/// <reference types="vite/client" />

/** Versão da extensão embutida no build (vite define). */
declare const __PORTAL_VERSION__: string;
/** Nome do pacote npm do instalador (bmad-product-studio ou -beta). */
declare const __INSTALLER_PKG__: string;

interface Window {
  /** Injetado pelo relay no index.html: a página veio de um portal hospedado. */
  __AIPORTAL_HOSTED__?: number;
  /** Injetado pelo relay (RELAY_SETUP_URL): página de instalação da empresa. */
  __AIPORTAL_SETUP_URL__?: string;
}
