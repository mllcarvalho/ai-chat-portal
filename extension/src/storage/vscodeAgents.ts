import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { VsCodeAgent } from '@aiportal/shared';
import { getPortalRoot } from './paths';

/**
 * Agentes/chat modes do VS Code são arquivos *.chatmode.md (frontmatter YAML
 * simples + instruções em markdown) em .github/chatmodes/ do repo e na pasta
 * de prompts do perfil do usuário.
 */
function userPromptsDirs(): string[] {
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return [path.join(home, 'Library', 'Application Support', 'Code', 'User', 'prompts')];
    case 'win32':
      return process.env.APPDATA ? [path.join(process.env.APPDATA, 'Code', 'User', 'prompts')] : [];
    default:
      return [path.join(home, '.config', 'Code', 'User', 'prompts')];
  }
}

function parseChatMode(file: string, source: VsCodeAgent['source']): VsCodeAgent | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  let description: string | undefined;
  let body = raw;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (fm) {
    body = raw.slice(fm[0].length);
    const descMatch = /^description\s*:\s*(['"]?)(.*?)\1\s*$/m.exec(fm[1]);
    if (descMatch) description = descMatch[2];
  }
  const name = path.basename(file).replace(/\.chatmode\.md$/i, '').replace(/\.md$/i, '');
  return {
    id: crypto.createHash('sha1').update(file).digest('hex').slice(0, 12),
    name,
    description,
    instructions: body.trim(),
    source,
  };
}

export function listVsCodeAgents(): VsCodeAgent[] {
  const agents: VsCodeAgent[] = [];
  const scan = (dir: string, source: VsCodeAgent['source']) => {
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const file of files) {
      if (!/\.chatmode\.md$/i.test(file)) continue;
      const agent = parseChatMode(path.join(dir, file), source);
      if (agent?.instructions) agents.push(agent);
    }
  };
  const root = getPortalRoot();
  if (root) scan(path.join(root, '.github', 'chatmodes'), 'project');
  for (const dir of userPromptsDirs()) scan(dir, 'user');
  return agents.sort((a, b) => a.name.localeCompare(b.name));
}
