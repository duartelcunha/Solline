/**
 * Resumo de uma linha para cada ferramenta do Claude Code: o que aparece no bloco
 * compacto. O detalhe completo (input e output) fica na vista detalhada.
 */

function str(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Último segmento de um caminho Windows ou POSIX. */
export function baseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? filePath;
}

function clip(text: string, max = 80): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function toolSummary(name: string, input: unknown): string {
  const file = str(input, 'file_path') ?? str(input, 'notebook_path');
  switch (name) {
    case 'Read':
      return file ? `Ler ${baseName(file)}` : 'Ler ficheiro';
    case 'Write':
      return file ? `Escrever ${baseName(file)}` : 'Escrever ficheiro';
    case 'Edit':
    case 'MultiEdit':
      return file ? `Editar ${baseName(file)}` : 'Editar ficheiro';
    case 'NotebookEdit':
      return file ? `Editar ${baseName(file)}` : 'Editar notebook';
    case 'Bash': {
      const description = str(input, 'description');
      const command = str(input, 'command');
      if (description) return clip(description);
      return command ? `Correr ${clip(command, 70)}` : 'Correr comando';
    }
    case 'Glob': {
      const pattern = str(input, 'pattern');
      return pattern ? `Procurar ficheiros ${clip(pattern, 60)}` : 'Procurar ficheiros';
    }
    case 'Grep': {
      const pattern = str(input, 'pattern');
      return pattern ? `Procurar "${clip(pattern, 60)}"` : 'Procurar no código';
    }
    case 'WebFetch': {
      const url = str(input, 'url');
      return url ? `Abrir ${clip(url, 70)}` : 'Abrir página';
    }
    case 'WebSearch': {
      const query = str(input, 'query');
      return query ? `Pesquisar "${clip(query, 60)}"` : 'Pesquisar na web';
    }
    case 'Task':
    case 'Agent': {
      const description = str(input, 'description');
      return description ? `Subagente: ${clip(description, 70)}` : 'Subagente';
    }
    case 'TodoWrite':
      return 'Atualizar tarefas';
    case 'AskUserQuestion':
      return 'Pergunta para ti';
    case 'ExitPlanMode':
      return 'Plano pronto';
    case 'Skill': {
      const skill = str(input, 'skill') ?? str(input, 'command');
      return skill ? `Skill ${skill}` : 'Skill';
    }
    default: {
      if (name.startsWith('mcp__')) {
        const [, server, tool] = name.split('__');
        return `${server ?? 'mcp'}: ${tool ?? name}`;
      }
      return name;
    }
  }
}

/** Texto de um tool_result: string, ou lista de blocos com texto. */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: unknown) => {
      if (typeof part !== 'object' || part === null) return '';
      const block = part as { type?: unknown; text?: unknown };
      if (block.type === 'text' && typeof block.text === 'string') return block.text;
      if (block.type === 'image') return '[imagem]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}
