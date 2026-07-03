import { netStatus, requestInitFor } from './netEnv';

/**
 * Busca web sem API key: endpoints HTML do DuckDuckGo, acessados pela mesma
 * infraestrutura de proxy do portal_fetch_url. O endpoint "html" é o principal;
 * o "lite" cobre quando o primeiro devolve página anti-bot ou é bloqueado.
 */

const SEARCH_TIMEOUT_MS = 20_000;

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X'
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Desfaz o redirect do DuckDuckGo (//duckduckgo.com/l/?uddg=<url>). */
function resolveResultUrl(href: string): string | undefined {
  try {
    const url = new URL(decodeEntities(href), 'https://duckduckgo.com');
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    if (/(^|\.)duckduckgo\.com$/.test(url.hostname)) {
      const target = url.searchParams.get('uddg');
      return target ?? undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

/** html.duckduckgo.com: âncoras result__a (título/link) e result__snippet. */
function parseHtmlResults(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const blocks = html.split(/<a[^>]*class="[^"]*\bresult__a\b[^"]*"/).slice(1);
  for (const block of blocks) {
    const href = /^[^>]*href="([^"]+)"/.exec(block)?.[1];
    const title = />([\s\S]*?)<\/a>/.exec(block)?.[1];
    if (!href || !title) continue;
    const url = resolveResultUrl(href);
    if (!url) continue;
    const snippet =
      /class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/.exec(block)?.[1] ?? '';
    results.push({ title: stripTags(title), url, snippet: stripTags(snippet) });
  }
  return results;
}

/**
 * lite.duckduckgo.com: resultados são as âncoras que apontam para fora do DDG
 * (resolveResultUrl filtra navegação interna), pareadas por ordem com as
 * células result-snippet. Sem depender de classes CSS além do snippet.
 */
function parseLiteResults(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const links = [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  const snippets = [
    ...html.matchAll(/<td[^>]*class=['"]?result-snippet['"]?[^>]*>([\s\S]*?)<\/td>/g),
  ];
  for (const link of links) {
    const url = resolveResultUrl(link[1]);
    const title = stripTags(link[2]);
    if (!url || !title) continue;
    results.push({
      title,
      url,
      snippet: stripTags(snippets[results.length]?.[1] ?? ''),
    });
  }
  return results;
}

async function fetchSearchPage(endpoint: string, query: string): Promise<string> {
  const url = `${endpoint}?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    ...requestInitFor(url, {
      // UA de navegador: os endpoints HTML do DDG devolvem página anti-bot para UAs de script
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      Accept: 'text/html',
    }),
    redirect: 'follow',
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`respondeu ${res.status} ${res.statusText}`);
  return await res.text();
}

export async function searchWeb(query: string, maxResults: number): Promise<WebSearchResult[]> {
  const attempts: Array<{ endpoint: string; parse: (html: string) => WebSearchResult[] }> = [
    { endpoint: 'https://html.duckduckgo.com/html/', parse: parseHtmlResults },
    { endpoint: 'https://lite.duckduckgo.com/lite/', parse: parseLiteResults },
  ];
  const failures: string[] = [];
  for (const { endpoint, parse } of attempts) {
    try {
      const page = await fetchSearchPage(endpoint, query);
      const results = parse(page).slice(0, maxResults);
      if (results.length) return results;
      failures.push(`${new URL(endpoint).hostname}: sem resultados (possível bloqueio anti-bot)`);
    } catch (err) {
      failures.push(`${new URL(endpoint).hostname}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(
    `Busca na web falhou — ${failures.join('; ')} · rede: ${netStatus('https://duckduckgo.com')}`,
  );
}
