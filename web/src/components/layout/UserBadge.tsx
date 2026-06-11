import { useCatalog } from '../../stores/catalogStore';

export function UserBadge() {
  const me = useCatalog((s) => s.me);
  if (!me) return null;
  return (
    <div className="user-badge" title={`Conectado como ${me.login} (via VS Code)`}>
      <img src={me.avatarUrl} alt={me.login} />
      <span className="user-badge__login">{me.login}</span>
    </div>
  );
}
