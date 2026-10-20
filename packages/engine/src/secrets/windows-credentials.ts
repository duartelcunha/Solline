import { spawn } from 'node:child_process';
import path from 'node:path';

/**
 * Lê uma credencial genérica do Gestor de Credenciais do Windows (CredRead), sem a pôr na
 * linha de comando nem em ficheiros: o script (fixo, sem segredos) vai em -EncodedCommand,
 * o alvo numa variável de ambiente e o segredo volta pelo stdout. As chaves pessoais vivem
 * aí (regra do Duarte), nunca em ficheiros nem no registo.
 */
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SollineCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll")]
  private static extern void CredFree(IntPtr credential);
  public static string Read(string target) {
    IntPtr pointer;
    if (!CredRead(target, 1, 0, out pointer)) return null;
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(pointer, typeof(CREDENTIAL));
      if (c.CredentialBlobSize == 0) return "";
      return Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2);
    } finally { CredFree(pointer); }
  }
}
"@
$value = [SollineCredential]::Read($env:SOLLINE_CREDENTIAL_TARGET)
if ([string]::IsNullOrWhiteSpace($value)) { exit 3 }
if ($env:SOLLINE_CREDENTIAL_MODE -ne 'check') { [Console]::Out.Write($value) }
exit 0
`;

export type CredentialReader = (
  target: string,
  mode: 'read' | 'check',
) => Promise<string | boolean | null>;

function powershell(): string {
  const root = process.env.SystemRoot ?? 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * read: o segredo, ou null se não existir. check: true/false, sem tirar o segredo do Windows.
 * Fora do Windows não há Gestor de Credenciais: devolve null/false.
 */
export const readWindowsCredential: CredentialReader = (target, mode) => {
  if (process.platform !== 'win32') return Promise.resolve(mode === 'check' ? false : null);
  return new Promise((resolve, reject) => {
    // Pelo stdin (-Command -) o PowerShell lê linha a linha e engole a here-string do Add-Type.
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
    const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded];
    const child = spawn(powershell(), args, {
      windowsHide: true,
      env: {
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        SOLLINE_CREDENTIAL_TARGET: target,
        SOLLINE_CREDENTIAL_MODE: mode,
      },
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (err += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 3) return resolve(mode === 'check' ? false : null);
      if (code !== 0) {
        return reject(new Error(`Gestor de Credenciais: ${err.trim().slice(-300) || code}`));
      }
      resolve(mode === 'check' ? true : out);
    });
    child.stdin.end();
  });
};
