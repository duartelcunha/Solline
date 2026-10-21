import { Fragment, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { Check, ListChecks, Lock, RotateCw, Send, ShieldCheck, X } from 'lucide-react';
import type { CheckResult, CheckSpec, Checks } from '@solline/protocol';
import { IconSwap } from '@solline/ui/icon-swap';
import { ActionItem, MenuShell } from '../../components/menu.tsx';
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

/**
 * A marca de cada estado, com as formas das gravidades do revisor: octógono para falhou,
 * triângulo para passou o limite. "Por correr" não se desenha (nada aconteceu ainda).
 */
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
      return (
        <svg aria-hidden width="11" height="11" viewBox="0 0 10 10" className="text-danger">
          <path d="M3 0h4l3 3v4l-3 3H3L0 7V3z" fill="currentColor" />
        </svg>
      );
    case 'timeout':
      return (
        <svg aria-hidden width="11" height="11" viewBox="0 0 10 10" className="text-accent-text">
          <path d="M5 0.5 9.8 9.5H0.2z" fill="currentColor" />
        </svg>
      );
    default:
      return null;
  }
}

const chipClass =
  'no-drag sl-press inline-flex h-7 items-center gap-1.5 rounded-control px-2 text-[12px] text-muted transition-colors duration-150 outline-none hover:bg-surface-hover hover:text-fg data-[state=open]:bg-surface-hover';

function seconds(ms: number | null): string {
  if (ms === null) return '';
  return `${(ms / 1000).toLocaleString('pt-PT', { maximumFractionDigits: 1 })} s`;
}

/** O resumo das verificações numa só cara: a correr, tudo bem, ou a primeira que falhou. */
function summary(enabled: readonly CheckSpec[], results: readonly CheckResult[]) {
  const of = (id: string) => results.find((r) => r.id === id)?.state ?? 'waiting';
  const broken = enabled.filter((s) => of(s.id) === 'failed' || of(s.id) === 'timeout');
  const first = broken[0];
  if (first) {
    return {
      face: of(first.id) as Face,
      text: broken.length === 1 ? first.label : `${broken.length}`,
      label: `${broken.map((s) => s.label).join(', ')}: ${broken.length === 1 ? 'falhou' : 'falharam'}`,
    };
  }
  if (enabled.some((s) => of(s.id) === 'running' || of(s.id) === 'pending')) {
    return { face: 'running' as Face, text: '', label: 'Verificações a correr' };
  }
  const passed = enabled.filter((s) => of(s.id) === 'passed').length;
  if (passed > 0) {
    return { face: 'passed' as Face, text: `${passed}`, label: `${passed} verificações passaram` };
  }
  return { face: 'waiting' as Face, text: '', label: 'Verificações por correr' };
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
          className={chipClass}
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
 * As verificações do projeto no cabeçalho, numa só pastilha: um visto e quantas passaram, ou a
 * marca e o nome da que falhou. O clique abre a lista, com o fim do erro e "Mandar ao agente".
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
  const sum = summary(enabled, checks.results);
  return (
    <>
      <MenuShell
        title="Verificações"
        side="bottom"
        align="end"
        trigger={
          <Menu.Trigger
            aria-label={sum.label}
            title={sum.label}
            data-testid="checks-chip"
            data-state-check={sum.face}
            className={chipClass}
          >
            <IconSwap swapKey={sum.face} className="size-3.5">
              {sum.face === 'waiting' ? (
                <ListChecks size={14} strokeWidth={1.75} className="text-subtle" />
              ) : (
                <Mark face={sum.face} />
              )}
            </IconSwap>
            {sum.text ? <span className="tabular-nums">{sum.text}</span> : null}
          </Menu.Trigger>
        }
      >
        {enabled.map((spec) => {
          const result = checks.results.find((r) => r.id === spec.id);
          const face: Face = result?.state ?? 'waiting';
          const broken = face === 'failed' || face === 'timeout';
          return (
            <Fragment key={spec.id}>
              <div
                className="flex items-center gap-2.5 px-2.5 py-1.5 text-[13px]"
                data-testid="check-row"
                data-check={spec.id}
                data-state-check={face}
              >
                <span className="grid size-4 place-items-center">
                  <Mark face={face} />
                </span>
                <span className="min-w-0 flex-1 truncate">{spec.label}</span>
                <span className="text-[11.5px] text-subtle tabular-nums">
                  {face === 'passed' ? seconds(result?.durationMs ?? null) : STATE_LABEL[face]}
                </span>
              </div>
              {broken && result?.tail ? (
                <pre
                  data-testid="check-tail"
                  className="mx-1 mb-1 max-h-48 overflow-y-auto rounded-control bg-surface-sunken px-2.5 py-2 font-mono text-[11px] leading-snug [overflow-wrap:anywhere] whitespace-pre-wrap text-muted select-text"
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
            </Fragment>
          );
        })}
        <Menu.Separator className="my-1 h-px bg-line" />
        <ActionItem
          title="Repetir"
          icon={<RotateCw size={14} />}
          disabled={busy || sum.face === 'running'}
          onSelect={() => void actions.runChecks(sessionId)}
          testId="check-again"
        />
        <ActionItem
          title="Editar a lista"
          icon={<ListChecks size={14} />}
          onSelect={() => setEditing(true)}
          testId="checks-edit"
        />
      </MenuShell>
      {editing ? (
        <ChecksEditor projectId={projectId} checks={checks} onClose={() => setEditing(false)} />
      ) : null}
    </>
  );
}

const inputClass =
  'h-7 min-w-0 rounded-control border border-line bg-bg px-2 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--sl-focus)]';

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
  // A preparação das worktrees novas: vazia e com os .env, vale a sugestão da Solline.
  const [setupCommand, setSetupCommand] = useState(project?.setup?.command ?? '');
  const [copyEnv, setCopyEnv] = useState(project?.setup?.copyEnv ?? true);
  const setupChanged =
    setupCommand.trim() !== (project?.setup?.command ?? '') ||
    copyEnv !== (project?.setup?.copyEnv ?? true);

  const save = async (next: CheckSpec[] | null) => {
    setSaving(true);
    let saved = await actions.setProjectChecks(projectId, next);
    if (saved && setupChanged) {
      saved = await actions.setProjectSetup(projectId, {
        command: setupCommand.trim(),
        copyEnv,
      });
    }
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
              Verificações e preparação
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
          <section
            className="flex flex-col gap-1.5 border-t border-line pt-3"
            data-testid="setup-editor"
          >
            <span className="text-[12px] text-muted">Preparar cada worktree nova</span>
            <input
              value={setupCommand}
              maxLength={300}
              onChange={(e) => setSetupCommand(e.target.value)}
              placeholder="Sugestão da Solline (instalar com o gestor do projeto)"
              aria-label="Comando de preparação"
              className={`${inputClass} w-full font-mono`}
              data-testid="setup-command"
            />
            <label className="flex items-center gap-2 text-[12px] text-muted">
              <input
                type="checkbox"
                checked={copyEnv}
                onChange={(e) => setCopyEnv(e.target.checked)}
                className="size-3.5 accent-[var(--sl-text)]"
              />
              Copiar os .env da raiz do projeto
            </label>
            {project?.setup ? (
              <button
                type="button"
                disabled={saving}
                onClick={() =>
                  void actions.setProjectSetup(projectId, null).then((ok) => ok && onClose())
                }
                className="sl-press self-start rounded-control px-2 py-1 text-[12px] text-muted hover:bg-surface-hover hover:text-fg"
              >
                Repor a sugestão
              </button>
            ) : null}
          </section>
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
