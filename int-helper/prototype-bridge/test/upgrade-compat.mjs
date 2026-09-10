import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { createPackage } from '../src/updater.mjs';
// Frozen verbatim from the public 0.18.0 updater, before the adapter split.
import { createUpdater, validatePackage } from './fixtures/updater/0.18.0.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const payload = await createPackage(repo);
validatePackage(payload, payload.version);
assert.ok(!payload.files.some(file => /\/(?:test|demo)\/|\/src\/web-adapters\/|dist\/demo/.test(file.path)));
const previous = structuredClone(payload);
previous.version = '0.18.0';
const manifest = previous.files.find(file => file.path === 'int-helper/.codex-plugin/plugin.json');
const bytes = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(manifest.base64, 'base64')), version: previous.version }));
Object.assign(manifest, { base64: bytes.toString('base64'), size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const folder = await fs.mkdtemp(join(tmpdir(), 'int-helper-upgrade-'));
let child;
try {
  const install = join(folder, 'install');
  await fs.writeFile(join(folder, 'private-history.jsonl'), 'private history stays outside installation');
  const calls = [];
  const oldUpdater = createUpdater({ root: install, runner: async (...args) => calls.push(args) });
  await oldUpdater.apply(previous, { initial: true });
  const before = JSON.parse(await fs.readFile(join(install, 'installation.json')));
  const upgraded = await oldUpdater.apply(payload);
  assert.equal(upgraded.version, payload.version);
  const after = JSON.parse(await fs.readFile(join(install, 'installation.json')));
  assert.equal(after.token, before.token);
  assert.equal(calls.length, 4);
  assert.equal(await fs.readFile(join(folder, 'private-history.jsonl'), 'utf8'), 'private history stays outside installation');
  const runtime = join(install, 'current/int-helper/prototype-bridge');
  await assert.rejects(fs.access(join(runtime, 'node_modules')));
  child = spawn(process.execPath, ['dist/server.cjs'], {
    cwd: runtime,
    env: { ...process.env, INT_PRACTICE_BRIDGE_PORT: '19873', INT_PRACTICE_HISTORY_DIR: join(folder, 'history') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const lines = createInterface({ input: child.stdout });
  const rpc = async (id, method, params) => {
    const waiting = new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); lines.off('line', onLine); child.off('exit', onExit); };
      const onLine = line => { cleanup(); resolve(line); };
      const onExit = () => { cleanup(); reject(new Error('Installed bridge exited: ' + errors)); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Installed bridge timed out: ' + errors)); }, 10000);
      lines.once('line', onLine);
      child.once('exit', onExit);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const line = await waiting;
    const response = JSON.parse(line);
    assert.equal(response.id, id, errors);
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    return response.result;
  };
  await rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'upgrade-test', version: '1.0.0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const { tools } = await rpc(2, 'tools/list', {});
  for (const name of ['inspect_page', 'read_exam_result', 'open_answer_review', 'answer_known_questions', 'set_exam_loop']) assert.ok(tools.some(tool => tool.name === name));
  assert.equal(tools.length, 18);
  lines.close();
  console.log('Upgrade compatibility passed: original 0.18.0 updater accepts/applies this payload; installed runtime starts 18 MCP tools without source/dependencies; pairing/history preserved');
} finally {
  if (child && child.exitCode === null) {
    const stopped = once(child, 'exit');
    child.kill();
    await stopped;
  }
  await fs.rm(folder, { recursive: true, force: true });
}
