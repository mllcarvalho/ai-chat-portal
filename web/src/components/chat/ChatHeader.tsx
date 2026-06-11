import { useEffect, useState } from 'react';
import type { SessionMode } from '@aiportal/shared';
import { useSessions } from '../../stores/sessionsStore';
import { useCatalog } from '../../stores/catalogStore';
import { useUi } from '../../stores/uiStore';
import { Dropdown } from '../common/Dropdown';

const MODE_LABEL: Record<SessionMode, string> = {
  ask: 'Ask',
  plan: 'Plan',
  agent: 'Agent',
};

const MODE_DESC: Record<SessionMode, string> = {
  ask: 'Pergunta e resposta, sem ferramentas',
  plan: 'Gera planos; só leitura de arquivos',
  agent: 'Usa ferramentas e MCPs automaticamente',
};

const MODE_COLOR: Record<SessionMode, string> = {
  ask: 'var(--mode-ask)',
  plan: 'var(--mode-plan)',
  agent: 'var(--mode-agent)',
};

export function ChatHeader() {
  const session = useSessions((s) => s.current);
  const patchCurrent = useSessions((s) => s.patchCurrent);
  const setMode = useSessions((s) => s.setMode);
  const models = useCatalog((s) => s.models);
  const agents = useCatalog((s) => s.agents);
  const skills = useCatalog((s) => s.skills);
  const loadSkills = useCatalog((s) => s.loadSkills);
  const openPanel = useUi((s) => s.openPanel);
  const setView = useUi((s) => s.setView);
  const [title, setTitle] = useState(session?.title ?? '');

  useEffect(() => {
    setTitle(session?.title ?? '');
    if (session) void loadSkills(session.projectId ?? undefined);
  }, [session?.id, session?.title, session?.projectId, loadSkills, session]);

  if (!session) return null;

  const model = models.find((m) => m.id === session.modelId) ?? models[0];
  const agent = agents.find((a) => a.id === session.agentId);
  const instructionSkills = skills.filter(
    (s) => s.kind === 'instruction' && (s.scope === 'global' || s.projectId === session.projectId),
  );
  const activeCount = session.activeSkillIds.length;

  return (
    <header className="chat-header">
      <input
        className="chat-header__title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => {
          if (title.trim() && title !== session.title) void patchCurrent({ title: title.trim() });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        title="Renomear conversa"
      />
      <span className="chat-header__spacer" />

      {/* Modo: ask / plan / agent */}
      <Dropdown
        trigger={(_, toggle) => (
          <button className="pill-btn pill-btn--active" onClick={toggle} title={MODE_DESC[session.mode]}>
            <span className="mode-dot" style={{ background: MODE_COLOR[session.mode] }} />
            {MODE_LABEL[session.mode]}
          </button>
        )}
      >
        {(close) =>
          (Object.keys(MODE_LABEL) as SessionMode[]).map((mode) => (
            <button
              key={mode}
              className={`dropdown__item${session.mode === mode ? ' dropdown__item--sel' : ''}`}
              onClick={() => {
                void setMode(mode);
                close();
              }}
            >
              <span className="mode-dot" style={{ background: MODE_COLOR[mode] }} />
              <span>
                {MODE_LABEL[mode]}
                <span className="dropdown__item-sub">{MODE_DESC[mode]}</span>
              </span>
            </button>
          ))
        }
      </Dropdown>

      {/* Modelo */}
      <Dropdown
        trigger={(_, toggle) => (
          <button className="pill-btn" onClick={toggle} title="Modelo do Copilot">
            ◆ {model?.name ?? 'modelo'}
          </button>
        )}
      >
        {(close) =>
          models.map((m) => (
            <button
              key={m.id}
              className={`dropdown__item${m.id === (session.modelId ?? model?.id) ? ' dropdown__item--sel' : ''}`}
              onClick={() => {
                void patchCurrent({ modelId: m.id });
                close();
              }}
            >
              <span>
                {m.name}
                <span className="dropdown__item-sub">
                  {m.family} · {Math.round(m.maxInputTokens / 1000)}k tokens
                </span>
              </span>
            </button>
          ))
        }
      </Dropdown>

      {/* Agente */}
      <Dropdown
        trigger={(_, toggle) => (
          <button className="pill-btn" onClick={toggle} title="Agente (preset de instruções)">
            {agent ? `${agent.icon ?? '🤖'} ${agent.name}` : '🤖 Sem agente'}
          </button>
        )}
      >
        {(close) => (
          <>
            <button
              className={`dropdown__item${!session.agentId ? ' dropdown__item--sel' : ''}`}
              onClick={() => {
                void patchCurrent({ agentId: '' });
                close();
              }}
            >
              Sem agente
            </button>
            {agents.map((a) => (
              <button
                key={a.id}
                className={`dropdown__item${a.id === session.agentId ? ' dropdown__item--sel' : ''}`}
                onClick={() => {
                  void patchCurrent({
                    agentId: a.id,
                    ...(a.defaultModelId ? { modelId: a.defaultModelId } : {}),
                    ...(a.defaultMode ? { mode: a.defaultMode } : {}),
                  });
                  close();
                }}
              >
                <span>
                  {a.icon ?? '🤖'} {a.name}
                  {a.description && <span className="dropdown__item-sub">{a.description}</span>}
                </span>
              </button>
            ))}
            <div className="dropdown__sep" />
            <button
              className="dropdown__item"
              onClick={() => {
                setView('agents');
                close();
              }}
            >
              Gerenciar agentes…
            </button>
          </>
        )}
      </Dropdown>

      {/* Skills ativas */}
      <Dropdown
        trigger={(_, toggle) => (
          <button
            className={`pill-btn${activeCount ? ' pill-btn--active' : ''}`}
            onClick={toggle}
            title="Skills de instrução ativas nesta conversa"
          >
            ⚡ Skills{activeCount ? ` (${activeCount})` : ''}
          </button>
        )}
      >
        {(close) => (
          <>
            {instructionSkills.length === 0 && (
              <div className="empty-state">Nenhuma skill de instrução.</div>
            )}
            {instructionSkills.map((skill) => {
              const active = session.activeSkillIds.includes(skill.id);
              return (
                <button
                  key={skill.id}
                  className={`dropdown__item${active ? ' dropdown__item--sel' : ''}`}
                  onClick={() => {
                    const next = active
                      ? session.activeSkillIds.filter((id) => id !== skill.id)
                      : [...session.activeSkillIds, skill.id];
                    void patchCurrent({ activeSkillIds: next });
                  }}
                >
                  <span>
                    {active ? '☑' : '☐'} {skill.name}
                    {skill.description && (
                      <span className="dropdown__item-sub">{skill.description}</span>
                    )}
                  </span>
                </button>
              );
            })}
            <div className="dropdown__sep" />
            <button
              className="dropdown__item"
              onClick={() => {
                setView('skills');
                close();
              }}
            >
              Gerenciar skills…
            </button>
          </>
        )}
      </Dropdown>

      <button className="pill-btn" onClick={() => setView('mcps')} title="Servidores MCP">
        🔧 MCPs
      </button>
      {session.projectId && (
        <button className="pill-btn" onClick={() => openPanel({ kind: 'files' })} title="Arquivos do projeto">
          📄 Arquivos
        </button>
      )}
    </header>
  );
}
