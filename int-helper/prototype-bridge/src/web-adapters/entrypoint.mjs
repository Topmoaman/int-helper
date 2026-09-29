import { CONTENT_VERSION } from "./content-helpers.mjs";
import { createIntProjectAdapter } from "./int-project.mjs";
import { createVirtualSchoolAdapter } from "./virtual-school.mjs";
import { waitForReady } from "./readiness.mjs";

(() => {
  if (globalThis.__intPracticeBridgeInstalled) return;
  globalThis.__intPracticeBridgeInstalled = true;
  const pageInstanceId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const wakeBridge = () => chrome.runtime.sendMessage({ action: "keep_bridge_awake" }).catch(() => {});
  wakeBridge();
  setInterval(wakeBridge, 20_000);

  const adapters = [
    createIntProjectAdapter({ document, location }),
    createVirtualSchoolAdapter({ document, location }),
  ];

  const currentAdapter = () => adapters.find((adapter) => adapter.supports(location));
  const pageIdentity = () => ({ contentVersion: CONTENT_VERSION, pageInstanceId, url: location.href, capabilities: ['scoped_envelope', 'page_identity', 'wait_question'] });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      if (message.expectedContentVersion && message.expectedContentVersion !== CONTENT_VERSION) {
        throw new Error('Practice page needs reloading before it can be used');
      }
      if (message.action === 'scoped_action') {
        if (message.expectedContentVersion !== CONTENT_VERSION || !message.request?.scope ||
            message.request.expectedContentVersion !== CONTENT_VERSION || message.request.action === 'scoped_action') {
          throw new Error('Invalid scoped version envelope');
        }
        message = message.request;
      }
      if (message.action === "page_version") {
        sendResponse({ ok: true, result: pageIdentity() });
        return true;
      }
      const adapter = currentAdapter();
      if (!adapter) throw new Error("Unsupported practice origin");
      if (message.action === 'page_identity') {
        let examCode = null;
        try { examCode = adapter.handle('read_question', message).examCode || null; }
        catch (error) { if (/reload|scope|version/iu.test(error.message)) throw error; }
        sendResponse({ ok: true, result: { ...pageIdentity(), examCode } });
        return true;
      }
      if (message.action === 'wait_question') {
        waitForReady({ document,
          read: () => {
            if (currentAdapter() !== adapter) throw new Error('Unsupported practice origin after navigation');
            return adapter.handle('read_question', message);
          },
          ready: question => !question.saving && (question.examCode !== message.previousExamCode || message.allowSame === true),
        }).then(result => sendResponse({ ok: true, result }), error => sendResponse({ ok: false, error: error.message }));
        return true;
      }
      const result = adapter.handle(message.action, message);
      if (result === null || result === undefined) return false;
      sendResponse({ ok: true, result });
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
    return true;
  });
})();
