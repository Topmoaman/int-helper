import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createIntProjectAdapter } from "../src/web-adapters/int-project.mjs";
import { createVirtualSchoolAdapter } from "../src/web-adapters/virtual-school.mjs";

const fixture = readFileSync(new URL("fixtures/virtual-school/course-list-fragments.html", import.meta.url), "utf8");
for (const selector of [".card-body", "h3.card-title", ".prog-pct", ".final-status > .final--fail", "button.btn-primary", 'button[title="ย้อนกลับ"]']) {
  const pattern = {
    ".card-body": 'class="card-body"',
    "h3.card-title": 'h3 class="card-title"',
    ".prog-pct": 'class="prog-pct"',
    ".final-status > .final--fail": 'class="final--fail"',
    "button.btn-primary": 'button class="btn-primary"',
    'button[title="ย้อนกลับ"]': 'button[^>]+title="ย้อนกลับ"',
  }[selector];
  assert.match(fixture, new RegExp(pattern, "u"), `fixture must preserve ${selector}`);
}

class Node {
  constructor({ text = "", attrs = {}, children = {}, lists = {}, onClick = null, disabled = false } = {}) {
    this.innerText = text;
    this.attrs = attrs;
    this.children = children;
    this.lists = lists;
    this.onClick = onClick;
    this.disabled = disabled;
    this.clicks = 0;
    this.classList = { contains: (name) => String(attrs.class || "").split(/\s+/u).includes(name) };
  }
  getAttribute(name) { return this.attrs[name] ?? null; }
  querySelector(selector) { return this.children[selector]?.[0] || this.lists[selector]?.[0] || null; }
  querySelectorAll(selector) { return this.lists[selector] || this.children[selector] || []; }
  getClientRects() { return [1]; }
  click() { this.clicks += 1; this.onClick?.(); }
}

const makeVirtualPage = () => {
  const location = {
    hostname: "main.virtualschool.club",
    pathname: "/Course",
    href: "https://main.virtualschool.club/Course?level=6&term=2&focus=22&isBackLevel=1",
  };
  let mode = "course";
  const cards = [
    ["ภาษาไทย", "0%", "เริ่มเรียน", "Final: ยังไม่ผ่าน"],
    ["ชีววิทยา (หลักสูตรปรับปรุง 2560)", "90%", "ดำเนินการต่อ", "Final: ยังไม่ผ่าน"],
    ["โลก ดาราศาสตร์ และอวกาศ (เพิ่มเติม 60)", "75%", "ดำเนินการต่อ", "Final: ยังไม่ผ่าน"],
  ];
  const makeCards = () => cards.map(([title, progress, actionLabel, finalStatus]) => {
    const action = new Node({ text: actionLabel, attrs: { class: "btn-primary" }, onClick: () => {
      if (title !== "ชีววิทยา (หลักสูตรปรับปรุง 2560)") return;
      mode = "study";
      location.pathname = "/StudyCourse";
      location.href = "https://main.virtualschool.club/StudyCourse?code=22&subject=22&subjectCode=22&subj=22&level=J&selectedLevel=6&term=2&year=2569&title=ชีววิทยา%20(หลักสูตรปรับปรุง%202560)";
    } });
    return new Node({ lists: {
      "h3.card-title": [new Node({ text: title })],
      ".prog-pct": [new Node({ text: progress })],
      ".final-status": [new Node({ text: finalStatus })],
      ".final-status > .final--fail": [new Node({ text: "ยังไม่ผ่าน" })],
      "button.btn-primary": [action],
      ".meta-chip": [new Node({ text: "ภาคเรียนที่ 2" })],
    } });
  });
  const back = new Node({ attrs: { title: "ย้อนกลับ", class: "back" }, onClick: () => {
    mode = "course";
    location.pathname = "/Course";
    location.href = "https://main.virtualschool.club/Course?level=6&term=2&focus=22";
  } });
  const document = {
    get body() { return new Node({ text: "" }); },
    get mode() { return mode; },
    querySelectorAll(selector) {
      if (mode === "course" && selector === ".card-body") return makeCards();
      if (mode === "course" && selector === "button, a") return makeCards().map((card) => card.querySelector("button.btn-primary"));
      if (mode === "study" && selector === 'button[title="ย้อนกลับ"]') return [back];
      if (mode === "study" && selector === "button, a") return [back];
      if (selector === "article") return [];
      return [];
    },
    querySelector(selector) {
      if (mode === "study" && selector === 'button[title="ย้อนกลับ"]') return back;
      return null;
    },
  };
  return { location, document, cards };
};

{
  const { location, document, cards } = makeVirtualPage();
  const adapter = createVirtualSchoolAdapter({ document, location });
  assert.equal(adapter.supports(location), true);
  assert.equal(adapter.inspect().course.subjectCode, null);
  const first = adapter.handle("read_subjects");
  assert.equal(first.cards.length, 3);
  assert.equal(Object.prototype.hasOwnProperty.call(first.cards[1], "subjectCode"), false);
  assert.equal(first.cards[1].progress, 90);
  assert.notEqual(first.cards[1].cardToken, first.cards[2].cardToken);
  const originalToken = first.listToken;
  cards[1][1] = "95%";
  cards[1][3] = "Final: ยังไม่ผ่าน";
  const refreshed = adapter.handle("read_subjects");
  assert.equal(refreshed.listToken, originalToken, "progress/status changes must not stale the list identity");
  const biology = refreshed.cards[1];
  const opened = adapter.handle("open_subject", { listToken: refreshed.listToken, cardToken: biology.cardToken });
  assert.equal(opened.subjectCode, "22", "subject code comes from StudyCourse URL after clicking the card");
  assert.equal(opened.destinationConfirmed, true);
  const scope = { origin: "https://main.virtualschool.club", subjectCode: "22", level: "J", term: "2", year: "2569", mode: "subject" };
  const returned = adapter.handle("return_to_subjects", { scope });
  assert.equal(returned.destinationConfirmed, true);
  assert.equal(returned.listToken, originalToken);
  assert.throws(() => adapter.handle("open_subject", { listToken: "stale", cardToken: biology.cardToken }), /changed/);
}

{
  const { location, document, cards } = makeVirtualPage();
  const adapter = createVirtualSchoolAdapter({ document, location });
  const list = adapter.handle("read_subjects");
  cards[0][1] = "unknown";
  assert.throws(() => adapter.handle("read_subjects"), /progress is unknown/);
  cards[0][1] = "0%";
  cards[2][0] = "ภาษาไทย";
  assert.throws(() => adapter.handle("read_subjects"), /captions are ambiguous/);
  assert.equal(Object.prototype.hasOwnProperty.call(list.cards[0], "subjectCode"), false);
}

{
  const location = { hostname: "www.int-project.com", pathname: "/student/virtual_school/index.php", href: "https://www.int-project.com/student/virtual_school/index.php" };
  const document = { querySelectorAll: () => [], querySelector: () => null, body: new Node({ text: "" }) };
  const int = createIntProjectAdapter({ document, location });
  const virtual = createVirtualSchoolAdapter({ document, location: { ...location, hostname: "main.virtualschool.club" } });
  assert.equal(int.supports(location), true);
  assert.equal(virtual.supports(location), false);
  assert.equal(int.handle("page_version").contentVersion, "0.15.3");
}

{
  const location = { hostname: "main.virtualschool.club", pathname: "/Exam", href: "https://main.virtualschool.club/Exam?examtype=F" };
  const scoreValue = new Node({ text: "0 / 50" });
  const scoreLabel = new Node({ text: "คะแนนรวม" });
  scoreLabel.nextElementSibling = scoreValue;
  const body = new Node({ text: "ส่งคำตอบเรียบร้อยแล้ว" });
  const document = {
    body,
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === "p, span") return [scoreLabel];
      if (selector === "button, a") return [];
      return [];
    },
  };
  const adapter = createVirtualSchoolAdapter({ document, location });
  const result = adapter.handle("read_exam_result");
  assert.deepEqual(result.score, { correct: 0, total: 50, passed: null });
  assert.equal(result.reviewAvailable, false);
  assert.equal(result.submittedMarker, "ส่งคำตอบเรียบร้อยแล้ว");
}

function cardsProgressMutate(first) {
  // The adapter recomputes card DOM from the page. This assertion documents the
  // contract without making the token depend on mutable progress/status text.
  assert.match(first.listToken, /^virtual-list:/u);
}

console.log("Web adapter contract passed: site support, stable Virtual list identity, opaque card selection, StudyCourse code extraction, return verification, and stale/ambiguous/unknown rejection");
