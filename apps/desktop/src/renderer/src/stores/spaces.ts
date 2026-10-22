import { create } from 'zustand';
import {
  emptySpaces,
  type SpacesState,
  type CommandName,
  type CommandPayload,
  type CommandResult,
} from '@solline/protocol';

export const useSpaces = create<{
  data: SpacesState;
  error: string | null;
  selectedTaskId: string | null;
}>(() => ({
  data: emptySpaces(),
  error: null,
  selectedTaskId: null,
}));
export function receiveSpaces(data: SpacesState): void {
  useSpaces.setState((current) => (data.revision >= current.data.revision ? { data } : {}));
}
export async function spaceRequest<C extends Extract<CommandName, `spaces.${string}`>>(
  command: C,
  input: CommandPayload<C>,
): Promise<CommandResult<C>> {
  try {
    const result = await window.solline.request(command, input);
    if (
      command === 'spaces.taskCreate' ||
      command === 'spaces.taskUpdate' ||
      command === 'spaces.delegate'
    ) {
      receiveSpaces(await window.solline.request('spaces.snapshot', {}));
    } else receiveSpaces(result as SpacesState);
    useSpaces.setState({ error: null });
    return result;
  } catch (error) {
    useSpaces.setState({ error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
export function quietSpace<C extends Extract<CommandName, `spaces.${string}`>>(
  command: C,
  input: CommandPayload<C>,
): void {
  void spaceRequest(command, input).catch(() => undefined);
}
