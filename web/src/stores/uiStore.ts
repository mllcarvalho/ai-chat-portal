import { create } from 'zustand';

export type PanelKind =
  | { kind: 'none' }
  | { kind: 'tools' }
  | { kind: 'skills' }
  | { kind: 'agents' }
  | { kind: 'files' }
  | { kind: 'settings' }
  | { kind: 'newProject' };

interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error' | 'ok';
}

interface UiState {
  panel: PanelKind;
  toasts: Toast[];
  openPanel: (panel: PanelKind) => void;
  closePanel: () => void;
  toast: (text: string, tone?: Toast['tone']) => void;
  dismissToast: (id: number) => void;
}

let toastSeq = 1;

export const useUi = create<UiState>((set, get) => ({
  panel: { kind: 'none' },
  toasts: [],
  openPanel: (panel) => set({ panel }),
  closePanel: () => set({ panel: { kind: 'none' } }),
  toast: (text, tone = 'info') => {
    const id = toastSeq++;
    set({ toasts: [...get().toasts, { id, text, tone }] });
    setTimeout(() => get().dismissToast(id), 5000);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));
