import { create } from 'zustand';

const PREVIEW_MODE_KEY = 'aiportal.previewMode';

export interface PreviewTab {
  path: string;
  name: string;
}

/**
 * Modo preview: split view estilo VS Code — chat de um lado, abas de arquivos
 * do outro. Com o modo ligado, clicar num arquivo no painel Arquivos abre uma
 * aba aqui em vez do visualizador embutido do drawer.
 */
interface PreviewState {
  enabled: boolean;
  toggle: () => void;
  /** Dono das abas (projeto ou workspace da conversa) — trocar de dono fecha tudo. */
  scopeKey?: string;
  tabs: PreviewTab[];
  activePath?: string;
  /** Garante que as abas pertencem ao escopo atual; se mudou, fecha todas. */
  ensureScope: (key: string) => void;
  openTab: (scopeKey: string, tab: PreviewTab) => void;
  setActive: (path: string) => void;
  closeTab: (path: string) => void;
  closeAll: () => void;
  /** Reflete rename de arquivo ou pasta nas abas abertas (prefixo de pasta incluso). */
  applyRename: (oldPath: string, newPath: string) => void;
  /** Fecha abas do arquivo/pasta excluídos. */
  applyDelete: (path: string) => void;
}

const nameOf = (path: string) => path.split('/').pop() ?? path;

function remapPath(path: string, oldPath: string, newPath: string): string | undefined {
  if (path === oldPath) return newPath;
  if (path.startsWith(oldPath + '/')) return newPath + path.slice(oldPath.length);
  return undefined;
}

export const usePreview = create<PreviewState>((set, get) => ({
  enabled: localStorage.getItem(PREVIEW_MODE_KEY) === '1',
  toggle: () => {
    const enabled = !get().enabled;
    localStorage.setItem(PREVIEW_MODE_KEY, enabled ? '1' : '0');
    set({ enabled });
  },
  tabs: [],
  ensureScope: (key) => {
    if (get().scopeKey !== key) set({ scopeKey: key, tabs: [], activePath: undefined });
  },
  openTab: (scopeKey, tab) => {
    const st = get();
    const tabs = st.scopeKey === scopeKey ? st.tabs : [];
    const exists = tabs.some((t) => t.path === tab.path);
    set({
      scopeKey,
      tabs: exists ? tabs : [...tabs, tab],
      activePath: tab.path,
    });
  },
  setActive: (path) => set({ activePath: path }),
  closeTab: (path) => {
    const st = get();
    const idx = st.tabs.findIndex((t) => t.path === path);
    if (idx === -1) return;
    const tabs = st.tabs.filter((t) => t.path !== path);
    let activePath = st.activePath;
    if (st.activePath === path) {
      activePath = (tabs[idx] ?? tabs[idx - 1])?.path;
    }
    set({ tabs, activePath });
  },
  closeAll: () => set({ tabs: [], activePath: undefined }),
  applyRename: (oldPath, newPath) => {
    const st = get();
    const tabs = st.tabs.map((t) => {
      const remapped = remapPath(t.path, oldPath, newPath);
      return remapped ? { path: remapped, name: nameOf(remapped) } : t;
    });
    const activeRemap = st.activePath && remapPath(st.activePath, oldPath, newPath);
    set({ tabs, activePath: activeRemap || st.activePath });
  },
  applyDelete: (path) => {
    const st = get();
    const doomed = st.tabs.filter((t) => t.path === path || t.path.startsWith(path + '/'));
    if (!doomed.length) return;
    const tabs = st.tabs.filter((t) => !doomed.includes(t));
    const activeGone = doomed.some((t) => t.path === st.activePath);
    set({ tabs, activePath: activeGone ? tabs[tabs.length - 1]?.path : st.activePath });
  },
}));
