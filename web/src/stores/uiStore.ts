import { create } from 'zustand';

/** Conteúdo da área principal: chat ou as páginas de gestão (tela cheia). */
export type MainView = 'chat' | 'skills' | 'agents' | 'mcps' | 'knowledge';

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

interface UiState {
  view: MainView;
  panel: PanelKind;
  toasts: Toast[];
  setView: (view: MainView) => void;
  openPanel: (panel: PanelKind) => void;
  closePanel: () => void;
  toast: (text: string, tone?: Toast['tone']) => void;
  dismissToast: (id: number) => void;
}

let toastSeq = 1;

export const useUi = create<UiState>((set, get) => ({
  view: 'chat',
  panel: { kind: 'none' },
  toasts: [],
  setView: (view) => set({ view }),
  openPanel: (panel) => set({ panel }),
  closePanel: () => set({ panel: { kind: 'none' } }),
  toast: (text, tone = 'info') => {
    const id = toastSeq++;
    set({ toasts: [...get().toasts, { id, text, tone }] });
    setTimeout(() => get().dismissToast(id), 5000);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));
