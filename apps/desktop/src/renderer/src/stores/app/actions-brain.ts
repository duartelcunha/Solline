import type { CommandPayload, CommandResult } from '@solline/protocol';
import { receiveSpaces, useSpaces } from '../spaces.ts';
import { memoryRequest, message, request, useApp } from './state.ts';

export const brainActions = {
  openSpace(projectId: string | null): void {
    useSpaces.setState({ panel: 'tasks' });
    useApp.setState({ view: 'spaces', spaceProjectId: projectId, activeProjectId: projectId });
  },

  /** As regras de um projeto, com os avisos; null se falhou (o erro fica no aviso). */
  async listRules(projectId: string): Promise<CommandResult<'rules.list'> | null> {
    try {
      return await request('rules.list', { projectId });
    } catch (error) {
      useApp.setState({ notice: `Não consegui ler as regras. ${message(error)}` });
      return null;
    }
  },

  /** Cria (sem id) ou altera uma regra; devolve a lista do projeto, ou null se falhou. */
  async saveRule(input: CommandPayload<'rules.save'>): Promise<CommandResult<'rules.save'> | null> {
    try {
      return await request('rules.save', input);
    } catch (error) {
      useApp.setState({ notice: `Não consegui guardar a regra. ${message(error)}` });
      return null;
    }
  },

  async deleteRule(
    projectId: string | null,
    id: string,
  ): Promise<CommandResult<'rules.delete'> | null> {
    try {
      return await request('rules.delete', { projectId, id });
    } catch (error) {
      useApp.setState({ notice: `Não consegui apagar a regra. ${message(error)}` });
      return null;
    }
  },

  async undoRules(projectId: string | null): Promise<CommandResult<'rules.undo'> | null> {
    try {
      return await request('rules.undo', { projectId });
    } catch (error) {
      useApp.setState({ notice: `Não consegui desfazer. ${message(error)}` });
      return null;
    }
  },

  async previewRules(projectId: string | null): Promise<CommandResult<'rules.preview'> | null> {
    try {
      return await request('rules.preview', { projectId });
    } catch (error) {
      useApp.setState({ notice: `Não consegui mostrar o texto. ${message(error)}` });
      return null;
    }
  },

  /**
   * Aprova propostas de memória (ou re-aprova); `scope: 'global'` e as edições são do utilizador.
   * Devolve se resultou (o estado novo chega por spaces.changed).
   */
  async approveMemories(
    ids: string[],
    options: Pick<CommandPayload<'memory.approve'>, 'scope' | 'edits'> = {},
  ): Promise<boolean> {
    return memoryRequest('memory.approve', { ids, ...options }, 'aprovar as memórias');
  },

  /** Rejeita propostas: apagam-se e não voltam a ser propostas. */
  async rejectMemories(ids: string[]): Promise<boolean> {
    return memoryRequest('memory.reject', { ids }, 'rejeitar as memórias');
  },

  /** Re-aprova memórias "a confirmar" (renova a prova e o relógio). */
  async confirmMemories(ids: string[]): Promise<boolean> {
    return memoryRequest('memory.confirm', { ids }, 'confirmar as memórias');
  },

  /** "Exportar para regras": a memória passa a regra do projeto. null se falhou. */
  async memoryToRule(
    id: string,
    projectId?: string,
  ): Promise<CommandResult<'memory.toRule'> | null> {
    try {
      const view = await request('memory.toRule', { id, ...(projectId ? { projectId } : {}) });
      receiveSpaces(await request('spaces.snapshot', {}));
      return view;
    } catch (error) {
      useApp.setState({
        notice: `Não consegui passar a memória para as regras. ${message(error)}`,
      });
      return null;
    }
  },
};
