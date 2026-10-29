'use strict';

// End-to-end T13 verification against an explicitly selected Kubernetes context,
// namespace, deployed app URL, and immutable runtime image identity.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const REQUIRED = [
  'T13_KUBECONFIG',
  'T13_CONTEXT',
  'T13_NAMESPACE',
  'T13_BASE_URL',
  'T13_ADMIN_USERNAME',
  'T13_ADMIN_PASSWORD',
  'T13_IMAGE_REF',
  'T13_RUN_ID'
];
const PERIODS = [1, 2, 3, 4, 5, 6, 7];
const FIXTURE_MARKS = [
  { roll: '01', name: 'Student One', statuses: ['P', 'A', 'P', 'P', 'A', 'P', 'U'] },
  { roll: '02', name: 'Student Two', statuses: ['A', 'A', 'P', 'P', 'P', 'U', 'U'] }
];
const IMAGE_REVISION_LABEL = 'org.opencontainers.image.revision';
const IMAGE_TREE_LABEL = 'org.opencontainers.image.source-tree-digest';
const IMAGE_BUILD_PATHS = ['Dockerfile', 'package.json', 'package-lock.json', 'server', 'public', 'scripts', 'ops'];
const IMAGE_RUNTIME_PATHS = ['package.json', 'package-lock.json', 'server', 'public', 'scripts', 'ops'];

function now() { return new Date().toISOString(); }
function jsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}
function appendJsonLine(file, value) {
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
}
function finishWritable(stream) {
  return stream.writableFinished ? Promise.resolve() : new Promise(resolve => stream.once('finish', resolve));
}
function dockerIgnored(relativePath) {
  const parts = relativePath.split('/');
  const basename = parts.at(-1);
  if (parts.some(part => ['node_modules', '.git', 'data', 'coverage', 'playwright-report', 'test-results', 'evidence'].includes(part))) return true;
  if (basename === '.env' || (basename.startsWith('.env.') && basename !== '.env.example')) return true;
  if (/\.(sqlite|db)(-|$)|\.log$/i.test(basename)) return true;
  return false;
}
function walkBuildPath(relativePath, output) {
  const absolutePath = path.join(ROOT, relativePath);
  const stat = fs.lstatSync(absolutePath);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(absolutePath).sort()) {
      const child = `${relativePath}/${name}`;
      if (!dockerIgnored(child)) walkBuildPath(child, output);
    }
  } else if (stat.isFile() && !dockerIgnored(relativePath)) output.push(relativePath.replaceAll('\\', '/'));
}
function payloadEntries(paths) {
  const files = [];
  for (const item of paths) walkBuildPath(item, files);
  return [...new Set(files)].sort().map(relativePath => {
    const bytes = fs.readFileSync(path.join(ROOT, relativePath));
    return { path: relativePath, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  });
}
function payloadDigest(entries) {
  const hash = crypto.createHash('sha256');
  for (const entry of entries) hash.update(`${entry.path}\0${entry.sha256}\n`);
  return hash.digest('hex');
}
function imageTag(imageRef) {
  const name = imageRef.split('@')[0];
  const slash = name.lastIndexOf('/');
  const colon = name.lastIndexOf(':');
  return colon > slash ? name.slice(colon + 1) : '';
}
function normalizeImageRef(imageRef) {
  // Kubernetes/containerd expands Docker Hub's implicit library namespace in
  // Pod status, while the Deployment may retain the short configured name.
  return imageRef.replace(/^docker\.io\/library\//, '');
}
function runtimeDigestScript() {
  const roots = JSON.stringify(IMAGE_RUNTIME_PATHS);
  return `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');const roots=${roots},files=[];function ignored(rel){const parts=rel.split('/'),base=parts[parts.length-1];return parts.some(p=>['node_modules','.git','data','coverage','playwright-report','test-results','evidence'].includes(p))||base==='.env'||(base.startsWith('.env.')&&base!=='.env.example')||/\\.(sqlite|db)(-|$)|\\.log$/i.test(base)}function walk(rel){const p=path.posix.join('/app',rel),st=fs.lstatSync(p);if(st.isDirectory()){for(const n of fs.readdirSync(p).sort()){const c=path.posix.join(rel,n);if(!ignored(c))walk(c)}}else if(st.isFile()&&!ignored(rel))files.push(rel)}for(const r of roots)walk(r);files.sort();const h=crypto.createHash('sha256');for(const rel of files){const b=fs.readFileSync(path.posix.join('/app',rel));h.update(rel+'\\0'+crypto.createHash('sha256').update(b).digest('hex')+'\\n')}process.stdout.write(h.digest('hex'));`;
}
function readConfig() {
  const missing = REQUIRED.filter(name => !process.env[name] || !process.env[name].trim());
  if (missing.length) throw new Error(`Missing required T13 environment inputs: ${missing.join(', ')}`);
  const context = process.env.T13_CONTEXT.trim();
  const namespace = process.env.T13_NAMESPACE.trim();
  const kubeconfig = process.env.T13_KUBECONFIG.trim();
  if (!path.isAbsolute(kubeconfig) || !fs.existsSync(kubeconfig) || !fs.statSync(kubeconfig).isFile()) {
    throw new Error('T13_KUBECONFIG must be an existing absolute kubeconfig file path.');
  }
  const username = process.env.T13_ADMIN_USERNAME;
  const password = process.env.T13_ADMIN_PASSWORD;
  const imageRef = process.env.T13_IMAGE_REF.trim();
  const runId = process.env.T13_RUN_ID.trim();
  if (!/^[a-z0-9]([a-z0-9-]{0,33}[a-z0-9])?$/.test(runId)) throw new Error('T13_RUN_ID must be 1–35 lowercase letters, digits, or hyphens and cannot start or end with a hyphen.');
  if (context !== 'kind-attendance-t13' || namespace !== 'attendance-t13') {
    throw new Error('T13_CONTEXT must be kind-attendance-t13 and T13_NAMESPACE must be attendance-t13.');
  }
  if (password.length < 12) throw new Error('T13_ADMIN_PASSWORD must contain at least 12 characters.');
  if (!/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(namespace) || namespace.length > 63) throw new Error('T13_NAMESPACE is not a valid Kubernetes namespace name.');
  const base = new URL(process.env.T13_BASE_URL);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || !base.port || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('T13_BASE_URL must use http://127.0.0.1:<port> with no credentials, path, query, or fragment.');
  }
  if (!imageRef || /\s/.test(imageRef)) throw new Error('T13_IMAGE_REF must be one exact image reference.');
  const tag = imageTag(imageRef);
  if (!tag || !tag.toLowerCase().includes(runId)) throw new Error('T13_IMAGE_REF must have a tag that includes the supplied T13_RUN_ID.');
  return { kubeconfig, context, namespace, baseUrl: base.origin, username, password, imageRef, runId };
}
function previousWeekday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  const day = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)));
  day.setUTCDate(day.getUTCDate() - 1);
  while (day.getUTCDay() === 0 || day.getUTCDay() === 6) day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}
function quoteArgs(args) {
  return args.map(value => {
    const s = String(value);
    return /^[A-Za-z0-9_./:=@+-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
  }).join(' ');
}

class EvidenceRunner {
  constructor(config) {
    this.config = config;
    this.runId = config.runId;
    this.evidenceRoot = path.resolve(process.env.T13_EVIDENCE_ROOT || path.join(ROOT, 'test-results', 't13'));
    this.runDir = path.join(this.evidenceRoot, this.runId);
    this.logsDir = path.join(this.runDir, 'logs');
    this.commandLog = path.join(this.runDir, 'commands.jsonl');
    this.commands = 0;
    this.apiRequests = [];
    this.startedAt = now();
    this.summary = {
      runId: this.runId,
      status: 'running',
      startedAt: this.startedAt,
      finishedAt: null,
      exitCode: null,
      reproductionCommand: 'npm run test:t13',
      context: config.context,
      namespace: config.namespace,
      applicationUrl: config.baseUrl,
      imageRef: config.imageRef,
      sourceRevision: null,
      workingTree: null,
      imageInspect: null,
      versions: {},
      apiRequests: this.apiRequests,
      assertions: [],
      artifacts: {}
    };
    this.kubectlPrefix = [`--kubeconfig=${config.kubeconfig}`];
    this.kubectlPrefix.push('--context', config.context, '--namespace', config.namespace);
  }

  start() {
    const runnerFiles = ['run.json', 'commands.jsonl', 'baseline.json', 'post-replacement.json', 'backup-metadata.json', 'restore-assertions.json', 'restore-pvc.yaml', 'restore-loader.yaml', 'restore-app.yaml', 'logs'];
    let preexistingEvidence = [];
    if (fs.existsSync(this.runDir)) {
      if (!process.env.T13_RUN_ID) throw new Error(`Evidence run directory already exists; refusing to overwrite it: ${this.runDir}`);
      preexistingEvidence = fs.readdirSync(this.runDir);
      const collisions = preexistingEvidence.filter(name => runnerFiles.includes(name));
      if (collisions.length) throw new Error(`Evidence run ID collides with existing runner artifacts: ${collisions.join(', ')}`);
    }
    fs.mkdirSync(this.logsDir, { recursive: true });
    fs.writeFileSync(this.commandLog, '', { mode: 0o600 });
    this.summary.artifacts = {
      run: path.join(this.runDir, 'run.json'),
      commands: this.commandLog,
      baseline: path.join(this.runDir, 'baseline.json'),
      replacement: path.join(this.runDir, 'post-replacement.json'),
      backupMetadata: path.join(this.runDir, 'backup-metadata.json'),
      restore: path.join(this.runDir, 'restore-assertions.json'),
      restorePvcManifest: path.join(this.runDir, 'restore-pvc.yaml'),
      restoreLoaderManifest: path.join(this.runDir, 'restore-loader.yaml'),
      restoreAppManifest: path.join(this.runDir, 'restore-app.yaml'),
      logs: this.logsDir,
      preexistingEvidence
    };
    this.writeSummary();
  }

  writeSummary() {
    this.summary.apiRequests = this.apiRequests;
    jsonFile(path.join(this.runDir, 'run.json'), this.summary);
  }

  recordAssertion(name, details = {}) {
    this.summary.assertions.push({ name, result: 'passed', at: now(), ...details });
    this.writeSummary();
  }

  async run(executable, args, options = {}) {
    const id = String(++this.commands).padStart(4, '0');
    const startedAt = now();
    const outLog = options.stdoutFile || (options.suppressStdoutLog ? null : path.join(this.logsDir, `${id}.stdout.txt`));
    const errLog = path.join(this.logsDir, `${id}.stderr.txt`);
    const record = {
      id,
      startedAt,
      command: `${executable} ${quoteArgs(args)}`,
      executable,
      argv: args,
      cwd: ROOT,
      stdout: outLog ? path.relative(this.runDir, outLog).replaceAll('\\', '/') : null,
      stderr: path.relative(this.runDir, errLog).replaceAll('\\', '/')
    };
    appendJsonLine(this.commandLog, record);
    const env = { ...process.env };
    delete env.T13_ADMIN_PASSWORD;
    delete env.T13_ADMIN_USERNAME;
    return await new Promise((resolve, reject) => {
      const child = spawn(executable, args, { cwd: ROOT, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const stdoutSink = outLog ? fs.createWriteStream(outLog, { mode: 0o600 }) : null;
      const stderrSink = fs.createWriteStream(errLog, { mode: 0o600 });
      const stdoutParts = [];
      const stderrParts = [];
      let stdoutSize = 0;
      let stderrSize = 0;
      let spawnError = null;
      if (options.inputFile) {
        const source = fs.createReadStream(options.inputFile);
        source.on('error', error => { spawnError = error; child.kill(); });
        source.pipe(child.stdin);
      } else child.stdin.end();
      child.stdout.on('data', chunk => {
        stdoutSize += chunk.length;
        if (!options.stdoutFile) {
          if (stdoutSize > (options.maxOutputBytes || 25 * 1024 * 1024)) {
            spawnError = new Error('Command output exceeded the 25 MiB evidence capture limit.');
            child.kill();
          } else stdoutParts.push(chunk);
        }
        stdoutSink?.write(chunk);
      });
      child.stderr.on('data', chunk => {
        stderrSize += chunk.length;
        if (stderrSize <= 5 * 1024 * 1024) stderrParts.push(chunk);
        stderrSink.write(chunk);
      });
      child.on('error', error => { spawnError = error; });
      child.on('close', async (code, signal) => {
        stdoutSink?.end();
        stderrSink.end();
        await Promise.all([stdoutSink ? finishWritable(stdoutSink) : Promise.resolve(), finishWritable(stderrSink)]);
        const result = {
          stdout: options.stdoutFile ? '' : Buffer.concat(stdoutParts).toString('utf8'),
          stderr: Buffer.concat(stderrParts).toString('utf8'),
          exitCode: code,
          signal,
          stdoutBytes: stdoutSize,
          stderrBytes: stderrSize
        };
        Object.assign(record, { finishedAt: now(), exitCode: code, signal, stdoutBytes: stdoutSize, stderrBytes: stderrSize });
        appendJsonLine(this.commandLog, { completedCommandId: id, finishedAt: record.finishedAt, exitCode: code, signal, stdoutBytes: stdoutSize, stderrBytes: stderrSize });
        this.writeSummary();
        if (spawnError) return reject(new Error(`${executable} command failed to start or stream: ${spawnError.message}`));
        if (code !== 0 && !options.allowFailure) {
          const detail = result.stderr.trim().split(/\r?\n/).slice(-4).join(' | ');
          return reject(new Error(`${executable} command exited ${code}${signal ? ` (${signal})` : ''}${detail ? `: ${detail}` : ''}`));
        }
        resolve(result);
      });
    });
  }

  async kubectl(args, options = {}) {
    return await this.run('kubectl', [...this.kubectlPrefix, ...args], options);
  }

  async git(args, options = {}) { return await this.run('git', args, options); }
  async docker(args, options = {}) { return await this.run('docker', args, options); }

  async getJson(resource, nameOrArgs = []) {
    const args = Array.isArray(nameOrArgs) ? nameOrArgs : [nameOrArgs];
    const result = await this.kubectl(['get', resource, ...args, '-o', 'json']);
    try { return JSON.parse(result.stdout); } catch { throw new Error(`Could not parse kubectl JSON for ${resource}.`); }
  }

  async checkVersionAndSource() {
    const nodeVersion = process.version;
    const npmVersion = (process.env.npm_config_user_agent || '').match(/(?:^|\s)npm\/([^\s]+)/)?.[1];
    if (!npmVersion) throw new Error('npm version was not provided by npm_config_user_agent; invoke with `npm run test:t13`.');
    const kubectlClient = await this.kubectl(['version', '--client', '-o', 'json']);
    const kubectlServer = await this.kubectl(['version', '-o', 'json']);
    const dockerVersion = await this.docker(['version', '--format', '{{json .}}']);
    const head = (await this.git(['rev-parse', 'HEAD'])).stdout.trim();
    if (!/^[0-9a-f]{40}$/i.test(head)) throw new Error('Could not read a full Git source revision.');
    const override = (process.env.T13_SOURCE_REVISION || '').trim();
    if (override && !(head.startsWith(override) || override.startsWith(head))) throw new Error('T13_SOURCE_REVISION does not match this checkout HEAD.');
    const workingTree = (await this.git(['status', '--porcelain=v1'])).stdout.trimEnd().split(/\r?\n/).filter(Boolean);
    assert.deepEqual(workingTree, [], `The working tree must be clean before a T13 run so the OCI revision label matches the built image; commit or stash first. Dirty entries: ${workingTree.join(', ')}`);
    const buildEntries = payloadEntries(IMAGE_BUILD_PATHS);
    const runtimeEntries = payloadEntries(IMAGE_RUNTIME_PATHS);
    const buildDigest = payloadDigest(buildEntries);
    const runtimeDigest = payloadDigest(runtimeEntries);
    const tag = imageTag(this.config.imageRef).toLowerCase();
    assert.ok(tag.includes(this.runId), 'T13_IMAGE_REF tag must include the supplied T13_RUN_ID.');
    if (!tag.includes(head.slice(0, 12).toLowerCase())) {
      throw new Error('T13_IMAGE_REF tag must include the first 12 characters of the checked-out source revision.');
    }
    const inspectRaw = await this.docker(['image', 'inspect', this.config.imageRef], { suppressStdoutLog: true });
    let inspected;
    try { inspected = JSON.parse(inspectRaw.stdout)[0]; } catch { throw new Error('docker image inspect did not return JSON for T13_IMAGE_REF.'); }
    if (!inspected?.Id || !inspected?.Config?.User) throw new Error('Image inspection is missing image ID or configured user metadata.');
    const imageUser = inspected.Config.User.split(':')[0].toLowerCase();
    assert.ok(!['0', 'root'].includes(imageUser), 'Locally inspected image is configured to run as root.');
    const labels = inspected.Config.Labels || {};
    assert.equal(labels[IMAGE_REVISION_LABEL], head, `Image label ${IMAGE_REVISION_LABEL} must equal the full checked-out Git HEAD.`);
    assert.equal(labels[IMAGE_TREE_LABEL], buildDigest, `Image label ${IMAGE_TREE_LABEL} does not match the deterministic Docker build-context digest.`);
    this.summary.sourceRevision = head;
    this.summary.workingTree = workingTree;
    this.summary.sourceTree = {
      algorithm: 'SHA-256 of sorted UTF-8 records: relative POSIX path, NUL byte, lowercase file SHA-256 hex, LF byte',
      buildPaths: IMAGE_BUILD_PATHS,
      runtimePaths: IMAGE_RUNTIME_PATHS,
      excludedByDockerIgnore: ['node_modules', '.git', '.env', '.env.* except .env.example', 'data', 'coverage', 'playwright-report', 'test-results', 'evidence', '*.sqlite*', '*.db*', '*.log'],
      buildDigest,
      runtimeDigest,
      buildEntries,
      runtimeEntries
    };
    this.summary.versions = {
      node: nodeVersion,
      npm: npmVersion,
      kubectlClient: JSON.parse(kubectlClient.stdout),
      kubernetesServer: JSON.parse(kubectlServer.stdout),
      docker: safeJsonParse(dockerVersion.stdout)
    };
    this.summary.imageInspect = {
      requestedRef: this.config.imageRef,
      imageId: inspected.Id,
      repoTags: inspected.RepoTags || [],
      repoDigests: inspected.RepoDigests || [],
      created: inspected.Created,
      os: inspected.Os,
      architecture: inspected.Architecture,
      configuredUser: inspected.Config.User,
      labels,
      entrypoint: inspected.Config.Entrypoint || [],
      cmd: inspected.Config.Cmd || []
    };
    this.recordAssertion('tool versions, Git revision, working-tree state, and local image inspect captured', {
      sourceRevision: head,
      dirtyPathCount: workingTree.length,
      localImageId: inspected.Id
    });
  }

  async preflightCluster() {
    const contexts = await this.kubectl(['config', 'get-contexts', '-o', 'name'], { suppressStdoutLog: true });
    const names = contexts.stdout.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    assert.deepEqual(names, [this.config.context], 'T13_KUBECONFIG must contain only the dedicated kind-attendance-t13 context.');
    const configResult = await this.kubectl(['config', 'view', '--minify', `--context=${this.config.context}`, '-o', 'json'], { suppressStdoutLog: true });
    let selectedConfig;
    try { selectedConfig = JSON.parse(configResult.stdout); } catch { throw new Error('Could not parse the selected context from the dedicated kubeconfig.'); }
    const selectedContext = selectedConfig.contexts?.[0];
    const selectedCluster = selectedConfig.clusters?.[0];
    assert.equal(selectedContext?.name, this.config.context, 'The minified kubeconfig context does not match T13_CONTEXT.');
    assert.equal(selectedContext?.context?.cluster, 'kind-attendance-t13', 'T13_CONTEXT must select the dedicated attendance-t13 kind cluster.');
    assert.equal(selectedCluster?.name, 'kind-attendance-t13', 'The kubeconfig cluster identity must be kind-attendance-t13.');
    const apiServer = new URL(selectedCluster?.cluster?.server || '');
    assert.equal(apiServer.protocol, 'https:', 'The kind API server must use HTTPS.');
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(apiServer.hostname), 'The selected cluster API server must be local to this machine.');
    const ready = await this.kubectl(['get', '--raw=/readyz']);
    assert.match(ready.stdout.trim(), /^ok$/i, 'Kubernetes API /readyz did not return ok.');
    const nodes = await this.getJson('nodes');
    const readyNodes = (nodes.items || []).filter(node => node.status?.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True'));
    assert.ok(nodes.items?.length > 0, 'The selected Kubernetes context has no nodes.');
    assert.ok(nodes.items.every(node => node.metadata.name.startsWith('attendance-t13-')), 'The selected cluster contains nodes outside the dedicated attendance-t13 kind cluster.');
    assert.equal(readyNodes.length, nodes.items.length, 'Every attendance-t13 kind node must be Ready.');
    const namespace = await this.getJson('namespace', this.config.namespace);
    assert.equal(namespace.metadata?.name, 'attendance-t13', 'The selected namespace is not the dedicated T13 namespace.');
    this.recordAssertion('selected Kubernetes context is present and cluster nodes are Ready', {
      context: this.config.context,
      kubeconfigContexts: names,
      clusterName: selectedCluster.name,
      apiServer: apiServer.origin,
      namespace: namespace.metadata.name,
      readyNodeNames: readyNodes.map(node => node.metadata.name)
    });
  }

  async ensureBaseUrlReachable() {
    const url = new URL(this.config.baseUrl);
    const forward = await this.startPortForward('service/attendance', Number(url.port), false);
    try { await this.waitForHealth(this.config.baseUrl); }
    catch (error) { await forward.stop(); throw error; }
    this.recordAssertion('application URL is served by a runner-owned port-forward to service/attendance', { applicationUrl: this.config.baseUrl, service: 'attendance' });
    return forward;
  }

  async waitForHealth(baseUrl) {
    await waitUntil(async () => {
      try {
        const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
        return response.ok && (await response.json()).ok === true;
      } catch { return false; }
    }, 30000, `Application health endpoint is unavailable at ${baseUrl} through its Kubernetes Service port-forward.`);
  }

  async startPortForward(resource, localPort, dynamic = true) {
    if (dynamic) localPort = await freePort();
    const args = [...this.kubectlPrefix, 'port-forward', '--address', '127.0.0.1', resource, `${localPort}:80`];
    const id = String(++this.commands).padStart(4, '0');
    const startedAt = now();
    const stdoutFile = path.join(this.logsDir, `${id}.stdout.txt`);
    const stderrFile = path.join(this.logsDir, `${id}.stderr.txt`);
    const record = {
      id, startedAt, command: `kubectl ${quoteArgs(args)}`, executable: 'kubectl', argv: args,
      cwd: ROOT,
      stdout: path.relative(this.runDir, stdoutFile).replaceAll('\\', '/'),
      stderr: path.relative(this.runDir, stderrFile).replaceAll('\\', '/')
    };
    appendJsonLine(this.commandLog, record);
    const env = { ...process.env };
    delete env.T13_ADMIN_PASSWORD;
    delete env.T13_ADMIN_USERNAME;
    const child = spawn('kubectl', args, { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = fs.createWriteStream(stdoutFile, { mode: 0o600 });
    const err = fs.createWriteStream(stderrFile, { mode: 0o600 });
    child.stdout.pipe(out);
    child.stderr.pipe(err);
    let output = '';
    child.stdout.on('data', chunk => { output = (output + chunk.toString('utf8')).slice(-4000); });
    let closed = null;
    const closePromise = new Promise(resolve => child.once('close', (code, signal) => { closed = { code, signal }; resolve(closed); }));
    child.once('error', error => { closed = { error }; });
    const handle = {
      localPort,
      stop: async () => {
        if (!closed) child.kill();
        await Promise.race([closePromise, delay(5000)]);
        if (!closed) {
          try { child.kill('SIGKILL'); } catch {}
          await Promise.race([closePromise, delay(2000)]);
        }
        out.end(); err.end();
        await Promise.all([finishWritable(out), finishWritable(err)]);
        const end = { completedCommandId: id, finishedAt: now(), exitCode: closed?.code ?? null, signal: closed?.signal || null, terminationRequested: true, stdoutBytes: fs.existsSync(stdoutFile) ? fs.statSync(stdoutFile).size : 0, stderrBytes: fs.existsSync(stderrFile) ? fs.statSync(stderrFile).size : 0 };
        appendJsonLine(this.commandLog, end);
        this.writeSummary();
      }
    };
    try {
      await waitUntil(async () => output.includes(`127.0.0.1:${localPort} ->`) || output.includes(`[::1]:${localPort} ->`) || closed, 10000, 'kubectl port-forward did not become ready.');
      if (closed) throw new Error(`kubectl port-forward exited before readiness${closed.code === undefined ? `: ${closed.error?.message}` : ` with code ${closed.code}`}.`);
    } catch (error) {
      await handle.stop();
      throw error;
    }
    return handle;
  }

  async login(baseUrl = this.config.baseUrl) {
    const requests = [];
    async function request(method, route, body, state) {
      const headers = {};
      if (state.cookie) headers.cookie = state.cookie;
      if (state.csrf) headers['X-CSRF-Token'] = state.csrf;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const started = Date.now();
      let response;
      try {
        response = await fetch(`${baseUrl}${route}`, {
          method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000)
        });
      } catch (error) {
        throw new Error(`Application request ${method} ${route} failed to connect: ${error.message}`);
      }
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) state.cookie = setCookie.split(';')[0];
      let data;
      if ((response.headers.get('content-type') || '').includes('text/csv')) data = await response.text();
      else {
        const text = await response.text();
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      }
      if (data && typeof data === 'object' && data.csrfToken) state.csrf = data.csrfToken;
      const entry = { method, route, status: response.status, durationMs: Date.now() - started, at: now() };
      requests.push(entry);
      this.apiRequests.push(entry);
      this.writeSummary();
      if (!response.ok) throw new Error(`Application request ${method} ${route} returned HTTP ${response.status}.`);
      return data;
    }
    const state = { cookie: '', csrf: '' };
    await request.call(this, 'GET', '/api/session', undefined, state);
    const result = await request.call(this, 'POST', '/api/login', { username: this.config.username, password: this.config.password }, state);
    assert.equal(result?.user?.role, 'admin', 'T13 credentials did not authenticate as an admin.');
    return {
      requests,
      request: (method, route, body) => request.call(this, method, route, body, state)
    };
  }

  async primaryDeployment() {
    const deployment = await this.getJson('deployment', 'attendance');
    assert.equal(deployment.spec.replicas, 1, 'Primary deployment must have exactly one replica.');
    assert.equal(deployment.spec.strategy?.type, 'Recreate', 'Primary deployment must use the Recreate strategy.');
    this.assertSecurityContext(deployment.spec.template.spec.securityContext, deployment.spec.template.spec.containers.find(item => item.name === 'attendance')?.securityContext, 'Primary Pod template');
    const container = deployment.spec.template.spec.containers.find(item => item.name === 'attendance');
    assert.ok(container, 'Primary attendance container was not found.');
    assert.equal(container.image, this.config.imageRef, 'Primary deployment image ref does not equal T13_IMAGE_REF.');
    assert.ok(container.envFrom?.some(item => item.configMapRef?.name === 'attendance-config'), 'Primary container must import the attendance-config ConfigMap.');
    assert.ok(!(container.env || []).some(item => item.name === 'DB_PATH'), 'Primary container must not override DB_PATH with a direct environment entry.');
    const mount = container.volumeMounts?.find(item => item.name === 'data' && item.mountPath === '/data');
    assert.ok(mount && mount.readOnly !== true, 'Primary container must mount writable /data.');
    const readiness = container.readinessProbe, liveness = container.livenessProbe;
    assert.equal(readiness?.httpGet?.path, '/health', 'Primary readiness probe must target /health.');
    assert.equal(readiness?.httpGet?.port, 'http', 'Primary readiness probe must use the http port.');
    assert.equal(liveness?.httpGet?.path, '/health', 'Primary liveness probe must target /health.');
    assert.equal(liveness?.httpGet?.port, 'http', 'Primary liveness probe must use the http port.');
    assert.ok(container.resources?.requests?.cpu && container.resources?.requests?.memory, 'Primary container must declare CPU and memory requests.');
    assert.ok(container.resources?.limits?.cpu && container.resources?.limits?.memory, 'Primary container must declare CPU and memory limits.');
    assert.equal(container.securityContext?.allowPrivilegeEscalation, false, 'Primary container must disable privilege escalation.');
    assert.deepEqual(container.securityContext?.capabilities?.drop, ['ALL'], 'Primary container must drop all capabilities.');
    this.recordAssertion('primary Deployment is one hardened Recreate replica with /health probes and resource limits', {
      replicas: deployment.spec.replicas,
      strategy: deployment.spec.strategy?.type,
      readinessProbe: readiness.httpGet,
      livenessProbe: liveness.httpGet,
      requests: container.resources.requests,
      limits: container.resources.limits,
      allowPrivilegeEscalation: container.securityContext.allowPrivilegeEscalation,
      capabilitiesDrop: container.securityContext.capabilities.drop
    });
    const volumes = deployment.spec.template.spec.volumes?.filter(v => v.persistentVolumeClaim) || [];
    assert.equal(volumes.length, 1, 'Primary Pod template must mount exactly one PVC.');
    assert.equal(volumes[0].persistentVolumeClaim.claimName, 'attendance-data', 'Primary Pod must mount attendance-data.');
    const configMap = await this.getJson('configmap', 'attendance-config');
    assert.equal(configMap.data?.DB_PATH, '/data/attendance.sqlite', 'DB_PATH must be /data/attendance.sqlite.');
    return { deployment, container, pvcVolume: volumes[0], configMap };
  }

  async primaryPod() {
    const selector = Object.entries(await this.primarySelector()).map(([key, value]) => `${key}=${value}`).join(',');
    const podList = await this.getJson('pods', ['-l', selector]);
    const pods = (podList.items || []).filter(pod => !pod.metadata.deletionTimestamp);
    assert.equal(pods.length, 1, `Expected exactly one non-terminating primary Pod, got ${pods.length}.`);
    const pod = pods[0];
    this.assertSecurityContext(pod.spec.securityContext, pod.spec.containers.find(item => item.name === 'attendance')?.securityContext, `Primary Pod ${pod.metadata.name}`);
    const ready = pod.status?.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True');
    assert.ok(ready, `Primary Pod ${pod.metadata.name} is not Ready.`);
    const status = pod.status?.containerStatuses?.find(item => item.name === 'attendance');
    assert.ok(status?.imageID, 'Primary Pod has no container imageID.');
    assert.equal(normalizeImageRef(status.image), normalizeImageRef(this.config.imageRef), 'Primary Pod reports a different container image ref.');
    return { pod, containerStatus: status };
  }

  async primarySelector() {
    const deployment = await this.getJson('deployment', 'attendance');
    return deployment.spec.selector.matchLabels;
  }

  async assertPodMount(pod, expectedClaim) {
    const volumes = (pod.spec.volumes || []).filter(volume => volume.persistentVolumeClaim);
    assert.equal(volumes.length, 1, `${pod.metadata.name} must mount exactly one PVC.`);
    assert.equal(volumes[0].persistentVolumeClaim.claimName, expectedClaim, `${pod.metadata.name} mounts unexpected PVC.`);
    const containerName = pod.spec.containers[0]?.name;
    const container = pod.spec.containers.find(item => item.name === containerName);
    const mount = container?.volumeMounts?.find(item => item.name === volumes[0].name && item.mountPath === '/data');
    assert.ok(mount && mount.readOnly !== true, `${pod.metadata.name} must have a writable /data mount.`);
  }

  assertSecurityContext(podContext, containerContext, label) {
    assert.equal(podContext?.runAsNonRoot, true, `${label} must set runAsNonRoot=true.`);
    assert.equal(podContext?.runAsUser, 1000, `${label} must run as UID 1000.`);
    assert.equal(podContext?.runAsGroup, 1000, `${label} must run as GID 1000.`);
    assert.equal(podContext?.fsGroup, 1000, `${label} must set fsGroup 1000 for the PVC.`);
    if (containerContext?.runAsNonRoot !== undefined) assert.equal(containerContext.runAsNonRoot, true, `${label} container must not override runAsNonRoot.`);
    if (containerContext?.runAsUser !== undefined) assert.equal(containerContext.runAsUser, 1000, `${label} container must not override runAsUser.`);
    if (containerContext?.runAsGroup !== undefined) assert.equal(containerContext.runAsGroup, 1000, `${label} container must not override runAsGroup.`);
    assert.equal(containerContext?.allowPrivilegeEscalation, false, `${label} container must disable privilege escalation.`);
    assert.notEqual(containerContext?.privileged, true, `${label} container must not run privileged.`);
    assert.ok(containerContext?.capabilities?.drop?.includes('ALL'), `${label} container must drop all capabilities.`);
  }

  async assertProcessIdentity(podName, container) {
    const script = 'process.stdout.write(JSON.stringify({uid:process.getuid(),gid:process.getgid()}))';
    const result = await this.kubectl(['exec', podName, '-c', container, '--', 'node', '-e', script]);
    let identity;
    try { identity = JSON.parse(result.stdout); } catch { throw new Error(`${podName}/${container} returned invalid process identity JSON.`); }
    assert.equal(identity.uid, 1000, `${podName}/${container} process must run as effective UID 1000.`);
    assert.equal(identity.gid, 1000, `${podName}/${container} process must run as effective GID 1000.`);
    this.recordAssertion('container process runs with effective non-root UID/GID 1000', { pod: podName, container, uid: identity.uid, gid: identity.gid });
    return identity;
  }

  async assertEffectiveDatabasePath(podName, container = 'attendance') {
    const result = await this.kubectl(['exec', podName, '-c', container, '--', 'node', '-e', 'process.stdout.write(process.env.DB_PATH || "")']);
    assert.equal(result.stdout.trim(), '/data/attendance.sqlite', `${podName}/${container} effective DB_PATH must be /data/attendance.sqlite.`);
    this.recordAssertion('running application process uses DB_PATH /data/attendance.sqlite', { pod: podName, container, databasePath: result.stdout.trim() });
  }

  async assertWritableDatabaseDirectory(podName, container = 'attendance') {
    const probe = `/data/.t13-write-${this.runId}`;
    const script = `const fs=require('node:fs');const p=${JSON.stringify(probe)};fs.writeFileSync(p,'t13-writable');fs.unlinkSync(p);`;
    await this.kubectl(['exec', podName, '-c', container, '--', 'node', '-e', script]);
    this.recordAssertion('application container can write and remove a probe under mounted /data', { pod: podName, path: '/data' });
  }

  async assertRuntimePayload(podName, container = 'attendance') {
    const nodeVersion = (await this.kubectl(['exec', podName, '-c', container, '--', 'node', '--version'])).stdout.trim();
    assert.equal(nodeVersion, 'v22.23.2', `${podName} is not running the pinned Node 22.23.2 runtime.`);
    const result = await this.kubectl(['exec', podName, '-c', container, '--', 'node', '-e', runtimeDigestScript()]);
    const digest = result.stdout.trim();
    assert.match(digest, /^[0-9a-f]{64}$/i, `${podName} did not report a valid runtime source digest.`);
    assert.equal(digest, this.summary.sourceTree.runtimeDigest, `${podName} runtime files do not match the checked-out source payload.`);
    this.recordAssertion('runtime version and files in Pod match the pinned runtime and checked-out source payload', { pod: podName, container, nodeVersion, runtimeDigest: digest });
    return digest;
  }

  async getBoundPvc(name) {
    const pvc = await this.getJson('pvc', name);
    assert.equal(pvc.status?.phase, 'Bound', `PVC ${name} is not Bound.`);
    assert.ok(pvc.metadata?.uid, `PVC ${name} has no UID.`);
    assert.ok(pvc.spec?.volumeName, `PVC ${name} has no bound PV name.`);
    return pvc;
  }

  async assertServiceTargetsPod(serviceName, pod) {
    const service = await this.getJson('service', serviceName);
    const endpoints = await this.getJson('endpoints', serviceName);
    const addresses = (endpoints.subsets || []).flatMap(subset => subset.addresses || []);
    assert.ok(addresses.some(address => address.targetRef?.uid === pod.metadata.uid), `${serviceName} has no ready endpoint for Pod ${pod.metadata.name}.`);
    return { service, endpoints };
  }

  async buildFixture(api) {
    const day = previousWeekday();
    const month = day.slice(0, 7);
    const className = `T13 ${this.runId}`;
    const classResult = await api.request('POST', '/api/classes', { name: className });
    assert.ok(Number.isSafeInteger(classResult.id) && classResult.id > 0, 'Class creation did not return a valid ID.');
    const suffix = this.runId.slice(-8).toUpperCase();
    const students = [];
    for (const fixture of FIXTURE_MARKS) {
      const roll = `T13-${suffix}-${fixture.roll}`;
      const studentName = `T13 ${this.runId} ${fixture.name}`;
      const created = await api.request('POST', '/api/students', {
        classId: classResult.id,
        roll,
        name: studentName,
        department: 'T13 synthetic verification',
        startDate: day,
        endDate: day
      });
      assert.ok(Number.isSafeInteger(created.id) && created.id > 0, 'Student creation did not return a valid ID.');
      students.push({ id: created.id, roll, name: studentName, statuses: fixture.statuses });
    }
    const calendar = await api.request('PUT', '/api/calendar', { date: day, periods: PERIODS });
    assert.equal(calendar?.ok, true, 'Could not set explicit P1–P7 calendar values.');
    const register = await api.request('GET', `/api/attendance?classId=${classResult.id}&date=${day}`);
    assert.deepEqual(register.periods, PERIODS, 'The deployed application did not return explicit periods P1–P7.');
    const entries = students.flatMap(student => student.statuses.map((status, index) => ({ studentId: student.id, period: index + 1, status })));
    const saved = await api.request('PUT', '/api/attendance', {
      classId: classResult.id,
      date: day,
      version: register.version,
      entries,
      reason: 'T13 synthetic baseline creation'
    });
    assert.equal(saved?.ok, true, 'Attendance submission failed.');
    const settings = await api.request('GET', '/api/settings');
    const threshold = Number(settings.threshold);
    assert.ok(Number.isFinite(threshold), 'Application attendance threshold is not numeric.');
    const expected = this.expectedBaseline({ classId: classResult.id, className, day, month, students, threshold });
    return expected;
  }

  expectedBaseline({ classId, className, day, month, students, threshold }) {
    const reports = students.map(student => {
      const working = student.statuses.length;
      const present = student.statuses.filter(status => status === 'P').length;
      const absent = student.statuses.filter(status => status === 'A').length;
      const unmarked = student.statuses.filter(status => status === 'U').length;
      const percentage = Math.round((present / working * 100 + Number.EPSILON) * 100) / 100;
      const complete = unmarked === 0;
      return {
        id: student.id,
        roll: student.roll,
        name: student.name,
        working,
        present,
        absent,
        unmarked,
        percentage,
        complete,
        low: working > 0 && complete && present / working * 100 < threshold
      };
    });
    const totals = reports.reduce((sum, row) => {
      for (const key of ['working', 'present', 'absent', 'unmarked']) sum[key] += row[key];
      return sum;
    }, { working: 0, present: 0, absent: 0, unmarked: 0 });
    totals.percentage = Math.round((totals.present / totals.working * 100 + Number.EPSILON) * 100) / 100;
    const header = ['id', 'roll', 'name', 'working', 'present', 'absent', 'unmarked', 'percentage', 'complete', 'low'];
    const csvRows = [header, ...reports.map(report => header.map(key => key === 'percentage' ? report[key].toFixed(2) : String(report[key])))];
    return {
      capturedAt: now(),
      runId: this.runId,
      dataset: {
        classId,
        className,
        date: day,
        month,
        periods: PERIODS,
        studentCount: students.length,
        students: students.map(student => ({
          id: student.id,
          roll: student.roll,
          name: student.name,
          department: 'T13 synthetic verification',
          startDate: day,
          endDate: day,
          periods: Object.fromEntries(student.statuses.map((status, index) => [`P${index + 1}`, status]))
        }))
      },
      independentlyCalculated: {
        threshold,
        reports,
        totals,
        csv: { class: csvRows, individuals: Object.fromEntries(reports.map(row => [String(row.id), [header, csvRows.find(csvRow => csvRow[0] === String(row.id))]])) }
      },
      actual: null
    };
  }

  async captureAndAssert(api, baseline, label) {
    const classId = baseline.dataset.classId;
    const day = baseline.dataset.date;
    const month = baseline.dataset.month;
    const expected = baseline.independentlyCalculated;
    const studentsResponse = await api.request('GET', `/api/students?classId=${classId}`);
    const studentRows = studentsResponse.students || [];
    assert.equal(studentRows.length, baseline.dataset.studentCount, `${label}: student count differs from baseline.`);
    const studentIds = studentRows.map(student => student.id).sort((a, b) => a - b);
    assert.deepEqual(studentIds, baseline.dataset.students.map(student => student.id).sort((a, b) => a - b), `${label}: student IDs differ from baseline.`);
    const daily = await api.request('GET', `/api/attendance?classId=${classId}&date=${day}`);
    assert.deepEqual(daily.periods, PERIODS, `${label}: P1–P7 calendar differs.`);
    const statusesByStudent = new Map(daily.students.map(student => [student.id, student.statuses]));
    for (const student of baseline.dataset.students) {
      const statuses = statusesByStudent.get(student.id);
      assert.ok(statuses, `${label}: missing attendance for student ${student.id}.`);
      assert.deepEqual(PERIODS.map(period => statuses[String(period)]), PERIODS.map(period => student.periods[`P${period}`]), `${label}: P1–P7 values differ for ${student.id}.`);
    }
    const report = await api.request('GET', `/api/reports?classId=${classId}&month=${month}`);
    assert.equal(report.month, month, `${label}: report month differs.`);
    assert.equal(report.threshold, expected.threshold, `${label}: attendance threshold differs.`);
    assert.equal(report.students.length, baseline.dataset.studentCount, `${label}: class report student count differs.`);
    const reportById = new Map(report.students.map(row => [row.id, row]));
    const individualReports = {};
    for (const expectedRow of expected.reports) {
      assert.deepEqual(reportById.get(expectedRow.id), expectedRow, `${label}: independent class report values differ for student ${expectedRow.id}.`);
      const individual = await api.request('GET', `/api/reports?classId=${classId}&month=${month}&studentId=${expectedRow.id}`);
      assert.equal(individual.month, month, `${label}: individual report month differs.`);
      assert.equal(individual.threshold, expected.threshold, `${label}: individual report threshold differs.`);
      assert.deepEqual(individual.students, [expectedRow], `${label}: individual report does not agree with independently calculated class row ${expectedRow.id}.`);
      individualReports[String(expectedRow.id)] = individual.students;
    }
    const classCsvText = await api.request('GET', `/api/reports.csv?classId=${classId}&month=${month}`);
    const classCsv = parseCsv(classCsvText);
    assert.deepEqual(classCsv, expected.csv.class, `${label}: parsed class CSV differs from independently calculated values.`);
    const individualCsv = {};
    const individualCsvSha256 = {};
    for (const row of expected.reports) {
      const text = await api.request('GET', `/api/reports.csv?classId=${classId}&month=${month}&studentId=${row.id}`);
      const parsed = parseCsv(text);
      assert.deepEqual(parsed, expected.csv.individuals[String(row.id)], `${label}: parsed individual CSV differs for student ${row.id}.`);
      individualCsv[String(row.id)] = parsed;
      individualCsvSha256[String(row.id)] = sha256Text(text);
    }
    // Totals are summed from the rows the application returned, not copied from
    // the independent fixture. Each observed row is already asserted against the
    // independently calculated values above, and the post-replacement comparison
    // then checks observation against observation.
    const observedTotals = report.students.reduce((sum, row) => {
      for (const key of ['working', 'present', 'absent', 'unmarked']) sum[key] += row[key];
      return sum;
    }, { working: 0, present: 0, absent: 0, unmarked: 0 });
    observedTotals.percentage = observedTotals.working
      ? Math.round((observedTotals.present / observedTotals.working * 100 + Number.EPSILON) * 100) / 100
      : null;
    assert.deepEqual(observedTotals, expected.totals, `${label}: observed totals differ from the independently calculated totals.`);
    const observed = {
      studentCount: studentRows.length,
      students: studentRows.map(student => ({
        id: student.id,
        roll: student.roll,
        name: student.name,
        department: student.department,
        startDate: student.startDate,
        endDate: student.endDate
      })).sort((a, b) => a.id - b.id),
      attendance: {
        classId,
        date: day,
        periods: daily.periods,
        students: daily.students.map(student => ({ id: student.id, roll: student.roll, name: student.name, statuses: PERIODS.map(period => student.statuses[String(period)]) })).sort((a, b) => a.id - b.id)
      },
      report: { month, threshold: report.threshold, students: report.students },
      individualReports,
      totals: observedTotals,
      csv: { class: classCsv, individuals: individualCsv },
      csvSha256: { class: sha256Text(classCsvText), individuals: individualCsvSha256 }
    };
    return observed;
  }

  async replacePrimaryPod(before, pvcBefore) {
    const oldName = before.pod.metadata.name;
    const oldUid = before.pod.metadata.uid;
    const scaleZero = await this.kubectl(['scale', 'deployment/attendance', '--replicas=0']);
    assert.match(scaleZero.stdout, /scaled/i, 'Deployment did not acknowledge scale to zero.');
    this.primaryScaledToZero = true;
    await waitUntil(async () => {
      const list = await this.getJson('pods', ['-l', 'app=attendance']);
      return (list.items || []).every(pod => pod.metadata.uid !== oldUid);
    }, 180000, 'Original attendance Pod did not terminate after scale-to-zero.');
    const gone = await this.kubectl(['get', `pod/${oldName}`, '-o', 'name', '--ignore-not-found']);
    assert.equal(gone.stdout.trim(), '', 'Original attendance Pod still exists after scale-to-zero.');
    this.recordAssertion('original application Pod terminated before scale-to-one', { originalPod: oldName, originalUid: oldUid });
    await this.kubectl(['scale', 'deployment/attendance', '--replicas=1']);
    await this.kubectl(['rollout', 'status', 'deployment/attendance', '--timeout=180s']);
    this.primaryScaledToZero = false;
    const after = await this.primaryPod();
    assert.notEqual(after.pod.metadata.uid, oldUid, 'Replacement Pod has the same UID as the original.');
    assert.equal(normalizeImageRef(after.containerStatus.image), normalizeImageRef(this.config.imageRef), 'Replacement Pod image ref changed.');
    assert.equal(after.containerStatus.imageID, before.containerStatus.imageID, 'Replacement Pod immutable imageID changed.');
    await this.assertPodMount(after.pod, 'attendance-data');
    await this.assertProcessIdentity(after.pod.metadata.name, 'attendance');
    await this.assertEffectiveDatabasePath(after.pod.metadata.name);
    await this.assertRuntimePayload(after.pod.metadata.name);
    const pvcAfter = await this.getBoundPvc('attendance-data');
    assert.equal(pvcAfter.metadata.uid, pvcBefore.metadata.uid, 'Primary PVC UID changed during Pod replacement.');
    assert.equal(pvcAfter.spec.volumeName, pvcBefore.spec.volumeName, 'Primary PVC PV binding changed during Pod replacement.');
    await this.assertWritableDatabaseDirectory(after.pod.metadata.name);
    const endpoints = await this.assertServiceTargetsPod('attendance', after.pod);
    this.recordAssertion('Pod replacement retained image, PVC UID/PV, writable database mount, and service endpoint', {
      originalPod: oldName,
      originalPodUid: oldUid,
      replacementPod: after.pod.metadata.name,
      replacementPodUid: after.pod.metadata.uid,
      imageRef: after.containerStatus.image,
      imageID: after.containerStatus.imageID,
      pvcUid: pvcAfter.metadata.uid,
      pv: pvcAfter.spec.volumeName,
      endpointPodUid: endpoints.endpoints.subsets?.flatMap(s => s.addresses || []).find(a => a.targetRef?.uid === after.pod.metadata.uid)?.targetRef.uid
    });
    return { after, pvcAfter };
  }

  restoreManifests(baseName, storage) {
    const pvcName = `${baseName}-data`;
    const loaderName = `${baseName}-loader`;
    const labels = { 'app.kubernetes.io/managed-by': 't13-test', 't13-run-id': this.runId };
    const requestedStorage = storage?.resources?.requests?.storage;
    assert.ok(requestedStorage, 'Primary PVC has no requested storage size to use for the isolated restore PVC.');
    const pvc = {
      apiVersion: 'v1', kind: 'PersistentVolumeClaim',
      metadata: { name: pvcName, namespace: this.config.namespace, labels },
      spec: {
        accessModes: storage.accessModes || ['ReadWriteOnce'],
        ...(storage.storageClassName !== undefined ? { storageClassName: storage.storageClassName } : {}),
        resources: { requests: { storage: requestedStorage } }
      }
    };
    const loader = {
      apiVersion: 'v1', kind: 'Pod',
      metadata: { name: loaderName, namespace: this.config.namespace, labels: { ...labels, 't13-role': 'restore-loader' } },
      spec: {
        restartPolicy: 'Never',
        securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
        containers: [{
          name: 'restore-loader', image: this.config.imageRef, imagePullPolicy: 'IfNotPresent',
          command: ['node', '-e', 'setInterval(() => {}, 3600000)'],
          volumeMounts: [{ name: 'data', mountPath: '/data' }],
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } }
        }],
        volumes: [{ name: 'data', persistentVolumeClaim: { claimName: pvcName } }]
      }
    };
    const selector = { 'app.kubernetes.io/name': baseName, 't13-run-id': this.runId };
    const deployment = {
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: baseName, namespace: this.config.namespace, labels },
      spec: {
        replicas: 1,
        strategy: { type: 'Recreate' },
        selector: { matchLabels: selector },
        template: {
          metadata: { labels: { ...selector, ...labels } },
          spec: {
            securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
            containers: [{
              name: 'attendance', image: this.config.imageRef, imagePullPolicy: 'IfNotPresent',
              envFrom: [{ configMapRef: { name: 'attendance-config' } }],
              ports: [{ containerPort: 3000, name: 'http' }],
              volumeMounts: [{ name: 'data', mountPath: '/data' }],
              readinessProbe: { httpGet: { path: '/health', port: 'http' }, initialDelaySeconds: 2, periodSeconds: 5 },
              livenessProbe: { httpGet: { path: '/health', port: 'http' }, initialDelaySeconds: 10, periodSeconds: 15 },
              resources: this.primaryResources,
              securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } }
            }],
            volumes: [{ name: 'data', persistentVolumeClaim: { claimName: pvcName } }]
          }
        }
      }
    };
    const service = {
      apiVersion: 'v1', kind: 'Service',
      metadata: { name: baseName, namespace: this.config.namespace, labels },
      spec: {
        selector,
        ports: [{ name: 'http', port: 80, targetPort: 'http' }],
        type: 'ClusterIP'
      }
    };
    return { pvc, loader, deployment, service, pvcName, loaderName };
  }

  async assertNoCollision(resources) {
    for (const [kind, name] of resources) {
      const result = await this.kubectl(['get', `${kind}/${name}`, '-o', 'name', '--ignore-not-found']);
      assert.equal(result.stdout.trim(), '', `Refusing to reuse existing run resource ${kind}/${name}.`);
    }
  }

  async createIsolatedRestore(baseline, primaryDeployment, primaryRuntime, sourcePvc, backupFile, backupMetadata) {
    this.primaryResources = primaryDeployment.container.resources;
    const restoreName = `t13-restore-${this.runId}`;
    const resources = this.restoreManifests(restoreName, sourcePvc.spec);
    const allResources = [
      ['pvc', resources.pvcName], ['pod', resources.loaderName],
      ['deployment', restoreName], ['service', restoreName]
    ];
    await this.assertNoCollision(allResources);
    jsonFile(path.join(this.runDir, 'restore-pvc.yaml'), resources.pvc);
    jsonFile(path.join(this.runDir, 'restore-loader.yaml'), resources.loader);
    jsonFile(path.join(this.runDir, 'restore-app.yaml'), { apiVersion: 'v1', kind: 'List', items: [resources.deployment, resources.service] });
    await this.kubectl(['apply', '-f', path.join(this.runDir, 'restore-pvc.yaml')]);
    // The local-path provisioner uses WaitForFirstConsumer. Create the loader
    // before waiting for Bound so scheduling can select the node and provision
    // the independent volume.
    await this.kubectl(['apply', '-f', path.join(this.runDir, 'restore-loader.yaml')]);
    await this.kubectl(['wait', '--for=condition=Ready', `pod/${resources.loaderName}`, '--timeout=180s']);
    const restorePvc = await waitForJson(async () => {
      const pvc = await this.getJson('pvc', resources.pvcName);
      if (pvc.status?.phase !== 'Bound') return null;
      return pvc;
    }, 180000, `Restore PVC ${resources.pvcName} did not bind.`);
    assert.notEqual(restorePvc.metadata.uid, sourcePvc.metadata.uid, 'Restore PVC UID must differ from primary PVC.');
    assert.notEqual(restorePvc.spec.volumeName, sourcePvc.spec.volumeName, 'Restore PVC must bind a different PV than primary.');
    const loaderPod = await this.getJson('pod', resources.loaderName);
    await this.assertPodMount(loaderPod, resources.pvcName);
    this.assertSecurityContext(loaderPod.spec.securityContext, loaderPod.spec.containers.find(item => item.name === 'restore-loader')?.securityContext, 'Restore loader Pod');
    await this.assertProcessIdentity(loaderPod.metadata.name, 'restore-loader');
    assert.ok(!(loaderPod.spec.volumes || []).some(volume => volume.persistentVolumeClaim?.claimName === 'attendance-data'), 'Restore loader mounted primary PVC.');
    const loaderStatus = loaderPod.status?.containerStatuses?.find(item => item.name === 'restore-loader');
    assert.equal(normalizeImageRef(loaderStatus?.image || ''), normalizeImageRef(this.config.imageRef), 'Restore loader image ref differs from primary.');
    assert.equal(loaderStatus?.imageID, primaryRuntime.containerStatus.imageID, 'Restore loader immutable imageID differs from primary.');
    const loaderRuntimeDigest = await this.assertRuntimePayload(loaderPod.metadata.name, 'restore-loader');
    const loadScript = "const fs=require('node:fs');const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>fs.writeFileSync('/data/attendance.sqlite',Buffer.concat(chunks),{mode:0o600}));";
    await this.kubectl(['exec', '-i', resources.loaderName, '-c', 'restore-loader', '--', 'node', '-e', loadScript], { inputFile: backupFile });
    const checksumScript = "const fs=require('node:fs'),c=require('node:crypto');process.stdout.write(c.createHash('sha256').update(fs.readFileSync('/data/attendance.sqlite')).digest('hex'));";
    const copiedHash = (await this.kubectl(['exec', resources.loaderName, '-c', 'restore-loader', '--', 'node', '-e', checksumScript])).stdout.trim();
    assert.equal(copiedHash, backupMetadata.sha256, 'Backup bytes copied to restore PVC differ from the exported backup checksum.');
    await this.kubectl(['delete', `pod/${resources.loaderName}`, '--wait=true', '--timeout=120s']);
    await this.kubectl(['apply', '-f', path.join(this.runDir, 'restore-app.yaml')]);
    await this.kubectl(['rollout', 'status', `deployment/${restoreName}`, '--timeout=180s']);
    const restorePodList = await this.getJson('pods', ['-l', `app.kubernetes.io/name=${restoreName},t13-run-id=${this.runId}`]);
    const restorePods = (restorePodList.items || []).filter(pod => !pod.metadata.deletionTimestamp);
    assert.equal(restorePods.length, 1, 'Expected exactly one restore application Pod.');
    const restorePod = restorePods[0];
    const status = restorePod.status?.containerStatuses?.find(item => item.name === 'attendance');
    assert.ok(status?.ready, 'Restore application container is not Ready.');
    assert.equal(normalizeImageRef(status.image), normalizeImageRef(this.config.imageRef), 'Restore Pod image ref differs from primary.');
    assert.equal(status.imageID, primaryRuntime.containerStatus.imageID, 'Restore Pod immutable imageID differs from primary.');
    await this.assertPodMount(restorePod, resources.pvcName);
    this.assertSecurityContext(restorePod.spec.securityContext, restorePod.spec.containers.find(item => item.name === 'attendance')?.securityContext, 'Restore application Pod');
    await this.assertProcessIdentity(restorePod.metadata.name, 'attendance');
    await this.assertEffectiveDatabasePath(restorePod.metadata.name);
    assert.ok(!(restorePod.spec.volumes || []).some(volume => volume.persistentVolumeClaim?.claimName === 'attendance-data'), 'Restore Pod mounted primary PVC.');
    const restoreRuntimeDigest = await this.assertRuntimePayload(restorePod.metadata.name);
    await this.assertWritableDatabaseDirectory(restorePod.metadata.name);
    const endpoints = await this.assertServiceTargetsPod(restoreName, restorePod);
    let restoreForward = null;
    let observed;
    try {
      restoreForward = await this.startPortForward(`service/${restoreName}`, 0, true);
      const baseUrl = `http://127.0.0.1:${restoreForward.localPort}`;
      const api = await this.loginAt(baseUrl);
      observed = await this.captureAndAssert(api, baseline, 'isolated restore');
    } finally {
      if (restoreForward) await restoreForward.stop();
    }
    const persistedRun = {
      completedAt: now(),
      instance: restoreName,
      service: restoreName,
      pod: restorePod.metadata.name,
      podUid: restorePod.metadata.uid,
      imageRef: status.image,
      imageID: status.imageID,
      loaderPod: loaderPod.metadata.name,
      loaderPodUid: loaderPod.metadata.uid,
      loaderImageRef: loaderStatus.image,
      loaderImageID: loaderStatus.imageID,
      loaderRuntimeDigest,
      restoreRuntimeDigest,
      pvc: resources.pvcName,
      pvcUid: restorePvc.metadata.uid,
      pv: restorePvc.spec.volumeName,
      sourcePvcUid: sourcePvc.metadata.uid,
      sourcePv: sourcePvc.spec.volumeName,
      sourceMountPresent: false,
      restoreMountsOnlyRestorePvc: true,
      backupSha256: backupMetadata.sha256,
      backupImageIdentity: backupMetadata.imageID,
      reportAndCsvAssertions: observed
    };
    jsonFile(path.join(this.runDir, 'restore-assertions.json'), persistedRun);
    this.recordAssertion('separate-PVC restored app matches independent student, attendance, report, and parsed CSV baseline', {
      restorePod: restorePod.metadata.name,
      restorePodUid: restorePod.metadata.uid,
      restorePvcUid: restorePvc.metadata.uid,
      restorePv: restorePvc.spec.volumeName,
      backupSha256: backupMetadata.sha256
    });
    return { restoreName, restorePod, restorePvc, endpoints, observed };
  }

  async loginAt(baseUrl) {
    return this.login(baseUrl);
  }

  async onlineBackup(sourcePod, baseline) {
    const remotePath = `/tmp/t13-${this.runId}.sqlite`;
    const copyOutPath = path.join(os.tmpdir(), `attendance-t13-${this.runId}.sqlite`);
    if (fs.existsSync(copyOutPath)) throw new Error('Refusing to overwrite an existing temporary online backup file.');
    this.backupTemporaryFile = copyOutPath;
    const backupStartedAt = now();
    let remoteCreated = false;
    try {
      await this.kubectl(['exec', sourcePod.metadata.name, '-c', 'attendance', '--', 'node', 'ops/sqlite-copy.cjs', '/data/attendance.sqlite', remotePath]);
      remoteCreated = true;
      const nodeRead = `require('node:fs').createReadStream(${JSON.stringify(remotePath)}).pipe(process.stdout)`;
      await this.kubectl(['exec', sourcePod.metadata.name, '-c', 'attendance', '--', 'node', '-e', nodeRead], { stdoutFile: copyOutPath });
    } finally {
      if (remoteCreated) {
        const removeRemote = `const fs=require('node:fs');if(fs.existsSync(${JSON.stringify(remotePath)}))fs.unlinkSync(${JSON.stringify(remotePath)})`;
        await this.kubectl(['exec', sourcePod.metadata.name, '-c', 'attendance', '--', 'node', '-e', removeRemote], { allowFailure: true }).catch(() => {});
      }
    }
    const backupCompletedAt = now();
    const stat = fs.statSync(copyOutPath);
    assert.ok(stat.size > 0, 'Exported online backup is empty.');
    const sha256 = await fileSha256(copyOutPath);
    const sqlite = inspectSqlite(copyOutPath);
    assert.equal(sqlite.integrityCheck, 'ok', 'Exported backup failed local SQLite integrity_check.');
    assert.ok(sqlite.schemaVersions.length > 0, 'Backup has no schema version migration rows.');
    const metadata = {
      backupStartedAt,
      backupCompletedAt,
      exportedAt: now(),
      sourcePod: sourcePod.metadata.name,
      sourcePodUid: sourcePod.metadata.uid,
      sourceDatabasePath: '/data/attendance.sqlite',
      destination: 'temporary host file outside the original PVC; removed after isolated restore verification',
      destinationOutsideOriginalPvc: true,
      bytes: stat.size,
      sha256,
      integrityCheck: sqlite.integrityCheck,
      schemaVersions: sqlite.schemaVersions,
      highestSchemaVersion: Math.max(...sqlite.schemaVersions),
      sourceRevision: this.summary.sourceRevision,
      imageRef: this.config.imageRef,
      imageID: sourcePod.status.containerStatuses.find(item => item.name === 'attendance').imageID,
      datasetClassId: baseline.dataset.classId,
      datasetStudentIds: baseline.dataset.students.map(student => student.id)
    };
    jsonFile(path.join(this.runDir, 'backup-metadata.json'), metadata);
    this.recordAssertion('online SQLite backup exported outside original PVC with checksum, integrity, schema, source revision, and image identity', {
      bytes: metadata.bytes,
      sha256,
      schemaVersions: metadata.schemaVersions,
      imageID: metadata.imageID
    });
    return { file: copyOutPath, metadata };
  }

  async execute() {
    this.start();
    let primaryForward = null;
    try {
      await this.checkVersionAndSource();
      await this.preflightCluster();
      primaryForward = await this.ensureBaseUrlReachable();
      const primary = await this.primaryDeployment();
      const before = await this.primaryPod();
      await this.assertPodMount(before.pod, 'attendance-data');
      await this.assertProcessIdentity(before.pod.metadata.name, 'attendance');
      await this.assertEffectiveDatabasePath(before.pod.metadata.name);
      await this.assertRuntimePayload(before.pod.metadata.name);
      const pvcBefore = await this.getBoundPvc('attendance-data');
      const storageClassName = pvcBefore.spec.storageClassName;
      assert.ok(storageClassName, 'Primary PVC must use an explicit working StorageClass.');
      const storageClass = await this.getJson('storageclass', storageClassName);
      assert.ok(storageClass.provisioner, `StorageClass ${storageClassName} has no provisioner.`);
      this.recordAssertion('primary PVC is Bound through a named StorageClass provisioner', {
        pvc: 'attendance-data',
        pvcUid: pvcBefore.metadata.uid,
        pv: pvcBefore.spec.volumeName,
        storageClass: storageClassName,
        provisioner: storageClass.provisioner
      });
      assert.equal(primary.pvcVolume.persistentVolumeClaim.claimName, 'attendance-data');
      const endpointBefore = await this.assertServiceTargetsPod('attendance', before.pod);
      await this.assertWritableDatabaseDirectory(before.pod.metadata.name);
      const restoreBase = `t13-restore-${this.runId}`;
      await this.assertNoCollision([
        ['pvc', `${restoreBase}-data`],
        ['pod', `${restoreBase}-loader`],
        ['deployment', restoreBase],
        ['service', restoreBase]
      ]);
      const baselineApi = await this.login();
      const baseline = await this.buildFixture(baselineApi);
      baseline.actual = await this.captureAndAssert(baselineApi, baseline, 'pre-replacement baseline');
      jsonFile(path.join(this.runDir, 'baseline.json'), baseline);
      this.recordAssertion('unique two-student P1–P7 dataset, independent arithmetic, class/individual reports, and parsed CSV verified before replacement', {
        classId: baseline.dataset.classId,
        studentIds: baseline.dataset.students.map(student => student.id),
        date: baseline.dataset.date,
        periods: baseline.dataset.periods,
        totals: baseline.independentlyCalculated.totals,
        percentages: baseline.independentlyCalculated.reports.map(row => row.percentage)
      });
      this.summary.primaryBefore = {
        deployment: 'attendance',
        pod: before.pod.metadata.name,
        podUid: before.pod.metadata.uid,
        imageRef: before.containerStatus.image,
        imageID: before.containerStatus.imageID,
        pvc: 'attendance-data',
        pvcUid: pvcBefore.metadata.uid,
        pv: pvcBefore.spec.volumeName,
        serviceEndpointPodUid: endpointBefore.endpoints.subsets?.flatMap(s => s.addresses || []).find(a => a.targetRef?.uid === before.pod.metadata.uid)?.targetRef.uid
      };
      this.writeSummary();
      if (primaryForward) { await primaryForward.stop(); primaryForward = null; }
      const replacement = await this.replacePrimaryPod(before, pvcBefore);
      primaryForward = await this.ensureBaseUrlReachable();
      const replacementApi = await this.login();
      const afterReplacement = await this.captureAndAssert(replacementApi, baseline, 'post-replacement');
      assert.deepEqual(afterReplacement, baseline.actual, 'Post-replacement application data differs from the independently checked baseline.');
      jsonFile(path.join(this.runDir, 'post-replacement.json'), {
        capturedAt: now(),
        pod: replacement.after.pod.metadata.name,
        podUid: replacement.after.pod.metadata.uid,
        imageRef: replacement.after.containerStatus.image,
        imageID: replacement.after.containerStatus.imageID,
        pvcUid: replacement.pvcAfter.metadata.uid,
        pv: replacement.pvcAfter.spec.volumeName,
        data: afterReplacement
      });
      this.recordAssertion('same student IDs, attendance, class/individual reports, totals, and parsed CSV survived controlled Pod replacement without reseeding', {
        classId: baseline.dataset.classId,
        studentIds: baseline.dataset.students.map(student => student.id),
        replacementPodUid: replacement.after.pod.metadata.uid,
        pvcUid: replacement.pvcAfter.metadata.uid,
        pv: replacement.pvcAfter.spec.volumeName
      });
      const backup = await this.onlineBackup(replacement.after.pod, baseline);
      const restore = await this.createIsolatedRestore(baseline, primary, replacement.after, replacement.pvcAfter, backup.file, backup.metadata);
      const primaryAfterRestore = await this.primaryPod();
      assert.equal(primaryAfterRestore.pod.metadata.uid, replacement.after.pod.metadata.uid, 'Restore procedure changed the original application Pod.');
      const pvcAfterRestore = await this.getBoundPvc('attendance-data');
      assert.equal(pvcAfterRestore.metadata.uid, replacement.pvcAfter.metadata.uid, 'Restore procedure changed the original PVC UID.');
      assert.equal(pvcAfterRestore.spec.volumeName, replacement.pvcAfter.spec.volumeName, 'Restore procedure changed the original PV binding.');
      const originalAfterRestoreApi = await this.login();
      const originalAfterRestore = await this.captureAndAssert(originalAfterRestoreApi, baseline, 'original app after isolated restore');
      assert.deepEqual(originalAfterRestore, baseline.actual, 'Isolated restore changed the original application data.');
      this.recordAssertion('isolated restore left the original app Pod, PVC/PV, and baseline data unchanged', {
        originalPodUid: primaryAfterRestore.pod.metadata.uid,
        originalPvcUid: pvcAfterRestore.metadata.uid,
        originalPv: pvcAfterRestore.spec.volumeName
      });
      this.summary.primaryAfter = {
        pod: replacement.after.pod.metadata.name,
        podUid: replacement.after.pod.metadata.uid,
        imageRef: replacement.after.containerStatus.image,
        imageID: replacement.after.containerStatus.imageID,
        pvcUid: replacement.pvcAfter.metadata.uid,
        pv: replacement.pvcAfter.spec.volumeName
      };
      this.summary.primaryAfterRestore = {
        pod: primaryAfterRestore.pod.metadata.name,
        podUid: primaryAfterRestore.pod.metadata.uid,
        pvcUid: pvcAfterRestore.metadata.uid,
        pv: pvcAfterRestore.spec.volumeName,
        dataMatchesBaseline: true
      };
      this.summary.restore = {
        deployment: restore.restoreName,
        service: restore.restoreName,
        pod: restore.restorePod.metadata.name,
        podUid: restore.restorePod.metadata.uid,
        imageID: restore.restorePod.status.containerStatuses.find(item => item.name === 'attendance').imageID,
        pvc: `${restore.restoreName}-data`,
        pvcUid: restore.restorePvc.metadata.uid,
        pv: restore.restorePvc.spec.volumeName,
        backupSha256: backup.metadata.sha256
      };
      this.summary.status = 'passed';
      this.summary.finishedAt = now();
      this.summary.exitCode = 0;
      this.summary.retainedRestoreResources = true;
      this.writeSummary();
    } catch (error) {
      this.summary.status = 'failed';
      this.summary.finishedAt = now();
      this.summary.exitCode = 1;
      this.summary.failure = error?.stack || error?.message || String(error);
      this.writeSummary();
      throw error;
    } finally {
      if (primaryForward) await primaryForward.stop().catch(() => {});
      if (this.primaryScaledToZero) {
        try {
          await this.kubectl(['scale', 'deployment/attendance', '--replicas=1']);
          await this.kubectl(['rollout', 'status', 'deployment/attendance', '--timeout=180s']);
          this.primaryScaledToZero = false;
          this.summary.failureRecovery = { result: 'restored-to-one-ready-replica', at: now(), originalPvcPreserved: true };
        } catch (recoveryError) {
          this.summary.failureRecovery = { result: 'failed', at: now(), error: recoveryError.message, originalPvcPreserved: true };
        }
        this.writeSummary();
      }
      if (this.backupTemporaryFile && fs.existsSync(this.backupTemporaryFile)) {
        try { fs.rmSync(this.backupTemporaryFile, { force: true }); }
        catch (cleanupError) {
          this.summary.status = 'failed';
          this.summary.exitCode = 1;
          this.summary.finishedAt = now();
          this.summary.failure = `${this.summary.failure ? `${this.summary.failure}\n` : ''}Backup temporary-file cleanup failed: ${cleanupError.message}`;
          this.writeSummary();
          throw cleanupError;
        }
      }
    }
  }
}

function safeJsonParse(value) {
  try { return JSON.parse(value); } catch { return value.trim(); }
}
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function waitUntil(check, timeoutMs, message) {
  const end = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < end) {
    try { if (await check()) return; } catch (error) { lastError = error; }
    await delay(1000);
  }
  throw new Error(`${message}${lastError ? ` Last error: ${lastError.message}` : ''}`);
}
async function waitForJson(check, timeoutMs, message) {
  let result;
  await waitUntil(async () => { result = await check(); return result; }, timeoutMs, message);
  return result;
}
async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\n') { row.push(cell.replace(/\r$/, '')); if (row.some(value => value !== '')) rows.push(row); row = []; cell = ''; }
    else cell += char;
  }
  if (quoted) throw new Error('CSV response contains an unterminated quoted field.');
  if (cell.length || row.length) { row.push(cell.replace(/\r$/, '')); if (row.some(value => value !== '')) rows.push(row); }
  return rows;
}
async function fileSha256(file) {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(file);
    input.on('error', reject);
    input.on('data', chunk => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}
function inspectSqlite(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all();
    const integrityCheck = integrity.length === 1 ? Object.values(integrity[0])[0] : 'unexpected-result';
    const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(row => Number(row.version));
    return { integrityCheck, schemaVersions: versions };
  } finally { db.close(); }
}
function sha256Text(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}
function sealEvidenceDirectory(runDir, runId) {
  const manifestFile = path.join(runDir, 'manifest.sha256.json');
  const files = [];
  const walk = directory => {
    for (const name of fs.readdirSync(directory).sort()) {
      const full = path.join(directory, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (full !== manifestFile) files.push(path.relative(runDir, full).replaceAll('\\', '/'));
    }
  };
  walk(runDir);
  const entries = files.sort().map(relative => {
    const bytes = fs.readFileSync(path.join(runDir, relative));
    return { path: relative, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  });
  const combined = crypto.createHash('sha256');
  for (const entry of entries) combined.update(`${entry.path}\0${entry.sha256}\n`);
  const manifest = {
    runId,
    sealedAt: now(),
    algorithm: 'SHA-256 of sorted UTF-8 records: relative POSIX path, NUL byte, lowercase file SHA-256 hex, LF byte',
    fileCount: entries.length,
    combinedSha256: combined.digest('hex'),
    files: entries
  };
  jsonFile(manifestFile, manifest);
  return manifest;
}

async function main() {
  if (process.argv.length !== 2) throw new Error('Usage: npm run test:t13 (configure required T13_* environment inputs; no CLI arguments are accepted).');
  const config = readConfig();
  const runner = new EvidenceRunner(config);
  let outcome = 'passed';
  try {
    await runner.execute();
    process.stdout.write(`T13 passed. Evidence: ${runner.runDir}\n`);
  } catch (error) {
    outcome = 'failed';
    process.stderr.write(`T13 failed: ${error.message}\nEvidence: ${runner.runDir}\n`);
    process.exitCode = 1;
  } finally {
    try {
      const manifest = sealEvidenceDirectory(runner.runDir, runner.runId);
      process.stdout.write(`${outcome === 'passed' ? 'Evidence sealed' : 'Failed-run evidence sealed'}: ${manifest.fileCount} files, combined SHA-256 ${manifest.combinedSha256}\n`);
    } catch (sealError) {
      process.stderr.write(`T13 evidence sealing failed: ${sealError.message}\n`);
      process.exitCode = 1;
    }
  }
}

main().catch(error => {
  process.stderr.write(`T13 preflight failed: ${error.message}\n`);
  process.exitCode = 1;
});
