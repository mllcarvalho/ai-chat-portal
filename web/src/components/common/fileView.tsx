import { ExcalidrawPreview } from './ExcalidrawPreview';

export const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);
export const isHtml = (path: string) => /\.html?$/i.test(path);
export const isExcalidraw = (path: string) => /\.excalidraw$/i.test(path);
export const hasPreview = (path: string) => isHtml(path) || isExcalidraw(path);

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
