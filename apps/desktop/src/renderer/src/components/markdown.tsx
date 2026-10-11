import { memo, useState, type ComponentProps } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy } from 'lucide-react';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? 'Copiado' : 'Copiar código'}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="grid size-6 place-items-center rounded-sm text-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-fg"
    >
      {copied ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={1.75} />}
    </button>
  );
}

function textOf(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'props' in node) {
    return textOf((node as { props: { children?: unknown } }).props.children);
  }
  return '';
}

const components: Components = {
  pre({ children, ...props }: ComponentProps<'pre'>) {
    const child = Array.isArray(children) ? children[0] : children;
    const className =
      child && typeof child === 'object' && 'props' in child
        ? String((child as { props: { className?: string } }).props.className ?? '')
        : '';
    const language = /language-([\w-]+)/.exec(className)?.[1];
    return (
      <div className="code-block my-3 overflow-hidden rounded-md border border-line bg-surface-sunken">
        <div className="flex h-8 items-center justify-between border-b border-line pr-1 pl-3">
          <span className="font-mono text-[11px] text-subtle">{language ?? 'texto'}</span>
          <CopyButton text={textOf(children)} />
        </div>
        <pre {...props} className="overflow-x-auto p-3 text-[12.5px] leading-[1.55]">
          {children}
        </pre>
      </div>
    );
  },
  a({ children, href, ...props }: ComponentProps<'a'>) {
    return (
      <a {...props} href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  },
};

/** Markdown com GFM e realce de código offline (highlight.js via lowlight). */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-sl">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
