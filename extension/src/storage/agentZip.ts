import JSZip from 'jszip';
import { slugifyCommand, type AgentPreset, type SessionMode } from '@aiportal/shared';
import { createAgent, getAgent, listAgents, updateAgent } from './agentStore';
import { getBase } from './knowledgeStore';
import { exportBaseZip, importBaseZip } from './knowledgeZip';
import {
  createSkill,
  getSkill,
  listAllSkills,
  readSkillAssetRaw,
  updateSkill,
  writeSkillAsset,
} from './skillStore';

/** agent.json dentro do zip — sem ids, que são gerados no import. */
interface AgentZipMeta {
  type: 'ai-chat-portal-agent';
  name: string;
  icon?: string;
  description?: string;
  instructions: string;
  defaultModelId?: string;
  defaultMode?: SessionMode;
  enabledTools?: string[] | null;
  /** Identidade de origem: reimports atualizam o agente existente em vez de duplicar. */
  originId?: string;
  exportedAt: string;
}

interface SkillZipEntry {
  name: string;
  description?: string;
  command?: string;
  content?: string;
  originId?: string;
  /** Anexos da pasta da skill: caminho relativo → conteúdo em base64. */
  files?: Record<string, string>;
}

export function agentHasLinks(agent: AgentPreset): boolean {
  return Boolean(agent.skillIds?.length || agent.knowledgeBaseIds?.length);
}

/** Empacota o agente com as skills e bases vinculadas (bases como zips aninhados). */
export async function exportAgentZip(agentId: string): Promise<Buffer> {
  const agent = getAgent(agentId);
  if (!agent) throw new Error('Agente não encontrado');
  const zip = new JSZip();
  const meta: AgentZipMeta = {
    type: 'ai-chat-portal-agent',
    name: agent.name,
    icon: agent.icon,
    description: agent.description,
    instructions: agent.instructions,
    defaultModelId: agent.defaultModelId,
    defaultMode: agent.defaultMode,
    enabledTools: agent.enabledTools ?? undefined,
    originId: agent.importedFrom ?? agent.id,
    exportedAt: new Date().toISOString(),
  };
  zip.file('agent.json', JSON.stringify(meta, null, 2));

  const usedPaths = new Set<string>();
  const uniquePath = (folder: string, slug: string, ext: string): string => {
    const base = slug || 'item';
    let candidate = `${folder}/${base}${ext}`;
    for (let n = 2; usedPaths.has(candidate); n++) candidate = `${folder}/${base}-${n}${ext}`;
    usedPaths.add(candidate);
    return candidate;
  };

  for (const id of agent.skillIds ?? []) {
    const skill = getSkill(id);
    if (!skill) continue;
    let files: Record<string, string> | undefined;
    for (const rel of skill.files ?? []) {
      const data = readSkillAssetRaw(id, rel);
      if (data) (files ??= {})[rel] = data.toString('base64');
    }
    const entry: SkillZipEntry = {
      name: skill.name,
      description: skill.description,
      command: skill.command,
      content: skill.content,
      originId: skill.importedFrom ?? skill.id,
      files,
    };
    zip.file(
      uniquePath('skills', slugifyCommand(skill.command ?? skill.name), '.json'),
      JSON.stringify(entry, null, 2),
    );
  }
  for (const id of agent.knowledgeBaseIds ?? []) {
    if (!getBase(id)) continue;
    zip.file(uniquePath('bases', slugifyCommand(getBase(id)!.name), '.zip'), await exportBaseZip(id));
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Recria o agente e o ecossistema dele a partir do zip: skills viram skills
 * globais, bases são importadas desativadas no toggle geral (o vínculo com o
 * agente já as coloca no contexto dele) e os vínculos apontam para os ids novos.
 */
export async function importAgentZip(zipData: Buffer): Promise<AgentPreset> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(zipData);
  } catch {
    throw new Error('Arquivo inválido — envie um .zip');
  }
  const agentEntry = zip.file('agent.json');
  if (!agentEntry) {
    throw new Error('O zip não contém agent.json — não é um export de agente do portal');
  }
  let meta: Partial<AgentZipMeta>;
  try {
    meta = JSON.parse(await agentEntry.async('string')) as Partial<AgentZipMeta>;
  } catch {
    throw new Error('agent.json ilegível');
  }
  if (!meta.name?.trim()) throw new Error('agent.json sem o campo "name"');

  const skillIds: string[] = [];
  for (const entry of zip.file(/^skills\/[^/]+\.json$/)) {
    try {
      const item = JSON.parse(await entry.async('string')) as Partial<SkillZipEntry>;
      if (!item.name?.trim()) continue;
      // upsert por origem: a skill original (restore) ou uma cópia já importada
      const existing = item.originId
        ? listAllSkills().find((s) => s.id === item.originId || s.importedFrom === item.originId)
        : undefined;
      const writeAssets = (skillId: string) => {
        for (const [rel, base64] of Object.entries(item.files ?? {})) {
          try {
            writeSkillAsset(skillId, rel, Buffer.from(base64, 'base64'));
          } catch {
            // anexo problemático não derruba o import da skill
          }
        }
      };
      if (existing) {
        updateSkill(existing.id, {
          name: item.name.trim(),
          description: item.description ?? '',
          content: item.content ?? '',
          ...(item.command ? { command: item.command } : {}),
        });
        writeAssets(existing.id);
        skillIds.push(existing.id);
        continue;
      }
      const skill = createSkill({
        scope: 'global',
        name: item.name.trim(),
        description: item.description ?? '',
        command: item.command,
        content: item.content ?? '',
        importedFrom: item.originId,
      });
      if (skill) {
        writeAssets(skill.id);
        skillIds.push(skill.id);
      }
    } catch {
      // skill ilegível — importa o resto
    }
  }

  const knowledgeBaseIds: string[] = [];
  for (const entry of zip.file(/^bases\/[^/]+\.zip$/)) {
    try {
      const fallbackName = entry.name.replace(/^bases\//, '').replace(/\.zip$/, '');
      // criada desativada no toggle geral (o vínculo já a põe no contexto do agente);
      // se a base já existe (upsert por origem), o toggle atual dela é preservado
      const base = await importBaseZip(await entry.async('nodebuffer'), {
        scope: 'global',
        fallbackName,
        enabledOnCreate: false,
      });
      knowledgeBaseIds.push(base.id);
    } catch {
      // base ilegível — importa o resto
    }
  }

  const validModes: SessionMode[] = ['ask', 'plan', 'agent'];
  const data = {
    name: meta.name.trim(),
    icon: meta.icon,
    description: meta.description,
    instructions: meta.instructions ?? '',
    defaultModelId: meta.defaultModelId,
    defaultMode: validModes.includes(meta.defaultMode as SessionMode)
      ? (meta.defaultMode as SessionMode)
      : undefined,
    enabledTools: meta.enabledTools ?? null,
    skillIds: skillIds.length ? skillIds : undefined,
    knowledgeBaseIds: knowledgeBaseIds.length ? knowledgeBaseIds : undefined,
  };
  // upsert por origem: o agente original (restore) ou uma cópia já importada
  const existingAgent = meta.originId
    ? listAgents().find((a) => a.id === meta.originId || a.importedFrom === meta.originId)
    : undefined;
  if (existingAgent) return updateAgent(existingAgent.id, data)!;
  return createAgent({ ...data, importedFrom: meta.originId });
}
