const show = (id, text, tone = "") => {
  const element = document.getElementById(id);
  element.textContent = text;
  element.className = tone;
};
let refreshing = false;
const renderUpdate = update => {
  const block = document.getElementById("update-block"), button = document.getElementById("install-update"), dismiss = document.getElementById("dismiss-update");
  block.hidden = !update || !(update.available || update.busy || update.needsRestart || update.error);
  if (!update) return;
  button.hidden = !update.available || update.needsRestart;
  button.disabled = !update.canInstall || update.busy;
  dismiss.hidden = !update.needsRestart;
  show("update-title", update.busy ? "กำลังอัปเดต…" : update.needsRestart ? "อัปเดตเป็น v" + update.installed + " แล้ว" : update.available ? "มีรุ่นใหม่ v" + update.latest : "การตรวจอัปเดต");
  show("update-message", update.busy ? "รอสักครู่ ส่วนขยายจะรีโหลดเมื่อเสร็จ" : update.needsRestart ? "รีโหลดหน้าฝึกทำข้อสอบและเปิดงาน Codex ใหม่เพื่อใช้รุ่นนี้" : update.error || update.reason || "อัปเดตเพื่อใช้รุ่นล่าสุด คลังเฉลยเดิมจะยังอยู่");
};
const refresh = async () => {
  if (refreshing) return;
  refreshing = true;
  try {
    const status = await chrome.runtime.sendMessage({ action: "bridge_status" });
    if (!status || status.error) throw new Error(status?.error || "Status unavailable");
    renderUpdate(status.update);
    const connected = status.ports.length > 0;
    show("bridge", connected ? "เชื่อมต่อแล้ว" : "ยังไม่เชื่อมต่อ", connected ? "ready" : "warning");
    show("connection-help", connected ? `เชื่อมต่อ ${status.ports.length} ช่องทาง แต่ยังไม่ยืนยันว่า task นี้มีเครื่องมือพร้อมใช้` : "เปิด task ใน Codex ที่เปิดใช้ INT Helper");
    show("page", status.page === "ready" ? "พร้อมอ่าน" : status.page === "reload" ? "ต้องรีโหลดหน้าเว็บ" : "ไม่ใช่หน้าที่รองรับ", status.page === "ready" ? "ready" : "warning");
    show("page-help", status.page === "reload" ? "รีโหลดหน้าเว็บแล้วเปิดป๊อปอัปอีกครั้ง" : status.page === "ready" ? `หน้าเว็บ v${status.pageVersion} ตรงกับส่วนขยาย การเชื่อมต่อไม่ได้หมายถึงกำลังทำข้อสอบ` : "เลือกแท็บ INT Project หรือ Virtual School");
    const scopes = status.scopes || [];
    if (scopes.length) {
      show("scope", scopes.map(s => s.subjectName || s.subjectCode || "ข้อสอบปัจจุบัน").join(" · "), "ready");
      show("scope-help", scopes.map(s => {
        const mode = s.mode === "final" ? `ปลายภาค · ${s.retryUntilPerfect ? "วนจนได้ 50/50" : "ทำหนึ่งรอบ"}` : s.mode === "chapter" ? `บทที่ ${s.chapter}` : s.mode === "exam" ? `ข้อสอบนี้ · ${s.submissionAllowed ? "ส่งได้" : "ตอบเท่านั้น"}` : "ทั้งวิชา";
        return mode + (s.durationMinutes ? ` · ${s.durationMinutes} นาที/รอบ` : "");
      }).join(" / "));
    } else {
      show("scope", status.page === "unsupported" ? "เลือกแท็บแบบฝึกหัด" : "แท็บนี้ยังไม่มีขอบเขตงาน", "warning");
      show("scope-help", status.otherScopedTabs ? `มีงานผูกกับแท็บอื่น ${status.otherScopedTabs} แท็บ` : "กำหนดวิชาหรือข้อสอบใน Codex ก่อนเริ่มทำ");
    }
    show("version", `v${status.version}`);
  } catch {
    show("bridge", "ตรวจสถานะไม่ได้", "warning");
    show("page", "ยังไม่ได้ตรวจ");
    show("scope", "เปิดป๊อปอัปอีกครั้ง", "warning");
    for (const id of ["connection-help", "page-help", "scope-help", "version"]) show(id, "");
  } finally { refreshing = false; }
};
document.getElementById("install-update").onclick = async () => {
  document.getElementById("install-update").disabled = true;
  show("update-title", "กำลังอัปเดต…");
  const result = await chrome.runtime.sendMessage({ action: "install_update" });
  if (!result?.ok) { show("update-message", result?.error || "อัปเดตไม่สำเร็จ"); await refresh(); }
};
document.getElementById("check-update").onclick = async () => {
  const button = document.getElementById("check-update"); button.disabled = true; button.textContent = "กำลังตรวจ…";
  try { const result = await chrome.runtime.sendMessage({ action: "check_update" }); if (result?.ok) { renderUpdate(result.result); if (!result.result.available && !result.result.error) button.textContent = "เป็นรุ่นล่าสุดแล้ว"; } }
  finally { button.disabled = false; if (button.textContent === "กำลังตรวจ…") button.textContent = "ตรวจรุ่นใหม่"; }
};
document.getElementById("dismiss-update").onclick = async () => { await chrome.runtime.sendMessage({ action: "dismiss_update_restart" }); await refresh(); };
refresh();
setInterval(refresh, 2000);
