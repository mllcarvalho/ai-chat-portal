import { create } from 'zustand';
import type { DiagnosticsReport } from '@aiportal/shared';
import { api } from '../api/client';

/**
 * Diagnóstico do ambiente: dispara na abertura do portal (App) e sob demanda
 * na página. O backend roda em background; aqui fazemos o polling até acabar.
 * O banner só interrompe quando problemCount > 0 (algum check vermelho).
 */
interface DiagnosticsState {
  report?: DiagnosticsReport;
  /** Última mensagem de correção aplicada (toast da página). */
  fixMessage?: string;
  fixError?: string;
  fixingId?: string;
  /** Banner dispensado nesta sessão do browser. */
  bannerDismissed: boolean;
  dismissBanner: () => void;
  /** Dispara o run em background e acompanha até terminar. */
  start: () => Promise<void>;
  refresh: () => Promise<void>;
  fix: (id: string) => Promise<void>;
}

let pollTimer: number | undefined;

export const useDiagnostics = create<DiagnosticsState>((set, get) => {
  const poll = () => {
    if (pollTimer) window.clearTimeout(pollTimer);
    pollTimer = window.setTimeout(async () => {
      try {
        const report = await api.getDiagnostics();
        set({ report });
        if (report.running) poll();
      } catch {
        // servidor indisponível — para o polling; um novo start recomeça
      }
    }, 1000);
  };

  return {
    bannerDismissed: false,
    dismissBanner: () => set({ bannerDismissed: true }),

    start: async () => {
      try {
        const report = await api.runDiagnostics();
        set({ report });
        if (report.running) poll();
      } catch {
        // sem diagnóstico não se bloqueia o portal
      }
    },

    refresh: async () => {
      try {
        const report = await api.getDiagnostics();
        set({ report });
        if (report.running) poll();
      } catch {
        // idem
      }
    },

    fix: async (id: string) => {
      set({ fixingId: id, fixMessage: undefined, fixError: undefined });
      try {
        const { message, report } = await api.fixDiagnostic(id);
        set({ fixMessage: message, report, fixingId: undefined });
        if (report.running) poll();
      } catch (err) {
        set({ fixError: (err as Error).message, fixingId: undefined });
      }
    },
  };
});
