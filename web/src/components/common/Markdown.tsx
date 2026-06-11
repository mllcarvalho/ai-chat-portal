import { memo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

function CodeBlock(props: { language?: string; children: ReactNode; raw: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(props.raw).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };
  return (
    <div className="code-block">
      <div className="code-block__bar">
        <span>{props.language ?? 'código'}</span>
        <button className="code-block__copy" onClick={copy}>
          {copied ? 'copiado ✓' : 'copiar'}
        </button>
      </div>
      <pre>{props.children}</pre>
    </div>
  );
}

function extractText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (node && typeof node === 'object' && 'props' in node) {
    return extractText((node as { props: { children?: unknown } }).props.children);
  }
  return '';
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre({ children }) {
            const child = Array.isArray(children) ? children[0] : children;
            const className =
              (child as { props?: { className?: string } })?.props?.className ?? '';
            const language = /language-([\w-]+)/.exec(className)?.[1];
            return (
              <CodeBlock language={language} raw={extractText(children)}>
                {children}
              </CodeBlock>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
