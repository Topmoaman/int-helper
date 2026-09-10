import { fileURLToPath } from 'node:url';
import { createPackage, createUpdater, INSTALL_HOME } from './int-helper/prototype-bridge/src/updater.mjs';
if (process.argv.includes('--help')) {
  console.log('Usage: node install.mjs\nInstalls into ' + INSTALL_HOME + '\nClose active practice tasks before installation. It does not change your question history.');
} else {
  try {
    const result = await createUpdater().apply(await createPackage(fileURLToPath(new URL('.', import.meta.url))), { initial: true });
    console.log(result.updated ? 'Installed ' + result.version + '.\nChrome → Extensions → Load unpacked:\n' + result.extensionPath + '\nDisable any older INT Helper extension. Open a new Codex task. Future updates are available in the popup.' : 'Already installed: ' + result.version + '.');
  } catch (error) {
    console.error('Installation failed:', error.message);
    process.exitCode = 1;
  }
}
