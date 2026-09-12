import { isNewer, REPOSITORY } from './updater.mjs';

// Consume the extension's cached release check; never fetch or install while answering.
export const createUpdateNotice = current => {
  let latest = null;
  const announced = new Set();
  return {
    observe(status) {
      if (!/^\d+\.\d+\.\d+$/.test(status?.latest || '')) return;
      if (isNewer(status.latest, current) && (!latest || isNewer(status.latest, latest))) latest = status.latest;
    },
    take() {
      if (!latest || announced.has(latest)) return null;
      announced.add(latest);
      return {
        current, latest,
        releaseUrl: `https://github.com/${REPOSITORY}/releases/tag/v${latest}`,
        message: `INT Helper v${latest} is available (this task uses v${current}). Tell the user briefly once, then continue their authorized work. To update, finish the task and leave the exam, open the extension popup, choose Check for updates then Update now, reload the practice page and open a new Codex task. Manual installations may need node install.mjs once.`,
      };
    },
  };
};
