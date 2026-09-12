// Release checks are read-only. Only a click in this extension's popup starts installation.
globalThis.createHelperUpdates = ({ chrome, fetcher = fetch, sockets, connectedPorts, isBusy, onChange }) => {
  const REPO = 'Topmoaman/int-helper', ASSET = 'int-helper-update.json';
  const VERSION = '0.20.1', INTERVAL = 4 * 60 * 60 * 1000;
  const pending = new Map(), capable = new Set();
  let cached = {}, checking = null, busy = false, paired = null;
  const ready = (async () => {
    cached = (await chrome.storage.local.get('helperUpdate')).helperUpdate || {};
    try {
      const response = await fetcher(chrome.runtime.getURL('updater-config.json'));
      const config = response.ok ? await response.json() : null;
      if (/^[a-f0-9]{64}$/.test(config?.token || '')) paired = config.token;
    } catch { /* Unmanaged downloads still get update notices and setup instructions. */ }
  })();
  const newer = version => {
    if (!/^\d+\.\d+\.\d+$/.test(version || '')) return false;
    const next = version.split('.').map(Number), current = VERSION.split('.').map(Number);
    for (let i = 0; i < 3; i++) if (next[i] !== current[i]) return next[i] > current[i];
    return false;
  };
  const save = async () => { await chrome.storage.local.set({ helperUpdate: cached }); onChange(); };
  const check = async (force = false) => {
    await ready;
    if (checking) return checking;
    if (!force && Date.now() - (cached.checkedAt || 0) < INTERVAL) return;
    checking = (async () => {
      try {
        const response = await fetcher('https://api.github.com/repos/' + REPO + '/releases/latest', { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
        if (response.status === 404) { cached = { ...cached, latest: null, checkedAt: Date.now(), error: null }; }
        else {
          if (!response.ok) throw new Error('ตรวจรุ่นใหม่ไม่ได้ ลองอีกครั้งภายหลัง');
          const release = await response.json();
          const tag = release.tag_name;
          if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(tag || '') || !release.assets?.some(a => a.name === ASSET && a.browser_download_url === 'https://github.com/' + REPO + '/releases/download/' + tag + '/' + ASSET)) throw new Error('รุ่นล่าสุดยังไม่มีชุดอัปเดตพร้อมใช้');
          cached = { ...cached, latest: tag.slice(1), checkedAt: Date.now(), error: null };
        }
      } catch (error) {
        // Preserve an already known update during an offline/rate-limited check.
        cached = { ...cached, checkedAt: Date.now(), error: error.message === 'ตรวจรุ่นใหม่ไม่ได้ ลองอีกครั้งภายหลัง' ? error.message : 'ตรวจรุ่นใหม่ไม่ได้ ลองอีกครั้งภายหลัง' };
      }
      await save();
    })().finally(() => { checking = null; });
    return checking;
  };
  const idle = async () => {
    if (isBusy()) return false;
    const tabs = await chrome.tabs.query({ url: ['https://int-project.com/student/virtual_school/*', 'https://www.int-project.com/student/virtual_school/*', 'https://main.virtualschool.club/*'] });
    return !tabs.some(tab => { try { return /\/(?:Exam|exam\.php)\/?$/i.test(new URL(tab.url).pathname); } catch { return true; } });
  };
  const status = async () => {
    await ready;
    const available = newer(cached.latest), port = connectedPorts().find(port => capable.has(port));
    return { available, latest: cached.latest || null, current: VERSION, busy, managed: !!paired,
      canInstall: !!paired && !!port && !busy && await idle(), error: cached.error || null,
      installed: cached.installed || null, needsRestart: cached.installed === VERSION,
      reason: !paired ? 'ติดตั้งด้วย node install.mjs หนึ่งครั้งเพื่อเปิดใช้อัปเดต' : !port ? 'เปิดงานใหม่ใน Codex ที่เปิดใช้ INT Helper ก่อนอัปเดต' : !await idle() ? 'จบงานปัจจุบันและออกจากหน้าข้อสอบก่อนอัปเดต' : null };
  };
  const rpc = (port, action) => new Promise((resolve, reject) => {
    const socket = sockets.get(port), id = crypto.randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('ยังยืนยันผลอัปเดตไม่ได้ อย่ากดซ้ำจนกว่าจะตรวจสถานะแล้ว')); }, 240000);
    pending.set(id, { port, resolve, reject, timer });
    try { socket.send(JSON.stringify({ type: 'update_request', id, action, token: paired })); }
    catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
  });
  const install = async () => {
    const info = await status();
    if (!info.available) throw new Error('ยังไม่มีรุ่นใหม่');
    if (!info.canInstall) throw new Error(info.reason || 'กำลังอัปเดตอยู่');
    busy = true; onChange();
    try {
      const port = connectedPorts().find(port => capable.has(port));
      const result = await rpc(port, 'install');
      if (!result.updated) { await check(true); return result; }
      cached = { ...cached, installed: result.version, latest: result.version, error: null };
      await save();
      // Same stable directory; reloading picks up the new unpacked extension.
      setTimeout(() => chrome.runtime.reload(), 750);
      return result;
    } catch (error) {
      cached.error = error.message; await save(); throw error;
    } finally { busy = false; onChange(); }
  };
  const receive = (port, message) => {
    if (message.type === 'pong' && message.updaterProtocol === 1) capable.add(port);
    if (message.type !== 'update_response') return;
    const item = pending.get(message.id);
    if (!item || item.port !== port) return;
    pending.delete(message.id); clearTimeout(item.timer);
    if (message.ok) item.resolve(message.result); else item.reject(new Error(message.error || 'อัปเดตไม่สำเร็จ'));
  };
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.url !== chrome.runtime.getURL('popup.html')) return;
    if (!['check_update', 'install_update', 'dismiss_update_restart'].includes(message.action)) return;
    const action = message.action === 'install_update' ? install() : message.action === 'check_update' ? check(true).then(status) : ready.then(async () => { cached.installed = null; await save(); return status(); });
    action.then(result => respond({ ok: true, result }), error => respond({ ok: false, error: error.message }));
    return true;
  });
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'helper-update-check') void check(); });
  void (async () => {
    if (!await chrome.alarms.get('helper-update-check')) await chrome.alarms.create('helper-update-check', { periodInMinutes: 240 });
    await check();
  })().catch(() => {});
  return { status, check, install, receive, idle, get busy() { return busy; }, get available() { return newer(cached.latest); } };
};
