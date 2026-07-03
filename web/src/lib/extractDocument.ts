import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

/**
 * Conversão de documentos binários (Excel, Word, PDF) em texto, feita no
 * navegador na hora do upload/anexo. O resto do portal só trafega texto, então
 * tudo a jusante (anexos, bases de conhecimento, arquivos de contexto) fica
 * intocado. As bibliotecas pesadas carregam sob demanda via import() dinâmico.
 */

const SHEET_EXTENSIONS = ['.xlsx', '.xlsm', '.xls'];
const CONVERTIBLE_EXTENSIONS = [...SHEET_EXTENSIONS, '.docx', '.pptx', '.pdf'];

/** Rótulo dos formatos conversíveis, para mensagens da UI. */
export const CONVERTIBLE_LABEL = 'Excel (.xlsx/.xls), Word (.docx), PowerPoint (.pptx) ou PDF';

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

export function isConvertibleDocument(name: string): boolean {
  return CONVERTIBLE_EXTENSIONS.includes(extOf(name));
}

/** Extrai o texto de um documento conversível; lança Error com mensagem amigável. */
export async function extractDocumentText(file: File): Promise<string> {
  const ext = extOf(file.name);
  if (ext === '.doc') {
    throw new Error('Formato .doc (Word antigo) não é suportado — salve como .docx.');
  }
  if (ext === '.ppt') {
    throw new Error('Formato .ppt (PowerPoint antigo) não é suportado — salve como .pptx.');
  }
  if (SHEET_EXTENSIONS.includes(ext)) return extractSheet(file);
  if (ext === '.docx') return extractDocx(file);
  if (ext === '.pptx') return extractPptx(file);
  if (ext === '.pdf') return extractPdf(file);
  throw new Error(`Formato não suportado: ${ext || file.name}`);
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
async function extractPptx(file: File): Promise<string> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
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

/** Uma seção markdown por aba, com o conteúdo em CSV. */
async function extractSheet(file: File): Promise<string> {
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(await file.arrayBuffer());
  const sections: string[] = [];
  for (const name of workbook.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[name]).trim();
    if (!csv) continue;
    sections.push(`## Aba: ${name}\n\n\`\`\`csv\n${csv}\n\`\`\``);
  }
  if (!sections.length) throw new Error('A planilha não tem conteúdo.');
  return sections.join('\n\n');
}

async function extractDocx(file: File): Promise<string> {
  const mammoth = (await import('mammoth')).default;
  const input = { arrayBuffer: await file.arrayBuffer() };
  // convertToMarkdown existe no runtime mas saiu dos types (deprecado no
  // mammoth); preserva títulos/listas/tabelas — se sumir, cai no texto puro
  const toMarkdown = (
    mammoth as unknown as {
      convertToMarkdown?: (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }>;
    }
  ).convertToMarkdown;
  const result = toMarkdown ? await toMarkdown.call(mammoth, input) : await mammoth.extractRawText(input);
  // imagens embutidas viram data-URIs base64 gigantes que só poluem o texto
  const text = result.value
    .replace(/!\[[^\]]*\]\(data:[^)]*\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) throw new Error('O documento não tem texto.');
  return text;
}

async function extractPdf(file: File): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  // sufixo de versão: invalida caches que guardaram o worker com MIME errado
  // (antes do servidor conhecer .mjs) — sem ele o erro persiste por até 1h
  const sep = pdfWorkerUrl.includes('?') ? '&' : '?';
  pdfjs.GlobalWorkerOptions.workerSrc = `${pdfWorkerUrl}${sep}v=1`;
  const task = pdfjs.getDocument({ data: await file.arrayBuffer() });
  const doc = await task.promise;
  try {
    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      let text = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        text += item.str;
        if (item.hasEOL) text += '\n';
      }
      text = text.trim();
      if (text) pages.push(doc.numPages > 1 ? `--- Página ${n} ---\n\n${text}` : text);
    }
    if (!pages.length) {
      throw new Error('O PDF não tem texto extraível (provavelmente é digitalizado/imagem).');
    }
    return pages.join('\n\n');
  } finally {
    void task.destroy();
  }
}
