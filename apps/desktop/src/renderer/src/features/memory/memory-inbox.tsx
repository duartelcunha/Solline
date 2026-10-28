import { useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Check,
  FileText,
  GitCommitHorizontal,
  Inbox,
  TriangleAlert,
} from 'lucide-react';
import { MEMORY_EDIT_TEXT, type MemoryCitation, type SpaceMemory } from '@solline/protocol';
import { actions, useApp } from '../../stores/app.ts';
import { quietSpace, useSpaces } from '../../stores/spaces.ts';
import { labelFor } from '../agents/agent-label.tsx';
import { navigateTo } from '../navigation/controller.ts';
import {
  batchSelectable,
  citationCopy,
  citationLabel,
  pendingFor,
  planApproval,
  ruleProjectOf,
  staleLabel,
  toConfirmFor,
  type MemoryScope,
} from './memory-model.ts';

const button = 'space-control sl-press';

interface Choice {
  scope: MemoryScope;
  /** O texto em edição; null se não se está a editar. */
  text: string | null;
}
const initial: Choice = { scope: 'project', text: null };

/** Uma prova: ficheiro e linhas, ou um commit. Clicar copia-a (a Solline não abre ficheiros por ti). */
function Proof({ citation }: { citation: MemoryCitation }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const Icon = 'commit' in citation ? GitCommitHorizontal : FileText;
  return (
    <button
      type="button"
      data-testid="memory-proof"
      title="Copiar"
      onClick={() => {
        void navigator.clipboard?.writeText(citationCopy(citation)).catch(() => undefined);
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1400);
      }}
      className="sl-press inline-flex max-w-full items-center gap-1.5 rounded-sm border border-line bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] hover:bg-surface-hover"
    >
      <Icon size={12} className="shrink-0 text-subtle" aria-hidden />
      <span className="truncate">{copied ? 'Copiado' : citationLabel(citation)}</span>
    </button>
  );
}

/** Quem propôs: o agente e a sessão (que se abre, se ainda existe). */
function Origin({ memory }: { memory: SpaceMemory }) {
  const agents = useApp((s) => s.agents);
  const origin = memory.origin;
  const open = useApp((s) => (origin ? s.sessionIds.includes(origin.sessionId) : false));
  if (!origin) return <span>{memory.source}</span>;
  const agent = labelFor(agents, origin.agent);
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5">
      Proposta do {agent}
      {open ? (
        <button
          type="button"
          className="sl-press inline-flex items-center gap-0.5 rounded-sm font-medium text-fg hover:underline"
          onClick={() => navigateTo({ view: 'session', sessionId: origin.sessionId })}
          data-testid="memory-origin-open"
        >
          · abrir a sessão <ArrowUpRight size={11} aria-hidden />
        </button>
      ) : (
        <span>· a sessão já não está aberta</span>
      )}
    </span>
  );
}

function ScopeChoice({
  value,
  onChange,
}: {
  value: MemoryScope;
  onChange: (scope: MemoryScope) => void;
}) {
  return (
    <div className="space-tabs" role="group" aria-label="Onde vive depois de aprovada">
      <button type="button" aria-pressed={value === 'project'} onClick={() => onChange('project')}>
        Projeto
      </button>
      <button type="button" aria-pressed={value === 'global'} onClick={() => onChange('global')}>
        Geral
      </button>
    </div>
  );
}

function ProposalCard({
  memory,
  choice,
  selected,
  showProject,
  busy,
  onChoice,
  onSelect,
  onApprove,
  onReject,
  onToRule,
}: {
  memory: SpaceMemory;
  choice: Choice;
  selected: boolean;
  showProject: boolean;
  busy: boolean;
  onChoice: (next: Choice) => void;
  onSelect: (on: boolean) => void;
  onApprove: () => void;
  onReject: () => void;
  onToRule: () => void;
}) {
  const projects = useApp((s) => s.projects);
  const projectName = projects.find((p) => p.id === memory.projectId)?.name;
  const editing = choice.text !== null;
  const canRule = ruleProjectOf(memory) !== null;
  return (
    <li
      data-testid="memory-proposal"
      data-external={memory.external || undefined}
      className="grid gap-3 rounded-md border border-line bg-surface p-4"
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-1 size-4 shrink-0"
          aria-label={`Escolher: ${memory.text}`}
          checked={selected}
          disabled={!batchSelectable(memory) || busy}
          title={batchSelectable(memory) ? undefined : 'Origem externa: aprova esta uma a uma'}
          onChange={(e) => onSelect(e.target.checked)}
          data-testid="memory-select"
        />
        <div className="min-w-0 flex-1">
          {showProject && projectName ? (
            <p className="mb-1 text-[11px] font-medium tracking-[0.04em] text-subtle uppercase">
              {projectName}
            </p>
          ) : null}
          {editing ? (
            <textarea
              aria-label="Texto da memória"
              value={choice.text ?? ''}
              maxLength={MEMORY_EDIT_TEXT}
              rows={3}
              onChange={(e) => onChoice({ ...choice, text: e.target.value })}
              data-testid="memory-edit"
            />
          ) : (
            <p
              className="text-[13.5px] leading-relaxed break-words whitespace-pre-wrap select-text"
              data-testid="memory-text"
            >
              {memory.text}
            </p>
          )}
          {memory.reason ? (
            <p className="mt-2 text-[12.5px] leading-relaxed text-muted select-text">
              <span className="font-medium text-fg">Porque importa: </span>
              {memory.reason}
            </p>
          ) : null}
        </div>
      </div>

      {memory.citations.length ? (
        <div className="flex flex-wrap items-center gap-1.5 pl-7">
          <span className="text-[11px] text-subtle">Prova</span>
          {memory.citations.map((citation) => (
            <Proof key={citationLabel(citation)} citation={citation} />
          ))}
        </div>
      ) : null}

      <p className="pl-7 text-[11.5px] text-muted">
        <Origin memory={memory} />
      </p>

      {memory.external ? (
        <p
          role="note"
          data-testid="memory-external"
          className="ml-7 flex items-start gap-2 rounded-control bg-attention-soft px-3 py-2 text-[12.5px] text-attention"
        >
          <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            Origem externa: o agente leu a web ou servidores de terceiros neste turno. Confirma que
            o texto é teu e não veio de uma página.
          </span>
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 pl-7">
        <ScopeChoice value={choice.scope} onChange={(scope) => onChoice({ ...choice, scope })} />
        <button
          type="button"
          className={`${button} space-primary`}
          disabled={busy || (editing && !(choice.text ?? '').trim())}
          onClick={onApprove}
          data-testid="memory-approve"
        >
          <Check size={13} />
          Aprovar
        </button>
        <button
          type="button"
          className={`${button} space-quiet`}
          disabled={busy}
          aria-pressed={editing}
          onClick={() => onChoice({ ...choice, text: editing ? null : memory.text })}
          data-testid="memory-edit-toggle"
        >
          {editing ? 'Largar a edição' : 'Editar'}
        </button>
        {canRule ? (
          <button
            type="button"
            className={`${button} space-quiet`}
            disabled={busy}
            onClick={onToRule}
            title="Aprova a memória e faz dela uma regra do projeto"
            data-testid="memory-to-rule"
          >
            Transformar em regra
          </button>
        ) : null}
        <button
          type="button"
          className={`${button} ml-auto`}
          disabled={busy}
          onClick={onReject}
          data-testid="memory-reject"
        >
          Recusar
        </button>
      </div>
    </li>
  );
}

function ConfirmCard({ memory, showProject }: { memory: SpaceMemory; showProject: boolean }) {
  const projects = useApp((s) => s.projects);
  const projectName = projects.find((p) => p.id === memory.projectId)?.name;
  const [busy, setBusy] = useState(false);
  return (
    <li
      data-testid="memory-confirm-card"
      className="grid gap-3 rounded-md border border-line bg-surface p-4"
    >
      <div>
        {showProject && projectName ? (
          <p className="mb-1 text-[11px] font-medium tracking-[0.04em] text-subtle uppercase">
            {projectName}
          </p>
        ) : null}
        <p className="text-[13.5px] leading-relaxed break-words whitespace-pre-wrap select-text">
          {memory.text}
        </p>
        <p className="mt-2 text-[12.5px] text-muted">{staleLabel(memory)}</p>
      </div>
      {memory.citations.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-subtle">Prova</span>
          {memory.citations.map((citation) => (
            <Proof key={citationLabel(citation)} citation={citation} />
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={`${button} space-primary`}
          disabled={busy}
          data-testid="memory-confirm"
          onClick={() => {
            setBusy(true);
            void actions.confirmMemories([memory.id]).finally(() => setBusy(false));
          }}
        >
          <Check size={13} />
          Confirmar
        </button>
        <button
          type="button"
          className={button}
          disabled={busy}
          onClick={() =>
            quietSpace('spaces.memorySave', {
              id: memory.id,
              projectId: memory.projectId,
              text: memory.text,
              source: memory.source,
              sourceId: memory.sourceId,
              state: 'disabled',
            })
          }
        >
          Desativar
        </button>
      </div>
    </li>
  );
}

/**
 * As propostas dos agentes à espera de ti e as memórias a confirmar. Aprova-se, edita-se ou
 * recusa-se em lote, sem interromper nenhuma sessão: o que está aqui ainda não chegou a nenhum agente.
 */
export function MemoryInbox({ projectId }: { projectId: string | null }) {
  const memories = useSpaces((s) => s.data.memories);
  const pending = pendingFor(memories, projectId);
  const toConfirm = toConfirmFor(memories, projectId);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const choiceOf = (id: string) => choices[id] ?? initial;
  const live = new Set(pending.map((m) => m.id));
  const chosen = [...selected].filter((id) => live.has(id));
  const selectable = pending.filter(batchSelectable);

  async function run(work: () => Promise<boolean>) {
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  }

  const choiceFor = (memory: SpaceMemory) => {
    const c = choiceOf(memory.id);
    const text = c.text?.trim();
    return {
      id: memory.id,
      scope: c.scope,
      ...(text && text !== memory.text ? { text } : {}),
    };
  };

  /** Uma chamada por âmbito; pára na primeira que falhe (o motor já mostrou porquê). */
  async function approve(memoryList: SpaceMemory[]): Promise<boolean> {
    for (const call of planApproval(memoryList.map(choiceFor))) {
      const ok = await actions.approveMemories(call.ids, {
        scope: call.scope,
        ...(Object.keys(call.edits).length ? { edits: call.edits } : {}),
      });
      if (!ok) return false;
    }
    setSelected((now) => new Set([...now].filter((id) => !memoryList.some((m) => m.id === id))));
    return true;
  }

  if (!pending.length && !toConfirm.length) return null;
  return (
    <div className="mt-6 grid gap-8" data-testid="memory-inbox">
      {pending.length ? (
        <section aria-label="Propostas por aprovar" className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-sm font-medium">
                <Inbox size={15} aria-hidden className="text-subtle" />
                Por aprovar
                <span className="tabular-nums text-muted" data-testid="memory-pending-count">
                  {pending.length}
                </span>
              </h2>
              <p className="mt-1 text-[12px] text-muted">
                Os agentes propõem, tu decides. Nada chega a um agente antes de aprovares.
              </p>
            </div>
            {selectable.length > 1 ? (
              <div className="flex flex-wrap items-center gap-2" data-testid="memory-batch">
                <label className="flex items-center gap-2 text-[12px] text-muted">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={chosen.length === selectable.length}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked ? new Set(selectable.map((m) => m.id)) : new Set(),
                      )
                    }
                    data-testid="memory-select-all"
                  />
                  Escolher todas
                </label>
                <button
                  type="button"
                  className={`${button} space-primary`}
                  disabled={busy || chosen.length === 0}
                  onClick={() =>
                    void run(() => approve(pending.filter((m) => chosen.includes(m.id))))
                  }
                  data-testid="memory-approve-selected"
                >
                  Aprovar{chosen.length ? ` ${chosen.length}` : ''}
                </button>
                <button
                  type="button"
                  className={button}
                  disabled={busy || chosen.length === 0}
                  onClick={() =>
                    void run(async () => {
                      const ok = await actions.rejectMemories(chosen);
                      if (ok) setSelected(new Set());
                      return ok;
                    })
                  }
                  data-testid="memory-reject-selected"
                >
                  Recusar{chosen.length ? ` ${chosen.length}` : ''}
                </button>
              </div>
            ) : null}
          </div>
          <ul className="grid gap-3">
            {pending.map((memory) => (
              <ProposalCard
                key={memory.id}
                memory={memory}
                choice={choiceOf(memory.id)}
                selected={selected.has(memory.id)}
                showProject={projectId === null}
                busy={busy}
                onChoice={(next) => setChoices((now) => ({ ...now, [memory.id]: next }))}
                onSelect={(on) =>
                  setSelected((now) => {
                    const next = new Set(now);
                    if (on) next.add(memory.id);
                    else next.delete(memory.id);
                    return next;
                  })
                }
                onApprove={() => void run(() => approve([memory]))}
                onReject={() => void run(() => actions.rejectMemories([memory.id]))}
                onToRule={() =>
                  void run(async () => {
                    const rule = ruleProjectOf(memory);
                    if (!rule) return false;
                    // A regra nasce de uma memória aprovada: aprova (com a tua edição) e depois passa-a.
                    const approved = await actions.approveMemories([memory.id], {
                      scope: 'project',
                      ...(choiceFor(memory).text
                        ? { edits: { [memory.id]: { text: choiceFor(memory).text ?? '' } } }
                        : {}),
                    });
                    if (!approved) return false;
                    return (await actions.memoryToRule(memory.id, rule)) !== null;
                  })
                }
              />
            ))}
          </ul>
        </section>
      ) : null}

      {toConfirm.length ? (
        <section aria-label="A confirmar" className="grid gap-3" data-testid="memory-to-confirm">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-medium">
              A confirmar
              <span className="tabular-nums text-muted">{toConfirm.length}</span>
            </h2>
            <p className="mt-1 text-[12px] text-muted">
              Estas deixaram de chegar aos agentes até confirmares que ainda valem.
            </p>
          </div>
          <ul className="grid gap-3">
            {toConfirm.map((memory) => (
              <ConfirmCard key={memory.id} memory={memory} showProject={projectId === null} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
