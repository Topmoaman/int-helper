# Install INT Helper with an AI assistant

This guide is for an assistant with terminal/file access on the user's computer. The goal is to install INT Helper and verify its connection. The installation request does not start, answer or submit a practice exam.

## 1. Inspect the local environment

- Identify the OS and shell. The maintainer's development/install environment is macOS; Windows/Linux end-to-end installation has not been verified. Use paths and quoting appropriate to the actual machine.
- Check `node --version`, `codex --version` and `codex plugin --help`. Node must be 20 or newer and Codex must expose plugin commands. Confirm Chrome is available.
- If a dependency is missing, explain the exact missing dependency and help the user set it up using its current official instructions. Do not claim the plugin is installed while prerequisites are missing. A normal text-only chat cannot perform the local install.
- If an exam task is running, finish or pause that task before replacing plugin/extension files. Keep existing history and local changes.

## 2. Get the latest stable source

Read the latest stable release at https://github.com/Topmoaman/int-helper/releases/latest and use its source ZIP/tag. Do not guess a version from this guide.

With Git available, clone into an unused user-selected or sensible project directory:

```sh
git clone https://github.com/Topmoaman/int-helper.git
cd int-helper
```

Then check out the exact stable release tag you just observed. Without Git, download/extract that release's source ZIP. Do not overwrite an existing modified checkout. The `int-helper-update.json` asset is consumed by the managed updater; it is not the source ZIP and cannot be loaded into Chrome.

Read the downloaded `README.md`, `install.mjs`, `int-helper/.mcp.json` and `int-helper/prototype-bridge/src/updater.mjs` before running installation. Use the repository's installer as written; no shell-piped remote installer or custom replacement MCP server is needed.

## 3. Run the installer

From the repository root (the folder containing `install.mjs`):

```sh
node install.mjs
```

The installer packages the included prebuilt runtime and runs these Codex operations internally:

- `codex plugin marketplace add <managed current directory> --json`
- `codex plugin add int-helper@int-helper-community --json`

It creates a stable installation below the current user's home directory at `.local/share/int-helper/install/current`, registers the marketplace, installs the plugin and prints an absolute Chrome extension path. Preserve that exact output. Normal installation does not require `npm install`, rebuilding, development tests or a new model API key.

If it fails, inspect the actual error and the local `codex plugin ... --help` output. Preserve the existing installation/history; report the blocker rather than silently changing model settings or inventing another installation layout. A retry is appropriate once the reported prerequisite or error is resolved.

## 4. Load the Chrome extension

Help with the following steps through available, authorized browser controls, or tell the user exactly which clicks remain:

1. Open `chrome://extensions`.
2. Disable an older INT Helper/INT Practice Bridge extension if present, so only the intended copy runs.
3. Enable **Developer mode** and choose **Load unpacked**.
4. Select the exact extension folder printed by the installer. Expand it to an absolute path; do not copy a path from someone else's machine.

On macOS the folder is typically `/Users/<username>/.local/share/int-helper/install/current/int-helper/prototype-bridge/extension`. In a macOS file picker, **Cmd+Shift+G** accepts the full path. Use the installed directory, not the source checkout, so managed updates and pairing work.

## 5. Verify the connection without answering an exam

- Open a new Codex task with **INT Helper** enabled. If the old INT Practice Helper plugin is enabled too, disable that older duplicate in this task.
- Have the user sign into their own practice account in Chrome and open a supported course overview. No account password needs to be copied into the repository, terminal or chat.
- Reload that page, then open the extension popup. Check its page/version and connection status against the installed manifest.
- In the new Codex task, discover the registered `int-helper-bridge` tools and call the read-only `inspect_page`. Do not use answering/submission tools as an installation check.
- If tools are missing, a connected extension badge is insufficient. Report the actual startup error. If it references a removed old plugin cache, restart Codex and use a new task; do not recreate the obsolete cache or launch a temporary alternate bridge.

The current runtime registers 19 tools. Confirm the installed plugin/extension versions, the absolute extension path and whether `inspect_page` succeeded. If a Chrome click or new Codex task still requires the user, say so explicitly instead of marking everything complete.

A startup handshake failure after a restart can also come from old orphan bridge processes occupying the local ports. Public 0.20.1 fixes future shutdown/port release; it cannot remove pre-existing orphans. Inspect the actual error and exact process ownership before any targeted cleanup; do not terminate all Node processes.

## Future updates

Managed installs starting at 0.18.0 can update in the extension popup: finish active practice work, leave the exam page, keep an idle compatible Codex bridge connected, then click **ตรวจรุ่นใหม่ → อัปเดตตอนนี้**. Reload the practice page and start a new Codex task afterward. The updater preserves separate history and stops on locally modified managed files.

After installation, point the user to the README's “ใช้ทำอะไรได้บ้าง” sections. Explain that they can describe a desired task naturally: help with one question, finish a chapter, continue unfinished subjects, leave answers for manual review, or pace a final attempt. No command syntax is required. Let the user choose their first practice task separately from installation.
