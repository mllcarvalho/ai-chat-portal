import { useEffect, useState } from 'react';
import { useCatalog } from '../../stores/catalogStore';
import { useSessions } from '../../stores/sessionsStore';
import { getToken } from '../../api/client';

function Check(props: { ok: boolean | undefined; label: string; hint?: string }) {
  return (
    <div className="check-item">
      <span
        className={`check-item__mark${
          props.ok === true ? ' check-item__mark--ok' : props.ok === false ? ' check-item__mark--fail' : ''
        }`}
      >
        {props.ok === true ? '✓' : props.ok === false ? '✕' : '…'}
      </span>
      <div>
        <div className="check-item__label">{props.label}</div>
        {props.hint && <div className="check-item__hint">{props.hint}</div>}
      </div>
    </div>
  );
}

export function OnboardingScreen() {
  const health = useCatalog((s) => s.health);
  const loadHealth = useCatalog((s) => s.loadHealth);
  const loadAll = useCatalog((s) => s.loadAll);
  const loadProjects = useSessions((s) => s.loadProjects);
  const loadSessions = useSessions((s) => s.loadSessions);
  const [serverUp, setServerUp] = useState<boolean | undefined>(undefined);
  const hasToken = !!getToken();

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const h = await loadHealth();
      if (cancelled) return;
      setServerUp(!!h);
      if (h?.ok) {
        await Promise.all([loadAll(), loadProjects(), loadSessions(null)]);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [loadHealth, loadAll, loadProjects, loadSessions]);

  return (
    <div className="onboarding">
      <div className="onboarding__card">
        <h1>
          ai<em>·</em>product<em>·</em>bmad<em>·</em>chat
        </h1>
        <p>Quase lá — verificando o ambiente. Esta tela atualiza sozinha a cada 3 segundos.</p>

        <Check
          ok={serverUp}
          label="Servidor do portal ativo"
          hint={
            serverUp === false
              ? 'Abra o VS Code (a extensão BMAD Product Studio sobe o servidor automaticamente) ou rode npm start na pasta do projeto.'
              : undefined
          }
        />
        <Check
          ok={serverUp ? health?.copilotChatInstalled : undefined}
          label="GitHub Copilot Chat instalado"
          hint={
            serverUp && health && !health.copilotChatInstalled
              ? 'Instale a extensão "GitHub Copilot Chat" no VS Code.'
              : undefined
          }
        />
        <Check
          ok={serverUp ? !!health?.account : undefined}
          label="Conta GitHub conectada"
          hint={
            serverUp && health && !health.account
              ? 'Entre com sua conta GitHub no VS Code (menu Accounts, canto inferior esquerdo).'
              : health?.account
                ? `Conectado como ${health.account.label}`
                : undefined
          }
        />
        <Check
          ok={serverUp ? (health ? health.modelCount > 0 : undefined) : undefined}
          label={`Modelos do Copilot disponíveis${health?.modelCount ? ` (${health.modelCount})` : ''}`}
          hint={
            serverUp && health && health.modelCount === 0
              ? 'Abra o chat do Copilot no VS Code uma vez para ativar os modelos.'
              : undefined
          }
        />
        {!hasToken && serverUp && (
          <p style={{ marginTop: 16 }}>
            ⚠️ Sem token de acesso: abra o portal pelo comando{' '}
            <strong>"BMAD Product Studio: Abrir no Navegador"</strong> no VS Code (Cmd/Ctrl+Shift+P) para
            entrar autenticado.
          </p>
        )}
      </div>
    </div>
  );
}
