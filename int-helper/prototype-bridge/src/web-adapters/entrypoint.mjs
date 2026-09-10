import { CONTENT_VERSION } from "./content-helpers.mjs";
import { createIntProjectAdapter } from "./int-project.mjs";
import { createVirtualSchoolAdapter } from "./virtual-school.mjs";

(() => {
  if (globalThis.__intPracticeBridgeInstalled) return;
  globalThis.__intPracticeBridgeInstalled = true;

  const wakeBridge = () => chrome.runtime.sendMessage({ action: "keep_bridge_awake" }).catch(() => {});
  wakeBridge();
  setInterval(wakeBridge, 20_000);

  const adapters = [
    createIntProjectAdapter({ document, location }),
    createVirtualSchoolAdapter({ document, location }),
  ];

  const currentAdapter = () => adapters.find((adapter) => adapter.supports(location));

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      if (message.action === "page_version") {
        sendResponse({ ok: true, result: { contentVersion: CONTENT_VERSION } });
        return true;
      }
      const adapter = currentAdapter();
      if (!adapter) throw new Error("Unsupported practice origin");
      const result = adapter.handle(message.action, message);
      if (result === null || result === undefined) return false;
      sendResponse({ ok: true, result });
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
    return true;
  });
})();
