import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Only code is placed on the command line. Key bytes travel through anonymous pipes;
// the OS vault is the only persistent location. In-memory Reflection.Emit P/Invoke avoids
// spawning csc.exe or writing temporary assemblies to disk.
const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$PSModuleAutoLoadingPreference = 'None'
$asm = [AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('SollineVault'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
$mod = $asm.DefineDynamicModule('SollineVault')
$tb = $mod.DefineType('SollineCredStruct', 'Public, SequentialLayout, Sealed, BeforeFieldInit, UnicodeClass', [ValueType])
$null = $tb.DefineField('Flags', [uint32], 'Public')
$null = $tb.DefineField('Type', [uint32], 'Public')
$null = $tb.DefineField('TargetName', [string], 'Public')
$null = $tb.DefineField('Comment', [string], 'Public')
$null = $tb.DefineField('LastWritten', [Runtime.InteropServices.ComTypes.FILETIME], 'Public')
$null = $tb.DefineField('CredentialBlobSize', [uint32], 'Public')
$null = $tb.DefineField('CredentialBlob', [IntPtr], 'Public')
$null = $tb.DefineField('Persist', [uint32], 'Public')
$null = $tb.DefineField('AttributeCount', [uint32], 'Public')
$null = $tb.DefineField('Attributes', [IntPtr], 'Public')
$null = $tb.DefineField('TargetAlias', [string], 'Public')
$null = $tb.DefineField('UserName', [string], 'Public')
$credType = $tb.CreateType()
$dllCtor = [Runtime.InteropServices.DllImportAttribute].GetConstructor(@([string]))
$entryField = [Runtime.InteropServices.DllImportAttribute].GetField('EntryPoint')
$charSetField = [Runtime.InteropServices.DllImportAttribute].GetField('CharSet')
$setLastErrField = [Runtime.InteropServices.DllImportAttribute].GetField('SetLastError')
function Add-VaultImport($typeBuilder, $name, $entry, $ret, $params) {
  $m = $typeBuilder.DefineMethod($name, 'Public, Static, PinvokeImpl', $ret, $params)
  $m.SetCustomAttribute([Reflection.Emit.CustomAttributeBuilder]::new(
    $dllCtor,
    @('advapi32.dll'),
    @($entryField, $charSetField, $setLastErrField),
    @($entry, [Runtime.InteropServices.CharSet]::Unicode, $true)
  ))
}
$api = $mod.DefineType('SollineAdvapi', 'Public, Abstract, Sealed')
Add-VaultImport $api 'Read' 'CredReadW' ([bool]) @([string], [uint32], [uint32], [IntPtr].MakeByRefType())
Add-VaultImport $api 'Write' 'CredWriteW' ([bool]) @([IntPtr], [uint32])
Add-VaultImport $api 'Delete' 'CredDeleteW' ([bool]) @([string], [uint32], [uint32])
Add-VaultImport $api 'CredFree' 'CredFree' ([void]) @([IntPtr])
$advapi = $api.CreateType()
$lines = [Console]::In.ReadToEnd().Replace([string][char]13, '').Split([char]10)
$mode = if ($lines.Length -gt 0) { $lines[0] } else { '' }
$target = if ($lines.Length -gt 1) { $lines[1] } else { '' }
$keyB64 = if ($lines.Length -gt 2) { $lines[2] } else { '' }
if ($mode -eq 'ensure') {
  $pointer = [IntPtr]::Zero
  if ($advapi::Read($target, 1, 0, [ref]$pointer)) {
    try {
      $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer, [Type]$credType)
      if ($credential.CredentialBlobSize -ne 32) { throw 'Invalid recovery key length' }
      $bytes = [byte[]]::new(32)
      [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, 32)
      [Console]::Out.Write('existing:' + [Convert]::ToBase64String($bytes))
      [Array]::Clear($bytes, 0, 32)
    } finally { $advapi::CredFree($pointer) }
  } else {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($code -ne 1168) { throw "Credential read failed ($code)" }
    if (-not $keyB64) { [Console]::Out.Write('missing'); exit 0 }
    $bytes = [Convert]::FromBase64String($keyB64)
    if ($bytes.Length -ne 32) { throw 'Invalid recovery key length' }
    $mem = [Runtime.InteropServices.Marshal]::AllocHGlobal(32)
    $credPtr = [Runtime.InteropServices.Marshal]::AllocHGlobal([Runtime.InteropServices.Marshal]::SizeOf([Type]$credType))
    $credMarshaled = $false
    try {
      [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $mem, 32)
      $credential = [Activator]::CreateInstance($credType)
      $credential.Type = 1
      $credential.TargetName = $target
      $credential.CredentialBlobSize = 32
      $credential.CredentialBlob = $mem
      $credential.Persist = 2
      $credential.UserName = 'Solline recovery'
      [Runtime.InteropServices.Marshal]::StructureToPtr($credential, $credPtr, $false)
      $credMarshaled = $true
      if (-not $advapi::Write($credPtr, 0)) { throw 'Credential write failed' }
      [Console]::Out.Write('saved')
    } finally {
      if ($credMarshaled) { [Runtime.InteropServices.Marshal]::DestroyStructure($credPtr, [Type]$credType) }
      [Runtime.InteropServices.Marshal]::FreeHGlobal($credPtr)
      [Runtime.InteropServices.Marshal]::Copy(([byte[]]::new(32)), 0, $mem, 32)
      [Runtime.InteropServices.Marshal]::FreeHGlobal($mem)
      [Array]::Clear($bytes, 0, 32)
    }
  }
} elseif ($mode -eq 'delete') {
  if (-not $advapi::Delete($target, 1, 0)) {
    if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 1168) { throw 'Credential deletion failed' }
  }
  [Console]::Out.Write('deleted')
} else { throw 'Invalid vault operation' }
`;

export function recoveryTarget(directory: string): string {
  return `Solline/recovery/${createHash('sha256').update(directory.toLowerCase()).digest('hex')}`;
}

function vault(input: {
  mode: 'ensure' | 'delete';
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
        env: { SystemRoot: systemRoot, PSModulePath: '', TEMP: process.env.TEMP, TMP: process.env.TMP },
      },
    );
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('O cofre de recuperação não respondeu.'));
    }, 30000);
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
    child.stdin.end(`${input.mode}\n${input.target}\n${input.key ?? ''}`);
  });
}

export async function loadRecoveryKey(directory: string): Promise<Buffer> {
  const target = recoveryTarget(directory);
  const existing = await Promise.all(
    ['recovery/engine-v1', 'recovery-ui'].map((relative) =>
      readdir(join(directory, relative)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      }),
    ),
  );
  const hasExistingData = existing.some((entries) => entries.length > 0);
  const candidate = hasExistingData ? undefined : randomBytes(32);
  let reply: string;
  try {
    reply = await vault({
      mode: 'ensure',
      target,
      ...(candidate ? { key: candidate.toString('base64') } : {}),
    });
  } catch (error) {
    candidate?.fill(0);
    throw error;
  }
  if (reply === 'saved') {
    if (!candidate) throw new Error('A chave não foi guardada no cofre.');
    return candidate;
  }
  candidate?.fill(0);
  if (reply === 'missing')
    throw new Error(
      'A chave dos dados existentes não está no cofre. Os dados foram preservados; não foi criada uma chave substituta.',
    );
  if (reply.startsWith('existing:')) {
    const key = Buffer.from(reply.slice('existing:'.length), 'base64');
    if (key.length !== 32) throw new Error('Chave de recuperação inválida');
    return key;
  }
  throw new Error('A chave não foi guardada no cofre.');
}

/** Used by isolated test fixture cleanup only, never during normal session cleanup. */
export async function removeRecoveryKey(directory: string): Promise<void> {
  await vault({ mode: 'delete', target: recoveryTarget(directory) });
}
