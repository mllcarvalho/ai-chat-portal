import { Cpu, Laptop } from 'lucide-react';
import type { Session } from '@aiportal/shared';
import { clientId } from '../../api/client';
import { useCollab } from '../../stores/collabStore';
import { Dropdown } from '../common/Dropdown';

/**
 * Escolhe QUEM roda a inferência da conversa (federação de licenças):
 * - "Host (minha licença)" = como sempre foi (default).
 * - um convidado que ligou o portal local dele = roda na licença DELE.
 *
 * Só aparece em conversas Copilot no modo colaboração, e só quando existe ao
 * menos um participante federado (ou já há um executor escolhido) — sem isso
 * não há decisão a tomar e o picker fica fora do caminho.
 */
export function ExecutorPicker(props: { session: Session }) {
  const { session } = props;
  const identity = useCollab((s) => s.identity);
  const peers = useCollab((s) => s.peers);
  const chosen = useCollab((s) => s.executors[session.id]);
  const chooseExecutor = useCollab((s) => s.chooseExecutor);

  // federação só faz sentido no Copilot (as CLIs são donas do próprio loop)
  const provider = session.provider ?? 'copilot';
  if (!identity || provider !== 'copilot') return null;

  // candidatos: participantes conectados que anunciaram poder executar
  const executors = peers.filter((p) => p.canExecute);
  if (executors.length === 0 && !chosen) return null;

  const label = chosen ? chosen.name.split(/\s+/)[0] : 'Host';
  const onHost = !chosen;

  return (
    <Dropdown
      trigger={(_, toggle) => (
        <button
          className={`pill-btn${chosen ? ' pill-btn--active' : ''}`}
          onClick={toggle}
          title="Quem executa a inferência desta conversa (federação de licenças)"
        >
          {onHost ? (
            <Cpu className="icon icon--sm" aria-hidden />
          ) : (
            <Laptop className="icon icon--sm" aria-hidden style={{ color: 'var(--tool)' }} />
          )}{' '}
          {label}
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="dropdown__label">Executar na licença de</div>
          <button
            className={`dropdown__item${onHost ? ' dropdown__item--sel' : ''}`}
            onClick={() => {
              void chooseExecutor(session.id, null);
              close();
            }}
          >
            <Cpu className="icon" aria-hidden />
            <div>
              Host (minha licença)
              <span className="dropdown__item-sub">Como sempre — roda nesta máquina.</span>
            </div>
          </button>
          {executors.map((peer) => {
            const isMe = peer.clientId === clientId;
            return (
              <button
                key={peer.clientId}
                className={`dropdown__item${chosen?.clientId === peer.clientId ? ' dropdown__item--sel' : ''}`}
                onClick={() => {
                  void chooseExecutor(session.id, peer.clientId);
                  close();
                }}
              >
                <Laptop className="icon" aria-hidden />
                <div>
                  {peer.name}
                  {isMe ? ' (você)' : ''}
                  <span className="dropdown__item-sub">Roda no Copilot e na cota dessa pessoa.</span>
                </div>
              </button>
            );
          })}
        </>
      )}
    </Dropdown>
  );
}
