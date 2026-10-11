import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { Block, ToolBlock } from '@solline/protocol';
import { Markdown } from '../../components/markdown.tsx';
import { ToolStateIcon } from './blocks.tsx';
import { ToolInput, prettyJson } from './tool-input.tsx';

const STATE_LABEL: Record<ToolBlock['state'], string> = {
  running: 'A correr',
  ok: 'Concluída',
  error: 'Falhou',
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-5">
      <h3 className="mb-2 text-[11px] font-medium tracking-[0.04em] text-subtle uppercase">
        {title}
      </h3>
      <div className="max-h-[22rem] overflow-auto rounded-md border border-line bg-surface-sunken p-3 select-text">
        {children}
      </div>
    </section>
  );
}

/** A vista detalhada de uma ferramenta: o "ctrl+o" do CLI, com input e output completos. */
export function ToolDetail({
  tool,
  childBlocks,
  onClose,
}: {
  tool: ToolBlock | null;
  childBlocks: Block[];
  onClose: () => void;
}) {
  return (
    <Dialog.Root open={tool !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay fixed inset-0 z-40 bg-black/25 backdrop-blur-[2px]" />
        <Dialog.Content
          data-testid="tool-detail"
          className="dialog-content fixed top-1/2 left-1/2 z-50 flex max-h-[86vh] w-[min(46rem,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-line bg-surface shadow-raised outline-none"
        >
          {tool ? (
            <>
              <header className="flex items-start gap-3 border-b border-line px-5 py-4">
                <span className="mt-1 grid size-4 place-items-center text-muted">
                  <ToolStateIcon state={tool.state} />
                </span>
                <div className="min-w-0 flex-1">
                  <Dialog.Title className="truncate text-[15px] font-semibold tracking-[-0.01em]">
                    {tool.summary}
                  </Dialog.Title>
                  <Dialog.Description className="text-[12px] text-muted">
                    <span className="font-mono">{tool.name}</span> · {STATE_LABEL[tool.state]}
                  </Dialog.Description>
                </div>
                <Dialog.Close
                  aria-label="Fechar detalhe"
                  className="grid size-7 place-items-center rounded-sm text-muted transition-colors duration-150 hover:bg-surface-hover hover:text-fg"
                >
                  <X size={15} />
                </Dialog.Close>
              </header>
              <div className="overflow-y-auto px-5 pb-5">
                <Section title="Entrada">
                  <ToolInput name={tool.name} input={tool.input} />
                </Section>
                <Section title="Saída">
                  {tool.output === undefined ? (
                    <span className="text-[12.5px] text-subtle">Ainda sem saída.</span>
                  ) : (
                    <pre
                      className="font-mono text-[12px] leading-[1.6] whitespace-pre-wrap"
                      data-testid="tool-output"
                    >
                      {tool.output || '(vazia)'}
                    </pre>
                  )}
                </Section>
                {tool.result !== undefined && typeof tool.result !== 'string' ? (
                  <details className="mt-5">
                    <summary className="cursor-pointer text-[12px] text-muted hover:text-fg">
                      Resultado estruturado
                    </summary>
                    <pre className="mt-2 max-h-80 overflow-auto rounded-md border border-line bg-surface-sunken p-3 font-mono text-[11.5px] leading-[1.55] select-text">
                      {prettyJson(tool.result)}
                    </pre>
                  </details>
                ) : null}
                {childBlocks.length > 0 ? (
                  <Section title={`Subagente · ${childBlocks.length} passos`}>
                    <ul className="space-y-1.5 text-[12.5px]">
                      {childBlocks.map((child) => (
                        <li key={child.id}>
                          {child.kind === 'tool' ? (
                            <span className="flex items-center gap-2">
                              <ToolStateIcon state={child.state} /> {child.summary}
                            </span>
                          ) : child.kind === 'text' ? (
                            <Markdown text={child.text} />
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </Section>
                ) : null}
              </div>
            </>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
