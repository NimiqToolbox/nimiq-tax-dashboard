// Vendors the browser build of the Nimiq web client (@nimiq/core on npm) into this static site.
// There is no build step, so the package's browser files are committed as-is:
//   web/                               -> nimiq-core/
//   launcher/browser/                  -> launcher/browser/
//   lib/index.d.ts, lib/web/index.mjs  -> lib/   (its ../../web/ imports rewritten to ../../nimiq-core/)
// The vendored version is pinned in package.json.
//
//   node scripts/update-nimiq-core.mjs           # update to the latest release on npm
//   node scripts/update-nimiq-core.mjs 2.22.0    # or to a specific version
//
// Needs node, npm and tar — e.g. docker run --rm -v "$PWD":/app -w /app node:22-alpine node scripts/update-nimiq-core.mjs

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = '@nimiq/core';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = (...args) => execFileSync('npm', args, { encoding: 'utf8' }).trim().split('\n').pop();

const manifestPath = join(ROOT, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const current = manifest.dependencies[PKG];
const target = process.argv[2] || npm('view', PKG, 'version'); // the `latest` dist-tag, never rc/next

if (target === current) {
  console.log(`${PKG} is up to date (${current}).`);
  process.exit(0);
}
console.log(`Updating ${PKG} ${current} -> ${target}`);

const tmp = mkdtempSync(join(tmpdir(), 'nimiq-core-'));
try {
  const tarball = npm('pack', `${PKG}@${target}`, '--pack-destination', tmp, '--silent');
  execFileSync('tar', ['-xzf', join(tmp, tarball), '-C', tmp]);
  const pkg = join(tmp, 'package');

  // Replace whole directories so files dropped upstream don't linger.
  for (const [from, to] of [['web', 'nimiq-core'], ['launcher/browser', 'launcher/browser']]) {
    rmSync(join(ROOT, to), { recursive: true, force: true });
    cpSync(join(pkg, from), join(ROOT, to), { recursive: true });
  }
  cpSync(join(pkg, 'lib/index.d.ts'), join(ROOT, 'lib/index.d.ts'));
  const libWeb = readFileSync(join(pkg, 'lib/web/index.mjs'), 'utf8').replaceAll('"../../web/', '"../../nimiq-core/');
  if (libWeb.includes('../../web/')) throw new Error('lib/web/index.mjs imports ../../web/ in a form this script does not rewrite');
  mkdirSync(join(ROOT, 'lib/web'), { recursive: true });
  writeFileSync(join(ROOT, 'lib/web/index.mjs'), libWeb);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// Fail loudly if the package layout changed: every relative import of the entry modules must resolve.
for (const file of ['nimiq-core/index.js', 'lib/web/index.mjs']) {
  const src = readFileSync(join(ROOT, file), 'utf8');
  for (const [, spec] of src.matchAll(/(?:from\s*|new URL\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
    if (!existsSync(resolve(ROOT, dirname(file), spec))) throw new Error(`${file}: import ${spec} does not exist`);
  }
}

manifest.dependencies[PKG] = target;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Vendored ${PKG} ${target}.`);
