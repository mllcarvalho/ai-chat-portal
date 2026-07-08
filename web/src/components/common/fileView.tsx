import { ExcalidrawPreview } from './ExcalidrawPreview';

export const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);
export const isHtml = (path: string) => /\.html?$/i.test(path);
export const isExcalidraw = (path: string) => /\.excalidraw$/i.test(path);
export const hasPreview = (path: string) => isHtml(path) || isExcalidraw(path);

/** Extensões que não fazem sentido exibir/editar como texto. */
const BINARY_EXT =
  /\.(pdf|docx?|xlsx?|pptx?|od[tsp]|png|jpe?g|gif|webp|bmp|ico|zip|gz|tgz|tar|rar|7z|exe|dll|so|dylib|bin|dat|woff2?|ttf|otf|eot|mp[34]|m4[av]|wav|ogg|avi|mov|mkv|heic)$/i;
export const isBinaryFile = (path: string) => BINARY_EXT.test(path);

/**
 * Preview embutido para artefatos visuais (mocks HTML do BMAD UX em iframe
 * isolado, wireframes .excalidraw em SVG). Arquivos truncados não têm preview:
 * o conteúdo incompleto renderizaria quebrado.
 */
export function FilePreview(props: { path: string; content: string }) {
  if (isHtml(props.path)) {
    return (
      <iframe
        className="html-preview"
        title={props.path}
        sandbox="allow-scripts"
        srcDoc={props.content}
      />
    );
  }
  if (isExcalidraw(props.path)) return <ExcalidrawPreview content={props.content} />;
  return null;
}
