# INT Practice Helper

A Codex plugin and local Chrome extension for authorized practice on INT Project and Virtual School. It uses the active Codex model; no separate model API key is required. This is an unofficial local prototype, not affiliated with either learning platform.

Shared version: **0.17.0+codex.20260910** · Chrome extension: **0.12.0**.

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
git clone https://github.com/Topmoaman/int-practice-helper.git
cd int-practice-helper
```

Keep this folder: Chrome loads the extension from it. Prebuilt MCP bundles are included, so normal installation does not require npm install.

### 2. Install the Codex plugin

From the extracted repository folder:

```sh
codex plugin marketplace add .
codex plugin add int-practice-helper@int-practice-community
```

Alternatively, register the GitHub marketplace directly:

```sh
codex plugin marketplace add Topmoaman/int-practice-helper --ref main
codex plugin add int-practice-helper@int-practice-community
```

You still need a local copy of the extension folder for Chrome. Enable the installed plugin in Codex and open a new task so its tools load.

### 3. Load the Chrome extension

1. Open Chrome's extension manager (`chrome://extensions`).
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select `int-practice-helper/prototype-bridge/extension` inside this repository.
5. Open your signed-in practice page and reload it.

When Codex starts this plugin's MCP server, the extension connects over localhost. Its popup shows connection and page status. A connection alone does not start answering anything.

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
cd int-practice-helper/prototype-bridge
npm ci
npm run build
npm run check
```

The checks use local simulated pages and mock extension connections. They do not answer or submit a live website exam. Test coverage includes scope, submission, review, duplicate history, exact answer reuse, stale codes and multiple MCP sessions. A full live Virtual School review/retry cycle has not been implemented.

Runtime code in this shared snapshot matches the working plugin. Sharing changes are limited to packaging, documentation and removing the original user's standing instructions. Third-party dependency notices are in `THIRD_PARTY_NOTICES.md`.
