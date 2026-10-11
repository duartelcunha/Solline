import { memo, type ComponentProps } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

const components: Components = {
  pre(props: ComponentProps<'pre'>) {
    return (
      <pre
        {...props}
        className="my-3 overflow-x-auto rounded-md border border-line bg-surface-sunken p-3 text-[12.5px] leading-[1.55]"
      />
    );
  },
  // Os links abrem no browser (o main só deixa sair https).
  a(props: ComponentProps<'a'>) {
    return <a {...props} target="_blank" rel="noreferrer" />;
  },
};

/**
 * Markdown com GFM e realce de código offline (highlight.js via lowlight).
 * shortcut: volta a analisar o texto todo a cada delta; numa resposta muito longa pode
 * pesar. Partir por parágrafos se se notar lentidão.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-sl">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false }]]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
