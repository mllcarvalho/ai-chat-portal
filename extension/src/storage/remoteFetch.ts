import TurndownService from 'turndown';
import { gfm } from '@joplin/turndown-plugin-gfm';
import { netStatus, requestInitFor } from '../tools/netEnv';
import { binaryKindFor, extractBinaryText } from './extractBinary';

const FETCH_TIMEOUT_MS = 20_000;
/** HTML bruto pode ser bem maior que o markdown final, então o teto é maior que DOC_LIMIT. */
const FETCH_LIMIT = 2 * 1024 * 1024;
/** Word/PDF/Excel comprimem muito texto; o teto de download é maior. */
const BINARY_FETCH_LIMIT = 20 * 1024 * 1024;

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
 * O undici esconde a causa real ("fetch failed") em err.cause — desce a
 * cadeia até o erro de rede de verdade (ENOTFOUND, ECONNREFUSED, cert…).
 */
function fetchErrorDetail(err: unknown): string {
  const messages: string[] = [];
  let current: unknown = err;
  while (current) {
    if (current instanceof AggregateError && current.errors.length) {
      current = current.errors[0];
      continue;
    }
    if (current instanceof Error) {
      const code = (current as NodeJS.ErrnoException).code;
      messages.push(
        code && !current.message.includes(code) ? `${current.message} (${code})` : current.message,
      );
      current = current.cause;
      continue;
    }
    messages.push(String(current));
    break;
  }
  // com uma causa mais específica na cadeia, o "fetch failed" genérico só polui
  const specific = messages.filter((m) => m && m !== 'fetch failed');
  return [...new Set(specific.length ? specific : messages)].join(' — ');
}

/**
 * Página remota já processada. O `html` só vem quando a resposta era HTML de
 * verdade: a varredura de site precisa dele porque `htmlToMarkdown` descarta
 * <nav>/<aside> — justamente onde os sites de documentação publicam o índice
 * de páginas.
 */
export interface RemoteDocument {
  /** Texto pronto para virar documento. */
  content: string;
  /** URL final (depois dos redirects). */
  finalUrl: string;
  html?: string;
  title?: string;
}

/** Compatibilidade: só o conteúdo, que é o que a maior parte do portal usa. */
export async function fetchRemoteContent(url: string): Promise<string> {
  return (await fetchRemoteDocument(url)).content;
}

/**
 * Baixa o conteúdo da URL e devolve texto pronto para virar documento:
 * markdown/texto entram como estão; HTML é convertido para markdown.
 */
export async function fetchRemoteDocument(url: string): Promise<RemoteDocument> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...requestInitFor(url, {
        'User-Agent': 'ai-chat-portal',
        Accept: 'text/markdown, text/html;q=0.9, text/plain;q=0.8, */*;q=0.5',
      }),
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Falha ao acessar a URL: ${fetchErrorDetail(err)} · rede: ${netStatus(url)}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `A URL respondeu ${res.status} (acesso negado) — a página exige autenticação. ` +
        'Para SharePoint, use o link da página/arquivo no site (*.sharepoint.com).',
    );
  }
  if (!res.ok) throw new Error(`A URL respondeu ${res.status} ${res.statusText}`);

  const pathname = new URL(res.url || url).pathname.toLowerCase();
  const type = (res.headers.get('content-type') ?? '').toLowerCase();
  const kind = binaryKindFor(type, pathname);
  if (kind) {
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > BINARY_FETCH_LIMIT) throw new Error('Arquivo remoto excede o limite de 20 MB');
    const data = Buffer.from(await res.arrayBuffer());
    if (data.byteLength > BINARY_FETCH_LIMIT) throw new Error('Arquivo remoto excede o limite de 20 MB');
    return { content: await extractBinaryText(kind, data), finalUrl: res.url || url };
  }
  if (/^(image|video|audio|font)\//.test(type) || /application\/(zip|octet-stream|msword|vnd\.)/.test(type)) {
    throw new Error(
      `Conteúdo não suportado (${type.split(';')[0].trim()}) — formatos aceitos: página HTML, markdown, texto, Word (.docx), Excel (.xlsx), PowerPoint (.pptx) e PDF`,
    );
  }
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > FETCH_LIMIT) throw new Error('Conteúdo remoto excede o limite de 2 MB');
  const text = await res.text();
  if (Buffer.byteLength(text) > FETCH_LIMIT) throw new Error('Conteúdo remoto excede o limite de 2 MB');

  const isPlain = type.includes('markdown') || /\.(md|markdown|txt)$/.test(pathname);
  const looksHtml = type.includes('html') || /^\s*(<!doctype\s+html|<html[\s>])/i.test(text);
  const markdown = !isPlain && looksHtml ? htmlToMarkdown(text) : text;
  return {
    content: sanitizeMarkdown(markdown, url),
    finalUrl: res.url || url,
    ...(!isPlain && looksHtml && { html: text, title: htmlTitle(text) }),
  };
}

/** <title> da página, sem o sufixo do site ("Autenticação — Meus Docs"). */
export function htmlTitle(html: string): string | undefined {
  const raw = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1];
  if (!raw) return undefined;
  const text = decodeEntities(raw).replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  const trimmed = text.split(/\s+[|·—–]\s+/)[0].trim();
  return (trimmed || text).slice(0, 120);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * href absolutos das âncoras do HTML, resolvidos contra a página. Inclui o que
 * vier de <nav>: numa varredura, o menu lateral é a melhor lista de páginas
 * quando o site não publica sitemap.
 */
export function extractLinks(html: string, baseUrl: string): string[] {
  const urls = new Set<string>();
  const anchor = /<a\s[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))/gi;
  let match: RegExpExecArray | null;
  while ((match = anchor.exec(html))) {
    const href = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '').trim();
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript|data):/i.test(href)) continue;
    try {
      const resolved = new URL(href, baseUrl);
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
      resolved.hash = '';
      urls.add(resolved.toString());
    } catch {
      // href quebrado na página: ignora e segue
    }
  }
  return [...urls];
}

/**
 * Limpa ruído que não serve ao modelo, mesmo quando a fonte já entrega markdown
 * (ex.: docs.github.com com Accept: text/markdown traz <svg> de ícones e screenshots).
 */
export function sanitizeMarkdown(markdown: string, baseUrl: string): string {
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

export function htmlToMarkdown(html: string): string {
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
