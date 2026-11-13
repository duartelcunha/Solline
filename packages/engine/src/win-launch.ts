/**
 * Desde o CVE-2024-27980 o Node não arranca um `.cmd`/`.bat` com `execFile` nem `spawn`
 * sem shell: responde EINVAL. O `gh` e o git de teste podem ser um `.cmd`. Passa-se pelo
 * `cmd.exe /d /c`. O Node cita cada argumento. Sem `/s` e sem aspas à volta da linha
 * inteira, senão o cmd procura o caminho com as aspas no nome.
 */
export function launchArgs(
  file: string,
  args: readonly string[],
): { file: string; args: string[]; verbatim: boolean } {
  if (process.platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(file)) {
    return { file, args: [...args], verbatim: false };
  }
  // Sem /s e sem aspas à volta da linha inteira: o /s tirava a primeira e a
  // última aspa e o cmd procurava `"C:\...\git.cmd"` como nome do programa.
  // O Node cita cada argumento que precisa. shell fica desligado.
  return {
    file: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/c', file, ...args],
    verbatim: false,
  };
}

