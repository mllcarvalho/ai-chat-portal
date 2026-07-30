import { useEffect, useState } from 'react';
import { Check as CheckIcon, TriangleAlert, X } from 'lucide-react';
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
        {props.ok === true ? (
          <CheckIcon className="icon icon--sm" aria-hidden />
        ) : props.ok === false ? (
          <X className="icon icon--sm" aria-hidden />
        ) : (
          '…'
        )}
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

  const providers = health?.providers ?? [];
  const anyReady = providers.some((p) => p.available);
  // servidor de pé mas sem o campo `providers` = extensão rodando build antiga
  const staleServer = !!serverUp && !!health && health.providers === undefined;

  return (
    <div className="onboarding">
      <div className="onboarding__card">
        <h1>
          bmad<em>·</em>product<em>·</em>studio
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
        {/*
          Basta UM motor para entrar: quem só tem Claude Code não precisa do
          Copilot, e vice-versa. Por isso os motores são listados como estado
          informativo, e o único check que trava é "pelo menos um".

          `providers` pode não existir: a extensão serve este bundle lendo do
          disco, então uma instalação nova troca o web na hora enquanto o
          servidor segue com o código antigo até a janela do VS Code
          recarregar. Sem o `?? []` a tela inteira quebra em branco nessa
          janela — justamente quando o usuário mais precisa da instrução.
        */}
        <Check
          ok={staleServer ? false : serverUp && providers.length ? anyReady : undefined}
          label="Pelo menos um motor de IA disponível"
          hint={
            staleServer
              ? 'O servidor do portal ainda está com a versão anterior. No VS Code: Cmd/Ctrl+Shift+P → "Developer: Reload Window".'
              : serverUp && providers.length && !anyReady
                ? 'Configure um dos motores abaixo — qualquer um já libera o portal.'
                : undefined
          }
        />
        {providers.length > 0 && (
          <div className="onboarding__providers">
            {providers.map((p) => (
              <Check key={p.id} ok={p.available} label={p.label} hint={p.detail} />
            ))}
          </div>
        )}
        {serverUp && health?.account && (
          <p className="onboarding__note">Conta GitHub conectada: {health.account.label}</p>
        )}
        {!hasToken && serverUp && (
          <p style={{ marginTop: 16 }}>
            <TriangleAlert className="icon" aria-hidden /> Sem token de acesso: abra o portal pelo
            comando{' '}
            <strong>"BMAD Product Studio: Abrir no Navegador"</strong> no VS Code (Cmd/Ctrl+Shift+P) para
            entrar autenticado.
          </p>
        )}
      </div>
    </div>
  );
}
