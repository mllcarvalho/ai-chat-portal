import * as fsp from 'node:fs/promises';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { extractText, getDocumentProxy } from 'unpdf';

/**
 * Conversão de documentos binários (Word, Excel, PowerPoint, PDF) em texto no
 * host da extensão — espelho Node do web/src/lib/extractDocument.ts (que roda
 * no navegador na hora do upload). Usada para fontes remotas: URLs que servem
 * binário e arquivos baixados do SharePoint via Graph.
 */

export type BinaryKind = 'word' | 'sheet' | 'slides' | 'pdf';

const KIND_BY_EXTENSION: Record<string, BinaryKind> = {
  '.docx': 'word',
  '.xlsx': 'sheet',
  '.xlsm': 'sheet',
  '.xls': 'sheet',
  '.pptx': 'slides',
  '.pdf': 'pdf',
};

const KIND_BY_TYPE: Array<[RegExp, BinaryKind]> = [
  [/wordprocessingml\.document/, 'word'],
  [/spreadsheetml\.sheet|ms-excel/, 'sheet'],
  [/presentationml\.presentation/, 'slides'],
  [/application\/pdf/, 'pdf'],
];

/** Identifica um binário conversível pelo content-type ou pela extensão do arquivo. */
export function binaryKindFor(contentType: string, fileName: string): BinaryKind | undefined {
  for (const [pattern, kind] of KIND_BY_TYPE) {
    if (pattern.test(contentType)) return kind;
  }
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? undefined : KIND_BY_EXTENSION[fileName.slice(dot).toLowerCase()];
}

/** Extrai o texto de um binário conversível; lança Error com mensagem amigável. */
export async function extractBinaryText(kind: BinaryKind, data: Buffer): Promise<string> {
  if (kind === 'word') return extractWord(data);
  if (kind === 'sheet') return extractSheet(data);
  if (kind === 'slides') return extractSlides(data);
  return extractPdf(data);
}

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

function decodeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m]);
}

/** Uma seção markdown por slide, com um parágrafo por bloco de texto (<a:p>). */
async function extractSlides(data: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(data);
  const slideNumber = (path: string) => Number(/slide(\d+)\.xml$/.exec(path)?.[1] ?? 0);
  const slides = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((a, b) => slideNumber(a) - slideNumber(b));
  const sections: string[] = [];
  for (const path of slides) {
    const xml = await zip.files[path].async('string');
    const paragraphs: string[] = [];
    for (const block of xml.match(/<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/g) ?? []) {
      const text = (block.match(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g) ?? [])
        .map((run) => run.replace(/<a:t(?:\s[^>]*)?>|<\/a:t>/g, ''))
        .join('')
        .trim();
      if (text) paragraphs.push(decodeXml(text));
    }
    if (paragraphs.length) {
      sections.push(`## Slide ${slideNumber(path)}\n\n${paragraphs.join('\n\n')}`);
    }
  }
  if (!sections.length) {
    throw new Error('A apresentação não tem texto extraível (slides só com imagens?).');
  }
  return sections.join('\n\n');
}

async function extractWord(data: Buffer): Promise<string> {
  const input = { buffer: data };
  // convertToMarkdown existe no runtime mas saiu dos types (deprecado no
  // mammoth); preserva títulos/listas/tabelas — se sumir, cai no texto puro
  const toMarkdown = (
    mammoth as unknown as {
      convertToMarkdown?: (input: { buffer: Buffer }) => Promise<{ value: string }>;
    }
  ).convertToMarkdown;
  const result = toMarkdown
    ? await toMarkdown.call(mammoth, input)
    : await mammoth.extractRawText(input);
  // imagens embutidas viram data-URIs base64 gigantes que só poluem o texto
  const text = result.value
    .replace(/!\[[^\]]*\]\(data:[^)]*\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) throw new Error('O documento Word não tem texto.');
  return text;
}

/** Uma seção markdown por aba, com o conteúdo em CSV. */
function extractSheet(data: Buffer): string {
  const workbook = XLSX.read(data);
  const sections: string[] = [];
  for (const name of workbook.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[name]).trim();
    if (!csv) continue;
    sections.push(`## Aba: ${name}\n\n\`\`\`csv\n${csv}\n\`\`\``);
  }
  if (!sections.length) throw new Error('A planilha não tem conteúdo.');
  return sections.join('\n\n');
}

async function extractPdf(data: Buffer): Promise<string> {
  const doc = await getDocumentProxy(new Uint8Array(data));
  const { text } = await extractText(doc, { mergePages: true });
  const cleaned = text.replace(/\n{3,}/g, '\n\n').trim();
  if (!cleaned) {
    throw new Error('O PDF não tem texto extraível (provavelmente é digitalizado/imagem).');
  }
  return cleaned;
}

/** Acima disso nem tentamos converter: ler o binário inteiro na memória sai caro. */
const EXTRACT_MAX_BYTES = 25 * 1024 * 1024;

/** Rótulo humano do formato, para o modelo saber que leu uma conversão. */
const KIND_LABEL: Record<BinaryKind, string> = {
  word: 'Word',
  sheet: 'Excel',
  slides: 'PowerPoint',
  pdf: 'PDF',
};

/**
 * Lê um arquivo do disco convertendo-o em texto quando for um formato binário
 * conhecido (Word/Excel/PowerPoint/PDF). Devolve `undefined` para qualquer
 * outro arquivo, para quem chamou seguir com a leitura de texto normal.
 *
 * É o que permite anexar um PDF/planilha em qualquer lugar do portal e o
 * modelo simplesmente LER — antes o conteúdo precisava ser convertido em .md
 * na hora do upload e o arquivo original se perdia.
 */
export async function readBinaryAsText(
  file: string,
  label: string,
): Promise<string | undefined> {
  const kind = binaryKindFor('', file);
  if (!kind) return undefined;
  let data: Buffer;
  try {
    const stat = await fsp.stat(file);
    if (stat.size > EXTRACT_MAX_BYTES) {
      return (
        `${label}: arquivo ${KIND_LABEL[kind]} de ${Math.round(stat.size / 1024 / 1024)} MB — ` +
        `grande demais para converter em texto (teto de ${EXTRACT_MAX_BYTES / 1024 / 1024} MB).`
      );
    }
    data = await fsp.readFile(file);
  } catch (err) {
    throw new Error(`Não consegui ler ${label}: ${err instanceof Error ? err.message : err}`);
  }
  return extractedNote(kind, label, await extractBinaryTextSafe(kind, data, label));
}

/** Mesma conversão, a partir dos bytes (upload, anexo de skill, doc de base). */
export async function bufferAsText(
  data: Buffer,
  fileName: string,
  label = fileName,
): Promise<string | undefined> {
  const kind = binaryKindFor('', fileName);
  if (!kind) return undefined;
  if (data.length > EXTRACT_MAX_BYTES) {
    return (
      `${label}: arquivo ${KIND_LABEL[kind]} de ${Math.round(data.length / 1024 / 1024)} MB — ` +
      `grande demais para converter em texto (teto de ${EXTRACT_MAX_BYTES / 1024 / 1024} MB).`
    );
  }
  return extractedNote(kind, label, await extractBinaryTextSafe(kind, data, label));
}

async function extractBinaryTextSafe(
  kind: BinaryKind,
  data: Buffer,
  label: string,
): Promise<string> {
  try {
    return await extractBinaryText(kind, data);
  } catch (err) {
    throw new Error(
      `Não consegui extrair o texto de ${label} (${KIND_LABEL[kind]}): ` +
        `${err instanceof Error ? err.message : err}`,
    );
  }
}

/** Deixa explícito que o conteúdo é uma conversão, não o arquivo como está. */
function extractedNote(kind: BinaryKind, label: string, text: string): string {
  return (
    `[texto extraído de ${label} (${KIND_LABEL[kind]}) — formatação, imagens e layout não são ` +
    `preservados]\n\n${text}`
  );
}
