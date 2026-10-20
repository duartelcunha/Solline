// Gera os tipos do protocolo do codex app-server a partir do codex.exe instalado (fixado no
// package.json). O app-server é experimental: em cada subida do Codex, voltar a correr isto.
// Uso: pnpm --filter @solline/engine codex:gen
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const target = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
const pkg = `@openai/codex-win32-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
const vendor = path.join(path.dirname(require.resolve(`${pkg}/package.json`)), 'vendor', target);
const exe = path.join(vendor, 'bin', 'codex.exe');
const { version } = JSON.parse(readFileSync(path.join(vendor, 'codex-package.json'), 'utf8'));
const out = path.join(here, '..', 'src', 'adapters', 'codex', 'protocol');

rmSync(out, { recursive: true, force: true });
execFileSync(exe, ['app-server', 'generate-ts', '--out', out], { stdio: 'inherit' });
writeFileSync(
  path.join(out, 'GENERATED_FROM.ts'),
  `// Versão do Codex que gerou estes tipos (o teste de deriva compara com o package.json).\nexport const GENERATED_FROM = '${version}';\n`,
);
console.log(`tipos do app-server ${version} em ${out}`);
