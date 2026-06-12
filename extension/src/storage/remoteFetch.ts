import TurndownService from 'turndown';
import { gfm } from '@joplin/turndown-plugin-gfm';

const FETCH_TIMEOUT_MS = 20_000;
/** HTML bruto pode ser bem maior que o markdown final, então o teto é maior que DOC_LIMIT. */
const FETCH_LIMIT = 2 * 1024 * 1024;

/** Valida a URL e reescreve páginas de arquivo do GitHub (blob) para o conteúdo bruto. */
export function normalizeSourceUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('URL inválida');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('A URL deve usar http:// ou https://');
  }
  if (url.hostname === 'github.com') {
    const blob = url.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/);
    if (blob) return `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}`;
  }
  return url.toString();
}

/** Nome de documento (.md/.txt) derivado do último segmento da URL. */
export function docNameForUrl(raw: string): string {
  const url = new URL(raw);
  const segment = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '');
  const keepExt = /\.(md|txt)$/i.exec(segment)?.[0].toLowerCase() ?? '.md';
  const base = segment.replace(/\.[^.]+$/, '') || url.hostname;
  const slug = base
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'documento'}${keepExt}`;
}

/**
 * Baixa o conteúdo da URL e devolve texto pronto para virar documento:
 * markdown/texto entram como estão; HTML é convertido para markdown.
 */
export async function fetchRemoteContent(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'User-Agent': 'ai-chat-portal',
        Accept: 'text/markdown, text/html;q=0.9, text/plain;q=0.8, */*;q=0.5',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Falha ao acessar a URL: ${message}`);
  }
  if (!res.ok) throw new Error(`A URL respondeu ${res.status} ${res.statusText}`);

  const type = (res.headers.get('content-type') ?? '').toLowerCase();
  if (/^(image|video|audio|font)\//.test(type) || /application\/(pdf|zip|octet-stream|msword|vnd\.)/.test(type)) {
    throw new Error(`Conteúdo não suportado (${type.split(';')[0].trim()}) — para PDF/Word/Excel use o Upload`);
  }
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > FETCH_LIMIT) throw new Error('Conteúdo remoto excede o limite de 2 MB');
  const text = await res.text();
  if (Buffer.byteLength(text) > FETCH_LIMIT) throw new Error('Conteúdo remoto excede o limite de 2 MB');

  const pathname = new URL(url).pathname.toLowerCase();
  const isPlain = type.includes('markdown') || /\.(md|markdown|txt)$/.test(pathname);
  const looksHtml = type.includes('html') || /^\s*(<!doctype\s+html|<html[\s>])/i.test(text);
  const markdown = !isPlain && looksHtml ? htmlToMarkdown(text) : text;
  return sanitizeMarkdown(markdown, url);
}

/**
 * Limpa ruído que não serve ao modelo, mesmo quando a fonte já entrega markdown
 * (ex.: docs.github.com com Accept: text/markdown traz <svg> de ícones e screenshots).
 */
function sanitizeMarkdown(markdown: string, baseUrl: string): string {
  let out = markdown
    .replace(/<svg[\s>][\s\S]*?<\/svg\s*>/gi, '')
    .replace(/!\[[^\]]*\]\([^()\s]*\)/g, '')
    .replace(/<img[^>]*>/gi, '')
    // sobra de imagem-link: [![alt](img)](destino) vira [](destino)
    .replace(/\[\s*\]\([^()\s]*\)/g, '');
  // links relativos à raiz viram absolutos para continuarem úteis fora do site
  out = out.replace(/\]\((\/[^()\s]*)\)/g, (match, href: string) => {
    try {
      return `](${new URL(href, baseUrl).toString()})`;
    } catch {
      return match;
    }
  });
  return out
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function htmlToMarkdown(html: string): string {
  // foca no conteúdo principal quando a página declara um (evita nav/rodapé no contexto)
  const region =
    /<main[\s>][\s\S]*<\/main>/i.exec(html)?.[0] ??
    /<article[\s>][\s\S]*<\/article>/i.exec(html)?.[0] ??
    /<body[\s>][\s\S]*<\/body>/i.exec(html)?.[0] ??
    html;
  const cleaned = region
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template|svg|iframe|nav|header|footer|aside|form)[\s>][\s\S]*?<\/\1\s*>/gi, '');

  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  service.use(gfm);
  const markdown = service.turndown(cleaned);
  return markdown.replace(/\n{3,}/g, '\n\n').trim();
}
