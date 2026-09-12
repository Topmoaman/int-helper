import assert from 'node:assert/strict';
import { promises as fs, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { createUpdater, createPackage, validatePackage, allowedPath, isNewer, latestRelease, REPOSITORY, ASSET_NAME } from '../src/updater.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const payload = await createPackage(repo);
const renameVersion = (version) => {
  const p = structuredClone(payload); p.version = version;
  const file = p.files.find(f => f.path.endsWith('.codex-plugin/plugin.json'));
  const manifest = JSON.parse(Buffer.from(file.base64, 'base64')); manifest.version = version;
  const bytes = Buffer.from(JSON.stringify(manifest));
  Object.assign(file, { base64: bytes.toString('base64'), size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  return p;
};
assert.equal(isNewer('0.22.0', '0.18.0'), true);
assert.equal(isNewer('0.18.0', '0.18.0'), false);
assert.equal(isNewer('0.9.0', '0.18.0'), false);
assert.throws(() => isNewer('latest', '0.18.0'));
for (const path of ['../x', '/tmp/x', 'int-helper/../x', 'int-helper\\x', 'int-helper/prototype-bridge/extension/updater-config.json', '.env', 'history/answer-bank.json']) assert.equal(allowedPath(path), false);
assert.ok(!payload.files.some(f => /updater-config|answer-bank|\.jsonl$/.test(f.path)));
const corrupt = structuredClone(payload); corrupt.files[0].sha256 = '0'.repeat(64);
assert.throws(() => validatePackage(corrupt), /checksum/);
const duplicate = structuredClone(payload); duplicate.files.push(duplicate.files[0]);
assert.throws(() => validatePackage(duplicate), /duplicate/);
assert.throws(() => validatePackage(payload, '8.0.0'), /version/);
const release = { tag_name: 'v0.22.0', draft: false, prerelease: false, assets: [{ name: ASSET_NAME, size: 100, browser_download_url: 'https://github.com/' + REPOSITORY + '/releases/download/v0.22.0/' + ASSET_NAME }] };
assert.equal((await latestRelease(async () => Response.json(release))).version, '0.22.0');
await assert.rejects(latestRelease(async () => Response.json({ ...release, prerelease: true })), /stable/);
await assert.rejects(latestRelease(async () => Response.json({ ...release, assets: [{ ...release.assets[0], browser_download_url: 'https://evil.invalid/update' }] })), /package/);
await assert.rejects(latestRelease(async () => new Response('offline', { status: 503 })), /503/);

const folder = await fs.mkdtemp(join(tmpdir(), 'helper-updater-test-'));
try {
  const root = join(folder, 'install'), calls = [];
  await fs.mkdir(join(folder, 'history'));
  await fs.writeFile(join(folder, 'history', 'answer-bank.json'), 'private-history');
  const updater = createUpdater({ root, runner: async (...args) => { calls.push(args); } });
  assert.equal((await updater.status()).managed, false);
  await assert.rejects(updater.authenticate('0'.repeat(64)), /installer/);
  await assert.rejects(updater.apply(payload), /installer/);
  await updater.apply(payload, { initial: true });
  assert.equal((await updater.status()).version, payload.version);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], ['codex', ['plugin', 'add', 'int-helper@int-helper-community', '--json']]);
  const configPath = join(root, 'installation.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  await updater.authenticate(config.token);
  await assert.rejects(updater.authenticate('0'.repeat(64)), /paired/);
  await assert.rejects(updater.apply(renameVersion('0.22.0'), { ensureIdle: async () => { throw Error('active exam'); } }), /active exam/);
  assert.equal((await updater.status()).version, payload.version);
  // A partial Codex install failure restores the entire prior install.
  let installCalls = 0;
  const failed = createUpdater({ root, runner: async (_command, args) => {
    if (args[1] === 'add' && ++installCalls === 1) throw Error('simulated Codex install failure');
  } });
  await assert.rejects(failed.apply(renameVersion('0.22.0')), /simulated/);
  assert.equal((await updater.status()).version, payload.version);
  assert.equal(JSON.parse(await fs.readFile(join(root, 'current/int-helper/.codex-plugin/plugin.json'), 'utf8')).version, payload.version);
  assert.equal(JSON.parse(await fs.readFile(configPath, 'utf8')).token, config.token);
  assert.equal(installCalls, 2, 'rollback reinstalls the previous Codex plugin');
  const network = createUpdater({ root, runner: async () => {}, fetcher: async url => Response.json(url.includes('/releases/latest') ? release : renameVersion('0.22.0')) });
  let idleChecks = 0;
  const installed = await network.installLatest({ ensureIdle: async () => { idleChecks++; } });
  assert.equal(installed.updated, true); assert.ok(idleChecks >= 3);
  assert.equal((await updater.status()).version, '0.22.0');
  assert.equal(await fs.readFile(join(folder, 'history/answer-bank.json'), 'utf8'), 'private-history');
  assert.equal(JSON.parse(await fs.readFile(configPath, 'utf8')).token, config.token);
  assert.equal(JSON.parse(await fs.readFile(join(root, 'previous/int-helper/.codex-plugin/plugin.json'), 'utf8')).version, payload.version);
  assert.equal((await updater.apply(payload)).updated, false, 'no downgrades');
  await fs.writeFile(join(root, 'update.lock'), 'running');
  await assert.rejects(updater.apply(renameVersion('0.23.0')), /Another update/);
  await fs.unlink(join(root, 'update.lock'));
  await fs.writeFile(join(root, 'current/README.md'), 'local edits');
  await assert.rejects(updater.apply(renameVersion('0.23.0')), /local changes/);
  assert.equal(await fs.readFile(join(root, 'current/README.md'), 'utf8'), 'local edits');
} finally { await fs.rm(folder, { recursive: true, force: true }); }

// Real extension updater code, with Chrome/network boundaries mocked.
let factory;
runInNewContext(readFileSync(new URL('../extension/updates.js', import.meta.url), 'utf8') + '\nexpose(createHelperUpdates);', {
  expose: fn => factory = fn, AbortSignal, URL, Date, crypto: { randomUUID: () => 'update-1' },
  setTimeout: (_fn, ms) => ms, clearTimeout() {},
});
let stored = {}, listener, alarm, reloads = 0, active = false, tabs = [], fetchCount = 0, sent = [], service;
const chrome = {
  storage: { local: { get: async () => stored, set: async value => { stored = value; } } },
  runtime: { getURL: path => 'chrome-extension://self/' + path, reload: () => { reloads++; }, onMessage: { addListener: fn => listener = fn } },
  alarms: { get: async () => null, create: async (_name, info) => { alarm = info; }, onAlarm: { addListener() {} } },
  tabs: { query: async () => tabs },
};
const socket = { send: text => { const message = JSON.parse(text); sent.push(message); queueMicrotask(() => service.receive(1, { type: 'update_response', id: message.id, ok: true, result: { updated: true, version: '0.22.0' } })); } };
let offline = false;
service = factory({ chrome, sockets: new Map([[1, socket]]), connectedPorts: () => [1], isBusy: () => active, onChange() {}, fetcher: async url => {
  if (url.startsWith('chrome-extension:')) return Response.json({ token: 'a'.repeat(64) });
  fetchCount++; if (offline) throw Error('offline'); return Response.json(release);
} });
await service.check();
assert.equal(alarm.periodInMinutes, 240);
assert.equal((await service.status()).available, true);
assert.equal(service.notice.latest, '0.22.0');
assert.deepEqual(Object.keys(service.notice), ['latest'], 'Codex metadata exposes no pairing/configuration data');
assert.equal((await service.status()).canInstall, false, 'wait for a compatible local bridge');
service.receive(1, { type: 'pong', updaterProtocol: 1 });
assert.equal((await service.status()).canInstall, true);
const count = fetchCount; await service.check(); assert.equal(fetchCount, count, 'cached checks avoid repeated network requests');
offline = true; await service.check(true); assert.equal((await service.status()).available, true, 'offline does not discard a known update');
assert.equal(service.notice.latest, '0.22.0', 'Codex keeps a previously validated release while offline');
offline = false;
active = true; await assert.rejects(service.install(), /จบงาน/); assert.equal(sent.length, 0);
active = false; tabs = [{ url: 'https://main.virtualschool.club/Exam?subject=A' }];
await assert.rejects(service.install(), /จบงาน/); assert.equal(sent.length, 0);
tabs = [];
assert.equal(listener({ action: 'install_update' }, { url: 'https://untrusted.test/' }, () => assert.fail('untrusted sender')), undefined);
await service.install();
assert.equal(sent.length, 1); assert.equal(sent[0].action, 'install'); assert.equal(sent[0].token, 'a'.repeat(64));
assert.equal(stored.helperUpdate.installed, '0.22.0');
assert.equal(JSON.stringify(stored).includes('a'.repeat(64)), false, 'pairing token is never stored in public status/cache');
console.log('Updater passed: release validation, checksums, pairing, idle gates, install, rollback, history preservation, no downgrades, cache/offline, popup-only install');
