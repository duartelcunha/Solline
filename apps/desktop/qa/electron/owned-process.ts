import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

export type ProcessIdentity = {
  pid: number;
  parentPid: number;
  started: string;
  nativeVerified?: boolean;
};
export type ProcessPresence = Omit<ProcessIdentity, 'started'> & {
  started: string | null;
  exited?: boolean;
  nativeVerified?: boolean;
};
export type Termination = {
  exitCode: number;
  stdout: string;
  stderr: string;
  pids: number[];
  exited?: ProcessIdentity[];
};
export type ProcessBackend = {
  snapshot: (
    captured?: ProcessIdentity[],
    rootPid?: number,
  ) => ProcessPresence[] | Promise<ProcessPresence[]>;
  terminate: (processes: ProcessIdentity[]) => Termination | Promise<Termination>;
  now: () => number;
  wait: () => Promise<void>;
};
export type CleanupReport = {
  root: ProcessIdentity;
  captured: ProcessIdentity[];
  termination?: Termination;
  survivors: ProcessIdentity[];
  ambiguous: ProcessPresence[];
  error?: string;
  verifiedGone: boolean;
  observedExited: ProcessIdentity[];
  observations: { phase: string; durationMs: number; survivors: number[] }[];
};

const run = promisify(execFile);
async function powershell(script: string): Promise<string> {
  const { stdout } = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  return stdout.trim();
}

function validPresence(value: ProcessPresence): boolean {
  return (
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    Number.isSafeInteger(value.parentPid) &&
    value.parentPid >= 0 &&
    (value.started === null ||
      (typeof value.started === 'string' && /^\d+$/.test(value.started))) &&
    (value.exited === undefined || typeof value.exited === 'boolean') &&
    (value.nativeVerified === undefined || typeof value.nativeVerified === 'boolean')
  );
}
function validIdentity(
  value: ProcessPresence,
): value is ProcessIdentity & { exited?: boolean; nativeVerified?: boolean } {
  return validPresence(value) && value.started !== null;
}

export const windowsBackend: ProcessBackend = {
  async snapshot(captured = [], rootPid) {
    if (!captured.every(validIdentity)) throw new Error('Invalid captured identities');
    if (rootPid !== undefined && (!Number.isSafeInteger(rootPid) || rootPid <= 0))
      throw new Error('Invalid root seed');
    const records = captured
      .map((item) => `@{pid=${item.pid};started='${item.started}'}`)
      .join(',');
    // Only process IDs and creation times: never collect command lines or environment.
    const value: unknown = JSON.parse(
      await powershell(`
$ErrorActionPreference = 'Stop'
$owned = @(${records})
$handles = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
$opened = @{}
$births = @{}
$attempted = [System.Collections.Generic.HashSet[int]]::new()
function Open-Candidate([int]$candidateId) {
  if (-not $attempted.Add($candidateId)) { return }
  $process = $null
  try {
    $process = Get-Process -Id $candidateId -ErrorAction Stop
    $null = $process.Handle
    $nativeTicks = $process.StartTime.ToUniversalTime().Ticks.ToString()
    $births[$candidateId] = $nativeTicks.Substring(0, $nativeTicks.Length - 1) + '0'
    $handles.Add($process)
    $opened[$candidateId] = $process
    $process = $null
  } catch { $opened[$candidateId] = $null }
  finally { if ($null -ne $process) { $process.Dispose() } }
}
try {
  $seed = ${rootPid ?? 0}
  if ($seed -gt 0) { Open-Candidate $seed }
  foreach ($record in $owned) { Open-Candidate $record.pid }
$rows = @(Get-CimInstance -Query 'SELECT ProcessId, ParentProcessId, CreationDate FROM Win32_Process' -ErrorAction Stop | Where-Object { $_.ProcessId -gt 0 } | ForEach-Object {
  $started = if ($null -ne $_.CreationDate) { $_.CreationDate.ToUniversalTime().Ticks.ToString() } else { $null }
  @{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; started = $started; exited = $false; nativeVerified = $false }
})
$byPid = @{}
foreach ($row in $rows) { $byPid[$row.pid] = $row }
$pending = [System.Collections.Generic.Queue[int]]::new()
$seen = [System.Collections.Generic.HashSet[int]]::new()
if ($seed -gt 0) { $pending.Enqueue($seed) }
foreach ($record in $owned) { $pending.Enqueue($record.pid) }
while ($pending.Count -gt 0) {
  $candidateId = $pending.Dequeue()
  if (-not $seen.Add($candidateId)) { continue }
  $row = $byPid[$candidateId]
  if ($null -eq $row) { continue }
  Open-Candidate $candidateId
  if ($null -eq $opened[$candidateId] -or $null -eq $row.started -or $births[$candidateId] -ne $row.started) {
    $row.started = $null
    continue
  }
  $row.nativeVerified = $true
  $row.exited = $opened[$candidateId].WaitForExit(0)
  $expected = $owned | Where-Object { $_.pid -eq $candidateId }
  if ($row.exited -or ($null -ne $expected -and $expected.started -ne $row.started)) { continue }
  foreach ($child in $rows) {
    if ($child.parentPid -eq $candidateId -and $null -ne $child.started -and [Int64]$child.started -ge [Int64]$row.started) { $pending.Enqueue($child.pid) }
  }
}
ConvertTo-Json -InputObject $rows -Compress
} finally { foreach ($process in $handles) { $process.Dispose() } }
`),
    );
    if (!Array.isArray(value) || !value.every((entry) => entry && validPresence(entry)))
      throw new Error('Invalid native process snapshot');
    return value as ProcessPresence[];
  },
  async terminate(processes) {
    if (!processes.length || !processes.every(validIdentity))
      throw new Error('Invalid captured process identities');
    const records = processes
      .map((item) => `@{pid=${item.pid};started='${item.started}'}`)
      .join(',');
    // Hold public .NET Process handles while checking creation identities and
    // invoking Kill() on those same objects. Retained handles prevent PID reuse.
    // No external killer process survives a PowerShell timeout; no tree-wide kill.
    // Descendants discovered later are reported as survivors, never broadly killed.
    // PID lifetime: https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/ns-processthreadsapi-process_information
    // Kill is asynchronous: https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.kill
    // Birth precision: https://learn.microsoft.com/en-us/windows/win32/wmisdk/cim-datetime
    // https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes
    const raw: unknown = JSON.parse(
      await powershell(`
$ErrorActionPreference = 'Stop'
$owned = @(${records})
$handles = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
$ids = [System.Collections.Generic.List[int]]::new()
$opened = @{}
$success = [System.Collections.Generic.List[string]]::new()
$failures = [System.Collections.Generic.List[string]]::new()
$birthChecks = [System.Collections.Generic.List[object]]::new()
try {
  foreach ($record in $owned) {
    $process = $null
    try {
      $process = Get-Process -Id $record.pid -ErrorAction Stop
      $null = $process.Handle
      # CIM has six fractional digits (microseconds); FILETIME has 100ns ticks.
      # Truncate the final tick digit as text, never round a ~6e17 value via double.
      $nativeTicks = $process.StartTime.ToUniversalTime().Ticks.ToString()
      $microTicks = $nativeTicks.Substring(0, $nativeTicks.Length - 1) + '0'
      $birthChecks.Add(@{pid=$record.pid;expected=$record.started;native=$nativeTicks;normalized=$microTicks})
      if ($microTicks -ne $record.started) { throw 'Captured process birth identity changed' }
      $handles.Add($process)
      $opened[$record.pid] = $process
      $ids.Add($record.pid)
      $process = $null
    } catch {
      $failures.Add('PID ' + $record.pid + ': identity/handle: ' + $_.Exception.Message)
      $opened[$record.pid] = $false
    } finally { if ($null -ne $process) { $process.Dispose() } }
  }
  $exited = [System.Collections.Generic.List[object]]::new()
  foreach ($id in $ids) {
    try {
      $opened[$id].Kill()
      $success.Add('PID ' + $id + ': termination requested')
    } catch { $failures.Add('PID ' + $id + ': ' + $_.Exception.Message) }
  }
  # A signalled, identity-validated handle proves exit even if CIM retains a row.
  # One total budget, not a fresh timeout for each process. Keep all handles open.
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  foreach ($id in $ids) {
    try {
      $remaining = [Math]::Max(0, 2000 - [int]$clock.ElapsedMilliseconds)
      if ($opened[$id].WaitForExit($remaining)) {
        $record = $owned | Where-Object { $_.pid -eq $id }
        $exited.Add(@{ pid = $id; started = $record.started })
        $success.Add('PID ' + $id + ': validated process handle signalled exit')
      }
    } catch { $failures.Add('PID ' + $id + ': exit verification: ' + $_.Exception.Message) }
  }
  $result = @{ exitCode = [int]($failures.Count -gt 0); stdout = ($success -join [Environment]::NewLine); stderr = ($failures -join [Environment]::NewLine); pids = @($ids.ToArray()); exited = @($exited.ToArray()); birthChecks = @($birthChecks.ToArray()) }
  ConvertTo-Json -InputObject $result -Compress
} finally { foreach ($process in $handles) { $process.Dispose() } }
`),
    );
    if (
      !raw ||
      typeof raw !== 'object' ||
      !('exitCode' in raw) ||
      typeof raw.exitCode !== 'number' ||
      !('stdout' in raw) ||
      typeof raw.stdout !== 'string' ||
      !('stderr' in raw) ||
      typeof raw.stderr !== 'string' ||
      !('pids' in raw) ||
      !Array.isArray(raw.pids) ||
      !raw.pids.every((pid) => processes.some((item) => item.pid === pid)) ||
      !('exited' in raw) ||
      !Array.isArray(raw.exited)
    )
      throw new Error('Invalid native termination result');
    const pids = raw.pids;
    const exited = raw.exited.map((proof: { pid?: number; started?: string }) => {
      const identity = processes.find(
        (item) => item.pid === proof?.pid && item.started === proof.started,
      );
      if (!identity || !pids.includes(identity.pid))
        throw new Error('Invalid native exit identity proof');
      return identity;
    });
    return { ...(raw as Termination), exited };
  },
  now: Date.now,
  wait: () => delay(100),
};

const key = (process: ProcessIdentity) => `${process.pid}:${process.started}`;
const same = (left: ProcessIdentity, right: ProcessIdentity) => key(left) === key(right);

export class ProcessCaptureError extends Error {
  readonly capture: { pid: number; phase: string; candidates: ProcessPresence[] };
  constructor(
    capture: { pid: number; phase: string; candidates: ProcessPresence[] },
    cause: unknown,
  ) {
    super(`Native process capture failed (${capture.phase}): ${String(cause)}`, { cause });
    this.capture = capture;
    this.name = 'ProcessCaptureError';
  }
}

/** Ownership is captured at launch, refreshed before close, and verified after kill. */
export class OwnedProcessTree {
  readonly report: CleanupReport;
  readonly #backend: ProcessBackend;
  readonly #captured = new Map<string, ProcessIdentity>();
  #stopPromise?: Promise<void>;

  static async create(
    pid: number,
    verifyOrigin: () => void | Promise<void>,
    backend: ProcessBackend = windowsBackend,
  ): Promise<OwnedProcessTree> {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid owned root PID');
    if (typeof verifyOrigin !== 'function') throw new Error('Original process proof required');
    // A matching native PID/birth alone cannot identify the process we launched
    // if it exited and its PID was reused while asynchronous capture was pending.
    let phase = 'origin-before';
    let snapshot: ProcessPresence[] = [];
    try {
      await verifyOrigin();
      const begin = backend.now();
      phase = 'native-snapshot';
      snapshot = await backend.snapshot([], pid);
      phase = 'origin-after';
      await verifyOrigin();
      phase = 'tree-capture';
      return new OwnedProcessTree(pid, backend, snapshot, backend.now() - begin);
    } catch (error) {
      // Diagnostic metadata only, never ownership authority or command lines.
      const ids = new Set([pid]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const item of snapshot)
          if (ids.has(item.parentPid) && !ids.has(item.pid)) {
            ids.add(item.pid);
            changed = true;
          }
      }
      throw new ProcessCaptureError(
        { pid, phase, candidates: snapshot.filter((item) => ids.has(item.pid)) },
        error,
      );
    }
  }

  private constructor(
    pid: number,
    backend: ProcessBackend,
    snapshot: ProcessPresence[],
    durationMs: number,
  ) {
    this.#backend = backend;
    const root = snapshot.find((process) => process.pid === pid);
    if (!root || !validIdentity(root) || root.nativeVerified !== true)
      throw new Error('Owned native root identity unavailable');
    this.#captured.set(key(root), root);
    this.report = {
      root,
      captured: [],
      survivors: [],
      ambiguous: [],
      verifiedGone: false,
      observedExited: [],
      observations: [],
    };
    this.#observe(snapshot);
    this.report.observations.push({
      phase: 'capture',
      durationMs,
      survivors: this.report.survivors.map((item) => item.pid),
    });
  }

  #observe(snapshot: ProcessPresence[]) {
    if (!snapshot.every(validPresence)) throw new Error('Invalid native process snapshot');
    this.report.ambiguous = [];
    // Only a present, matching parent proves fresh child ownership. A missing
    // parent might have been reused and exited between snapshots. Previously
    // captured orphans remain owned; fresh ambiguous children are never killed.
    let changed = true;
    while (changed) {
      changed = false;
      for (const parent of this.#captured.values()) {
        const current = snapshot.find((item) => item.pid === parent.pid);
        if (current && (!validIdentity(current) || current.nativeVerified !== true)) {
          this.report.ambiguous.push(current);
          continue;
        }
        if (current && !same(current, parent)) continue;
        for (const child of snapshot) {
          if (child.parentPid !== parent.pid) continue;
          if (!validIdentity(child) || child.nativeVerified !== true) {
            this.report.ambiguous.push(child);
            continue;
          }
          if (BigInt(child.started) < BigInt(parent.started) || this.#captured.has(key(child)))
            continue;
          if (
            !current ||
            current.exited ||
            this.report.observedExited.some((proof) => same(proof, parent)) ||
            this.report.termination?.exited?.some((proof) => same(proof, parent))
          ) {
            this.report.ambiguous.push(child);
            continue;
          }
          this.#captured.set(key(child), child);
          changed = true;
        }
      }
    }
    this.report.captured = [...this.#captured.values()];
    for (const item of snapshot.filter(validIdentity)) {
      if (
        item.exited &&
        this.#captured.has(key(item)) &&
        !this.report.observedExited.some((proof) => same(proof, item))
      )
        this.report.observedExited.push({
          pid: item.pid,
          parentPid: item.parentPid,
          started: item.started,
          nativeVerified: true,
        });
    }
    this.report.survivors = snapshot
      .filter(validIdentity)
      .filter((item) => this.#captured.has(key(item)))
      .filter((item) => !this.report.observedExited.some((proof) => same(proof, item)))
      .filter((item) => !this.report.termination?.exited?.some((proof) => same(proof, item)));
    if (this.report.ambiguous.length)
      throw new Error('Ambiguous process ownership; preserve fixture and credentials');
  }

  async refresh(): Promise<void> {
    if (this.report.verifiedGone) return;
    const begin = this.#backend.now();
    try {
      this.#observe(await this.#backend.snapshot([...this.#captured.values()]));
    } catch (error) {
      this.report.error = String(error);
      throw error;
    } finally {
      this.report.observations.push({
        phase: 'snapshot',
        durationMs: this.#backend.now() - begin,
        survivors: this.report.survivors.map((item) => item.pid),
      });
    }
  }

  stop(): Promise<void> {
    return (this.#stopPromise ??= this.#stop());
  }

  async #stop(): Promise<void> {
    if (this.report.error)
      throw new Error('Prior cleanup failure; preserve fixture and credentials');
    if (this.report.verifiedGone) return;
    this.report.verifiedGone = false;
    try {
      await this.refresh();
      if (this.report.survivors.length) {
        // The backend revalidates each identity under a held process handle.
        const begin = this.#backend.now();
        try {
          this.report.termination = await this.#backend.terminate([...this.report.survivors]);
        } finally {
          this.report.observations.push({
            phase: 'terminate',
            durationMs: this.#backend.now() - begin,
            survivors: this.report.survivors.map((item) => item.pid),
          });
        }
      }
      const deadline = this.#backend.now() + 10_000;
      do {
        await this.refresh();
        if (!this.report.survivors.length) {
          this.report.verifiedGone = true;
          return;
        }
        if (this.#backend.now() >= deadline) break;
        await this.#backend.wait();
      } while (this.#backend.now() <= deadline);
      throw new Error('Captured owned processes remain alive; preserve fixture and credentials');
    } catch (error) {
      this.report.error = String(error);
      throw error;
    }
  }
}

/** Evidence errors also fail closed. Termination errors are benign only after proof of exit. */
export async function stopOwnedProcesses(
  owners: OwnedProcessTree[],
  record: (report: CleanupReport) => Promise<void>,
): Promise<void> {
  const errors: unknown[] = [];
  for (const owner of owners) {
    try {
      await owner.stop();
    } catch (error) {
      errors.push(error);
    }
    try {
      await record(owner.report);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, 'Owned process cleanup failed; preserve fixture');
}

/** Never remove files when process verification or credential removal failed. */
export async function cleanupOwnedFixture(
  stop: () => Promise<void>,
  removeCredential: () => Promise<void>,
  removeFiles: () => Promise<void>,
): Promise<void> {
  await stop();
  await removeCredential();
  await removeFiles();
}
