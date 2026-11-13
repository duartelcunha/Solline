/**
 * Desde o CVE-2024-27980 o Node não arranca um `.cmd`/`.bat` com `execFile` nem `spawn`
 * sem shell: responde EINVAL. O `gh` e o git de teste podem ser um `.cmd`. Passa-se pelo
 * `cmd.exe /d /s /c` com os argumentos entre aspas, sem `shell: true`.
 */
export function launchArgs(
  file: string,
  args: readonly string[],
): { file: string; args: string[]; verbatim: boolean } {
  if (process.platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(file)) {
    return { file, args: [...args], verbatim: false };
  }
  const line = [file, ...args].map(quoteCmd).join(' ');
  return {
    file: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    verbatim: true,
  };
}

function quoteCmd(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[\s"&|<>^%]/.test(arg)) return arg;
  return `"${arg.replaceAll('"', '""')}"`;
}
