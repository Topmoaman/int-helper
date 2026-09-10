# INT Helper

A Codex plugin and local Chrome extension for authorized practice on INT Project and Virtual School. It uses the active Codex model; no separate model API key is required. This is an unofficial local prototype, not affiliated with either learning platform.

Shared version: **0.18.0** · Chrome extension: **0.13.0**.

## What works

| Feature | INT Project | Virtual School |
| --- | --- | --- |
| Read text and image questions | Supported | Supported |
| Scoped answers and guarded submission | Supported | Supported |
| One-attempt final mode (Normal) | Supported | Supported |
| Extract verified correct answers from review | Supported | Planned |
| Unique subject answer bank and known-answer batches | Supported | Full workflow planned |
| Review and retry 50-question finals (Loop) | Supported | Planned |
| Minimum duration per final attempt | Supported | Planned |

Virtual School support is partial. A finished attempt or a passing grade does not guarantee a full score. Loop needs Codex to remain active and can stop for usage limits, unavailable review data or site restrictions.

## Install

You need Chrome, Node.js 20 or newer, Codex with plugin support, and your own signed-in practice account. `node` must be available to Codex. These instructions use the Codex CLI for plugin installation; the plugin can then be used in the desktop app.

### 1. Get the files

Download and extract this repository using **Code → Download ZIP**, or clone it:

```sh
git clone https://github.com/Topmoaman/int-helper.git
cd int-helper
```

Keep this folder: Chrome loads the extension from it. Prebuilt MCP bundles are included, so normal installation does not require npm install.

### 2. Run the one-time installer

Close any active practice tasks, then run this command from the extracted repository folder:

```sh
node install.mjs
```

It installs the plugin through Codex into a stable directory under `~/.local/share/int-helper/install/current/` and prints the extension path. Node.js and the `codex` command must be on PATH. The installer registers the `int-helper-community` marketplace and installs `int-helper`. It does not alter your saved question history.

### 3. Load the installed extension once

1. Open Chrome's extension manager (`chrome://extensions`).
2. Disable the old Practice Bridge extension if you already installed it.
3. Enable **Developer mode** and choose **Load unpacked**.
4. Select the exact extension folder printed by the installer, normally `~/.local/share/int-helper/install/current/int-helper/prototype-bridge/extension` (expand `~` to your home directory).
5. Reload the practice page and open a new Codex task with **INT Helper** enabled. Disable the older INT Practice Helper plugin in that task if it is still installed.

Load the installed folder, not the downloaded source folder, to enable the update button.

## Updates

The extension checks public GitHub Releases at startup and approximately every four hours while Chrome is running. A new stable release shows **UP** on the extension icon and **มีรุ่นใหม่** in its popup. You can also press **ตรวจรุ่นใหม่**. Checking never installs an update or sends practice questions to GitHub.

When an update is available:

1. Finish the current practice task and leave the exam page. Open an idle Codex task with INT Helper connected if needed.
2. Click **อัปเดตตอนนี้** in the popup.
3. The local bridge downloads the release, validates file checksums, keeps a previous copy, installs the new Codex plugin and reloads the extension.
4. Reload the practice page and open a new Codex task to load the new tools.

The update button requires the one-time installer above and a connected compatible bridge. It stays disabled while a practice scope is unfinished or any supported exam page is open. Internet/installation failures are shown in the popup; an already known update remains visible while offline. Local edits stop an update rather than being overwritten. Failed installation restores the previous files and attempts to restore the previous Codex plugin. Saved history is outside the install directory and is preserved.

This is a user-triggered updater for an unpacked extension, not Chrome Web Store auto-update. Old 0.17 installations need the one-time setup to receive this capability. Merely pushing commits does not notify users: publish a stable GitHub Release containing the update asset.

## Use

Start on the course overview for chapter, subject or final-only tasks. Use your own subject name and explicitly state the actions you want.

Normal example:

> ทำปลายภาควิชาที่เปิดอยู่แบบ Normal 1 รอบ อนุญาตให้ตอบ บันทึก และส่งคำตอบ แล้วรายงานคะแนน

INT Loop example:

> ทำปลายภาควิชาที่เปิดอยู่แบบ Loop อนุญาตให้ตอบ บันทึก ส่งคำตอบ อ่านเฉลย และเริ่มรอบใหม่ในวิชาเดิมทุกครั้งจนได้ 50/50 โดยไม่ต้องถามยืนยันซ้ำ

Optional pacing:

> ใช้เวลาอย่างน้อย 60 นาทีต่อรอบ

History is off by default. Ask to enable it if you want questions remembered; enabling INT Loop also enables history. This shared edition does not inherit the original author's pretest preferences. Specify whether pretests should be answered or submitted empty.

## Local data and connection

No saved questions, answer banks, browser sessions, credentials or personal task transcripts are included. Each user signs into the practice website in their own Chrome profile.

When enabled, question text/images, answer events and verified review evidence are stored in that user's `~/.local/share/int-practice-helper/history/`. `INT_PRACTICE_HISTORY_DIR` changes this directory. These files are excluded from Git. Disable history through the plugin to stop future recording.

The bridge binds to `127.0.0.1` on ports 17373–17388. This prototype checks Chrome-extension origins but does not pair to one specific extension ID; do not expose the bridge to other machines. Questions and images are returned to the active Codex session for reasoning.

## Update and troubleshoot

- After replacing the extension files, click **Reload** on its Chrome extension card, then reload the practice page.
- After updating/reinstalling the plugin, open a new Codex task.
- If `node` is missing, install Node.js and restart Codex so it sees the updated PATH.
- If a question code becomes stale, use the fresh code returned by the bridge; a page reload is only needed for extension/page version mismatch or lost scope.
- The extension does not independently solve questions or keep an exam running after Codex disconnects.

## Development

```sh
cd int-helper/prototype-bridge
npm ci
npm run build
npm run check
```

The checks use local simulated pages and mock extension connections. They do not answer or submit a live website exam. Test coverage includes scope, submission, review, duplicate history, exact answer reuse, stale codes and multiple MCP sessions. A full live Virtual School review/retry cycle has not been implemented.

This release adds a managed updater and renames the shared plugin to INT Helper. Virtual School review/Loop parity remains planned. Third-party dependency notices are in `THIRD_PARTY_NOTICES.md`.

## Publishing a release

Bump the plugin version, the `VERSION` constant in `extension/updates.js`, the extension manifest/content versions and test expectations together. Build and test, then generate the asset from the repository root:

```sh
node scripts/build-release.mjs release
```

Publish a stable tag such as `v0.18.0` with `release/int-helper-update.json` attached. The tag and plugin version must match exactly. Update sources are restricted to this repository; file paths are allowlisted and local pairing credentials are excluded from release packages. Checksums detect damaged content; trust in the publisher comes from GitHub HTTPS and repository ownership, not a separate signing key.
