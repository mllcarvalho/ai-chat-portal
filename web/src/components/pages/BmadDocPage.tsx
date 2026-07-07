import { useState } from 'react';
import { Modal } from '../common/Modal';
import { PageShell } from './PageShell';
import {
  BMAD_AGENTS,
  BMAD_CATEGORIES,
  type BmadCategoryDoc,
  type BmadSkillDoc,
} from '../../lib/bmadDoc';
import { useUi } from '../../stores/uiStore';

/**
 * Documentação do BMAD dentro do portal: o que é o framework, quem são os
 * agentes e o catálogo de skills agrupado por função. Clicar numa skill abre
 * o detalhe (quem executa, o que faz, quando usar, o que produz) com atalho
 * para usá-la numa conversa.
 */
export function BmadDocPage() {
  const seedComposer = useUi((s) => s.seedComposer);
  const [selected, setSelected] = useState<{ skill: BmadSkillDoc; category: BmadCategoryDoc }>();

  return (
    <PageShell
      icon="📖"
      title="Doc BMAD"
      subtitle="O framework por trás do portal: fases, agentes e o que cada skill /bmad-* faz."
    >
      <section className="bmaddoc__intro">
        <h3>O que é o BMAD</h3>
        <p>
          O <strong>BMAD Method</strong> é um framework de desenvolvimento de produto orientado por
          agentes de IA: personas especializadas (analista, PM, UX, arquiteto, dev, tech writer)
          conduzem workflows guiados — as <strong>skills</strong> — que levam uma ideia da
          descoberta à entrega, com artefatos rastreáveis em cada fase.
        </p>
        <p>
          O fluxo típico: <em>descoberta e pesquisa</em> → <em>planejamento</em> (brief, PRD,
          epics e stories) → <em>arquitetura e UX</em> → <em>desenvolvimento</em> →{' '}
          <em>qualidade e acompanhamento</em>. Neste portal, as personas aparecem no seletor de
          agente do chat, as skills são os comandos <code>/bmad-*</code> e os documentos gerados
          ficam na pasta <code>_bmad-output/</code> do projeto da conversa. Sem saber por onde
          começar? Rode <code>/bmad-help</code> em qualquer conversa.
        </p>
      </section>

      <h3 className="bmaddoc__section-title">🤖 Os agentes</h3>
      <div className="bmaddoc__agents">
        {BMAD_AGENTS.map((agent) => (
          <div className="bmaddoc__agent" key={agent.code}>
            <div className="bmaddoc__agent-head">
              <span className="bmaddoc__agent-icon">{agent.icon}</span>
              <div>
                <div className="bmaddoc__agent-name">{agent.persona}</div>
                <div className="bmaddoc__agent-role">{agent.role}</div>
              </div>
            </div>
            <p className="bmaddoc__agent-summary">{agent.summary}</p>
          </div>
        ))}
      </div>

      <h3 className="bmaddoc__section-title">⚡ As skills, por função</h3>
      {BMAD_CATEGORIES.map((category) => (
        <section className="bmaddoc__category" key={category.id}>
          <div className="bmaddoc__category-head">
            <span className="bmaddoc__category-icon">{category.icon}</span>
            <div className="bmaddoc__category-text">
              <span className="bmaddoc__category-title">{category.title}</span>
              <span className="bmaddoc__category-blurb">{category.blurb}</span>
            </div>
            <span className="bmaddoc__category-count">
              {category.skills.length} skill{category.skills.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="bmaddoc__skills">
            {category.skills.map((skill) => (
              <button
                key={skill.command}
                className="bmaddoc__skill"
                onClick={() => setSelected({ skill, category })}
                title="Ver detalhes"
              >
                <code>/{skill.command}</code>
                <span className="bmaddoc__skill-label">{skill.label}</span>
              </button>
            ))}
          </div>
        </section>
      ))}

      {selected && (
        <Modal
          title={`${selected.skill.name}`}
          wide
          onClose={() => setSelected(undefined)}
          footer={
            <>
              <button className="btn" onClick={() => setSelected(undefined)}>
                Fechar
              </button>
              <button
                className="btn btn--primary"
                onClick={() => {
                  seedComposer(`/${selected.skill.command} `);
                  setSelected(undefined);
                }}
              >
                Usar numa conversa
              </button>
            </>
          }
        >
          <div className="bmaddoc__detail">
            <div className="bmaddoc__detail-tags">
              <code className="bmaddoc__detail-command">/{selected.skill.command}</code>
              <span className="chip">
                {selected.category.icon} {selected.category.title}
              </span>
            </div>
            <p className="bmaddoc__detail-desc">{selected.skill.description}</p>
            <dl className="bmaddoc__detail-fields">
              <dt>👤 Quem executa</dt>
              <dd>{selected.skill.agent}</dd>
              <dt>⚙️ O que faz</dt>
              <dd>{selected.skill.does}</dd>
              <dt>🕐 Quando usar</dt>
              <dd>{selected.skill.whenToUse}</dd>
              <dt>📦 O que produz</dt>
              <dd>{selected.skill.produces}</dd>
            </dl>
          </div>
        </Modal>
      )}
    </PageShell>
  );
}
