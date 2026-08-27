import { RefreshCw } from 'lucide-react';
import { useCatalog } from '../../stores/catalogStore';
import { useCollab } from '../../stores/collabStore';
import { useUi } from '../../stores/uiStore';

export function UserBadge() {
  const me = useCatalog((s) => s.me);
  const identity = useCollab((s) => s.identity);
  const setLoggedIn = useUi((s) => s.setLoggedIn);

  // convidado (modo colaboração): mostra a identidade do convite, sem o
  // relogin RACF — isso configuraria o proxy da máquina do HOST
  if (identity?.role === 'guest') {
    return (
      <div className="user-badge" title={`Convidado nesta sessão como ${identity.name}`}>
        <span className="collab-avatar" style={{ background: identity.color }}>
          {identity.name
            .trim()
            .split(/\s+/)
            .slice(0, 2)
            .map((p) => p[0]?.toUpperCase() ?? '')
            .join('') || '?'}
        </span>
        <span className="user-badge__login">{identity.name} · convidado</span>
      </div>
    );
  }

  return (
    <div className="user-badge" title={me ? `Conectado como ${me.login} (via VS Code)` : undefined}>
      {me && (
        <>
          <img src={me.avatarUrl} alt={me.login} />
          <span className="user-badge__login">{me.login}</span>
        </>
      )}
      <button
        className="user-badge__relogin"
        title="Refazer login (trocar usuário ou atualizar a senha do proxy)"
        aria-label="Refazer login"
        onClick={() => setLoggedIn(false)}
      >
        <RefreshCw className="icon icon--sm" aria-hidden />
      </button>
    </div>
  );
}
