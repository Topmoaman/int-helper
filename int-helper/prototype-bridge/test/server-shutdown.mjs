import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, connect } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const serverPath = process.argv[2] || fileURLToPath(new URL("../dist/server.cjs", import.meta.url));
const freePort = async () => {
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
};
const bounded = async (promise, label) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), 2500);
  })]); } finally { clearTimeout(timer); }
};

// Repeatedly reclaim the same port: more than the bridge's 16-slot pool.
const port = await freePort();
for (let cycle = 0; cycle < 20; cycle++) {
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, INT_PRACTICE_BRIDGE_PORT: String(port) }, stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let stdout = "", stderr = "", socket;
  const ready = new Promise(resolve => child.stdout.on("data", data => {
    stdout += data;
    if (stdout.split("\n").some(line => { try { return JSON.parse(line).id === 1; } catch { return false; } })) resolve();
  }));
  child.stderr.on("data", data => { stderr += data; });
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "shutdown-test", version: "1" },
    } }) + "\n");
    await bounded(ready, "MCP initialization failed: " + stderr);
    assert.ok(stderr.includes(`127.0.0.1:${port}`), "the previous cycle must release its exact port");
    if (cycle < 3) {
      socket = connect(port, "127.0.0.1");
      await once(socket, "connect");
      const upgraded = once(socket, "data");
      socket.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: chrome-extension://shutdown-test\r\n\r\n");
      assert.match(String((await bounded(upgraded, "WebSocket upgrade timed out"))[0]), /101 Switching Protocols/);
    }
    if (cycle === 0) {
      const browserRequest = once(socket, "data");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "inspect_page", arguments: {} } }) + "\n");
      await bounded(browserRequest, "Pending browser request was not dispatched");
    }
    if (cycle === 1) child.kill("SIGTERM");
    else if (cycle === 2) child.kill("SIGINT");
    else child.stdin.end(); // Codex/parent exits: its MCP stdin pipe closes.
    const [code] = await bounded(exited, `Bridge survived MCP disconnect in cycle ${cycle}; loopback port leaked`);
    assert.equal(code, 0);
    const probe = createServer();
    await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(port, "127.0.0.1", resolve); });
    await new Promise(resolve => probe.close(resolve));
  } finally {
    socket?.destroy();
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
  }
}

// EOF may already be present before initialization finishes.
const early = spawn(process.execPath, [serverPath], {
  env: { ...process.env, INT_PRACTICE_BRIDGE_PORT: String(port) }, stdio: ["pipe", "ignore", "ignore"],
});
const ended = once(early, "exit");
early.stdin.end();
try { assert.equal((await bounded(ended, "Early EOF leaked a bridge"))[0], 0); }
finally { if (early.exitCode === null && early.signalCode === null) { early.kill("SIGKILL"); await ended; } }
console.log("Server shutdown passed: MCP EOF, SIGTERM/SIGINT with a connected extension, 20 repeated port reuses and EOF before initialization");
