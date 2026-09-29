// Observe the document because SPA navigation may replace the question root.
// A mutation is only a wakeup: read() must validate scope and question identity.
export const waitForReady = ({ read, ready, document, timeoutMs = 6000,
  Observer = globalThis.MutationObserver, intervalMs = 150 }) => new Promise((resolve, reject) => {
  let observer, poll, deadline, settled = false;
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    observer?.disconnect();
    clearInterval(poll);
    clearTimeout(deadline);
    error ? reject(error) : resolve(value);
  };
  const check = () => {
    if (settled) return;
    try { const value = read(); if (ready(value)) finish(null, value); }
    catch (error) {
      if (/scope|reload|version|unsupported|current exam changed/iu.test(error.message)) finish(error);
      // Missing question markup can be transient during navigation.
    }
  };
  check();
  if (settled) return;
  if (Observer && document.documentElement) {
    observer = new Observer(check);
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  }
  poll = setInterval(check, intervalMs); // Property-only changes need a fallback.
  deadline = setTimeout(() => finish(new Error('Timed out waiting for the next question')), timeoutMs);
  check(); // Close the gap between the first read and observer registration.
});
