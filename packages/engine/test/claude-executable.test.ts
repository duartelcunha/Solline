import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  binaryName,
  platformPackageName,
  resolveClaudeExecutable,
  toUnpackedPath,
} from '../src/index.ts';

describe('resolveClaudeExecutable', () => {
  it('deixa o SDK escolher em desenvolvimento', () => {
    expect(resolveClaudeExecutable({ packaged: false })).toBeUndefined();
  });

  it('aponta para app.asar.unpacked na app instalada', () => {
    const resources = path.join('Programs', 'solline', 'resources');
    const resolved = resolveClaudeExecutable({
      packaged: true,
      platform: 'win32',
      arch: 'x64',
      resolve: (specifier) => path.join(resources, 'app.asar', 'node_modules', specifier),
    });
    expect(resolved).toBe(
      path.join(
        resources,
        'app.asar.unpacked',
        'node_modules',
        '@anthropic-ai',
        'claude-agent-sdk-win32-x64',
        'claude.exe',
      ),
    );
  });

  it('só troca o segmento app.asar inteiro', () => {
    expect(toUnpackedPath('/r/app.asar/node_modules/x')).toBe(
      '/r/app.asar.unpacked/node_modules/x',
    );
    expect(toUnpackedPath('/r/app.asar.unpacked/x')).toBe('/r/app.asar.unpacked/x');
    expect(toUnpackedPath('/r/myapp.asar/x')).toBe('/r/myapp.asar/x');
  });

  it('o binário desta plataforma está instalado', () => {
    const resolved = resolveClaudeExecutable({ packaged: true });
    expect(resolved?.endsWith(binaryName())).toBe(true);
    expect(resolved?.includes(platformPackageName().split('/')[1] ?? '')).toBe(true);
    expect(existsSync(resolved ?? '')).toBe(true);
  });
});
