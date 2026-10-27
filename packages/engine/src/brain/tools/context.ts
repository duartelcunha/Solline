import { defineBrainTool } from '../tool.ts';

/**
 * A primeira ferramenta da Solline, só para provar o caminho de ponta a ponta: diz ao agente
 * em que sessão está. Sem segredos, sem escrita; a identidade é a que o motor resolveu.
 */
export const contextTool = defineBrainTool({
  name: 'solline_context',
  description:
    'Tells you which Solline session you are running in: project id, working folder, session title and agent. Read-only.',
  input: {},
  readOnly: true,
  handler: (ctx) => {
    const session = ctx.session();
    return {
      project: ctx.projectId,
      folder: session.folder,
      session: session.title,
      agent: ctx.agent,
    };
  },
});
