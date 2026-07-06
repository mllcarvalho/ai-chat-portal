import { create } from 'zustand';

/** Conteúdo da área principal: home (MESA/PROJETO), chat ou as páginas de gestão. */
export type MainView =
  | 'home'
  | 'chat'
  | 'skills'
  | 'agents'
  | 'mcps'
  | 'knowledge'
  | 'bmadDoc'
  | 'diagnostics';

/** Sobreposições leves que continuam como modal/drawer. */
export type PanelKind =
  | { kind: 'none' }
  | { kind: 'files' }
  | { kind: 'settings' }
  | { kind: 'newProject' };

interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error' | 'ok';
}

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Ação destrutiva: botão de confirmar em vermelho. */
  danger?: boolean;
}

const HIDE_TOOL_CARDS_KEY = 'aiportal.hideToolCards';
const LOGGED_IN_KEY = 'aiportal.loggedIn';
const SIDEBAR_COLLAPSED_KEY = 'aiportal.sidebarCollapsed';

interface UiState {
  view: MainView;
  panel: PanelKind;
  toasts: Toast[];
  /**
   * Login RACF feito neste navegador — persiste entre refreshes (localStorage).
   * Para trocar de usuário ou atualizar a senha do proxy, o botão ↻ ao lado do
   * nome do usuário (rodapé da sidebar) volta para a tela de login.
   */
  loggedIn: boolean;
  setLoggedIn: (loggedIn: boolean) => void;
  /**
   * Oculta os cards técnicos de ferramentas (portal_write_file etc.) no chat.
   * Pedidos de aprovação aparecem sempre, independente desta preferência.
   */
  hideToolCards: boolean;
  setHideToolCards: (hide: boolean) => void;
  /** Sidebar recolhida num trilho de ícones — persiste entre refreshes. */
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  /** Incrementa quando uma ferramenta mexe nos arquivos — o painel Arquivos recarrega sozinho. */
  filesVersion: number;
  bumpFilesVersion: () => void;
  /** Confirmação pendente (renderizada pelo ConfirmDialog). */
  confirmState?: ConfirmOptions & { resolve: (ok: boolean) => void };
  /** Texto a inserir no composer (ex: comando slash escolhido num menu). */
  composerSeed?: string;
  setView: (view: MainView) => void;
  openPanel: (panel: PanelKind) => void;
  closePanel: () => void;
  seedComposer: (text: string) => void;
  clearComposerSeed: () => void;
  toast: (text: string, tone?: Toast['tone']) => void;
  dismissToast: (id: number) => void;
  /** Substituto do window.confirm com o layout do portal. */
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  resolveConfirm: (ok: boolean) => void;
}

let toastSeq = 1;

export const useUi = create<UiState>((set, get) => ({
  view: 'home',
  panel: { kind: 'none' },
  toasts: [],
  loggedIn: localStorage.getItem(LOGGED_IN_KEY) === '1',
  setLoggedIn: (loggedIn) => {
    localStorage.setItem(LOGGED_IN_KEY, loggedIn ? '1' : '0');
    set({ loggedIn });
  },
  hideToolCards: localStorage.getItem(HIDE_TOOL_CARDS_KEY) === '1',
  setHideToolCards: (hide) => {
    localStorage.setItem(HIDE_TOOL_CARDS_KEY, hide ? '1' : '0');
    set({ hideToolCards: hide });
  },
  sidebarCollapsed: localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1',
  toggleSidebar: () => {
    const collapsed = !get().sidebarCollapsed;
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
    set({ sidebarCollapsed: collapsed });
  },
  filesVersion: 0,
  bumpFilesVersion: () => set({ filesVersion: get().filesVersion + 1 }),
  setView: (view) => set({ view }),
  seedComposer: (text) => set({ composerSeed: text, view: 'chat' }),
  clearComposerSeed: () => set({ composerSeed: undefined }),
  openPanel: (panel) => set({ panel }),
  closePanel: () => set({ panel: { kind: 'none' } }),
  toast: (text, tone = 'info') => {
    const id = toastSeq++;
    set({ toasts: [...get().toasts, { id, text, tone }] });
    setTimeout(() => get().dismissToast(id), 5000);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  confirm: (opts) =>
    new Promise<boolean>((resolve) => {
      // só uma confirmação por vez; a anterior é cancelada
      get().confirmState?.resolve(false);
      set({ confirmState: { ...opts, resolve } });
    }),
  resolveConfirm: (ok) => {
    const pending = get().confirmState;
    set({ confirmState: undefined });
    pending?.resolve(ok);
  },
}));
