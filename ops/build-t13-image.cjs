'use strict';

// Build a source-tagged local image for the dedicated T13 kind cluster.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = (process.env.T13_RUN_ID || '').trim();
const PATHS = ['Dockerfile', 'package.json', 'package-lock.json', 'server', 'public', 'scripts', 'ops'];
const REVISION_LABEL = 'org.opencontainers.image.revision';
const TREE_LABEL = 'org.opencontainers.image.source-tree-digest';
const RUN_LABEL = 'org.opencontainers.image.run-id';

function ignored(relativePath) {
  const parts = relativePath.split('/');
  const basename = parts.at(-1);
  if (parts.some(part => ['node_modules', '.git', 'data', 'coverage', 'playwright-report', 'test-results', 'evidence'].includes(part))) return true;
  if (basename === '.env' || (basename.startsWith('.env.') && basename !== '.env.example')) return true;
  return /\.(sqlite|db)(-|$)|\.log$/i.test(basename);
}

function walk(relativePath, output) {
  const absolutePath = path.join(ROOT, relativePath);
  const stat = fs.lstatSync(absolutePath);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(absolutePath).sort()) {
      const child = `${relativePath}/${name}`;
      if (!ignored(child)) walk(child, output);
    }
  } else if (stat.isFile() && !ignored(relativePath)) {
    output.push(relativePath.replaceAll('\\', '/'));
  }
}

function sourceTree() {
  const files = [];
  for (const item of PATHS) walk(item, files);
  const entries = [...new Set(files)].sort().map(relativePath => {
    const bytes = fs.readFileSync(path.join(ROOT, relativePath));
    return { path: relativePath, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  });
  const hash = crypto.createHash('sha256');
  for (const entry of entries) hash.update(`${entry.path}\0${entry.sha256}\n`);
  return { entries, digest: hash.digest('hex') };
}

function main() {
  assert.match(RUN_ID, /^[a-z0-9]([a-z0-9-]{0,33}[a-z0-9])?$/, 'Set a unique T13_RUN_ID of 1–35 lowercase letters, digits, or hyphens.');
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  assert.match(revision, /^[0-9a-f]{40}$/i, 'Could not resolve a full Git HEAD revision.');
  const imageRef = `attendance:t13-${revision.slice(0, 12)}-${RUN_ID}`;
  const { entries, digest } = sourceTree();
  const build = spawnSync('docker', [
    'build',
    '--label', `${REVISION_LABEL}=${revision}`,
    '--label', `${TREE_LABEL}=${digest}`,
    '--label', `${RUN_LABEL}=${RUN_ID}`,
    '--tag', imageRef,
    '.'
  ], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  if (build.error) throw build.error;
  if (build.status !== 0) process.exit(build.status || 1);

  const inspected = JSON.parse(execFileSync('docker', ['image', 'inspect', imageRef], { cwd: ROOT, encoding: 'utf8' }))[0];
  assert.equal(inspected.Config.Labels?.[REVISION_LABEL], revision);
  assert.equal(inspected.Config.Labels?.[TREE_LABEL], digest);
  assert.equal(inspected.Config.Labels?.[RUN_LABEL], RUN_ID);
  const user = String(inspected.Config.User || '').split(':')[0].toLowerCase();
  assert.ok(user && !['0', 'root'].includes(user), 'T13 image must be configured to run as a non-root user.');
  process.stdout.write(`${JSON.stringify({
    status: 'built',
    imageRef,
    imageId: inspected.Id,
    sourceRevision: revision,
    runId: RUN_ID,
    sourceTreeDigest: digest,
    sourceEntries: entries,
    configuredUser: inspected.Config.User,
    labels: inspected.Config.Labels
  }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`T13 image build failed: ${error.message}\n`);
  process.exitCode = 1;
}
