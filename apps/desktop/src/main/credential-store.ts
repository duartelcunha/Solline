import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { SECRET_MAX_LENGTH, assertSecretTarget, type SecretStore } from '@solline/protocol';

/**
 * O Gestor de Credenciais do Windows como cofre dos segredos dos servidores MCP. Sem dependências
 * nativas: um PowerShell chama `CredWriteW`/`CredReadW`/`CredDeleteW` do advapi32 por P/Invoke. O
 * valor viaja sempre por stdin (em base64) e nunca por argumentos da linha de comando; o script é
 * fixo e não leva nenhum dado. O nome de cada segredo é `Solline/mcp/<serverId>/<VARIÁVEL>`.
 */

const SOURCE = `
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class SollineCred {
  const uint TYPE_GENERIC = 1;
  const uint PERSIST_LOCAL_MACHINE = 2;
  const int ERROR_NOT_FOUND = 1168;
  const int MAX_BLOB = 2560;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWrite(ref CREDENTIAL credential, uint flags);
  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDelete(string target, uint type, uint flags);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern void CredFree(IntPtr buffer);

  static string B(string text) { return Convert.ToBase64String(Encoding.UTF8.GetBytes(text)); }
  static string U(string text) { return Encoding.UTF8.GetString(Convert.FromBase64String(text)); }

  static string Read(string target) {
    IntPtr pointer;
    if (!CredRead(target, TYPE_GENERIC, 0, out pointer)) {
      int error = Marshal.GetLastWin32Error();
      if (error == ERROR_NOT_FOUND) return "N";
      throw new System.ComponentModel.Win32Exception(error);
    }
    try {
      CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(pointer, typeof(CREDENTIAL));
      byte[] blob = new byte[credential.CredentialBlobSize];
      if (blob.Length > 0) Marshal.Copy(credential.CredentialBlob, blob, 0, blob.Length);
      string value = Encoding.Unicode.GetString(blob);
      Array.Clear(blob, 0, blob.Length);
      return "V|" + B(value);
    } finally {
      CredFree(pointer);
    }
  }

  static void Write(string target, string value) {
    byte[] blob = Encoding.Unicode.GetBytes(value);
    if (blob.Length > MAX_BLOB) throw new InvalidOperationException("Valor grande demais para o cofre");
    IntPtr memory = Marshal.AllocCoTaskMem(Math.Max(blob.Length, 1));
    try {
      if (blob.Length > 0) Marshal.Copy(blob, 0, memory, blob.Length);
      CREDENTIAL credential = new CREDENTIAL();
      credential.Type = TYPE_GENERIC;
      credential.TargetName = target;
      credential.CredentialBlobSize = (uint)blob.Length;
      credential.CredentialBlob = memory;
      credential.Persist = PERSIST_LOCAL_MACHINE;
      credential.UserName = "Solline";
      if (!CredWrite(ref credential, 0))
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally {
      Marshal.Copy(new byte[blob.Length], 0, memory, blob.Length);
      Marshal.FreeCoTaskMem(memory);
      Array.Clear(blob, 0, blob.Length);
    }
  }

  static void Delete(string target) {
    if (!CredDelete(target, TYPE_GENERIC, 0)) {
      int error = Marshal.GetLastWin32Error();
      if (error != ERROR_NOT_FOUND) throw new System.ComponentModel.Win32Exception(error);
    }
  }

  public static string Run(string input) {
    StringBuilder output = new StringBuilder();
    foreach (string raw in input.Split(new char[] { '\\n' }, StringSplitOptions.RemoveEmptyEntries)) {
      string line = raw.Trim();
      if (line.Length == 0) continue;
      string[] part = line.Split('|');
      try {
        if (part[0] == "R") output.AppendLine(Read(U(part[1])));
        else if (part[0] == "W") { Write(U(part[1]), U(part[2])); output.AppendLine("K"); }
        else if (part[0] == "D") { Delete(U(part[1])); output.AppendLine("K"); }
        else output.AppendLine("E|" + B("Operação desconhecida"));
      } catch (Exception error) {
        output.AppendLine("E|" + B(error.Message));
      }
    }
    return output.ToString();
  }
}
`;

const SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'${SOURCE}'@
[Console]::Out.Write([SollineCred]::Run([Console]::In.ReadToEnd()))`;

/** O PowerShell do sistema, pelo caminho completo (nunca o primeiro "powershell" do PATH). */
function powershell(): string {
  return join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

type Operation =
  | { op: 'R'; target: string }
  | { op: 'W'; target: string; value: string }
  | { op: 'D'; target: string };

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

/** Corre as operações num só PowerShell; devolve uma linha de resposta por operação. */
function run(operations: readonly Operation[], timeoutMs = 60_000): Promise<string[]> {
  const input = operations
    .map((o) => (o.op === 'W' ? `W|${b64(o.target)}|${b64(o.value)}` : `${o.op}|${b64(o.target)}`))
    .join('\n');
  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = execFile(
      powershell(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          // Nada de stderr nem de stdout na mensagem: podiam trazer valores.
          reject(new Error('O Gestor de Credenciais não respondeu'));
          return;
        }
        const lines = stdout.split(/\r?\n/).filter((l) => l.length > 0);
        if (lines.length !== operations.length) {
          reject(new Error('Resposta inesperada do Gestor de Credenciais'));
          return;
        }
        resolve(lines);
      },
    );
    child.stdin?.end(input);
  });
}

function failure(line: string): Error {
  const [, message] = line.split('|');
  return new Error(
    message
      ? `Gestor de Credenciais: ${Buffer.from(message, 'base64').toString('utf8')}`
      : 'Gestor de Credenciais: falhou',
  );
}

export class WindowsCredentialStore implements SecretStore {
  async get(target: string): Promise<string | null> {
    return (await this.getMany([target]))[0] ?? null;
  }

  async getMany(targets: readonly string[]): Promise<(string | null)[]> {
    if (targets.length === 0) return [];
    for (const target of targets) assertSecretTarget(target);
    const lines = await run(targets.map((target) => ({ op: 'R' as const, target })));
    return lines.map((line) => {
      if (line === 'N') return null;
      if (line.startsWith('V|')) return Buffer.from(line.slice(2), 'base64').toString('utf8');
      throw failure(line);
    });
  }

  async set(target: string, value: string): Promise<void> {
    assertSecretTarget(target);
    if (value.length === 0 || value.length > SECRET_MAX_LENGTH)
      throw new Error('O valor do segredo tem de ter entre 1 e 1000 caracteres');
    const [line] = await run([{ op: 'W', target, value }]);
    if (line !== 'K') throw failure(line ?? 'E');
  }

  async remove(targets: readonly string[]): Promise<void> {
    if (targets.length === 0) return;
    for (const target of targets) assertSecretTarget(target);
    const lines = await run(targets.map((target) => ({ op: 'D' as const, target })));
    const bad = lines.find((line) => line !== 'K');
    if (bad) throw failure(bad);
  }
}

/** Sem cofre, nada se guarda: o utilizador vê porquê quando tenta acrescentar um segredo. */
export class UnavailableSecretStore implements SecretStore {
  readonly #reason: string;
  constructor(reason: string) {
    this.#reason = reason;
  }
  get(): Promise<string | null> {
    return Promise.reject(new Error(this.#reason));
  }
  getMany(): Promise<(string | null)[]> {
    return Promise.reject(new Error(this.#reason));
  }
  set(): Promise<void> {
    return Promise.reject(new Error(this.#reason));
  }
  remove(): Promise<void> {
    return Promise.reject(new Error(this.#reason));
  }
}

export function createSecretStore(): SecretStore {
  return process.platform === 'win32'
    ? new WindowsCredentialStore()
    : new UnavailableSecretStore(
        'O cofre de segredos só existe no Windows (Gestor de Credenciais)',
      );
}
