import { isBmadAsset, slugifyCommand } from '@aiportal/shared';
import { Router, sendError, sendJson } from '../router';
import { shareByEmail } from '../../tools/emailShare';
import { exportAgentZip } from '../../storage/agentZip';
import { exportBaseZip } from '../../storage/knowledgeZip';
import { getAgent } from '../../storage/agentStore';
import { getBase } from '../../storage/knowledgeStore';
import { getSkill } from '../../storage/skillStore';
import { exportSkillFile } from '../../storage/skillZip';
import { getSession } from '../../storage/sessionStore';
import { sessionExportFileName, sessionToMarkdown } from '../../storage/sessionMarkdown';

/**
 * Envio por email de agentes, skills, bases de conhecimento e conversas: gera
 * o mesmo artefato do export/download (zip do agente com vínculos, zip da
 * base, .md da skill re-importável, .md legível da conversa) e abre o cliente
 * de email com ele anexado. Ativos do BMAD ficam de fora — são instalados,
 * não compartilhados.
 */
export function registerShareRoutes(router: Router): void {
  router.post('/api/share/email', async ({ res, body }) => {
    const input = (body ?? {}) as { kind?: string; id?: string };
    if (!input.id || !['agent', 'skill', 'knowledge', 'session'].includes(input.kind ?? '')) {
      sendError(res, 400, 'Informe kind (agent | skill | knowledge | session) e id');
      return;
    }
    if (isBmadAsset(input.id)) {
      sendError(res, 400, 'Ativos do BMAD não são compartilháveis — a outra pessoa já os tem na instalação');
      return;
    }
    try {
      let fileName: string;
      let data: Buffer;
      let subject: string;
      if (input.kind === 'agent') {
        const agent = getAgent(input.id);
        if (!agent) {
          sendError(res, 404, 'Agente não encontrado');
          return;
        }
        fileName = `${slugifyCommand(agent.name) || 'agente'}.agent.zip`;
        data = await exportAgentZip(agent.id);
        subject = `Agente "${agent.name}" — BMAD Product Studio`;
      } else if (input.kind === 'knowledge') {
        const base = getBase(input.id);
        if (!base) {
          sendError(res, 404, 'Base não encontrada');
          return;
        }
        fileName = `${slugifyCommand(base.name) || 'base'}.zip`;
        data = await exportBaseZip(base.id);
        subject = `Base de conhecimento "${base.name}" — BMAD Product Studio`;
      } else if (input.kind === 'session') {
        const session = getSession(input.id);
        if (!session) {
          sendError(res, 404, 'Conversa não encontrada');
          return;
        }
        // mesmo artefato do download: a conversa inteira em Markdown legível
        fileName = sessionExportFileName(session);
        data = Buffer.from(sessionToMarkdown(session), 'utf8');
        subject = `Conversa "${session.title}" — BMAD Product Studio`;
      } else {
        const skill = getSkill(input.id);
        if (!skill) {
          sendError(res, 404, 'Skill não encontrada');
          return;
        }
        // mesmo artefato do botão Baixar (re-importável): .md simples ou
        // .skill.zip quando a skill tem anexos
        const file = await exportSkillFile(input.id);
        if (!file) {
          sendError(res, 404, 'Não foi possível gerar o arquivo da skill — ela pode ter sido excluída');
          return;
        }
        fileName = file.fileName;
        data = file.data;
        subject = `Skill "${skill.name}" — BMAD Product Studio`;
      }
      const result = await shareByEmail(fileName, data, subject);
      sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : String(err));
    }
  });
}
