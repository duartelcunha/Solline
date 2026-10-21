import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { Check, Clock, ListChecks, Lock, RotateCw, Send, ShieldCheck, X } from 'lucide-react';
import type { CheckResult, CheckSpec, Checks } from '@solline/protocol';
import { ActionItem, MenuShell } from '../../components/menu.tsx';
import { useChangedSinceMount } from '../../lib/morph.ts';
import { actions, useApp, useSession } from '../../stores/app.ts';

export type Face = 'waiting' | CheckResult['state'];

const STATE_LABEL: Record<Face, string> = {
  waiting: 'por correr',
  pending: 'à espera',
  running: 'a correr',
  passed: 'passou',
  failed: 'falhou',
  timeout: 'passou o limite',
};

/** A marca de cada estado: lê-se pela forma, não só pela cor. */
export function Mark({ face }: { face: Face }) {
  switch (face) {
    case 'running':
    case 'pending':
      return (
        <span
          aria-hidden
          className="spinner block size-[11px] rounded-full border-[1.5px] border-current border-t-transparent text-subtle"
        />
      );
    case 'passed':
      return <Check aria-hidden size={13} strokeWidth={2.25} className="text-success" />;
    case 'failed':
      return <X aria-hidden size={13} strokeWidth={2.25} className="text-danger" />;
    case 'timeout':
      return <Clock aria-hidden size={12} strokeWidth={2} className="text-accent-text" />;
    default:
      return <span aria-hidden className="block size-[7px] rounded-full border border-subtle" />;
  }
}

const pillClass =
  'no-drag sl-press inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-muted transition-colors duration-150 outline-none hover:bg-surface-hover hover:text-fg data-[state=open]:bg-surface-hover';

function seconds(ms: number | null): string | undefined {
  if (ms === null) return undefined;
  return `${(ms / 1000).toLocaleString('pt-PT', { maximumFractionDigits: 1 })} s`;
}

/** Uma verificação: a marca muda de forma quando o estado muda; o clique mostra o erro. */
function CheckPill({
  sessionId,
  spec,
  result,
  busy,
}: {
  sessionId: string;
  spec: CheckSpec;
  result: CheckResult | undefined;
  busy: boolean;
}) {
  const face: Face = result?.state ?? 'waiting';
  const changed = useChangedSinceMount(face);
  const broken = face === 'failed' || face === 'timeout';
  const label = `${spec.label}: ${STATE_LABEL[face]}`;
  return (
    <MenuShell
      title={spec.label}
      side="bottom"
      align="end"
      trigger={
        <Menu.Trigger
          aria-label={label}
          title={label}
          data-testid="check-pill"
          data-check={spec.id}
          data-state-check={face}
          className={pillClass}
        >
          <span
            key={face}
            className={`grid size-3.5 place-items-center ${changed ? 'icon-morph' : ''}`}
          >
            <Mark face={face} />
          </span>
          {spec.label}
        </Menu.Trigger>
      }
    >
      {broken && result?.tail ? (
        <pre
          data-testid="check-tail"
          className="mx-1 mb-1 max-h-48 overflow-y-auto rounded-md bg-surface-sunken px-2.5 py-2 font-mono text-[11px] leading-snug [overflow-wrap:anywhere] whitespace-pre-wrap text-muted select-text"
        >
          {result.tail}
        </pre>
      ) : null}
      {broken ? (
        <ActionItem
          title="Mandar ao agente"
          icon={<Send size={14} />}
          disabled={busy}
          onSelect={() => void actions.fixCheck(sessionId, spec.id)}
          testId="check-fix"
        />
      ) : null}
      <ActionItem
        title="Repetir"
        description={face === 'passed' ? seconds(result?.durationMs ?? null) : undefined}
        icon={<RotateCw size={14} />}
        disabled={busy || face === 'running'}
        onSelect={() => void actions.runChecks(sessionId)}
        testId="check-again"
      />
    </MenuShell>
  );
}

/** Sem confiança: uma pastilha com cadeado que explica e oferece confiar. */
function LockedPill({ projectId }: { projectId: string }) {
  return (
    <MenuShell
      title="Verificações"
      side="bottom"
      align="end"
      trigger={
        <Menu.Trigger
          aria-label="Verificações: o projeto não é de confiança"
          title="Verificações desligadas"
          data-testid="checks-locked"
          className={pillClass}
        >
          <Lock size={13} strokeWidth={1.75} className="text-subtle" />
        </Menu.Trigger>
      }
    >
      <p className="px-2.5 pb-1.5 text-[12px] leading-snug text-muted">
        Correr os comandos do projeto precisa de confiança.
      </p>
      <ActionItem
        title="Confiar neste projeto"
        icon={<ShieldCheck size={14} />}
        onSelect={() => void actions.setProjectTrusted(projectId, true)}
        testId="checks-trust"
      />
    </MenuShell>
  );
}

/**
 * As verificações do projeto no cabeçalho, ao lado do revisor: uma pastilha por verificação
 * ligada e um botão para editar a lista.
 */
export function ChecksRow({ sessionId }: { sessionId: string }) {
  const checks = useSession(sessionId, (s) => s.checks);
  const projectId = useSession(sessionId, (s) => s.projectId);
  const busy = useSession(
    sessionId,
    (s) => s.info.state === 'running' || s.info.state === 'starting',
  );
  const [editing, setEditing] = useState(false);
  if (!checks) return null;
  if (!checks.trusted) return <LockedPill projectId={projectId} />;
  const enabled = checks.specs.filter((s) => s.enabled);
  return (
    <div className="flex items-center" data-testid="checks">
      {enabled.map((spec) => (
        <CheckPill
          key={spec.id}
          sessionId={sessionId}
          spec={spec}
          result={checks.results.find((r) => r.id === spec.id)}
          busy={busy}
        />
      ))}
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label="Editar as verificações"
        title="Verificações"
        data-testid="checks-edit"
        className="no-drag sl-press grid size-7 place-items-center rounded-md text-subtle hover:bg-surface-hover hover:text-fg"
      >
        <ListChecks size={14} strokeWidth={1.75} />
      </button>
      {editing ? (
        <ChecksEditor projectId={projectId} checks={checks} onClose={() => setEditing(false)} />
      ) : null}
    </div>
  );
}

const inputClass =
  'h-7 min-w-0 rounded-md border border-line bg-bg px-2 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--sl-focus)]';

/** A lista do projeto: ligar, desligar e mudar o comando. Um comando novo pede confirmação. */
function ChecksEditor({
  projectId,
  checks,
  onClose,
}: {
  projectId: string;
  checks: Checks;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<CheckSpec[]>(checks.specs);
  const [saving, setSaving] = useState(false);
  const project = useApp((s) => s.projects.find((p) => p.id === projectId));
  const set = (i: number, patch: Partial<CheckSpec>) =>
    setDraft((d) => d.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const valid = draft.every((c) => c.command.trim() && c.label.trim());

  const save = async (next: CheckSpec[] | null) => {
    setSaving(true);
    const saved = await actions.setProjectChecks(projectId, next);
    setSaving(false);
    if (saved) onClose();
  };

  return (
    <Dialog.Root open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay fixed inset-0 z-40 bg-black/25 backdrop-blur-[2px]" />
        <Dialog.Content
          data-testid="checks-editor"
          className="dialog-content fixed top-1/2 left-1/2 z-50 flex w-[min(30rem,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-lg border border-line bg-surface p-4 shadow-raised outline-none"
        >
          <div>
            <Dialog.Title className="text-[14px] font-semibold tracking-[-0.01em]">
              Verificações
            </Dialog.Title>
            <Dialog.Description className="text-[12px] text-muted">
              {project?.name ?? 'Projeto'} · no fim de cada turno que mude ficheiros
            </Dialog.Description>
          </div>
          <ul className="flex flex-col gap-1.5">
            {draft.map((check, i) => (
              <li
                key={check.id}
                className="flex items-center gap-2"
                data-testid="checks-editor-row"
              >
                <input
                  type="checkbox"
                  checked={check.enabled}
                  onChange={(e) => set(i, { enabled: e.target.checked })}
                  aria-label={`Ligar ${check.label}`}
                  className="size-3.5 shrink-0 accent-[var(--sl-text)]"
                />
                <input
                  value={check.label}
                  maxLength={24}
                  onChange={(e) => set(i, { label: e.target.value })}
                  aria-label="Nome"
                  className={`${inputClass} w-24`}
                />
                <input
                  value={check.command}
                  maxLength={300}
                  onChange={(e) => set(i, { command: e.target.value })}
                  aria-label={`Comando de ${check.label}`}
                  className={`${inputClass} flex-1 font-mono`}
                  data-testid="checks-editor-command"
                />
                <button
                  type="button"
                  onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}
                  aria-label={`Tirar ${check.label}`}
                  className="sl-press grid size-7 shrink-0 place-items-center rounded-md text-subtle hover:bg-surface-hover hover:text-fg"
                >
                  <X size={13} />
                </button>
              </li>
            ))}
          </ul>
          {draft.length < 6 ? (
            <button
              type="button"
              onClick={() =>
                setDraft((d) => [
                  ...d,
                  {
                    id: `cmd-${Date.now().toString(36)}`,
                    label: 'Nova',
                    command: '',
                    enabled: true,
                  },
                ])
              }
              className="sl-press self-start rounded-md px-2 py-1 text-[12px] font-medium text-muted hover:bg-surface-hover hover:text-fg"
              data-testid="checks-editor-add"
            >
              + Comando
            </button>
          ) : null}
          <div className="flex items-center gap-2">
            {!checks.detected ? (
              <button
                type="button"
                disabled={saving}
                onClick={() => void save(null)}
                className="sl-press rounded-md px-2 py-1 text-[12px] text-muted hover:bg-surface-hover hover:text-fg"
              >
                Repor do package.json
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              className="sl-press ml-auto rounded-md px-3 py-1.5 text-[12px] font-medium text-muted hover:bg-surface-hover hover:text-fg"
            >
              Cancelar
            </button>
            <button
              type="button"
              disabled={!valid || saving}
              onClick={() =>
                void save(
                  draft.map((c) => ({ ...c, label: c.label.trim(), command: c.command.trim() })),
                )
              }
              className="sl-press rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-bg disabled:opacity-50"
              data-testid="checks-editor-save"
            >
              Guardar
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
