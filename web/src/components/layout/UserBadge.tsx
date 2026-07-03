import { useCatalog } from '../../stores/catalogStore';
import { useUi } from '../../stores/uiStore';

export function UserBadge() {
  const me = useCatalog((s) => s.me);
  const setLoggedIn = useUi((s) => s.setLoggedIn);
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
        ↻
      </button>
    </div>
  );
}
