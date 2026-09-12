import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const REPOSITORY = 'Topmoaman/int-helper';
export const ASSET_NAME = 'int-helper-update.json';
export const INSTALL_HOME = join(homedir(), '.local/share/int-helper/install');
const CONFIG_FILE = 'installation.json';
const EXTENSION_CONFIG = 'int-helper/prototype-bridge/extension/updater-config.json';
const MAX_BYTES = 15 * 1024 * 1024;
const runFile = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const versionParts = value => {
  if (!/^\d+\.\d+\.\d+(?:\+codex\.\d+)?$/.test(value || '')) throw new Error('Invalid release version');
  return value.split('+')[0].split('.').map(Number);
};
export const isNewer = (next, current) => {
  const a = versionParts(next), b = versionParts(current);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
};
export const allowedPath = path => typeof path === 'string' && !path.includes('\\') &&
  path.split('/').every(part => part && part !== '.' && part !== '..') && path !== EXTENSION_CONFIG &&
  (/^(README\.md|THIRD_PARTY_NOTICES\.md|\.gitignore|install\.mjs|scripts\/build-release\.mjs|\.agents\/plugins\/marketplace\.json)$/.test(path) ||
   /^int-helper\/(?:\.codex-plugin\/plugin\.json|\.mcp\.json|skills\/int-helper\/(?:SKILL\.md|agents\/openai\.yaml)|prototype-bridge\/(?:package(?:-lock)?\.json|(?:src|test|demo)\/[\w-]+\.mjs|dist\/[\w-]+\.cjs|extension\/[\w-]+\.(?:js|html|json)))$/.test(path));

export const validatePackage = (payload, expectedVersion) => {
  if (payload?.format !== 1 || payload.repository !== REPOSITORY || !Array.isArray(payload.files) || !payload.files.length || payload.files.length > 100) throw new Error('Invalid update package');
  versionParts(payload.version);
  if (expectedVersion && payload.version !== expectedVersion) throw new Error('Release version does not match package');
  const files = new Map(); let total = 0;
  for (const item of payload.files) {
    if (!allowedPath(item.path) || files.has(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256 || '') || typeof item.base64 !== 'string') throw new Error('Unsafe or duplicate update file');
    const bytes = Buffer.from(item.base64, 'base64');
    if (bytes.toString('base64') !== item.base64 || bytes.length !== item.size || digest(bytes) !== item.sha256) throw new Error('Update file checksum mismatch');
    total += bytes.length;
    if (total > MAX_BYTES) throw new Error('Update package is too large');
    files.set(item.path, bytes);
  }
  const readJSON = path => JSON.parse(files.get(path)?.toString() || 'null');
  const plugin = readJSON('int-helper/.codex-plugin/plugin.json');
  const extension = readJSON('int-helper/prototype-bridge/extension/manifest.json');
  const marketplace = readJSON('.agents/plugins/marketplace.json');
  if (plugin?.name !== 'int-helper' || plugin.version !== payload.version || extension?.version !== payload.extensionVersion || marketplace?.name !== 'int-helper-community' || marketplace.plugins?.[0]?.source?.path !== './int-helper') throw new Error('Package manifests do not match');
  versionParts(payload.extensionVersion);
  for (const path of ['install.mjs', 'int-helper/.mcp.json', 'int-helper/prototype-bridge/dist/server.cjs', 'int-helper/prototype-bridge/extension/service-worker.js', 'int-helper/prototype-bridge/extension/content-script.js']) if (!files.has(path)) throw new Error('Update package is incomplete');
  return files;
};

export const createPackage = async root => {
  // Ship the executable installation only. Source/tests (including nested web
  // adapters and HTML fixtures) remain in the repository/source ZIP. Keeping
  // this payload within the 0.18.0 path contract lets that updater install it.
  const runtimePath = path => allowedPath(path) &&
    (!path.startsWith('int-helper/prototype-bridge/') ||
      /^int-helper\/prototype-bridge\/(?:src\/updater\.mjs|dist\/server\.cjs|extension\/[\w-]+\.(?:js|html|json))$/.test(path)) &&
    path !== 'scripts/build-release.mjs';
  const files = [];
  const visit = async (folder, prefix = '') => {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'history', 'release'].includes(entry.name)) continue;
      const path = prefix + entry.name;
      if (entry.isDirectory()) await visit(join(folder, entry.name), path + '/');
      else if (entry.isFile() && runtimePath(path)) {
        const bytes = await fs.readFile(join(root, path));
        files.push({ path, size: bytes.length, sha256: digest(bytes), base64: bytes.toString('base64') });
      }
    }
  };
  await visit(root);
  const plugin = JSON.parse(await fs.readFile(join(root, 'int-helper/.codex-plugin/plugin.json'), 'utf8'));
  const extension = JSON.parse(await fs.readFile(join(root, 'int-helper/prototype-bridge/extension/manifest.json'), 'utf8'));
  const payload = { format: 1, repository: REPOSITORY, version: plugin.version, extensionVersion: extension.version, files: files.sort((a,b) => a.path.localeCompare(b.path)) };
  validatePackage(payload);
  return payload;
};

const fetchJSON = async (url, fetcher, limit = MAX_BYTES * 2) => {
  const response = await fetcher(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'int-helper-updater' }, signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error('GitHub update request failed (' + response.status + ')');
  if (Number(response.headers.get('content-length')) > limit) throw new Error('Update response is too large');
  let size = 0; const chunks = [];
  for await (const chunk of response.body) { size += chunk.length; if (size > limit) throw new Error('Update response is too large'); chunks.push(Buffer.from(chunk)); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};
export const latestRelease = async (fetcher = fetch) => {
  const release = await fetchJSON('https://api.github.com/repos/' + REPOSITORY + '/releases/latest', fetcher, 256 * 1024);
  if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name || '')) throw new Error('No supported stable release');
  const version = release.tag_name.slice(1);
  const url = 'https://github.com/' + REPOSITORY + '/releases/download/' + release.tag_name + '/' + ASSET_NAME;
  const asset = release.assets?.find(asset => asset.name === ASSET_NAME && asset.browser_download_url === url);
  if (!asset || asset.size > MAX_BYTES * 2) throw new Error('Release does not have an update package');
  return { version, url, htmlUrl: 'https://github.com/' + REPOSITORY + '/releases/tag/' + release.tag_name };
};

const readConfig = async root => {
  try { return JSON.parse(await fs.readFile(join(root, CONFIG_FILE), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const writeJSON = async (path, value) => {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await fs.writeFile(path + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(path + '.tmp', path);
};
const installCodex = async (current, runner) => {
  // No shell, downloaded installer execution, or release-supplied command arguments.
  await runner('codex', ['plugin', 'marketplace', 'add', current, '--json']);
  await runner('codex', ['plugin', 'add', 'int-helper@int-helper-community', '--json']);
};
const defaultRunner = (command, args) => runFile(command, args, { timeout: 90000, maxBuffer: 1024 * 1024, windowsHide: true });

export const createUpdater = ({ root = INSTALL_HOME, fetcher = fetch, runner = defaultRunner } = {}) => {
  const current = join(root, 'current'), previous = join(root, 'previous');
  const status = async () => {
    const config = await readConfig(root);
    return { managed: !!config, version: config?.version || null, extensionVersion: config?.extensionVersion || null };
  };
  const authenticate = async token => {
    const config = await readConfig(root);
    if (!config || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Run the one-time installer and load its extension folder first');
    const expected = Buffer.from(config.token, 'hex'), actual = Buffer.from(token, 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('This extension is not paired with the managed installation');
  };
  const apply = async (payload, { initial = false, ensureIdle = async () => {} } = {}) => {
    const files = validatePackage(payload);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    let lock;
    try { lock = await fs.open(join(root, 'update.lock'), 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('Another update is running; do not start a second update'); throw error; }
    const stage = join(root, 'staging-' + randomBytes(6).toString('hex'));
    let old, movedOld = false, activated = false;
    try {
      old = await readConfig(root);
      if (!initial && !old) throw new Error('Run the one-time installer first');
      if (old && !isNewer(payload.version, old.version)) return { updated: false, version: old.version };
      await ensureIdle();
      if (old) {
        for (const [path, hash] of Object.entries(old.hashes)) {
          const stat = await fs.lstat(join(current, path));
          if (!stat.isFile() || stat.isSymbolicLink() || digest(await fs.readFile(join(current, path))) !== hash) throw new Error('Installed files have local changes; update stopped to preserve them');
        }
      }
      for (const [path, bytes] of files) {
        await fs.mkdir(dirname(join(stage, path)), { recursive: true, mode: 0o700 });
        await fs.writeFile(join(stage, path), bytes, { mode: 0o600 });
      }
      const config = { version: payload.version, extensionVersion: payload.extensionVersion, token: old?.token || randomBytes(32).toString('hex'), hashes: Object.fromEntries(payload.files.map(file => [file.path, file.sha256])) };
      await writeJSON(join(stage, EXTENSION_CONFIG), { token: config.token });
      await ensureIdle();
      // Only the dedicated install directory is swapped; history lives elsewhere.
      if (old) {
        await fs.rm(previous, { recursive: true, force: true });
        await fs.rename(current, previous); movedOld = true;
      } else {
        try { await fs.access(current); throw new Error('An unmanaged install folder already exists'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      await fs.rename(stage, current); activated = true;
      await installCodex(current, runner);
      await writeJSON(join(root, CONFIG_FILE), config);
      return { updated: true, version: payload.version, extensionVersion: payload.extensionVersion,
        extensionPath: join(current, 'int-helper/prototype-bridge/extension'), restartTask: true };
    } catch (error) {
      if (activated) await fs.rm(current, { recursive: true, force: true });
      if (movedOld) {
        await fs.rename(previous, current);
        try { await installCodex(current, runner); }
        catch { throw new Error('Update failed. Previous files were restored, but Codex reinstall failed; rerun the installer before use.'); }
      }
      throw error;
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
      await lock.close();
      await fs.unlink(join(root, 'update.lock'));
    }
  };
  const installLatest = async ({ ensureIdle }) => {
    await ensureIdle();
    const release = await latestRelease(fetcher);
    const config = await readConfig(root);
    if (!config) throw new Error('Run the one-time installer first');
    if (!isNewer(release.version, config.version)) return { updated: false, version: config.version };
    const payload = await fetchJSON(release.url, fetcher);
    validatePackage(payload, release.version);
    return apply(payload, { ensureIdle });
  };
  return { status, authenticate, apply, installLatest };
};
