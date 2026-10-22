import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  OwnedProcessTree,
  ProcessCaptureError,
  cleanupOwnedFixture,
  stopOwnedProcesses,
  windowsBackend,
  type ProcessBackend,
  type ProcessIdentity,
  type ProcessPresence,
  type CleanupReport,
} from './owned-process.ts';

const root: ProcessIdentity = { pid: 101, parentPid: 1, started: '100', nativeVerified: true };
const child: ProcessIdentity = { pid: 102, parentPid: 101, started: '110', nativeVerified: true };
function fake() {
  const state = {
    processes: [root, child] as ProcessPresence[],
    calls: [] as ProcessIdentity[][],
    failSnapshot: false,
    time: 0,
    code: 0,
    exited: [] as ProcessIdentity[],
    afterKill: () => {
      state.processes = [];
    },
  };
  const backend: ProcessBackend = {
    snapshot: () => {
      if (state.failSnapshot) throw new Error('query failed');
      return structuredClone(state.processes).map((item) => ({ nativeVerified: true, ...item }));
    },
    terminate: (processes) => {
      state.calls.push(processes);
      state.afterKill();
      return {
        exitCode: state.code,
        stdout: 'root terminated',
        stderr: state.code ? 'child already gone' : '',
        pids: processes.map((p) => p.pid),
        exited: state.exited,
      };
    },
    now: () => state.time,
    wait: async () => {
      state.time += 1000;
    },
  };
  return { state, backend };
}

test('termination errors are accepted only after every captured identity is gone, retaining diagnostics', async () => {
  const { state, backend } = fake();
  const owner = await OwnedProcessTree.create(root.pid, () => undefined, backend);
  state.code = 1;
  const records: CleanupReport[] = [];
  await stopOwnedProcesses([owner], async (report) => {
    records.push(structuredClone(report));
  });
  assert.equal(state.calls.length, 1);
  assert.deepEqual(state.calls[0], [root, child]);
  assert.equal(records[0]?.verifiedGone, true);
  assert.equal(records[0]?.termination?.exitCode, 1);
  assert.equal(records[0]?.termination?.stderr, 'child already gone');
});

test('initial root requires native birth proof before adopting any descendant', async () => {
  const { state, backend } = fake();
  state.processes = [{ ...root, nativeVerified: false }, child];
  await assert.rejects(
    OwnedProcessTree.create(root.pid, () => undefined, backend),
    (error) => {
      assert.ok(error instanceof ProcessCaptureError);
      assert.equal(error.capture.phase, 'tree-capture');
      assert.equal(error.capture.pid, root.pid);
      assert.deepEqual(error.capture.candidates, state.processes);
      assert.match(String(error.cause), /root identity unavailable/);
      return true;
    },
  );
  assert.equal(state.calls.length, 0);
});

test('failed launch-origin proof prevents even starting process discovery', async () => {
  const { state, backend } = fake();
  let snapshots = 0;
  backend.snapshot = () => {
    snapshots++;
    return state.processes;
  };
  await assert.rejects(
    OwnedProcessTree.create(
      root.pid,
      () => {
        throw new Error('Original connection closed');
      },
      backend,
    ),
    /Original connection closed/,
  );
  assert.equal(snapshots, 0);
  assert.equal(state.calls.length, 0);
});

test('original process death during deferred capture rejects before publishing an owner', async () => {
  const { state, backend } = fake();
  let release: ((rows: ProcessPresence[]) => void) | undefined;
  let announce: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    announce = resolve;
  });
  backend.snapshot = () => {
    announce?.();
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  let originalAlive = true,
    checks = 0,
    published = false;
  const capture = OwnedProcessTree.create(
    root.pid,
    () => {
      checks++;
      if (!originalAlive) throw new Error('Original process exited');
    },
    backend,
  ).then((owner) => {
    published = true;
    return owner;
  });
  await started;
  originalAlive = false;
  assert.ok(release);
  release([
    { ...root, started: '999' },
    { ...child, started: '1000' },
  ]);
  await assert.rejects(capture, /Original process exited/);
  assert.equal(checks, 2);
  assert.equal(published, false);
  assert.equal(state.calls.length, 0);
});

test('stale CIM parent without native birth proof cannot adopt an unrelated child', async () => {
  const { state, backend } = fake();
  const owner = await OwnedProcessTree.create(root.pid, () => undefined, backend);
  state.processes = [
    { ...root, nativeVerified: false },
    child,
    { pid: 103, parentPid: root.pid, started: '120' },
  ];
  await assert.rejects(owner.stop(), /Ambiguous process ownership/);
  assert.equal(state.calls.length, 0);
  assert.ok(!owner.report.captured.some((item) => item.pid === 103));
});

test('unverified child blocks adoption and cannot bridge to a verified grandchild', async () => {
  const { state, backend } = fake();
  state.processes = [root];
  const owner = await OwnedProcessTree.create(root.pid, () => undefined, backend);
  state.processes = [
    root,
    { ...child, nativeVerified: false },
    { pid: 103, parentPid: child.pid, started: '120', nativeVerified: true },
  ];
  await assert.rejects(owner.stop(), /Ambiguous process ownership/);
  assert.equal(state.calls.length, 0);
  assert.deepEqual(owner.report.captured, [root]);
});

test('concurrent stop calls share one termination and await the same exit verification', async () => {
  const { state, backend } = fake();
  const owner = await OwnedProcessTree.create(root.pid, () => undefined, backend);
  const terminate = backend.terminate;
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  backend.terminate = async (processes) => {
    await held;
    return terminate(processes);
  };
  const first = owner.stop(),
    second = owner.stop();
  assert.equal(first, second);
  assert.ok(release);
  release();
  await Promise.all([first, second]);
  assert.equal(state.calls.length, 1);
  assert.equal(owner.report.verifiedGone, true);
});

test('signalled validated handles prove exit despite stale CIM rows', async () => {
  const { state, backend } = fake();
  const owner = await OwnedProcessTree.create(root.pid, () => undefined, backend);
  state.afterKill = () => {
    state.exited = [root, child];
  };
  await owner.stop();
  assert.equal(owner.report.verifiedGone, true);
  assert.deepEqual(owner.report.survivors, []);
  assert.deepEqual(owner.report.termination?.exited, [root, child]);
  assert.deepEqual(state.processes, [root, child]);
});

test('signalled captured handles do not excuse an unverified new descendant', async () => {
  const { state, backend } = fake();
  const owner = await OwnedProcessTree.create(root.pid, () => undefined, backend);
  state.afterKill = () => {
    state.exited = [root, child];
    state.processes = [{ pid: 103, parentPid: root.pid, started: '120' }];
  };
  await assert.rejects(owner.stop(), /Ambiguous process ownership/);
  assert.equal(owner.report.verifiedGone, false);
  assert.equal(state.calls.length, 1);
});

test('later native snapshot exit proofs resolve stale CIM without another kill', async () => {
  const { state, backend } = fake();
  const owner = await OwnedProcessTree.create(root.pid, () => undefined, backend);
  state.afterKill = () => {
    state.processes = [root, child].map((item) => ({ ...item, exited: true }));
  };
  await owner.stop();
  assert.equal(owner.report.verifiedGone, true);
  assert.deepEqual(owner.report.observedExited, [root, child]);
  assert.equal(state.calls.length, 1);
});

test('an exited parent snapshot cannot establish new descendant ownership', async () => {
  const { state, backend } = fake();
  const owner = await OwnedProcessTree.create(root.pid, () => undefined, backend);
  state.processes = [
    { ...root, exited: true },
    child,
    { pid: 103, parentPid: root.pid, started: '120' },
  ];
  await assert.rejects(owner.stop(), /Ambiguous process ownership/);
  assert.equal(state.calls.length, 0);
});

test('permanent exit proof prevents stale parent row from adopting a later child', async () => {
  const { state, backend } = fake();
  const owner = await OwnedProcessTree.create(root.pid, () => undefined, backend);
  state.processes = [{ ...root, exited: true }, child];
  await owner.refresh();
  state.processes = [root, child, { pid: 103, parentPid: root.pid, started: '120' }];
  await assert.rejects(owner.stop(), /Ambiguous process ownership/);
  assert.equal(state.calls.length, 0);
  assert.deepEqual(owner.report.observedExited, [root]);
});

test('surviving child blocks credential and directory removal, even after root exited', async () => {
  const { state, backend } = fake();
  const owner = await OwnedProcessTree.create(root.pid, () => undefined, backend);
  state.afterKill = () => {
    state.processes = [child];
  };
  const removed: string[] = [];
  await assert.rejects(
    cleanupOwnedFixture(
      () => owner.stop(),
      async () => {
        removed.push('key');
      },
      async () => {
        removed.push('files');
      },
    ),
    /remain alive/,
  );
  assert.deepEqual(owner.report.survivors, [child]);
  assert.deepEqual(removed, []);
  const rejected = owner.stop();
  assert.equal(owner.stop(), rejected);
  await assert.rejects(rejected, /remain alive/);
  assert.equal(state.calls.length, 1);
});

test('reused root PID is never terminated', async () => {
  const { state, backend } = fake();
  const owner = await OwnedProcessTree.create(root.pid, () => undefined, backend);
  state.processes = [{ ...root, started: '999' }];
  await owner.stop();
  assert.deepEqual(state.calls, []);
  assert.equal(owner.report.verifiedGone, true);
});

test('reused descendant PID belonging elsewhere is excluded from the kill list', async () => {
  const { state, backend } = fake();
  const owner = await OwnedProcessTree.create(root.pid, () => undefined, backend);
  const reused = { ...child, parentPid: 900, started: '999' };
  state.processes = [root, reused];
  state.afterKill = () => {
    state.processes = [reused];
  };
  await owner.stop();
  assert.deepEqual(state.calls, [[root]]);
  assert.equal(owner.report.verifiedGone, true);
});

test('snapshot query failure fails closed before any termination or deletion', async () => {
  const { state, backend } = fake();
  const owner = await OwnedProcessTree.create(root.pid, () => undefined, backend);
  state.failSnapshot = true;
  const removed: string[] = [];
  await assert.rejects(
    cleanupOwnedFixture(
      () => owner.stop(),
      async () => {
        removed.push('key');
      },
      async () => {
        removed.push('files');
      },
    ),
    /query failed/,
  );
  assert.deepEqual(state.calls, []);
  assert.deepEqual(removed, []);
});

test('failed verification after termination retains command diagnostics and blocks deletion', async () => {
  const { state, backend } = fake();
  const owner = await OwnedProcessTree.create(root.pid, () => undefined, backend);
  state.code = 1;
  state.afterKill = () => {
    state.failSnapshot = true;
  };
  const records: CleanupReport[] = [];
  await assert.rejects(
    stopOwnedProcesses([owner], async (report) => {
      records.push(report);
    }),
    /cleanup failed/,
  );
  assert.equal(records[0]?.verifiedGone, false);
  assert.equal(records[0]?.termination?.stderr, 'child already gone');
  assert.match(records[0]?.error ?? '', /query failed/);
});

test('new descendant observed after capture is a failure, not a broader second kill', async () => {
  const { state, backend } = fake();
  const owner = await OwnedProcessTree.create(root.pid, () => undefined, backend);
  const late = { pid: 103, parentPid: child.pid, started: '120', nativeVerified: true };
  state.afterKill = () => {
    state.processes = [late];
  };
  await assert.rejects(owner.stop(), /Ambiguous process ownership/);
  assert.equal(state.calls.length, 1);
  assert.deepEqual(state.calls[0], [root, child]);
  assert.deepEqual(owner.report.ambiguous, [late]);
});

test('missing parent cannot establish ownership after invisible PID reuse and exit', async () => {
  const { state, backend } = fake();
  const owner = await OwnedProcessTree.create(root.pid, () => undefined, backend);
  // The original root exited. A different process reused its PID, created this
  // child, then exited before the next snapshot: PPID alone is not ownership.
  const unrelated = { pid: 200, parentPid: root.pid, started: '999', nativeVerified: true };
  state.processes = [unrelated];
  await assert.rejects(owner.stop(), /Ambiguous process ownership/);
  assert.deepEqual(state.calls, []);
  assert.deepEqual(owner.report.ambiguous, [unrelated]);
});

test('present captured PID with unreadable identity cannot be declared gone', async () => {
  const { state, backend } = fake();
  const owner = await OwnedProcessTree.create(root.pid, () => undefined, backend);
  state.processes = [{ ...root, started: null }];
  await assert.rejects(owner.stop(), /Ambiguous process ownership/);
  assert.deepEqual(state.calls, []);
  assert.equal(owner.report.verifiedGone, false);
});

test('credential removal failure preserves the fixture after verified process exit', async () => {
  const { backend } = fake();
  const owner = await OwnedProcessTree.create(root.pid, () => undefined, backend);
  let filesRemoved = false;
  await assert.rejects(
    cleanupOwnedFixture(
      () => owner.stop(),
      async () => {
        throw new Error('vault unavailable');
      },
      async () => {
        filesRemoved = true;
      },
    ),
    /vault unavailable/,
  );
  assert.equal(owner.report.verifiedGone, true);
  assert.equal(filesRemoved, false);
});

test('evidence failure prevents deletion and never masks termination diagnostics', async () => {
  const { backend } = fake();
  const owner = await OwnedProcessTree.create(root.pid, () => undefined, backend);
  let keyRemoved = false;
  await assert.rejects(
    cleanupOwnedFixture(
      () =>
        stopOwnedProcesses([owner], async () => {
          throw new Error('attachment failed');
        }),
      async () => {
        keyRemoved = true;
      },
      async () => {},
    ),
    /cleanup failed/,
  );
  assert.equal(owner.report.verifiedGone, true);
  assert.equal(keyRemoved, false);
});

test(
  'Windows backend terminates only its real captured Node parent and child',
  {
    skip: process.platform !== 'win32',
    timeout: 30_000,
  },
  async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      windowsHide: true, stdio: 'ignore', env: process.env,
    });
    child.on('spawn', () => process.stdout.write(JSON.stringify({ pid: process.pid, childPid: child.pid }) + '\\n'));
    setInterval(() => {}, 1000);
  `,
      ],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: Object.fromEntries(
          Object.entries(process.env).filter(([name]) =>
            /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP)$/i.test(name),
          ),
        ),
      },
    );
    let owner: OwnedProcessTree | undefined;
    let eventLoopTicks = 0;
    const heartbeat = setInterval(() => eventLoopTicks++, 20);
    let readyTimeout: ReturnType<typeof setTimeout> | undefined;
    const ready = new Promise<{ pid: number; childPid: number }>((resolve, reject) => {
      readyTimeout = setTimeout(
        () => reject(new Error('Owned Node child did not become ready')),
        10_000,
      );
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
        if (!output.includes('\n')) return;
        clearTimeout(readyTimeout);
        try {
          resolve(JSON.parse(output.trim()));
        } catch (error) {
          reject(error);
        }
      });
      child.once('error', (error) => {
        clearTimeout(readyTimeout);
        reject(error);
      });
    });
    void ready.catch(() => {});
    try {
      if (!child.pid) throw new Error('Owned Node PID unavailable');
      const nativePid = child.pid;
      owner = await OwnedProcessTree.create(nativePid, () => {
        if (child.pid !== nativePid || child.exitCode !== null || child.signalCode !== null)
          throw new Error('Original test child exited during capture');
      });
      assert.ok(eventLoopTicks > 0, 'native capture must leave the Node event loop responsive');
      const identities = await ready;
      assert.equal(identities.pid, child.pid);
      await owner.refresh();
      assert.ok(owner.report.captured.some((item) => item.pid === identities.childPid));
      // Simulate stale CIM claiming an older birth for a currently live PID.
      // Real termination must reject the held handle's different native birth.
      const mismatch = await windowsBackend.terminate([
        { ...owner.report.root, started: (BigInt(owner.report.root.started) - 10n).toString() },
      ]);
      assert.equal(mismatch.exitCode, 1);
      assert.deepEqual(mismatch.pids, []);
      assert.deepEqual(mismatch.exited, []);
      assert.match(mismatch.stderr, /birth identity changed/);
      await owner.refresh();
      assert.ok(owner.report.survivors.some((item) => item.pid === identities.pid));
      console.log(JSON.stringify({ nativeBirthMismatchProof: mismatch }));
      await owner.stop();
      assert.equal(owner.report.verifiedGone, true);
      assert.deepEqual(owner.report.survivors, []);
      const killed = owner.report.termination?.pids;
      assert.ok(killed?.includes(identities.pid));
      assert.ok(killed?.includes(identities.childPid));
      assert.deepEqual(
        killed?.toSorted(),
        owner.report.captured.map((item) => item.pid).toSorted(),
      );
      // Windows may add console-host descendants. Every captured PID must still
      // have a complete parent chain to our exact launched root, never the runner.
      for (const item of owner.report.captured) {
        const seen = new Set<number>();
        let current = item;
        while (current.pid !== identities.pid) {
          assert.ok(!seen.has(current.pid));
          seen.add(current.pid);
          const parent = owner.report.captured.find(
            (candidate) => candidate.pid === current.parentPid,
          );
          assert.ok(parent);
          assert.ok(BigInt(current.started) >= BigInt(parent.started));
          current = parent;
        }
      }
      assert.ok(!owner.report.captured.some((item) => item.pid === process.pid));
    } finally {
      try {
        if (owner) await owner.stop();
      } finally {
        if (owner) console.log(JSON.stringify({ nativeOwnedProcessProof: owner.report }));
        clearTimeout(readyTimeout);
        clearInterval(heartbeat);
        // Identity failure never falls back to an unverified kill; detach only
        // this test's stdio so a failed proof cannot keep the test runner open.
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }
    }
  },
);
