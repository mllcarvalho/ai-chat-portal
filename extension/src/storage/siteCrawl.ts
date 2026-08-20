import { netStatus, requestInitFor } from '../tools/netEnv';
import {
  extractLinks,
  fetchRemoteDocument,
  normalizeSourceUrl,
  type RemoteDocument,
} from './remoteFetch';

/**
 * Varredura de um site de documentação (GitHub Pages, MkDocs, Docusaurus,
 * Jekyll…) para dentro de uma base de conhecimento.
 *
 * A ordem importa: quase todo gerador de site estático publica sitemap.xml, e
 * ele é uma lista COMPLETA e explícita das páginas — raspar links é sempre uma
 * aproximação (perde o que só aparece depois do JS, repete âncora, entra em
 * página de tag/categoria). Por isso o sitemap é o caminho principal e a
 * navegação por links é o plano B.
 *
 * Em qualquer um dos dois a varredura fica presa ao MESMO host e ao MESMO
 * prefixo de caminho da URL inicial: quem aponta para
 * `usuario.github.io/projeto/guia/` quer o guia, não o site inteiro nem o
 * blog do rodapé.
 */

const SITEMAP_TIMEOUT_MS = 15_000;
const SITEMAP_LIMIT = 5 * 1024 * 1024;
/** Sitemap de índice aponta para outros sitemaps; ler muitos não compensa. */
const MAX_SITEMAP_FILES = 5;
export const CRAWL_MAX_PAGES_CAP = 100;
export const CRAWL_DEFAULT_MAX_PAGES = 25;
export const CRAWL_DEFAULT_DEPTH = 2;

/** Extensões que não são página de documentação — nem tenta baixar. */
const SKIP_EXTENSIONS =
  /\.(png|jpe?g|gif|webp|svg|ico|css|js|mjs|map|zip|gz|tar|woff2?|ttf|eot|mp4|mp3|mov|xml|json|rss|atom)$/i;

export interface CrawledPage {
  url: string;
  title: string;
  content: string;
}

export interface CrawlResult {
  pages: CrawledPage[];
  /** Como as páginas foram descobertas — a UI mostra isso no grupo. */
  via: 'sitemap' | 'links';
  /** Páginas que falharam ao baixar (a varredura segue com o resto). */
  errors: Array<{ url: string; error: string }>;
  /** Havia mais páginas do que o teto permitia? */
  truncated: boolean;
}

export interface CrawlOptions {
  maxPages?: number;
  depth?: number;
}

/** Chave de deduplicação: ignora hash e barra final. */
function canonical(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Prefixo do caminho que delimita a varredura (a "pasta" da URL inicial). */
function scopePrefix(root: URL): string {
  const path = root.pathname;
  // .../guia/pagina.html → .../guia/ ; .../guia/ → .../guia/
  if (/\.[a-z0-9]+$/i.test(path)) return path.replace(/\/[^/]*$/, '/');
  return path.endsWith('/') ? path : `${path}/`;
}

function inScope(candidate: string, root: URL, prefix: string): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.host !== root.host) return false;
  if (SKIP_EXTENSIONS.test(url.pathname)) return false;
  // a própria URL inicial vale mesmo quando é um arquivo fora do prefixo
  if (canonical(candidate) === canonical(root.toString())) return true;
  return url.pathname.startsWith(prefix);
}

/** Baixa um XML (sitemap) como texto, sem passar pelo pipeline de markdown. */
async function fetchXml(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url, {
      ...requestInitFor(url, { 'User-Agent': 'ai-chat-portal', Accept: 'application/xml, text/xml' }),
      redirect: 'follow',
      signal: AbortSignal.timeout(SITEMAP_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const text = await res.text();
    if (Buffer.byteLength(text) > SITEMAP_LIMIT) return undefined;
    return text.includes('<loc') ? text : undefined;
  } catch {
    return undefined;
  }
}

function locsIn(xml: string): string[] {
  const out: string[] = [];
  const loc = /<loc>\s*([\s\S]*?)\s*<\/loc>/gi;
  let match: RegExpExecArray | null;
  while ((match = loc.exec(xml))) {
    const value = match[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    if (value) out.push(value);
  }
  return out;
}

/**
 * URLs do sitemap do site, já filtradas ao escopo.
 *
 * Sobe pelos diretórios do caminho, do mais fundo para a raiz: um GitHub Pages
 * de PROJETO publica em `usuario.github.io/repo/sitemap.xml`, não na raiz do
 * domínio — procurar só em `/sitemap.xml` acharia o site pessoal do usuário
 * (ou nada) e jogaria a varredura no plano B à toa.
 */
async function urlsFromSitemap(root: URL, prefix: string): Promise<string[] | undefined> {
  const segments = prefix.split('/').filter(Boolean);
  const candidates: string[] = [];
  for (let depth = segments.length; depth >= 0; depth -= 1) {
    const dir = depth ? `/${segments.slice(0, depth).join('/')}/` : '/';
    candidates.push(new URL(`${dir}sitemap.xml`, root).toString());
  }
  for (const candidate of [...new Set(candidates)]) {
    const xml = await fetchXml(candidate);
    if (!xml) continue;
    let locs = locsIn(xml);
    // sitemap de índice: os <loc> apontam para outros sitemaps
    if (/<sitemapindex/i.test(xml)) {
      const nested: string[] = [];
      for (const child of locs.slice(0, MAX_SITEMAP_FILES)) {
        const childXml = await fetchXml(child);
        if (childXml) nested.push(...locsIn(childXml));
      }
      locs = nested;
    }
    const scoped = locs.filter((u) => inScope(u, root, prefix));
    if (scoped.length) return [...new Map(scoped.map((u) => [canonical(u), u])).values()];
  }
  return undefined;
}

/** Descobre as páginas navegando pelos links, em largura, até o limite. */
async function urlsFromLinks(
  root: URL,
  prefix: string,
  maxPages: number,
  depth: number,
  pageCache: Map<string, CrawledPage>,
  errors: CrawlResult['errors'],
  rootDoc?: RemoteDocument,
): Promise<string[]> {
  const found: string[] = [];
  const rootUrl = root.toString();
  const seen = new Set<string>([canonical(rootUrl)]);
  let frontier = [rootUrl];
  for (let level = 0; level <= depth && frontier.length && found.length < maxPages; level += 1) {
    const next: string[] = [];
    for (const url of frontier) {
      if (found.length >= maxPages) break;
      try {
        // a raiz já foi baixada para descobrir o host final: não baixa de novo
        const doc =
          rootDoc && canonical(url) === canonical(rootUrl)
            ? rootDoc
            : await fetchRemoteDocument(url);
        pageCache.set(canonical(url), {
          url,
          title: doc.title ?? titleFromContent(doc.content, url),
          content: doc.content,
        });
        found.push(url);
        // só vale descer mais um nível se ainda houver nível para descer
        if (level < depth && doc.html) {
          for (const link of extractLinks(doc.html, doc.finalUrl)) {
            const key = canonical(link);
            if (seen.has(key) || !inScope(link, root, prefix)) continue;
            seen.add(key);
            next.push(link);
          }
        }
      } catch (err) {
        errors.push({ url, error: err instanceof Error ? err.message : String(err) });
      }
    }
    frontier = next;
  }
  return found;
}

/** Primeiro heading do markdown, quando a página não tem <title> aproveitável. */
function titleFromContent(content: string, url: string): string {
  const heading = /^#{1,3}\s+(.+)$/m.exec(content)?.[1]?.trim();
  if (heading) return heading.slice(0, 120);
  const segment = new URL(url).pathname.split('/').filter(Boolean).pop();
  return segment ? decodeURIComponent(segment).replace(/\.[^.]+$/, '') : new URL(url).hostname;
}

/**
 * Varre um site a partir de uma URL e devolve uma página por documento.
 * Falha de página individual NÃO derruba a varredura: entra em `errors` e o
 * resto continua — num portal interno é comum uma página ou outra dar 403.
 */
export async function crawlSite(rawUrl: string, opts: CrawlOptions = {}): Promise<CrawlResult> {
  const maxPages = Math.max(1, Math.min(CRAWL_MAX_PAGES_CAP, opts.maxPages ?? CRAWL_DEFAULT_MAX_PAGES));
  const depth = Math.max(0, Math.min(4, opts.depth ?? CRAWL_DEFAULT_DEPTH));
  const errors: CrawlResult['errors'] = [];
  const pageCache = new Map<string, CrawledPage>();

  /*
   * A raiz é resolvida ANTES de qualquer filtro: domínio que redireciona
   * (vitejs.dev → vite.dev, http → https, sem www → com www) publica o
   * sitemap já com o host novo. Escopando pelo host digitado, TODA URL do
   * sitemap seria descartada e a varredura cairia no plano B sem motivo.
   */
  const requestedUrl = normalizeSourceUrl(rawUrl);
  const first = await fetchRemoteDocument(requestedUrl);
  const rootUrl = first.finalUrl;
  const root = new URL(rootUrl);
  const prefix = scopePrefix(root);
  pageCache.set(canonical(rootUrl), {
    url: rootUrl,
    title: first.title ?? titleFromContent(first.content, rootUrl),
    content: first.content,
  });

  const sitemapUrls = await urlsFromSitemap(root, prefix);
  const via: CrawlResult['via'] = sitemapUrls ? 'sitemap' : 'links';
  let urls: string[];
  let truncated = false;
  if (sitemapUrls) {
    // a URL inicial primeiro: é a página que a pessoa realmente apontou
    const rootKey = canonical(rootUrl);
    const ordered = [
      ...sitemapUrls.filter((u) => canonical(u) === rootKey),
      ...sitemapUrls.filter((u) => canonical(u) !== rootKey),
    ];
    truncated = ordered.length > maxPages;
    urls = ordered.slice(0, maxPages);
  } else {
    urls = await urlsFromLinks(root, prefix, maxPages, depth, pageCache, errors, first);
  }

  const pages: CrawledPage[] = [];
  for (const url of urls) {
    const cached = pageCache.get(canonical(url));
    if (cached) {
      pages.push(cached);
      continue;
    }
    try {
      const doc = await fetchRemoteDocument(url);
      if (!doc.content.trim()) continue;
      pages.push({
        url,
        title: doc.title ?? titleFromContent(doc.content, url),
        content: doc.content,
      });
    } catch (err) {
      errors.push({ url, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (!pages.length) {
    const detail = errors[0]?.error ?? `nenhuma página encontrada sob ${prefix}`;
    throw new Error(`Varredura não trouxe nenhuma página: ${detail} · rede: ${netStatus(rootUrl)}`);
  }
  stripCommonTitleSuffix(pages);
  return { pages, via, errors, truncated };
}

/**
 * Tira o nome do site que quase todo gerador cola no <title> ("Setup - Material
 * for MkDocs"). Só remove quando o MESMO sufixo se repete na maioria das
 * páginas — é a evidência de que ali é a assinatura do site, e não parte do
 * título ("Guia - Parte 2" numa página só continua inteiro).
 */
function stripCommonTitleSuffix(pages: CrawledPage[]): void {
  if (pages.length < 3) return;
  for (const sep of [' - ', ' – ', ' — ', ' | ', ' · ', ' :: ']) {
    const suffixOf = (title: string) => {
      const at = title.lastIndexOf(sep);
      return at > 0 ? title.slice(at) : undefined;
    };
    const counts = new Map<string, number>();
    for (const page of pages) {
      const suffix = suffixOf(page.title);
      if (suffix) counts.set(suffix, (counts.get(suffix) ?? 0) + 1);
    }
    const threshold = Math.max(3, Math.ceil(pages.length * 0.6));
    const common = [...counts.entries()].find(([, n]) => n >= threshold)?.[0];
    if (!common) continue;
    for (const page of pages) {
      if (!page.title.endsWith(common)) continue;
      const stripped = page.title.slice(0, -common.length).trim();
      if (stripped) page.title = stripped;
    }
    return;
  }
}
