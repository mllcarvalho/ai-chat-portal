import { useEffect, useRef, useState } from 'react';

/**
 * Renderiza um bloco ```mermaid``` como diagrama SVG. O mermaid (~2 MB) entra
 * por import dinâmico: vira chunk próprio do bundle, carregado só quando o
 * primeiro diagrama aparece — e servido localmente (sem CDN, ambiente offline).
 */

let mermaidReady: Promise<typeof import('mermaid').default> | undefined;

function loadMermaid() {
  mermaidReady ??= import('mermaid').then((mod) => {
    mod.default.initialize({
      startOnLoad: false,
      theme: 'neutral',
      securityLevel: 'strict',
      fontFamily: 'inherit',
    });
    return mod.default;
  });
  return mermaidReady;
}

let renderSeq = 0;

export function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string>();
  const [error, setError] = useState<string>();
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    // debounce: durante o streaming o código muda a cada token — renderiza só
    // quando ele estabiliza (o fallback de erro cobre o meio-tempo)
    const timer = setTimeout(() => {
      void loadMermaid()
        .then((mermaid) => mermaid.render(`mermaid-${renderSeq++}`, code))
        .then(({ svg: rendered }) => {
          if (cancelled) return;
          setSvg(rendered);
          setError(undefined);
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
          // o mermaid.render deixa um nó de erro órfão no body — limpa
          document.querySelectorAll('body > [id^="dmermaid-"]').forEach((el) => el.remove());
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code]);

  if (error) {
    // diagrama inválido (ou ainda sendo transmitido): mostra o código como sempre foi
    return (
      <div className="code-block">
        <div className="code-block__bar">
          <span>mermaid (diagrama inválido)</span>
        </div>
        <pre>{code}</pre>
      </div>
    );
  }
  if (!svg) {
    return (
      <div ref={hostRef} className="mermaid-block">
        <span className="mermaid-block__loading">desenhando diagrama…</span>
      </div>
    );
  }
  return (
    <div
      ref={hostRef}
      className="mermaid-block"
      // SVG produzido localmente pelo mermaid com securityLevel strict
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
