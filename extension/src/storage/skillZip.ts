import JSZip from 'jszip';
import { slugifyCommand, type SkillWithContent } from '@aiportal/shared';
import { getSkill, readSkillAssetRaw } from './skillStore';

/**
 * Export/import de skill como artefato único:
 *  - skill SEM anexos → um .md com frontmatter (name/description/command) —
 *    o formato clássico do botão Baixar, re-importável;
 *  - skill COM anexos → um .zip com esse mesmo skill.md na raiz + os anexos
 *    nos caminhos relativos originais.
 * O import (página Skills e agentZip) aceita os dois.
 */

/** O .md re-importável da skill (frontmatter + conteúdo). */
export function skillMarkdown(skill: SkillWithContent): string {
  const command = skill.command ?? slugifyCommand(skill.name);
  return `---\nname: ${skill.name}\ndescription: ${skill.description ?? ''}\ncommand: ${command}\n---\n\n${skill.content}\n`;
}

export interface SkillExportFile {
  fileName: string;
  data: Buffer;
  contentType: string;
}

/** Artefato de download/email da skill: .md simples ou .zip com anexos. */
export async function exportSkillFile(id: string): Promise<SkillExportFile | undefined> {
  const skill = getSkill(id);
  if (!skill) return undefined;
  const command = skill.command ?? slugifyCommand(skill.name);
  if (!skill.files?.length) {
    return {
      fileName: `${command}.md`,
      data: Buffer.from(skillMarkdown(skill), 'utf8'),
      contentType: 'text/markdown; charset=utf-8',
    };
  }
  const zip = new JSZip();
  zip.file('skill.md', skillMarkdown(skill));
  for (const rel of skill.files) {
    const data = readSkillAssetRaw(id, rel);
    if (data) zip.file(rel, data);
  }
  return {
    fileName: `${command}.skill.zip`,
    data: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
    contentType: 'application/zip',
  };
}
