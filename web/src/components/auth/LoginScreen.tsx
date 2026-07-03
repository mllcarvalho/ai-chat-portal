import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useUi } from '../../stores/uiStore';

/**
 * Porta de entrada do portal: usuário RACF + senha. As credenciais configuram
 * o proxy corporativo da máquina (http.proxy do VS Code, HTTP_PROXY/HTTPS_PROXY
 * no .bashrc/.zshrc e strict-ssl/always-auth/cafile no ~/.npmrc). O login fica
 * gravado no navegador — refresh não pede de novo; para trocar de usuário ou
 * atualizar a senha do proxy há o botão ↻ no rodapé da sidebar.
 */
export function LoginScreen() {
  const setLoggedIn = useUi((s) => s.setLoggedIn);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [proxyHost, setProxyHost] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    void api
      .loginStatus()
      .then((status) => {
        if (status.username) setUsername(status.username);
        setProxyHost(status.proxyHost);
      })
      .catch(() => {
        // sem status não tem pré-preenchimento; o login em si continua possível
      });
  }, []);

  const blank = !username.trim() && !password;
  // um preenchido e o outro não: nem configura nem entra — pede para completar ou limpar
  const incomplete = !blank && (!username.trim() || !password);

  const submit = async () => {
    if (incomplete || busy) return;
    if (blank) {
      // máquina pessoal: entra sem tocar em settings.json/.bashrc/.zshrc
      setLoggedIn(true);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api.login(username.trim(), password);
      setLoggedIn(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="onboarding">
      <div className="onboarding__card login-card">
        <h1>
          ai<em>·</em>product<em>·</em>bmad<em>·</em>chat
        </h1>
        <p>
          Entre com seu usuário de rede para configurar o proxy corporativo
          {proxyHost ? ` (${proxyHost})` : ''} no VS Code e no shell desta máquina.
        </p>
        <div className="field">
          <label>Usuário (RACF)</label>
          <input
            autoFocus={!username}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="ex: c1234567"
            autoComplete="username"
            spellCheck={false}
          />
        </div>
        <div className="field">
          <label>Senha</label>
          <input
            autoFocus={!!username}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
            autoComplete="current-password"
          />
        </div>
        {error && <p className="login-card__error">{error}</p>}
        <button
          className="btn btn--primary login-card__submit"
          disabled={busy || incomplete}
          onClick={() => void submit()}
        >
          {busy ? 'Configurando proxy…' : blank ? 'Entrar sem configurar proxy' : 'Entrar'}
        </button>
        <p className="login-card__hint">
          Máquina pessoal, sem proxy corporativo? Deixe os dois campos em branco: nada é alterado
          na máquina. Preenchendo, a senha entra só na URL do proxy gravada nas configurações
          (settings.json, .bashrc/.zshrc, ~/.npmrc e a tela Rede do portal). O login fica salvo
          neste navegador — use o ↻ da sidebar para relogar.
        </p>
      </div>
    </div>
  );
}
