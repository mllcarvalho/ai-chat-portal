import { useEffect, useState } from 'react';
import { Check as CheckIcon, Copy, X } from 'lucide-react';
import { DEFAULT_PORT, PORT_RANGE } from '@aiportal/shared';
import { installCommand, setupUrl, versionOlder } from '../../api/server';
import { copyText } from '../../lib/compat';

/**
 * Tela de boas-vindas do portal hospedado: a pessoa abriu o link da empresa
 * sem ?server= (primeiro acesso, ou favorito salvo). A interface está aqui,
 * mas o servidor é a extensão do VS Code na máquina dela — então esta tela
 * sonda 127.0.0.1, diz o que falta e dá os comandos prontos:
 *
 * - nada rodando → passo a passo de instalação (VS Code, bootstrap da
 *   empresa em /setup.html, e o `npx … --portal <este endereço>`);
 * - rodando mas atrasada → comando de atualizar (a UI hospedada é sempre a
 *   mais nova; extensão velha pode não falar o mesmo contrato);
 * - rodando e atual → como entrar autenticado (o token só a extensão tem).
 */

interface LocalPortal {
  port: number;
  version: string;
}

const PROBE_EVERY_MS = 5000;

async function probeLocal(): Promise<LocalPortal | null> {
  const ports = Array.from({ length: PORT_RANGE + 1 }, (_, i) => DEFAULT_PORT + i);
  const results = await Promise.all(
    ports.map(async (port) => {
      try {
        // o health pode levar alguns segundos (modelos/conta com rede ruim)
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return null;
        const health = (await res.json()) as { version?: unknown };
        return typeof health.version === 'string' ? { port, version: health.version } : null;
      } catch {
        return null;
      }
    }),
  );
  return results.find((r) => r !== null) ?? null;
}

function Command(props: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void copyText(props.text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      },
      () => undefined,
    );
  return (
    <div className="welcome-cmd">
      <code>{props.text}</code>
      <button className="btn btn--sm" onClick={copy} title="Copiar comando">
        {copied ? <CheckIcon className="icon icon--sm" aria-hidden /> : <Copy className="icon icon--sm" aria-hidden />}
        {copied ? 'copiado' : 'copiar'}
      </button>
    </div>
  );
}

export function HostedWelcome() {
  // undefined = ainda sondando; null = nada rodando
  const [local, setLocal] = useState<LocalPortal | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      const found = await probeLocal();
      running = false;
      if (!cancelled) setLocal(found);
    };
    void tick();
    const timer = setInterval(() => void tick(), PROBE_EVERY_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const cmd = installCommand();
  const outdated = !!local && versionOlder(local.version, __PORTAL_VERSION__);
  const mark = local === undefined ? '…' : local && !outdated ? 'ok' : 'fail';

  return (
    <div className="onboarding">
      <div className="onboarding__card onboarding__card--wide">
        <h1>
          bmad<em>·</em>product<em>·</em>studio
        </h1>
        <p>
          A interface está aqui, mas quem trabalha é a extensão do VS Code na <strong>sua máquina</strong>: é
          ela que fala com o Copilot, com os seus arquivos e com os MCPs. Nada disso sai do seu computador.
        </p>

        <div className="check-item">
          <span
            className={`check-item__mark${mark === 'ok' ? ' check-item__mark--ok' : mark === 'fail' ? ' check-item__mark--fail' : ''}`}
          >
            {mark === 'ok' ? (
              <CheckIcon className="icon icon--sm" aria-hidden />
            ) : mark === 'fail' ? (
              <X className="icon icon--sm" aria-hidden />
            ) : (
              '…'
            )}
          </span>
          <div>
            <div className="check-item__label">
              {local === undefined
                ? 'Procurando a extensão nesta máquina…'
                : local === null
                  ? 'Nenhuma extensão do BMAD Studio rodando nesta máquina'
                  : outdated
                    ? `Extensão desatualizada (v${local.version} — o portal está na v${__PORTAL_VERSION__})`
                    : `Extensão encontrada (v${local.version}, porta ${local.port})`}
            </div>
            <div className="check-item__hint">
              {local === undefined &&
                'Se o navegador perguntar sobre acesso à rede local, permita — é assim que esta página encontra a extensão.'}
              {local === null && 'Esta tela procura de novo a cada 5 segundos.'}
              {local && outdated && 'Feche o VS Code, rode o comando abaixo e volte aqui.'}
              {local && !outdated && (
                <>
                  Para entrar autenticado, no VS Code: <strong>Cmd/Ctrl+Shift+P</strong> →{' '}
                  <strong>"BMAD Product Studio: Abrir no Navegador"</strong>. Se abrir em 127.0.0.1 em vez de aqui,
                  rode o comando abaixo uma vez.
                </>
              )}
            </div>
          </div>
        </div>

        {local !== undefined && (
          <div className="welcome-steps">
            {local === null && (
              <>
                <div className="welcome-step">
                  <span className="welcome-step__no">1</span>
                  <div>
                    <div className="check-item__label">Programas</div>
                    <div className="check-item__hint">
                      <a href="https://code.visualstudio.com" target="_blank" rel="noreferrer">
                        VS Code
                      </a>{' '}
                      com a conta GitHub (Copilot) conectada, e{' '}
                      <a href="https://nodejs.org" target="_blank" rel="noreferrer">
                        Node.js 18+
                      </a>
                      .
                    </div>
                  </div>
                </div>
                <div className="welcome-step">
                  <span className="welcome-step__no">2</span>
                  <div>
                    <div className="check-item__label">Máquina corporativa</div>
                    <div className="check-item__hint">
                      Proxy, certificado e registry precisam estar configurados antes. O passo a passo completo, com
                      o script de preparação, está em{' '}
                      <a href={setupUrl()} target="_blank" rel="noreferrer">
                        {setupUrl().replace(/^https?:\/\//, '').replace(/^\//, `${location.host}/`)}
                      </a>
                      .
                    </div>
                  </div>
                </div>
              </>
            )}
            <div className="welcome-step">
              <span className="welcome-step__no">{local === null ? 3 : outdated ? '↑' : '!'}</span>
              <div>
                <div className="check-item__label">
                  {local === null ? 'Instalar' : outdated ? 'Atualizar' : 'Apontar a extensão para este endereço'}
                </div>
                <div className="check-item__hint">
                  Num terminal novo. O comando instala a extensão, abre o VS Code e volta para cá já autenticado.
                </div>
                <Command text={cmd} />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
