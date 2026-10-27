import { z } from 'zod';
import { BrainToolError, defineBrainTool, type BrainTool } from '../brain/tool.ts';
import type { RulesManager } from './manager.ts';
import { READ_RULE_TOOL } from './render.ts';

/**
 * As ferramentas das regras do projeto para os agentes. Só leem, e só as regras do projeto da
 * sessão que chama: a identidade vem do motor (ctx.projectId), nunca dos argumentos.
 */
export function rulesTools(rules: Pick<RulesManager, 'enabled' | 'get'>): BrainTool[] {
  return [
    defineBrainTool({
      name: READ_RULE_TOOL,
      description:
        'Reads one of the project rules the user wrote in Solline, by id. The rule index in your instructions lists the ids. Read-only.',
      input: { id: z.string().min(1).max(128).describe('The rule id from the index') },
      readOnly: true,
      handler: (ctx, { id }) => {
        const rule = rules.get(ctx.projectId, id);
        if (!rule || !rule.enabled)
          throw new BrainToolError('Não há nenhuma regra ativa com esse id neste projeto.');
        const applies = rule.globs.length > 0 ? `\nAplica-se a: ${rule.globs.join(', ')}` : '';
        return `# ${rule.title}${applies}\n\n${rule.text}`;
      },
    }),
    defineBrainTool({
      name: 'list_rules',
      description:
        'Lists the active rules of this project (id, title and the file patterns each applies to). Read-only.',
      input: {},
      readOnly: true,
      handler: (ctx) =>
        rules.enabled(ctx.projectId).map((rule) => ({
          id: rule.id,
          title: rule.title,
          globs: rule.globs,
        })),
    }),
  ];
}
