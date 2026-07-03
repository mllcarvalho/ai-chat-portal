import { useMemo } from 'react';

/**
 * Preview de arquivos .excalidraw (wireframes do BMAD UX): renderer SVG
 * próprio, sem dependências — cobre as formas que os wireframes usam
 * (retângulo, elipse, losango, linha, seta, texto, frame). Traço limpo em vez
 * do rabisco do Excalidraw; para edição real o usuário abre no excalidraw.com.
 */

interface ExElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle?: number;
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: string;
  strokeWidth?: number;
  strokeStyle?: string;
  opacity?: number;
  isDeleted?: boolean;
  index?: string;
  roundness?: unknown;
  points?: Array<[number, number]>;
  text?: string;
  fontSize?: number;
  textAlign?: string;
  verticalAlign?: string;
  lineHeight?: number;
  containerId?: string | null;
  name?: string;
}

interface ExFile {
  type?: string;
  elements?: ExElement[];
  appState?: { viewBackgroundColor?: string };
}

const PAD = 24;

function parseExcalidraw(content: string): { elements: ExElement[]; background: string } {
  const data = JSON.parse(content) as ExFile;
  if (!Array.isArray(data.elements)) throw new Error('sem lista de elementos');
  const elements = data.elements
    .filter((el) => el && !el.isDeleted && Number.isFinite(el.x) && Number.isFinite(el.y))
    .sort((a, b) => (a.index && b.index ? (a.index < b.index ? -1 : 1) : 0));
  return { elements, background: data.appState?.viewBackgroundColor ?? '#ffffff' };
}

function bounds(elements: ExElement[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of elements) {
    const points = el.points?.length ? el.points : [[0, 0], [el.width || 0, el.height || 0]];
    for (const [px, py] of points) {
      minX = Math.min(minX, el.x + Math.min(px, 0));
      minY = Math.min(minY, el.y + Math.min(py, 0));
      maxX = Math.max(maxX, el.x + Math.max(px, el.width || 0));
      maxY = Math.max(maxY, el.y + Math.max(py, el.height || 0));
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, width: 100, height: 100 };
  return { minX, minY, width: maxX - minX, height: maxY - minY };
}

function strokeProps(el: ExElement) {
  return {
    stroke: el.strokeColor ?? '#1e1e1e',
    strokeWidth: el.strokeWidth ?? 1.5,
    strokeDasharray:
      el.strokeStyle === 'dashed' ? '8 6' : el.strokeStyle === 'dotted' ? '2 4' : undefined,
    opacity: (el.opacity ?? 100) / 100,
  };
}

function fillProps(el: ExElement) {
  const bg = el.backgroundColor;
  if (!bg || bg === 'transparent') return { fill: 'none' as const };
  // hachure/cross-hatch do Excalidraw viram preenchimento translúcido
  return { fill: bg, fillOpacity: el.fillStyle === 'solid' ? 1 : 0.25 };
}

function rotation(el: ExElement): string | undefined {
  if (!el.angle) return undefined;
  const cx = el.x + (el.width || 0) / 2;
  const cy = el.y + (el.height || 0) / 2;
  return `rotate(${(el.angle * 180) / Math.PI} ${cx} ${cy})`;
}

function renderText(el: ExElement) {
  const fontSize = el.fontSize ?? 16;
  const lineHeight = (el.lineHeight ?? 1.25) * fontSize;
  const lines = (el.text ?? '').split('\n');
  const anchor = el.textAlign === 'center' ? 'middle' : el.textAlign === 'right' ? 'end' : 'start';
  const anchorX =
    el.textAlign === 'center' ? el.x + (el.width || 0) / 2
    : el.textAlign === 'right' ? el.x + (el.width || 0)
    : el.x;
  return (
    <text
      key={el.id}
      x={anchorX}
      y={el.y + fontSize * 0.85}
      fontSize={fontSize}
      fontFamily="var(--font-body, sans-serif)"
      textAnchor={anchor}
      fill={el.strokeColor ?? '#1e1e1e'}
      opacity={(el.opacity ?? 100) / 100}
      transform={rotation(el)}
    >
      {lines.map((line, i) => (
        <tspan key={i} x={anchorX} dy={i === 0 ? 0 : lineHeight}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

function renderLinear(el: ExElement) {
  const points = el.points?.length ? el.points : [[0, 0], [el.width || 0, el.height || 0]];
  const abs = points.map(([px, py]) => [el.x + px, el.y + py] as const);
  const d = abs.map(([px, py], i) => `${i === 0 ? 'M' : 'L'} ${px} ${py}`).join(' ');
  const parts = [
    <path key="line" d={d} fill="none" {...strokeProps(el)} transform={rotation(el)} />,
  ];
  if (el.type === 'arrow' && abs.length >= 2) {
    const [x1, y1] = abs[abs.length - 2];
    const [x2, y2] = abs[abs.length - 1];
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const size = 10 + (el.strokeWidth ?? 1.5) * 2;
    const left = [x2 - size * Math.cos(angle - 0.45), y2 - size * Math.sin(angle - 0.45)];
    const right = [x2 - size * Math.cos(angle + 0.45), y2 - size * Math.sin(angle + 0.45)];
    parts.push(
      <path
        key="head"
        d={`M ${left[0]} ${left[1]} L ${x2} ${y2} L ${right[0]} ${right[1]}`}
        fill="none"
        {...strokeProps(el)}
        strokeDasharray={undefined}
        transform={rotation(el)}
      />,
    );
  }
  return <g key={el.id}>{parts}</g>;
}

function renderElement(el: ExElement) {
  switch (el.type) {
    case 'rectangle':
      return (
        <rect
          key={el.id}
          x={el.x}
          y={el.y}
          width={el.width}
          height={el.height}
          rx={el.roundness ? Math.min(12, el.width / 8, el.height / 8) : 0}
          {...strokeProps(el)}
          {...fillProps(el)}
          transform={rotation(el)}
        />
      );
    case 'frame':
      return (
        <g key={el.id}>
          <rect
            x={el.x}
            y={el.y}
            width={el.width}
            height={el.height}
            rx={6}
            fill="none"
            stroke="#9aa3b2"
            strokeWidth={1}
          />
          <text x={el.x} y={el.y - 6} fontSize={12} fill="#9aa3b2" fontFamily="var(--font-body, sans-serif)">
            {el.name ?? 'Frame'}
          </text>
        </g>
      );
    case 'ellipse':
      return (
        <ellipse
          key={el.id}
          cx={el.x + el.width / 2}
          cy={el.y + el.height / 2}
          rx={el.width / 2}
          ry={el.height / 2}
          {...strokeProps(el)}
          {...fillProps(el)}
          transform={rotation(el)}
        />
      );
    case 'diamond': {
      const cx = el.x + el.width / 2;
      const cy = el.y + el.height / 2;
      return (
        <polygon
          key={el.id}
          points={`${cx},${el.y} ${el.x + el.width},${cy} ${cx},${el.y + el.height} ${el.x},${cy}`}
          {...strokeProps(el)}
          {...fillProps(el)}
          transform={rotation(el)}
        />
      );
    }
    case 'line':
    case 'arrow':
      return renderLinear(el);
    case 'text':
      return renderText(el);
    default:
      return null;
  }
}

export function ExcalidrawPreview({ content }: { content: string }) {
  const parsed = useMemo(() => {
    try {
      return parseExcalidraw(content);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }, [content]);

  if ('error' in parsed) {
    return (
      <div className="empty-state">
        Não foi possível interpretar este .excalidraw ({parsed.error}). Veja o código-fonte ou
        abra no excalidraw.com.
      </div>
    );
  }
  const box = bounds(parsed.elements);
  return (
    <div className="excalidraw-preview" style={{ background: parsed.background }}>
      <svg
        viewBox={`${box.minX - PAD} ${box.minY - PAD} ${box.width + PAD * 2} ${box.height + PAD * 2}`}
        style={{ width: '100%', height: 'auto', display: 'block' }}
        role="img"
      >
        {parsed.elements.map(renderElement)}
      </svg>
    </div>
  );
}
