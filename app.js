/* Study Aid — courses, materials, and Claude-generated quizzes & flashcards.
 * All data lives in localStorage; generation calls the Anthropic Messages API
 * directly from the browser with structured (JSON-schema) outputs.
 */

"use strict";

/* ================================================================
 * State & persistence
 * ================================================================ */

const STORAGE_KEY = "studyAidState_v1";
const API_KEY_STORAGE = "studyAidApiKey";

const COURSE_COLORS = ["#c05621", "#2f7d4f", "#2b6cb0", "#805ad5", "#b83280", "#986801", "#0e7490"];

let state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.error("Failed to load saved state", e);
  }
  return { courses: [], activeCourseId: null };
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    toast("⚠️ Could not save — browser storage may be full.");
  }
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function activeCourse() {
  return state.courses.find((c) => c.id === state.activeCourseId) || null;
}

/* ================================================================
 * Anthropic API (browser direct access, structured outputs)
 * ================================================================ */

const MODEL = "claude-opus-4-8";

const QUIZ_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Short descriptive title for this quiz" },
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: {
            type: "array",
            items: { type: "string" },
            description: "Exactly 4 answer options",
          },
          correctIndex: { type: "integer", enum: [0, 1, 2, 3] },
          explanation: {
            type: "string",
            description: "Why the correct answer is right and the others are wrong",
          },
        },
        required: ["question", "options", "correctIndex", "explanation"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "questions"],
  additionalProperties: false,
};

const FLASHCARD_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Short descriptive title for this deck" },
    cards: {
      type: "array",
      items: {
        type: "object",
        properties: {
          front: { type: "string", description: "Prompt side: a term, concept, or question" },
          back: { type: "string", description: "Answer side: concise definition or answer" },
        },
        required: ["front", "back"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "cards"],
  additionalProperties: false,
};

async function callClaude({ system, user, schema }) {
  const apiKey = localStorage.getItem(API_KEY_STORAGE);
  if (!apiKey) {
    const err = new Error("No API key set. Click ⚙️ in the sidebar to add your Anthropic API key.");
    err.noKey = true;
    throw err;
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system,
      output_config: { format: { type: "json_schema", schema } },
      messages: [{ role: "user", content: user }],
    }),
  });

  if (!res.ok) {
    let msg = `API error (HTTP ${res.status})`;
    try {
      const body = await res.json();
      if (body?.error?.message) msg = body.error.message;
    } catch (_) { /* non-JSON error body */ }
    if (res.status === 401) msg = "Invalid API key — check it in Settings (⚙️).";
    if (res.status === 429) msg = "Rate limited by the API — wait a minute and try again.";
    throw new Error(msg);
  }

  const data = await res.json();

  if (data.stop_reason === "refusal") {
    throw new Error("The model declined to generate content from this material.");
  }
  if (data.stop_reason === "max_tokens") {
    throw new Error("The response was cut off — try generating fewer items at once.");
  }

  const textBlock = data.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("The API returned no content — please try again.");
  return JSON.parse(textBlock.text);
}

function buildGenPrompt(course, materials, count, difficulty, focus, kind, avoid = []) {
  const sources = materials
    .map((m) => `<material title="${m.name.replace(/"/g, "'")}">\n${m.text}\n</material>`)
    .join("\n\n");

  const difficultyNote = {
    mixed: "Mix difficulty: some recall questions, some application/analysis.",
    introductory: "Keep items introductory: definitions, core concepts, straightforward recall.",
    challenging: "Make items challenging: application, analysis, edge cases, and common misconceptions.",
  }[difficulty];

  const focusNote = focus
    ? `Focus specifically on: ${focus}. Only cover other topics if needed for context.`
    : "Cover the material broadly, weighting the most important concepts.";

  const kindNote =
    kind === "quiz"
      ? `Create exactly ${count} multiple-choice questions. Each question must have exactly 4 options with exactly one correct answer. Make distractors plausible (common mistakes or related concepts), not obviously wrong. Vary which option index is correct. Every explanation should teach — say why the right answer is right and briefly why the tempting distractors are wrong.`
      : `Create exactly ${count} flashcards. Fronts should be terms, concepts, or short questions; backs should be concise, self-contained answers (1-3 sentences). Don't duplicate concepts across cards.`;

  const avoidNote = avoid.length
    ? `\nThe following items are already in this study set. Do NOT duplicate or closely paraphrase any of them — cover different facts, concepts, or angles from the materials:\n${avoid.map((a) => `- ${a}`).join("\n")}\n`
    : "";

  return {
    system:
      "You are an expert tutor creating study materials for a university student. " +
      "Base every item strictly on the provided course materials — do not invent facts that are not supported by them. " +
      "Write clearly and precisely at the level of the source material.",
    user:
      `Course: ${course.name}\n\n` +
      `Source materials:\n${sources}\n\n` +
      `Task: ${kindNote}\n${difficultyNote}\n${focusNote}\n${avoidNote}` +
      `Also produce a short title describing what this set covers.`,
  };
}

/* ================================================================
 * File reading (txt/md/pdf)
 * ================================================================ */

const PDFJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
let pdfjsReady = null;

function loadPdfJs() {
  if (pdfjsReady) return pdfjsReady;
  pdfjsReady = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = PDFJS_URL;
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      resolve(window.pdfjsLib);
    };
    s.onerror = () => reject(new Error("Could not load the PDF reader (are you offline?)."));
    document.head.appendChild(s);
  });
  return pdfjsReady;
}

async function extractPdfText(file) {
  const pdfjs = await loadPdfJs();
  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((it) => it.str).join(" "));
  }
  const text = pages.join("\n\n").replace(/[ \t]+/g, " ").trim();
  if (!text) throw new Error(`"${file.name}" appears to be a scanned/image PDF with no extractable text.`);
  return text;
}

async function readUploadedFile(file) {
  if (file.name.toLowerCase().endsWith(".pdf") || file.type === "application/pdf") {
    return extractPdfText(file);
  }
  const text = (await file.text()).trim();
  if (!text) throw new Error(`"${file.name}" is empty.`);
  return text;
}

/* ================================================================
 * DOM helpers
 * ================================================================ */

const $ = (sel) => document.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? "" : v);
  }
  for (const child of children) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(child));
  }
  return node;
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

/* ================================================================
 * Rendering — sidebar & course shell
 * ================================================================ */

function renderSidebar() {
  const list = $("#courseList");
  list.replaceChildren();
  state.courses.forEach((course) => {
    list.append(
      el(
        "div",
        {
          class: "course-item" + (course.id === state.activeCourseId ? " active" : ""),
          onclick: () => selectCourse(course.id),
        },
        el("span", { class: "course-dot", style: `background:${course.color}` }),
        el("span", { class: "course-item-name" }, course.name),
        el("span", { class: "course-item-count" }, String(course.materials.length))
      )
    );
  });
}

function renderCourse() {
  const course = activeCourse();
  $("#emptyState").hidden = !!course;
  $("#courseView").hidden = !course;
  if (!course) return;

  $("#courseTitle").textContent = course.name;
  const s = course.stats;
  $("#courseStats").textContent =
    s.answered > 0
      ? `${s.quizzesTaken} quiz${s.quizzesTaken === 1 ? "" : "zes"} taken · ${Math.round((s.correct / s.answered) * 100)}% correct overall`
      : "";

  renderMaterials(course);
  renderGeneratePicker(course);
  renderQuizList(course);
  renderDeckList(course);
}

function renderAll() {
  renderSidebar();
  renderCourse();
}

/* ================================================================
 * Courses
 * ================================================================ */

function addCourse(name) {
  const course = {
    id: uid(),
    name,
    color: COURSE_COLORS[state.courses.length % COURSE_COLORS.length],
    materials: [],
    quizzes: [],
    decks: [],
    stats: { quizzesTaken: 0, answered: 0, correct: 0 },
  };
  state.courses.push(course);
  state.activeCourseId = course.id;
  saveState();
  renderAll();
}

function selectCourse(id) {
  state.activeCourseId = id;
  closePlayers();
  saveState();
  renderAll();
}

function closePlayers() {
  $("#quizPlayer").hidden = true;
  $("#quizList").hidden = false;
  $("#deckPlayer").hidden = true;
  $("#deckList").hidden = false;
}

/* ================================================================
 * Materials tab
 * ================================================================ */

function renderMaterials(course) {
  const list = $("#materialList");
  list.replaceChildren();
  if (course.materials.length === 0) {
    list.append(el("div", { class: "set-list" }, el("div", { class: "empty-note" }, "No materials yet — upload something above.")));
    return;
  }
  course.materials.forEach((m) => {
    list.append(
      el(
        "div",
        { class: "material-item" },
        el("span", { class: "material-icon" }, m.source === "pdf" ? "📕" : "📄"),
        el(
          "div",
          { class: "material-info" },
          el("div", { class: "material-name" }, m.name),
          el("div", { class: "material-meta" }, `${wordCount(m.text).toLocaleString()} words · added ${fmtDate(m.addedAt)}`)
        ),
        el("button", {
          class: "btn btn-danger btn-sm",
          onclick: () => {
            if (!confirm(`Delete "${m.name}"? Quizzes and decks made from it are kept.`)) return;
            course.materials = course.materials.filter((x) => x.id !== m.id);
            saveState();
            renderCourse();
          },
        }, "Delete")
      )
    );
  });
}

function addMaterial(course, name, text, source) {
  course.materials.push({ id: uid(), name, text, source, addedAt: Date.now() });
  saveState();
  renderAll();
}

async function handleFiles(files) {
  const course = activeCourse();
  if (!course) return;
  for (const file of files) {
    try {
      toast(`Reading ${file.name}…`);
      const text = await readUploadedFile(file);
      const source = file.name.toLowerCase().endsWith(".pdf") ? "pdf" : "text";
      addMaterial(course, file.name, text, source);
      toast(`✅ Added "${file.name}"`);
    } catch (e) {
      toast(`⚠️ ${e.message}`);
    }
  }
}

/* ================================================================
 * Generate tab
 * ================================================================ */

function renderGeneratePicker(course) {
  const picker = $("#genMaterialPicker");
  picker.replaceChildren();
  if (course.materials.length === 0) {
    picker.append(el("div", { class: "empty-note" }, "Upload materials first (Materials tab)."));
    $("#generateBtn").disabled = true;
    return;
  }
  $("#generateBtn").disabled = false;
  course.materials.forEach((m, i) => {
    picker.append(
      el(
        "label",
        {},
        el("input", { type: "checkbox", value: m.id, checked: i === course.materials.length - 1 || course.materials.length <= 3 }),
        `${m.name} (${wordCount(m.text).toLocaleString()} words)`
      )
    );
  });
}

function setGenStatus(html, isError) {
  const box = $("#genStatus");
  box.hidden = false;
  box.classList.toggle("error", !!isError);
  box.innerHTML = html;
}

/* Items per API call. One response can only hold so many tokens, so larger
 * sets are built across multiple calls, each told what's already covered. */
const GEN_BATCH_SIZE = 15;

function autoItemCount(materials) {
  const words = materials.reduce((sum, m) => sum + wordCount(m.text), 0);
  // Roughly one item per ~80 words of source, within sane bounds.
  return Math.max(10, Math.min(75, Math.round(words / 80)));
}

/* Generate up to `target` items of `kind`, batching API calls as needed.
 * Returns {title, items, warning} — `warning` is set if a later batch failed
 * after some items had already been collected (partial result). */
async function generateSet(kind, target, course, materials, difficulty, focus) {
  const label = kind === "quiz" ? "quiz questions" : "flashcards";
  const schema = kind === "quiz" ? QUIZ_SCHEMA : FLASHCARD_SCHEMA;
  const items = [];
  let title = null;
  let warning = null;

  while (items.length < target) {
    const n = Math.min(GEN_BATCH_SIZE, target - items.length);
    setGenStatus(
      `<span class="spinner"></span> Generating ${label}… ${items.length} of ${target} done. Larger sets take a few minutes.`
    );
    const avoid = items.map((it) => (kind === "quiz" ? it.question : it.front));
    const { system, user } = buildGenPrompt(course, materials, n, difficulty, focus, kind, avoid);

    let result;
    try {
      result = await callClaude({ system, user, schema });
    } catch (e) {
      if (items.length === 0) throw e; // nothing salvageable — surface the error
      warning = e.message;
      break; // keep what we have
    }

    if (!title && result.title) title = result.title;
    const fresh =
      kind === "quiz"
        ? (result.questions || []).filter((q) => Array.isArray(q.options) && q.options.length === 4)
        : (result.cards || []).filter((c) => c.front && c.back);
    if (fresh.length === 0) break; // the material is exhausted
    items.push(...fresh);
  }

  return { title, items: items.slice(0, target), warning };
}

async function handleGenerate() {
  const course = activeCourse();
  if (!course) return;

  const selectedIds = [...$("#genMaterialPicker").querySelectorAll("input:checked")].map((i) => i.value);
  const materials = course.materials.filter((m) => selectedIds.includes(m.id));
  if (materials.length === 0) {
    setGenStatus("Select at least one material.", true);
    return;
  }

  const type = $("#genType").value;
  const countRaw = $("#genCount").value;
  const count = countRaw === "auto" ? autoItemCount(materials) : parseInt(countRaw, 10);
  const difficulty = $("#genDifficulty").value;
  const focus = $("#genFocus").value.trim();
  const kinds = type === "both" ? ["quiz", "flashcards"] : [type];

  const btn = $("#generateBtn");
  btn.disabled = true;

  try {
    const warnings = [];
    for (const kind of kinds) {
      const { title, items, warning } = await generateSet(kind, count, course, materials, difficulty, focus);
      if (items.length === 0) throw new Error("No usable items came back — please try again.");
      if (warning) warnings.push(`saved ${items.length} of ${count} (a later batch failed: ${warning})`);

      if (kind === "quiz") {
        course.quizzes.unshift({ id: uid(), title: title || "Quiz", createdAt: Date.now(), questions: items, best: null });
      } else {
        course.decks.unshift({ id: uid(), title: title || "Flashcards", createdAt: Date.now(), cards: items });
      }
      saveState();
    }

    renderCourse();
    const where = type === "both" ? "the Quizzes and Flashcards tabs" : type === "quiz" ? "the Quizzes tab" : "the Flashcards tab";
    setGenStatus(
      warnings.length
        ? `⚠️ Partly done — ${warnings.join("; ")}. Find the results in ${where}.`
        : `✅ Done! Find your new material in ${where}.`
    );
  } catch (e) {
    setGenStatus(`⚠️ ${e.message}`, true);
    if (e.noKey) $("#settingsModal").showModal();
  } finally {
    btn.disabled = false;
  }
}

/* ================================================================
 * Quizzes tab
 * ================================================================ */

function renderQuizList(course) {
  const list = $("#quizList");
  list.replaceChildren();
  if (course.quizzes.length === 0) {
    list.append(el("div", { class: "empty-note" }, "No quizzes yet — create one in the Generate tab."));
    return;
  }
  course.quizzes.forEach((quiz) => {
    list.append(
      el(
        "div",
        { class: "set-item" },
        el("span", { class: "material-icon" }, "❓"),
        el(
          "div",
          { class: "set-info" },
          el("div", { class: "set-title" }, quiz.title),
          el(
            "div",
            { class: "set-meta" },
            `${quiz.questions.length} questions · created ${fmtDate(quiz.createdAt)}` +
              (quiz.best != null ? ` · best score ${quiz.best}%` : "")
          )
        ),
        el("button", { class: "btn btn-primary btn-sm", onclick: () => startQuiz(course, quiz) }, "Take quiz"),
        el("button", {
          class: "btn btn-danger btn-sm",
          onclick: () => {
            if (!confirm(`Delete quiz "${quiz.title}"?`)) return;
            course.quizzes = course.quizzes.filter((q) => q.id !== quiz.id);
            saveState();
            renderCourse();
          },
        }, "Delete")
      )
    );
  });
}

function startQuiz(course, quiz) {
  const order = quiz.questions.map((_, i) => i).sort(() => Math.random() - 0.5);
  const session = { course, quiz, order, index: 0, correct: 0 };
  $("#quizList").hidden = true;
  const player = $("#quizPlayer");
  player.hidden = false;
  renderQuizQuestion(session, player);
}

function renderQuizQuestion(session, player) {
  const { quiz, order, index } = session;

  if (index >= order.length) {
    renderQuizResult(session, player);
    return;
  }

  const q = quiz.questions[order[index]];
  player.replaceChildren(
    el(
      "div",
      { class: "player-top" },
      el("span", {}, `Question ${index + 1} of ${order.length}`),
      el("button", { class: "btn btn-ghost btn-sm", onclick: () => { closePlayers(); renderCourse(); } }, "✕ Exit")
    ),
    el("div", { class: "progress-bar" }, el("div", { class: "progress-fill", style: `width:${(index / order.length) * 100}%` })),
    el(
      "div",
      { class: "question-card" },
      el("div", { class: "question-text" }, q.question),
      el(
        "div",
        { class: "options" },
        ...q.options.map((opt, i) =>
          el("button", { class: "option", onclick: (ev) => answerQuestion(session, player, i, ev.currentTarget) }, `${"ABCD"[i]}.  ${opt}`)
        )
      ),
      el("div", { class: "explanation", hidden: true, id: "explanationBox" })
    ),
    el("div", { class: "player-actions", id: "quizActions" })
  );
}

function answerQuestion(session, player, chosen, chosenBtn) {
  const q = session.quiz.questions[session.order[session.index]];
  const buttons = player.querySelectorAll(".option");
  buttons.forEach((b) => (b.disabled = true));
  buttons[q.correctIndex].classList.add("correct");

  const isCorrect = chosen === q.correctIndex;
  if (isCorrect) session.correct++;
  else chosenBtn.classList.add("incorrect");

  session.course.stats.answered++;
  if (isCorrect) session.course.stats.correct++;
  saveState();

  const box = player.querySelector("#explanationBox");
  box.hidden = false;
  box.replaceChildren(el("strong", {}, isCorrect ? "✅ Correct!" : "❌ Not quite."), q.explanation);

  player.querySelector("#quizActions").append(
    el(
      "button",
      {
        class: "btn btn-primary",
        onclick: () => {
          session.index++;
          renderQuizQuestion(session, player);
        },
      },
      session.index + 1 >= session.order.length ? "See results" : "Next question →"
    )
  );
  player.querySelector("#quizActions button").focus();
}

function renderQuizResult(session, player) {
  const { course, quiz, order, correct } = session;
  const pct = Math.round((correct / order.length) * 100);
  course.stats.quizzesTaken++;
  if (quiz.best == null || pct > quiz.best) quiz.best = pct;
  saveState();

  const message =
    pct === 100 ? "Perfect score — you know this cold." :
    pct >= 80 ? "Great work — nearly there." :
    pct >= 60 ? "Solid — review the misses and go again." :
    "Keep at it — retake after reviewing the material.";

  player.replaceChildren(
    el(
      "div",
      { class: "quiz-result" },
      el("div", { class: "score" }, `${pct}%`),
      el("p", {}, `${correct} of ${order.length} correct. ${message}`),
      el(
        "div",
        { class: "player-actions", style: "justify-content:center" },
        el("button", { class: "btn btn-primary", onclick: () => startQuiz(course, quiz) }, "Retake quiz"),
        el("button", { class: "btn", onclick: () => { closePlayers(); renderCourse(); } }, "Back to quizzes")
      )
    )
  );
}

/* ================================================================
 * Flashcards tab
 * ================================================================ */

function renderDeckList(course) {
  const list = $("#deckList");
  list.replaceChildren();
  if (course.decks.length === 0) {
    list.append(el("div", { class: "empty-note" }, "No flashcard decks yet — create one in the Generate tab."));
    return;
  }
  course.decks.forEach((deck) => {
    list.append(
      el(
        "div",
        { class: "set-item" },
        el("span", { class: "material-icon" }, "🃏"),
        el(
          "div",
          { class: "set-info" },
          el("div", { class: "set-title" }, deck.title),
          el("div", { class: "set-meta" }, `${deck.cards.length} cards · created ${fmtDate(deck.createdAt)}`)
        ),
        el("button", { class: "btn btn-primary btn-sm", onclick: () => startDeck(deck) }, "Study"),
        el("button", {
          class: "btn btn-danger btn-sm",
          onclick: () => {
            if (!confirm(`Delete deck "${deck.title}"?`)) return;
            course.decks = course.decks.filter((d) => d.id !== deck.id);
            saveState();
            renderCourse();
          },
        }, "Delete")
      )
    );
  });
}

function startDeck(deck) {
  const queue = [...deck.cards].sort(() => Math.random() - 0.5);
  const session = { deck, queue, done: 0, total: deck.cards.length, again: 0 };
  $("#deckList").hidden = true;
  const player = $("#deckPlayer");
  player.hidden = false;
  renderFlashcard(session, player);
}

function renderFlashcard(session, player) {
  if (session.queue.length === 0) {
    player.replaceChildren(
      el(
        "div",
        { class: "deck-done" },
        el("div", { class: "big" }, "🎉"),
        el("h3", {}, "Deck complete!"),
        el("p", {}, `You reviewed ${session.total} cards${session.again ? ` (${session.again} needed a second look)` : ""}.`),
        el(
          "div",
          { class: "player-actions", style: "justify-content:center" },
          el("button", { class: "btn btn-primary", onclick: () => startDeck(session.deck) }, "Study again"),
          el("button", { class: "btn", onclick: () => { closePlayers(); renderCourse(); } }, "Back to decks")
        )
      )
    );
    return;
  }

  const card = session.queue[0];
  const flashcard = el(
    "div",
    { class: "flashcard", onclick: () => flashcard.classList.toggle("flipped") },
    el("div", { class: "flashcard-face" }, card.front),
    el("div", { class: "flashcard-face back" }, card.back)
  );

  player.replaceChildren(
    el(
      "div",
      { class: "player-top" },
      el("span", {}, `Card ${session.done + 1} · ${session.queue.length} remaining`),
      el("button", { class: "btn btn-ghost btn-sm", onclick: () => { closePlayers(); renderCourse(); } }, "✕ Exit")
    ),
    el("div", { class: "progress-bar" }, el("div", { class: "progress-fill", style: `width:${(session.done / (session.done + session.queue.length)) * 100}%` })),
    el("div", { class: "flashcard-scene" }, flashcard),
    el("div", { class: "flip-hint" }, "Click the card to flip it"),
    el(
      "div",
      { class: "player-actions", style: "justify-content:center" },
      el("button", {
        class: "btn",
        onclick: () => {
          // Put the card back near the end of the queue for another pass.
          session.queue.push(session.queue.shift());
          session.again++;
          renderFlashcard(session, player);
        },
      }, "🔁 Review again"),
      el("button", {
        class: "btn btn-primary",
        onclick: () => {
          session.queue.shift();
          session.done++;
          renderFlashcard(session, player);
        },
      }, "✅ Got it")
    )
  );
}

/* ================================================================
 * Import / export
 * ================================================================ */

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = el("a", { href: URL.createObjectURL(blob), download: `study-aid-backup-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importData(file) {
  try {
    const imported = JSON.parse(await file.text());
    if (!Array.isArray(imported.courses)) throw new Error("not a Study Aid backup");
    if (!confirm(`Replace your current data with "${file.name}" (${imported.courses.length} courses)?`)) return;
    state = imported;
    saveState();
    renderAll();
    toast("✅ Data imported.");
  } catch (e) {
    toast(`⚠️ Import failed: ${e.message}`);
  }
}

/* ================================================================
 * Event wiring
 * ================================================================ */

function init() {
  // Sidebar
  $("#newCourseForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#newCourseName").value.trim();
    if (name) addCourse(name);
    $("#newCourseName").value = "";
  });
  $("#exportBtn").addEventListener("click", exportData);
  $("#importInput").addEventListener("change", (e) => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = "";
  });

  // Course header
  $("#renameCourseBtn").addEventListener("click", () => {
    const course = activeCourse();
    if (!course) return;
    const name = prompt("Course name:", course.name);
    if (name?.trim()) {
      course.name = name.trim();
      saveState();
      renderAll();
    }
  });
  $("#deleteCourseBtn").addEventListener("click", () => {
    const course = activeCourse();
    if (!course) return;
    if (!confirm(`Delete "${course.name}" and all of its materials, quizzes, and flashcards?`)) return;
    state.courses = state.courses.filter((c) => c.id !== course.id);
    state.activeCourseId = state.courses[0]?.id ?? null;
    saveState();
    renderAll();
  });

  // Tabs
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      $(`#tab-${tab.dataset.tab}`).classList.add("active");
      closePlayers();
      renderCourse();
    });
  });

  // Materials
  const dropzone = $("#dropzone");
  $("#fileInput").addEventListener("change", (e) => {
    handleFiles([...e.target.files]);
    e.target.value = "";
  });
  ["dragover", "dragenter"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add("dragover");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove("dragover");
    })
  );
  dropzone.addEventListener("drop", (e) => handleFiles([...e.dataTransfer.files]));

  $("#pasteSaveBtn").addEventListener("click", () => {
    const course = activeCourse();
    if (!course) return;
    const text = $("#pasteText").value.trim();
    if (!text) {
      toast("⚠️ Paste some text first.");
      return;
    }
    const title = $("#pasteTitle").value.trim() || `Pasted notes (${fmtDate(Date.now())})`;
    addMaterial(course, title, text, "text");
    $("#pasteText").value = "";
    $("#pasteTitle").value = "";
    toast(`✅ Added "${title}"`);
  });

  // Generate
  $("#generateBtn").addEventListener("click", handleGenerate);

  // Settings
  const modal = $("#settingsModal");
  $("#settingsBtn").addEventListener("click", () => {
    $("#apiKeyInput").value = localStorage.getItem(API_KEY_STORAGE) || "";
    modal.showModal();
  });
  $("#settingsCancelBtn").addEventListener("click", () => modal.close());
  $("#settingsSaveBtn").addEventListener("click", () => {
    const key = $("#apiKeyInput").value.trim();
    if (key) localStorage.setItem(API_KEY_STORAGE, key);
    else localStorage.removeItem(API_KEY_STORAGE);
    modal.close();
    toast(key ? "✅ API key saved." : "API key removed.");
  });

  renderAll();
}

init();
