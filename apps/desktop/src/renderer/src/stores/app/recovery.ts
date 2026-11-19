import type { EngineEvent, EngineSnapshot } from '@solline/protocol';
import type { UiRecoveryState } from '@solline/protocol/bridge';
import { receiveRules } from '../rules.ts';
import { withConsults } from '../session.ts';
import { receiveSpaces } from '../spaces.ts';
import { dispatch } from './dispatch.ts';
import {
  adoptStore,
  draftSubscriptions,
  draftWrites,
  earlyEvents,
  flushDrafts,
  flushUiClose,
  message,
  request,
  sessionStores,
  storeFromItem,
  useApp,
} from './state.ts';

export function restoreSnapshot(snapshot: EngineSnapshot, ui: UiRecoveryState): void {
  if (snapshot.spaces) receiveSpaces(snapshot.spaces);
  if (snapshot.rules) receiveRules(snapshot.rules);
  if (snapshot.durability.status === 'failed')
    throw new Error(snapshot.durability.error ?? 'O estado não está guardado');
  for (const unsubscribe of draftSubscriptions.values()) unsubscribe();
  draftSubscriptions.clear();
  draftWrites.clear();
  sessionStores.clear();
  earlyEvents.clear();
  for (const item of snapshot.sessions) {
    const store = storeFromItem(item);
    const draft = ui.drafts[item.session.id];
    store.setState({
      ...withConsults(
        store.getState(),
        (snapshot.consults ?? []).filter((c) => c.sessionId === item.session.id),
      ),
      composerText: draft?.pendingSend
        ? [draft.pendingSend, draft.text].filter(Boolean).join('\n')
        : (draft?.text ?? ''),
      pendingSend: null,
      ...(draft?.review ? { reviewDraft: draft.review } : {}),
      actionError: draft?.pendingSend
        ? 'Um envio anterior ficou sem confirmação na interface. O texto foi preservado; verifica a conversa antes de reenviar.'
        : null,
    });
    adoptStore(item.session.id, store);
  }
  const ids = snapshot.sessions.map((item) => item.session.id);
  const current = useApp.getState();
  const selected =
    current.activeSessionId && ids.includes(current.activeSessionId)
      ? current.activeSessionId
      : (ids[0] ?? null);
  useApp.setState({
    sessionIds: ids,
    races: Object.fromEntries(snapshot.races.map((race) => [race.id, race])),
    engineOffline: false,
    recoveryOperations: snapshot.operations.filter((operation) => operation.state === 'unknown'),
    activeSessionId: selected,
    activeProjectId:
      current.view === 'spaces'
        ? current.spaceProjectId
        : selected
          ? (sessionStores.get(selected)?.getState().projectId ?? null)
          : null,
    view:
      current.view === 'spaces' || current.view === 'desk'
        ? current.view
        : current.view === 'race' &&
            snapshot.races.some((r) => r.id === current.activeRaceId && r.phase !== 'closed')
          ? 'race'
          : selected
            ? 'session'
            : 'desk',
  });
}

/** Subscribe before snapshot; snapshots and queued events share an epoch/sequence boundary. */
export function connectRecovery(): () => void {
  let disposed = false;
  let syncing = false;
  let epoch: string | undefined;
  let sequence = -1;
  let buffered: EngineEvent[] = [];
  const accept = (event: EngineEvent): boolean => {
    if (event.epoch && event.sequence !== undefined) {
      if (event.epoch !== epoch) return false;
      if (event.sequence <= sequence) return true;
      if (event.sequence !== sequence + 1) return false;
      sequence = event.sequence;
    }
    dispatch(event);
    return true;
  };
  const sync = async () => {
    if (syncing || disposed) return;
    syncing = true;
    useApp.setState({ recoveryStatus: 'loading' });
    try {
      if (sessionStores.size) await flushDrafts();
      for (let attempt = 0; attempt < 3; attempt++) {
        const [snapshot, ui] = await Promise.all([
          request('engine.snapshot', {}),
          window.solline.recovery.ui(),
        ]);
        if (disposed) return;
        const events = buffered;
        buffered = [];
        const newest = events.findLast((event) => event.epoch);
        if (newest?.epoch && newest.epoch !== snapshot.epoch) continue;
        epoch = snapshot.epoch;
        sequence = snapshot.sequence;
        restoreSnapshot(snapshot, ui);
        let complete = true;
        for (const event of events)
          if (!accept(event)) {
            complete = false;
            break;
          }
        if (complete) {
          useApp.setState({ recoveryStatus: 'ready' });
          return;
        }
      }
      throw new Error(
        'A sequência de eventos mudou durante a recuperação. Tenta restaurar a interface novamente.',
      );
    } catch (error) {
      if (!disposed)
        useApp.setState({
          recoveryStatus: 'failed',
          engineOffline: true,
          notice: `Não foi possível restaurar o estado em segurança. ${message(error)}`,
        });
    } finally {
      syncing = false;
    }
  };
  const off = window.solline.onEvent((event) => {
    if (disposed) return;
    if (syncing || !epoch) buffered.push(event);
    else if (!accept(event)) {
      buffered.push(event);
      void sync();
    }
  });
  const freeze = () => {
    document.getElementById('root')?.setAttribute('inert', '');
    useApp.setState({ closePending: true });
  };
  const thaw = () => {
    document.getElementById('root')?.removeAttribute('inert');
    useApp.setState({ closePending: false });
  };
  const blockInput = (event: Event) => {
    if (!useApp.getState().closePending) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const inputEvents = ['keydown', 'beforeinput', 'pointerdown', 'click'] as const;
  for (const name of inputEvents) document.addEventListener(name, blockInput, true);
  const offClose = window.solline.window.onPrepareClose(async () => {
    freeze();
    await flushUiClose();
  });
  const offCancelled = window.solline.window.onCloseCancelled(thaw);
  void sync();
  return () => {
    disposed = true;
    buffered = [];
    off();
    offClose();
    offCancelled();
    for (const name of inputEvents) document.removeEventListener(name, blockInput, true);
    thaw();
  };
}
