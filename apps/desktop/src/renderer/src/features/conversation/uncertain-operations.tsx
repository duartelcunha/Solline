import { sessionStore, useApp } from '../../stores/app.ts';
import type { RecoveryOperationDetails } from '@solline/protocol';

const DECISIONS: Record<string, string> = {
  'allow-once': 'Permitir uma vez',
  'allow-always': 'Permitir sempre',
  deny: 'Recusar',
  'deny-always': 'Recusar sempre',
  answer: 'Responder à pergunta',
};

function IntentDetails({ details }: { details: RecoveryOperationDetails }) {
  const answer = details.answer;
  return (
    <div className="mt-2 space-y-2 text-sm select-text">
      {details.path ? <p className="break-all">Ficheiro: {details.path}</p> : null}
      {details.note ? <p className="whitespace-pre-wrap break-words">{details.note}</p> : null}
      {answer ? <p>{DECISIONS[answer.decision]}</p> : null}
      {answer?.decision === 'deny' && answer.message ? (
        <p className="whitespace-pre-wrap break-words">{answer.message}</p>
      ) : null}
      {answer?.decision === 'answer' ? (
        <dl className="space-y-2">
          {Object.entries(answer.answers).map(([question, value]) => (
            <div key={question}>
              <dt className="text-muted">{question}</dt>
              <dd className="whitespace-pre-wrap break-words">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {details.comments?.map((comment, index) => (
        <blockquote key={index} className="border-l-2 border-line pl-3">
          <p className="text-xs text-muted break-all">
            {comment.path} · linha {comment.line}
          </p>
          <p className="whitespace-pre-wrap break-words">{comment.text}</p>
        </blockquote>
      ))}
    </div>
  );
}

const LABELS: Record<string, string> = {
  'session.turn': 'Mensagem da fila',
  'session.send': 'Envio de mensagem',
  'permission.answer': 'Resposta a uma permissão',
  'review.apply': 'Alteração na revisão',
  'review.undo': 'Desfazer alteração',
  'review.comment': 'Comentários para o agente',
  'session.rewind': 'Rebobinar sessão',
  'session.bring': 'Trazer alterações',
  'worktrees.bring': 'Trazer alterações',
  'worktrees.discardNow': 'Eliminar worktree',
  'session.closeNow': 'Fechar sessão',
  'session.start': 'Abrir sessão',
  'race.begin': 'Iniciar corrida',
  'split.begin': 'Iniciar repartição',
  'split.integrate': 'Integrar repartição',
  'split.resolveNow': 'Abrir sessão para resolver um conflito',
  'split.continue': 'Continuar a integração',
  'race.bring': 'Trazer o resultado para o projeto',
};

/** Preserved intents are evidence, never a queue to retry. Text stays selectable. */
export function UncertainOperations() {
  const operations = useApp((state) => state.recoveryOperations);
  if (!operations.length) return null;
  return (
    <details
      className="mx-5 mt-3 rounded-control border border-attention/40 bg-surface px-4 py-3 text-sm text-fg"
      data-testid="uncertain-operations"
    >
      <summary className="cursor-pointer font-medium">
        {operations.length === 1
          ? 'Uma operação precisa de confirmação'
          : `${operations.length} operações precisam de confirmação`}
      </summary>
      <p className="mt-2 text-muted">
        A execução foi interrompida antes de confirmar o resultado. Verifica a conversa e os
        ficheiros antes de repetir. Nada foi reenviado.
      </p>
      <ol className="mt-3 max-h-56 space-y-3 overflow-y-auto">
        {operations.map((operation) => (
          <li key={operation.id} className="border-t border-line pt-3">
            <p className="font-medium">{LABELS[operation.command] ?? 'Operação interrompida'}</p>
            {operation.text ? (
              <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-sm select-text">
                {operation.text}
              </pre>
            ) : null}
            {operation.details ? <IntentDetails details={operation.details} /> : null}
            {operation.sessionId && sessionStore(operation.sessionId) ? (
              <p className="mt-1 text-xs text-muted">
                {sessionStore(operation.sessionId)?.getState().info.title}
              </p>
            ) : null}
          </li>
        ))}
      </ol>
    </details>
  );
}
