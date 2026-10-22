import { readFile, readdir } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import config from '../electron-builder.config.mjs';
assert.deepEqual(config.files, [
  'out/main/**',
  'out/preload/**',
  'out/renderer/**',
  'package.json',
]);
assert.equal(config.electronFuses.runAsNode, false);
assert.equal(config.electronFuses.enableNodeCliInspectArguments, false);
assert.equal(config.electronFuses.enableNodeOptionsEnvironmentVariable, false);
assert.equal(config.electronFuses.onlyLoadAppFromAsar, true);
const forbidden =
  /solline-scripted-qa-agent|Claude QA|Falha simulada: tenta de novo|QA: comando sem cenário|window\.qa/;
let checked = 0;
async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await scan(path);
    else if (/\.(js|css|html)$/.test(entry.name)) {
      const text = await readFile(path, 'utf8');
      assert(!forbidden.test(text), `QA marker in production: ${path}`);
      if (/\.(css|html)$/.test(entry.name))
        assert(!/(?:src=|url\()["']?https?:\/\//.test(text), `Remote resource: ${path}`);
      checked++;
    }
  }
}
for (const directory of ['out/main', 'out/preload', 'out/renderer']) await scan(directory);
assert(checked >= 4, 'Production build is incomplete');
console.log(
  `Production entries checked (${checked} files); QA excluded, fuses preserved, renderer resources local.`,
);

// Optional second gate inspects the actual packaged archive and executable, without launching it.
if (process.argv[2]) {
  const { listPackage, extractFile } = await import('@electron/asar');
  const { getCurrentFuseWire, FuseV1Options } = await import('@electron/fuses');
  const packaged = process.argv[2];
  const archive = join(packaged, 'resources/app.asar');
  const entries = listPackage(archive).map((entry) =>
    entry.replace(/^[/\\]+/, '').replaceAll('\\', '/'),
  );
  assert(entries.includes('out/main/index.js'));
  assert(entries.includes('out/renderer/index.html'));
  assert(
    entries.every((entry) => /^(?:out(?:\/|$)|node_modules(?:\/|$)|package\.json$)/.test(entry)),
    'Unexpected top-level packaged source',
  );
  assert(
    !entries.some((entry) => /^out\/(?:qa|qa-electron)(?:\/|$)/.test(entry)),
    'QA build packaged',
  );
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  let packagedFiles = 0;
  for (const entry of entries.filter((entry) => /^out\/.*\.(?:js|css|html|woff2)$/.test(entry))) {
    const bytes = extractFile(archive, normalize(entry));
    assert.equal(hash(bytes), hash(await readFile(entry)), `Packaged resource differs: ${entry}`);
    packagedFiles++;
  }
  const wire = await getCurrentFuseWire(join(packaged, 'Solline.exe'));
  for (const fuse of [
    FuseV1Options.RunAsNode,
    FuseV1Options.EnableNodeOptionsEnvironmentVariable,
    FuseV1Options.EnableNodeCliInspectArguments,
  ])
    assert.equal(wire[fuse], '0'.charCodeAt(0));
  for (const fuse of [
    FuseV1Options.EnableCookieEncryption,
    FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
    FuseV1Options.OnlyLoadAppFromAsar,
    FuseV1Options.GrantFileProtocolExtraPrivileges,
  ])
    assert.equal(wire[fuse], '1'.charCodeAt(0));
  console.log(
    `Actual ASAR: ${packagedFiles} resources match production byte-for-byte; executable fuses verified. Installation/DPI/login not claimed.`,
  );
}
