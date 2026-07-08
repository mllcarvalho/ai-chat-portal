import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BmadArtifact, BmadArtifactKind } from '@aiportal/shared';

/**
 * Detecção dos artefatos BMAD produzidos num projeto: varre _bmad-output/
 * (recursivo) e classifica cada arquivo pela convenção de nomes do BMAD v6/BMM.
 *
 * Convenção observada na instalação (skills em .agents/skills/bmad-*):
 *  - brainstorming:  {output_folder}/brainstorming/brainstorming-session-{date}-{time}.md
 *  - research:       {planning_artifacts}/research/(market|domain|technical)-{slug}-research-{date}.md
 *  - brief:          {doc_workspace}/brief.md (workspace é subpasta livre de _bmad-output)
 *  - PRD:            {doc_workspace}/prd.md (+ validation-report.md, review-{slug}.md)
 *  - PRFAQ:          {planning_artifacts}/prfaq-{project_name}.md
 *  - UX:             DESIGN.md / arquivos *ux*
 *  - épicos:         {planning_artifacts}/epics.md (ou pasta/arquivos epic-*)
 *  - readiness:      {planning_artifacts}/implementation-readiness-report-{date}.md
 * onde planning_artifacts = _bmad-output/planning-artifacts (config do BMM).
 *
 * O mapa abaixo é a fonte da verdade e é EDITÁVEL: a primeira regex que casar
 * com o caminho relativo a _bmad-output (minúsculo, separador "/") define o
 * tipo. A ordem importa — padrões específicos vêm antes dos genéricos.
 */
const KIND_PATTERNS: Array<{ kind: BmadArtifactKind; test: RegExp }> = [
  { kind: 'brainstorming', test: /(^|\/)brainstorming(\/|[^/]*\.md$)/ },
  { kind: 'market-research', test: /(^|\/)market-[^/]*\.md$/ },
  { kind: 'domain-research', test: /(^|\/)domain-[^/]*\.md$/ },
  { kind: 'technical-research', test: /(^|\/)technical-[^/]*\.md$/ },
  { kind: 'prfaq', test: /(^|\/)prfaq[^/]*\.md$/ },
  { kind: 'prd-validation', test: /(^|\/)validation-report[^/]*\.md$/ },
  { kind: 'adversarial-review', test: /(^|\/)review-(?!rubric)[^/]*\.md$/ },
  { kind: 'implementation-readiness', test: /(^|\/)implementation-readiness[^/]*\.md$/ },
  { kind: 'epics', test: /(^|\/)epics?([-.][^/]*)?(\.md$|\/)/ },
  { kind: 'product-brief', test: /(^|\/)[^/]*brief[^/]*\.md$/ },
  { kind: 'ux-design', test: /(^|\/)(ux[^/]*|[^/]*[-_]ux[^/]*|design)\.md$/ },
  { kind: 'prd', test: /(^|\/)[^/]*prd[^/]*\.md$/ },
];

const OUTPUT_DIR = '_bmad-output';
const MAX_DEPTH = 6;

/**
 * Varre a pasta _bmad-output do projeto e retorna os artefatos reconhecidos,
 * do mais recente para o mais antigo. Pasta inexistente = lista vazia.
 */
export function scanBmadArtifacts(projectRoot: string): BmadArtifact[] {
  const out: BmadArtifact[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // dotfiles são internos das skills (.decision-log.md, .working/…)
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, relPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const lower = relPath.toLowerCase();
      const matched = KIND_PATTERNS.find((p) => p.test.test(lower));
      if (!matched) continue;
      let mtime: string;
      try {
        mtime = fs.statSync(abs).mtime.toISOString();
      } catch {
        continue;
      }
      out.push({
        kind: matched.kind,
        name: entry.name,
        path: `${OUTPUT_DIR}/${relPath}`,
        mtime,
      });
    }
  };
  walk(path.join(projectRoot, OUTPUT_DIR), '', 0);
  return out.sort((a, b) => b.mtime.localeCompare(a.mtime));
}
