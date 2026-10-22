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
for (const name of ['index', 'recovery', 'prompt', 'attention']) {
  const preload = await readFile(`out/preload/${name}.js`, 'utf8');
  assert(!/require\(["']\./.test(preload), `Sandbox preload depends on a local chunk: ${name}`);
  const html = await readFile(`out/renderer/${name}.html`, 'utf8');
  assert(html.includes('<html'), `Missing independent renderer: ${name}`);
}
const main = await readFile('out/main/index.js', 'utf8');
assert(
  !/\bshow(?:MessageBox|OpenDialog|SaveDialog|ErrorBox)(?:Sync)?\b/.test(main),
  'Native dialog in application',
);
assert(!/new\s+(?:\w+\.)?Notification\(/.test(main), 'Native notification in application');
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
  for (const name of ['recovery', 'prompt', 'attention']) {
    assert(entries.includes(`out/renderer/${name}.html`));
    assert(entries.includes(`out/preload/${name}.js`));
  }
  assert(
    entries.every((entry) => /^(?:out(?:\/|$)|node_modules(?:\/|$)|package\.json$)/.test(entry)),
    'Unexpected top-level packaged source',
  );
  assert(
    !entries.some((entry) => /^out\/(?:qa|qa-electron)(?:\/|$)/.test(entry)),
    'QA build packaged',
  );
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const nativeAgent = 'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe';
  assert(entries.includes(nativeAgent), 'Windows Claude executable missing from package');
  assert.equal(
    hash(await readFile(join(packaged, 'resources/app.asar.unpacked', nativeAgent))),
    hash(await readFile(join('../../', nativeAgent))),
    'Unpacked Windows Claude executable differs from the installed locked dependency',
  );
  for (const dependency of ['@anthropic-ai/claude-agent-sdk', 'zod']) {
    const manifest = `node_modules/${dependency}/package.json`;
    assert(entries.includes(manifest), `Runtime dependency missing: ${dependency}`);
    assert.equal(
      JSON.parse(extractFile(archive, normalize(manifest)).toString()).version,
      JSON.parse(await readFile(join('../../', manifest), 'utf8')).version,
      `Packaged runtime dependency version differs: ${dependency}`,
    );
  }
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
