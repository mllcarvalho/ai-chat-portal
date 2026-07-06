import type JSZip from 'jszip';

export interface ParsedSkillZip {
  /** O markdown da skill (skill.md/SKILL.md — frontmatter opcional). */
  markdown: string;
  /** Anexos com caminho relativo à pasta da skill. */
  files: Array<{ path: string; base64: string }>;
}

/**
 * Interpreta um zip de skill vindo de qualquer lugar razoável:
 *  - o .skill.zip exportado pelo portal (skill.md na raiz);
 *  - uma pasta de skill zipada direto do disco (SKILL.md maiúsculo, com
 *    skill.json junto, possivelmente embrulhada numa subpasta pelo zipador).
 * Regra: acha o skill.md/SKILL.md (qualquer caixa) mais raso — ou, na falta,
 * o .md mais raso — e trata a pasta dele como raiz da skill: tudo abaixo vira
 * anexo (menos o skill.json, que é metadado do portal, não anexo).
 */
export async function parseSkillZip(zip: JSZip): Promise<ParsedSkillZip | undefined> {
  const entries = Object.values(zip.files).filter((e) => !e.dir);
  const depth = (name: string) => name.split('/').length;
  const byDepth = (a: { name: string }, b: { name: string }) => depth(a.name) - depth(b.name);
  const mdEntry =
    entries.filter((e) => /(^|\/)skill\.md$/i.test(e.name)).sort(byDepth)[0] ??
    entries.filter((e) => /\.md$/i.test(e.name)).sort(byDepth)[0];
  if (!mdEntry) return undefined;
  const baseDir = mdEntry.name.includes('/')
    ? mdEntry.name.slice(0, mdEntry.name.lastIndexOf('/') + 1)
    : '';
  const files: ParsedSkillZip['files'] = [];
  for (const entry of entries) {
    if (entry.name === mdEntry.name) continue;
    if (baseDir && !entry.name.startsWith(baseDir)) continue; // fora da pasta da skill
    const rel = entry.name.slice(baseDir.length);
    if (!rel || rel.toLowerCase() === 'skill.json') continue;
    files.push({ path: rel, base64: await entry.async('base64') });
  }
  return { markdown: await mdEntry.async('string'), files };
}
