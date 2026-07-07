import * as vscode from 'vscode';
import { requestInitFor } from '../tools/netEnv';
import { withTimeout } from '../util';
import { loadConfig } from './configStore';
import { binaryKindFor, extractBinaryText } from './extractBinary';
import { htmlToMarkdown, sanitizeMarkdown } from './remoteFetch';

/**
 * Fontes remotas hospedadas em SharePoint. Um fetch direto da URL não
 * funciona: a página exige a sessão SSO do navegador (cookies inacessíveis à
 * extensão) e páginas modernas são renderizadas por JavaScript — o HTML cru
 * vem vazio. O caminho suportado é o Microsoft Graph, com o token do provedor
 * de autenticação 'microsoft' embutido no VS Code (mesma conta corporativa,
 * client ID do próprio VS Code — sem registrar app no Azure AD):
 *   - páginas modernas (/SitePages/*.aspx): Pages API com canvasLayout,
 *     extraindo o HTML das web parts de texto;
 *   - arquivos (Word/Excel/PDF/texto): shares API, que resolve qualquer URL
 *     de arquivo (inclusive links de compartilhamento /:w:/...) no driveItem.
 */

const GRAPH = 'https://graph.microsoft.com/v1.0';
/** offline_access garante refresh token — sem ele a sessão expira em ~1h. */
const GRAPH_SCOPES = [
  'https://graph.microsoft.com/Sites.Read.All',
  'https://graph.microsoft.com/Files.Read.All',
  'offline_access',
];

/**
 * O client ID do próprio VS Code NÃO é pré-autorizado pela Microsoft para
 * escopos de SharePoint (AADSTS65002: apps first-party precisam de
 * pré-autorização do dono da API). Então o login exige um app registrado no
 * Entra ID, informado em Configurações; os scopes especiais VSCODE_CLIENT_ID/
 * VSCODE_TENANT fazem o provedor 'microsoft' usar esse app.
 */
const SETUP_HELP =
  'Sem depender do admin: use o bookmarklet — página Conhecimento → "🔖 Capturar do navegador" — ' +
  'com a página do SharePoint aberta e logada. Já a sincronização automática por URL exige um app ' +
  'registrado no Entra ID da empresa, configurado em Configurações → "SharePoint (Microsoft Graph)" ' +
  '(requisitos do app: plataforma "Mobile and desktop applications" com redirect http://localhost, ' +
  'cliente público habilitado e permissões delegadas Sites.Read.All e Files.Read.All do Graph).';

/** Config fresca do disco: o Client ID pode ter sido salvo por OUTRA janela do VS Code. */
function microsoftConfig(): { clientId?: string; tenant?: string } {
  return loadConfig().microsoft ?? {};
}

function graphScopes(): string[] {
  const ms = microsoftConfig();
  if (!ms.clientId) return GRAPH_SCOPES;
  return [
    `VSCODE_CLIENT_ID:${ms.clientId}`,
    `VSCODE_TENANT:${ms.tenant || 'organizations'}`,
    ...GRAPH_SCOPES,
  ];
}
const FETCH_TIMEOUT_MS = 30_000;
const FILE_LIMIT = 20 * 1024 * 1024;
/** Extensões de texto baixadas como estão (além das convertíveis de extractBinary). */
const TEXT_EXTENSIONS = /\.(md|markdown|txt|csv|json|html?)$/i;

export function isSharePointUrl(raw: string): boolean {
  try {
    return /\.sharepoint\.(com|us|de|cn)$/i.test(new URL(raw).hostname);
  } catch {
    return false;
  }
}

let consentPending = false;

/**
 * Mesmo padrão do consentimento GitHub (routes/copilot.ts): a chamada parte do
 * navegador, sem gesto do usuário na janela do VS Code, então o diálogo de
 * login é pedido por notificação — uma vez só — e a requisição atual falha com
 * instrução para tentar de novo depois de autorizar.
 */
function requestMicrosoftConsent(): void {
  if (consentPending) return;
  consentPending = true;
  void vscode.window
    .showInformationMessage(
      'O BMAD Product Studio precisa de acesso à sua conta Microsoft para ler páginas e arquivos do SharePoint.',
      'Entrar com a conta Microsoft',
    )
    .then(async (choice) => {
      try {
        if (choice !== 'Entrar com a conta Microsoft') return;
        await vscode.authentication.getSession('microsoft', graphScopes(), {
          createIfNone: true,
        });
      } catch (err) {
        // o VS Code já mostra o erro bruto do login; aqui entra a orientação
        const message = err instanceof Error ? err.message : String(err);
        if (/AADSTS65002|AADSTS650052|AADSTS700016/.test(message)) {
          void vscode.window.showErrorMessage(`Login Microsoft falhou. ${SETUP_HELP}`);
        }
      } finally {
        consentPending = false;
      }
    });
}

async function graphToken(): Promise<string> {
  if (!microsoftConfig().clientId) {
    // sem app configurado o login falharia sempre com AADSTS65002 — falha
    // cedo com a instrução em vez de mandar o usuário a um erro da Microsoft
    throw new Error(`Sincronização por URL de SharePoint não configurada. ${SETUP_HELP}`);
  }
  const session = await withTimeout(
    vscode.authentication.getSession('microsoft', graphScopes(), { silent: true }),
    5000,
    undefined,
  );
  if (!session) {
    requestMicrosoftConsent();
    throw new Error(
      'Entre com a conta Microsoft na janela do VS Code (notificação no canto inferior direito) e adicione a URL de novo',
    );
  }
  return session.accessToken;
}

async function graphFetch(pathOrUrl: string, token: string): Promise<Response> {
  const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `${GRAPH}${pathOrUrl}`;
  const res = await fetch(url, {
    ...requestInitFor(url, { Authorization: `Bearer ${token}`, Accept: 'application/json' }),
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 401) {
    throw new Error('A sessão Microsoft expirou — tente de novo (o VS Code renova o login sozinho)');
  }
  if (res.status === 403) {
    throw new Error(
      'O Microsoft Graph negou o acesso (403). Ou seu usuário não tem permissão neste site, ou o ' +
        'tenant da empresa exige consentimento de administrador para leitura de SharePoint pelo VS Code.',
    );
  }
  if (res.status === 404) {
    throw new Error('Página ou arquivo não encontrado no SharePoint — confira a URL e o seu acesso');
  }
  if (!res.ok) throw new Error(`O Microsoft Graph respondeu ${res.status} ${res.statusText}`);
  return res;
}

async function graphGet<T>(pathOrUrl: string, token: string): Promise<T> {
  return (await graphFetch(pathOrUrl, token)).json() as Promise<T>;
}

export interface SharePointContent {
  content: string;
  /** Nome de documento sugerido (título da página ou nome do arquivo). */
  suggestedName?: string;
}

export async function fetchSharePointContent(raw: string): Promise<SharePointContent> {
  const url = new URL(raw);
  const pathname = url.pathname.toLowerCase();
  if (pathname.endsWith('allitems.aspx') || pathname.includes('/forms/')) {
    throw new Error(
      'Esta URL é a visualização de uma biblioteca/lista — use o link direto de um arquivo ou de uma página',
    );
  }
  const token = await graphToken();
  if (pathname.includes('/sitepages/') && pathname.endsWith('.aspx')) {
    return fetchSitePage(url, token);
  }
  return fetchDriveFile(url, token);
}

// ---------------------------------------------------------------------------
// Páginas modernas (SitePages)

interface SitePageMeta {
  id: string;
  name?: string;
  title?: string;
}

interface TextWebPart {
  '@odata.type'?: string;
  innerHtml?: string;
  data?: { title?: string; description?: string };
}

interface CanvasColumn {
  webparts?: TextWebPart[];
}

interface CanvasLayout {
  horizontalSections?: Array<{ columns?: CanvasColumn[] }>;
  verticalSection?: CanvasColumn;
}

async function fetchSitePage(url: URL, token: string): Promise<SharePointContent> {
  const siteId = await resolveSiteId(url, token);
  const pageName = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '');
  const page = await findPage(siteId, pageName, token);
  if (!page) {
    throw new Error(`Página "${pageName}" não encontrada no site — confira a URL`);
  }
  const full = await graphGet<SitePageMeta & { canvasLayout?: CanvasLayout }>(
    `/sites/${siteId}/pages/${page.id}/microsoft.graph.sitePage?$expand=canvasLayout`,
    token,
  );
  const html = collectWebPartHtml(full.canvasLayout);
  if (!html.trim()) {
    throw new Error(
      'A página não tem conteúdo de texto extraível (só web parts dinâmicas, que o Graph não expõe)',
    );
  }
  const title = full.title || page.title || pageName.replace(/\.aspx$/i, '');
  const markdown = sanitizeMarkdown(htmlToMarkdown(html), url.toString());
  return {
    content: `# ${title}\n\n${markdown}`,
    suggestedName: `${safeName(title)}.md`,
  };
}

/** Site pelo caminho: /sites/Nome ou /teams/Nome; sem prefixo, o site raiz do tenant. */
async function resolveSiteId(url: URL, token: string): Promise<string> {
  const match = /^\/(sites|teams)\/([^/]+)/i.exec(url.pathname);
  const path = match
    ? `/sites/${url.hostname}:/${match[1]}/${decodeURIComponent(match[2])}`
    : `/sites/${url.hostname}`;
  const site = await graphGet<{ id?: string }>(path, token);
  if (!site.id) throw new Error('Não foi possível resolver o site do SharePoint pela URL');
  return site.id;
}

async function findPage(
  siteId: string,
  pageName: string,
  token: string,
): Promise<SitePageMeta | undefined> {
  // caminho rápido: filtro por nome (nem todo tenant aceita $filter em pages)
  try {
    const filtered = await graphGet<{ value?: SitePageMeta[] }>(
      `/sites/${siteId}/pages?$filter=${encodeURIComponent(`name eq '${pageName.replace(/'/g, "''")}'`)}`,
      token,
    );
    if (filtered.value?.length) return filtered.value[0];
  } catch {
    // cai na listagem paginada
  }
  const target = pageName.toLowerCase();
  let next: string | undefined = `/sites/${siteId}/pages?$select=id,name,title&$top=100`;
  for (let hop = 0; next && hop < 10; hop++) {
    const batch: { value?: SitePageMeta[]; '@odata.nextLink'?: string } = await graphGet(
      next,
      token,
    );
    const hit = batch.value?.find((p) => p.name?.toLowerCase() === target);
    if (hit) return hit;
    next = batch['@odata.nextLink'];
  }
  return undefined;
}

function collectWebPartHtml(layout?: CanvasLayout): string {
  const chunks: string[] = [];
  const takeColumn = (column?: CanvasColumn) => {
    for (const part of column?.webparts ?? []) {
      if (part.innerHtml) {
        chunks.push(part.innerHtml);
      } else if (part.data?.title || part.data?.description) {
        // web part dinâmica: pelo menos título/descrição entram como contexto
        chunks.push(
          `<p>${[part.data.title, part.data.description].filter(Boolean).join(' — ')}</p>`,
        );
      }
    }
  };
  for (const section of layout?.horizontalSections ?? []) {
    for (const column of section.columns ?? []) takeColumn(column);
  }
  takeColumn(layout?.verticalSection);
  return chunks.join('\n');
}

// ---------------------------------------------------------------------------
// Arquivos (bibliotecas de documentos, links de compartilhamento)

interface DriveItem {
  name?: string;
  size?: number;
  file?: { mimeType?: string };
  folder?: object;
}

/** Codifica a URL no formato de shareId do Graph (base64url com prefixo u!). */
function shareIdFor(url: string): string {
  const b64 = Buffer.from(url, 'utf8').toString('base64');
  return `u!${b64.replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-')}`;
}

async function fetchDriveFile(url: URL, token: string): Promise<SharePointContent> {
  const shareId = shareIdFor(url.toString());
  const item = await graphGet<DriveItem>(
    `/shares/${shareId}/driveItem?$select=name,size,file,folder`,
    token,
  );
  if (item.folder) {
    throw new Error('A URL aponta para uma pasta — use o link direto de um arquivo');
  }
  const name = item.name ?? 'documento';
  if (/\.(doc|ppt)$/i.test(name)) {
    throw new Error(
      `Formato ${/\.doc$/i.test(name) ? '.doc' : '.ppt'} (Office antigo) não é suportado — salve como ${/\.doc$/i.test(name) ? '.docx' : '.pptx'}`,
    );
  }
  const kind = binaryKindFor(item.file?.mimeType ?? '', name);
  if (!kind && !TEXT_EXTENSIONS.test(name)) {
    throw new Error(
      `Formato não suportado (${name}) — aceitos: página do SharePoint, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), PDF, markdown e texto`,
    );
  }
  if ((item.size ?? 0) > FILE_LIMIT) {
    throw new Error('Arquivo excede o limite de 20 MB');
  }
  const res = await graphFetch(`/shares/${shareId}/driveItem/content`, token);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.byteLength > FILE_LIMIT) throw new Error('Arquivo excede o limite de 20 MB');

  let content: string;
  if (kind) {
    content = await extractBinaryText(kind, data);
  } else if (/\.html?$/i.test(name)) {
    content = sanitizeMarkdown(htmlToMarkdown(data.toString('utf8')), url.toString());
  } else {
    content = data.toString('utf8');
  }
  const stem = name.replace(/\.[^.]+$/, '') || 'documento';
  const ext = /\.(md|txt)$/i.exec(name)?.[0].toLowerCase() ?? '.md';
  return { content, suggestedName: `${safeName(stem)}${ext}` };
}

/** Nome de arquivo seguro preservando legibilidade (o safeDocName do store valida o resto). */
function safeName(title: string): string {
  return title.replace(/[/\\:*?"<>|]+/g, '-').trim().slice(0, 80) || 'documento';
}
