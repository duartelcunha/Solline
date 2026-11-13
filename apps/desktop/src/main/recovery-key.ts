import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Only code is placed on the command line. Key bytes travel through anonymous pipes;
// the OS vault is the only persistent location. No temporary script or credential file.
const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SollineCredential {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Credential {
    public uint Flags, Type;
    public string TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist, AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias, UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool Read(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool Write(ref Credential credential, uint flags);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool Delete(string target, uint type, uint flags);
}
'@
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($inputData.mode -eq 'read') {
  $pointer = [IntPtr]::Zero
  if (![SollineCredential]::Read($inputData.target, 1, 0, [ref]$pointer)) {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($code -eq 1168) { [Console]::Out.Write('missing'); exit 0 }
    throw "Credential read failed ($code)"
  }
  try {
    $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer, [type][SollineCredential+Credential])
    if ($credential.CredentialBlobSize -ne 32) { throw 'Invalid recovery key length' }
    $bytes = New-Object byte[] 32
    [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, 32)
    [Console]::Out.Write([Convert]::ToBase64String($bytes))
  } finally { [SollineCredential]::CredFree($pointer) }
} elseif ($inputData.mode -eq 'write') {
  $bytes = [Convert]::FromBase64String($inputData.key)
  if ($bytes.Length -ne 32) { throw 'Invalid recovery key length' }
  $pointer = [Runtime.InteropServices.Marshal]::AllocHGlobal(32)
  try {
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $pointer, 32)
    $credential = New-Object SollineCredential+Credential
    $credential.Type = 1; $credential.TargetName = $inputData.target
    $credential.CredentialBlobSize = 32; $credential.CredentialBlob = $pointer
    $credential.Persist = 2; $credential.UserName = 'Solline recovery'
    if (![SollineCredential]::Write([ref]$credential, 0)) { throw 'Credential write failed' }
    [Console]::Out.Write('saved')
  } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($pointer) }
} elseif ($inputData.mode -eq 'delete') {
  if (![SollineCredential]::Delete($inputData.target, 1, 0)) {
    if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 1168) { throw 'Credential deletion failed' }
  }
  [Console]::Out.Write('deleted')
} else { throw 'Invalid vault operation' }
`;

export function recoveryTarget(directory: string): string {
  return `Solline/recovery/${createHash('sha256').update(directory.toLowerCase()).digest('hex')}`;
}

function vault(input: {
  mode: 'read' | 'write' | 'delete';
  target: string;
  key?: string;
}): Promise<string> {
  if (process.platform !== 'win32')
    return Promise.reject(
      new Error('O cofre de recuperação não está disponível nesta plataforma.'),
    );
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  return new Promise((resolve, reject) => {
    const child = spawn(
      join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { SystemRoot: systemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
      },
    );
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('O cofre de recuperação não respondeu.'));
    }, 25000);
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.resume();
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('Não foi possível abrir o cofre de recuperação.'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // Never forward subprocess output: errors may include its input.
      if (code !== 0) reject(new Error('O Windows recusou o acesso ao cofre de recuperação.'));
      else resolve(output.trim());
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(input));
  });
}

export async function loadRecoveryKey(directory: string): Promise<Buffer> {
  const target = recoveryTarget(directory);
  const saved = await vault({ mode: 'read', target });
  if (saved !== 'missing') {
    const key = Buffer.from(saved, 'base64');
    if (key.length !== 32) throw new Error('Chave de recuperação inválida');
    return key;
  }
  const existing = await Promise.all(
    ['recovery/engine-v1', 'recovery-ui'].map((relative) =>
      readdir(join(directory, relative)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      }),
    ),
  );
  if (existing.some((entries) => entries.length > 0))
    throw new Error(
      'A chave dos dados existentes não está no cofre. Os dados foram preservados; não foi criada uma chave substituta.',
    );
  const key = randomBytes(32);
  if ((await vault({ mode: 'write', target, key: key.toString('base64') })) !== 'saved')
    throw new Error('A chave não foi guardada no cofre.');
  return key;
}

/** Used by isolated test fixture cleanup only, never during normal session cleanup. */
export async function removeRecoveryKey(directory: string): Promise<void> {
  await vault({ mode: 'delete', target: recoveryTarget(directory) });
}
