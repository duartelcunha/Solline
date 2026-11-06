import { useEffect, useState } from 'react';
import { Info, Pencil, Plus, ScrollText, Undo2 } from 'lucide-react';
import type { ProjectRule, RulesPreview } from '@solline/protocol';
import { actions } from '../../stores/app.ts';
import { rulesOf, useRules } from '../../stores/rules.ts';
import {
  SIZE_WARN_CHARS,
  SIZE_WARN_LINES,
  alwaysOnSize,
  firstLine,
  globsText,
  parseGlobs,
} from './rules-model.ts';

interface Draft {
  id?: string;
  title: string;
  text: string;
  globs: string;
  enabled: boolean;
}

const blank: Draft = { title: '', text: '', globs: '', enabled: true };

/** Uma regra ligada ou desligada: o interruptor diz-o pela posição, pelo traço e pelo nome. */
function Switch({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      data-testid="rule-switch"
      className={`sl-press relative h-5 w-9 shrink-0 rounded-full border transition-colors ${checked ? 'border-transparent bg-accent' : 'border-line-strong bg-transparent'}`}
    >
      <span
        aria-hidden
        className={`absolute top-1/2 left-[3px] size-3.5 -translate-y-1/2 rounded-full transition-[translate,background-color] duration-150 motion-reduce:transition-none ${checked ? 'translate-x-[15px] bg-on-accent' : 'translate-x-0 bg-muted'}`}
      />
    </button>
  );
}

function Notice({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return (
    <p
      role="note"
      data-testid={testId}
      className="flex items-start gap-2 rounded-control bg-attention-soft px-3 py-2 text-[12.5px] text-attention"
    >
      <Info size={14} className="mt-0.5 shrink-0" aria-hidden />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

function RuleForm({
  projectId,
  initial,
  onClose,
}: {
  projectId: string | null;
  initial: Draft;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const parsed = parseGlobs(draft.globs);
  const ready = draft.title.trim() !== '' && draft.text.trim() !== '' && parsed.error === null;

  // Apagar não se desfaz: o primeiro clique pede confirmação no próprio botão.
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), 4000);
    return () => clearTimeout(timer);
  }, [confirming]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    const view = await actions.saveRule({
      projectId,
      ...(draft.id ? { id: draft.id } : {}),
      title: draft.title.trim(),
      text: draft.text.trim(),
      globs: parsed.globs,
      enabled: draft.enabled,
    });
    setBusy(false);
    if (view) onClose();
  }

  async function remove() {
    if (!draft.id || busy) return;
    setBusy(true);
    const view = await actions.deleteRule(projectId, draft.id);
    setBusy(false);
    if (view) onClose();
  }

  const id = draft.id ?? 'new';
  return (
    <form
      onSubmit={(e) => void save(e)}
      className="grid gap-4 rounded-md border border-line-strong bg-surface p-4"
      data-testid="rule-form"
      aria-label={draft.id ? 'Editar regra' : 'Nova regra'}
    >
      <div>
        <label className="space-label" htmlFor={`rule-title-${id}`}>
          Título
        </label>
        <input
          id={`rule-title-${id}`}
          value={draft.title}
          maxLength={120}
          placeholder="Por exemplo: Mensagens de commit"
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          // O título é a primeira coisa a escrever.
          autoFocus
        />
      </div>
      <div>
        <label className="space-label" htmlFor={`rule-text-${id}`}>
          Regra
        </label>
        <textarea
          id={`rule-text-${id}`}
          value={draft.text}
          maxLength={10_000}
          rows={4}
          placeholder="Uma ou duas frases que um agente possa seguir à letra."
          onChange={(e) => setDraft({ ...draft, text: e.target.value })}
        />
      </div>
      <div>
        <label className="space-label" htmlFor={`rule-globs-${id}`}>
          Só para estes ficheiros (opcional)
        </label>
        <input
          id={`rule-globs-${id}`}
          value={draft.globs}
          className="font-mono"
          placeholder="*.ts, src/db/**"
          aria-invalid={parsed.error !== null}
          aria-describedby={`rule-globs-help-${id}`}
          onChange={(e) => setDraft({ ...draft, globs: e.target.value })}
        />
        <p
          id={`rule-globs-help-${id}`}
          className={`mt-2 text-[11.5px] ${parsed.error ? 'text-danger' : 'text-muted'}`}
        >
          {parsed.error ??
            'Sem padrões, a regra vale sempre. Com padrões, só chega ao agente quando editar esses ficheiros.'}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          className="space-control space-primary"
          disabled={!ready || busy}
          data-testid="rule-save"
        >
          Guardar
        </button>
        <button type="button" className="space-control" onClick={onClose}>
          Cancelar
        </button>
        <label className="ml-2 flex items-center gap-2 text-[12px] text-muted">
          <Switch
            checked={draft.enabled}
            label="Regra ligada"
            onChange={(enabled) => setDraft({ ...draft, enabled })}
          />
          {draft.enabled ? 'Ligada' : 'Desligada'}
        </label>
        {draft.id ? (
          <button
            type="button"
            className={`space-control ml-auto ${confirming ? 'text-danger' : ''}`}
            disabled={busy}
            onClick={() => (confirming ? void remove() : setConfirming(true))}
            data-testid="rule-delete"
          >
            {confirming ? 'Confirmar' : 'Apagar'}
          </button>
        ) : null}
      </div>
    </form>
  );
}

function RuleRow({ rule, onEdit }: { rule: ProjectRule; onEdit: () => void }) {
  return (
    <li
      data-testid="rule-row"
      data-enabled={rule.enabled}
      className="flex items-start gap-3 border-t border-line py-4 first:border-t-0"
    >
      <div className="pt-0.5">
        <Switch
          checked={rule.enabled}
          label={`${rule.enabled ? 'Desligar' : 'Ligar'} a regra ${rule.title}`}
          onChange={(enabled) =>
            void actions.saveRule({
              projectId: rule.projectId,
              id: rule.id,
              title: rule.title,
              text: rule.text,
              globs: rule.globs,
              enabled,
            })
          }
        />
      </div>
      <button
        type="button"
        onClick={onEdit}
        aria-label={`Editar a regra ${rule.title}`}
        className={`min-w-0 flex-1 rounded-sm text-left ${rule.enabled ? '' : 'opacity-60'}`}
      >
        <span className="block truncate text-[13px] font-medium">{rule.title}</span>
        <span className="mt-0.5 block truncate text-[12.5px] text-muted">
          {firstLine(rule.text)}
        </span>
        <span className="mt-2 flex flex-wrap items-center gap-1.5">
          {rule.globs.length === 0 ? (
            <span className="text-[11px] text-subtle">Vale sempre</span>
          ) : (
            rule.globs.map((glob) => (
              <code
                key={glob}
                className="rounded-sm border border-line bg-surface-sunken px-1.5 py-px font-mono text-[11px]"
              >
                {glob}
              </code>
            ))
          )}
          {rule.enabled ? null : <span className="text-[11px] text-subtle">· Desligada</span>}
        </span>
      </button>
      {/* A linha inteira já edita: o lápis é o sinal visível e fica fora da ordem do teclado. */}
      <button type="button" className="space-control" aria-hidden tabIndex={-1} onClick={onEdit}>
        <Pencil size={14} />
      </button>
    </li>
  );
}

export function RulesEditor({ projectId }: { projectId: string | null }) {
  const data = useRules((s) => s.data);
  const view = rulesOf(data, projectId);
  const global = projectId === null ? null : rulesOf(data, null);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [scope, setScope] = useState<string | null>(projectId);
  const [preview, setPreview] = useState<RulesPreview | null>(null);
  const size = alwaysOnSize([...(global?.rules ?? []), ...view.rules]);

  async function showPreview() {
    const text = await actions.previewRules(projectId);
    if (text) setPreview(text);
  }

  const draftOf = (rule: ProjectRule) => ({
    id: rule.id,
    title: rule.title,
    text: rule.text,
    globs: globsText(rule.globs),
    enabled: rule.enabled,
  });

  const list = (rules: ProjectRule[], level: string | null) => (
    <ul data-testid={level === null ? 'rules-global' : 'rules-list'}>
      {rules.map((rule) =>
        editing === rule.id ? (
          <li key={rule.id} className="py-3">
            <RuleForm projectId={level} initial={draftOf(rule)} onClose={() => setEditing(null)} />
          </li>
        ) : (
          <RuleRow key={rule.id} rule={rule} onEdit={() => setEditing(rule.id)} />
        ),
      )}
    </ul>
  );

  return (
    <section className="space-rules-view max-w-[800px]" aria-label="Regras">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-medium">
            {projectId === null ? 'Regras de todos os projetos' : 'Regras do projeto'}
          </h2>
          <p className="mt-1 text-[12px] text-muted">
            Escritas por ti e guardadas na Solline. Um commit não as altera.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="space-control"
            disabled={!view.canUndo}
            onClick={() => void actions.undoRules(projectId)}
            data-testid="rules-undo"
          >
            <Undo2 size={14} />
            Desfazer
          </button>
          <button
            type="button"
            className="space-control"
            onClick={() => void (preview ? setPreview(null) : showPreview())}
            data-testid="rules-preview"
          >
            {preview ? 'Fechar pré-visualização' : 'O que o agente recebe'}
          </button>
          <button
            type="button"
            className="space-control space-primary"
            onClick={() => {
              setScope(projectId);
              setEditing('new');
            }}
            data-testid="rule-new"
          >
            <Plus size={14} />
            Regra
          </button>
        </div>
      </div>

      <div className="mt-5 grid gap-2.5">
        {view.warnings.map((warning) => (
          <Notice key={warning.text} testId="rules-warning-length">
            {warning.text}
          </Notice>
        ))}
      </div>

      {preview ? (
        <div className="mt-4 grid gap-3" data-testid="rules-preview-text">
          {(
            [
              ['Claude', preview.claude],
              ['Codex', preview.codex],
              ['ACP', preview.acp],
            ] as const
          ).map(([name, text]) => (
            <div key={name}>
              <p className="text-[12px] font-medium">{name}</p>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-control border border-line bg-surface-sunken p-3 font-mono text-[11.5px] text-muted">
                {text || '(nada no arranque)'}
              </pre>
            </div>
          ))}
        </div>
      ) : null}

      {editing === 'new' ? (
        <div className="mt-5">
          <RuleForm
            projectId={scope}
            initial={blank}
            onClose={() => setEditing(null)}
          />
        </div>
      ) : null}

      {global && global.rules.length > 0 ? (
        <div className="mt-5">
          <h3 className="text-[12.5px] font-medium text-muted">Em todos os projetos</h3>
          {list(global.rules, null)}
        </div>
      ) : null}

      {projectId !== null ? (
        view.rules.length === 0 && editing !== 'new' && !global?.rules.length ? (
          <div className="space-empty" data-testid="rules-empty">
            <ScrollText size={30} strokeWidth={1} aria-hidden />
            <p>Ainda sem regras.</p>
            <span>Uma regra curta, escrita por ti, vale mais do que um ficheiro comprido.</span>
          </div>
        ) : (
          <>
            <h3 className="mt-5 text-[12.5px] font-medium text-muted">Neste projeto</h3>
            {list(view.rules, projectId)}
          </>
        )
      ) : view.rules.length === 0 && editing !== 'new' ? (
        <div className="space-empty" data-testid="rules-empty">
          <ScrollText size={30} strokeWidth={1} aria-hidden />
          <p>Ainda sem regras gerais.</p>
          <span>Valem em todos os projetos, até as desligares.</span>
        </div>
      ) : (
        list(view.rules, null)
      )}

      <p
        className="mt-4 text-[11.5px] text-subtle tabular-nums"
        data-testid="rules-size"
        title={`Acima de ${SIZE_WARN_LINES} linhas ou ${SIZE_WARN_CHARS} caracteres os agentes seguem pior`}
      >
        Sempre à vista dos agentes: {size.lines} linhas · {size.chars} caracteres
      </p>
    </section>
  );
}
