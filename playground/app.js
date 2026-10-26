// MK playground: the real compiler (dist/src) running in the browser.
import { CompileError, Lexer, Parser, VERSION, compile } from "../dist/src/index.js";
import { EXAMPLES } from "./examples.js";

const RUNTIME_URL = new URL("../dist/src/runtime/index.js", import.meta.url).href;
const runtime = await import(RUNTIME_URL);

// Node's Buffer, as far as the examples need it.
globalThis.Buffer ??= {
  alloc: (n) => new Uint8Array(n),
  from: (s) => new TextEncoder().encode(String(s)),
};

const DEMO_USERS = [
  { name: "Ana", score: 92, status: "active" },
  { name: "Marko", score: 47, status: "active" },
  { name: "Jelena", score: 78, status: "inactive" },
  { name: "Stefan", score: 65, status: "active" },
  { name: "Mila", score: 50, status: "active" },
];

const $ = (id) => document.getElementById(id);
const editor = $("source");
const highlight = $("highlight");
const output = $("output");
const status = $("status");
const diagnosticsList = $("diagnostics");
const examples = $("examples");

let tab = "ts";
let last = { ts: "", js: "", ast: "", ok: false };
const consoleLines = [];

// ---------------------------------------------------------------------------
// Syntax highlighting with MK's own lexer
// ---------------------------------------------------------------------------

const KEYWORDS = new Set(["fn", "let", "var", "signal", "effect", "consume", "spawn", "import", "export", "return", "if", "else", "while", "for", "in", "break", "continue"]);
const QUERY = new Set(["query", "where"]);
const CONSTANTS = new Set(["true", "false", "null"]);
const TYPES = new Set(["int", "float", "string", "bool", "void", "any", "List", "Map", "Task"]);
const BUILTINS = new Set(["print", "len", "str", "int", "float", "now", "panic", "keys", "sleep", "fetch", "fetchJson", "fetchText", "readFile", "writeFile", "join", "batch", "untrack", "isNull"]);

function tokenClass(t, prev, next) {
  if (KEYWORDS.has(t.type)) return "t-keyword";
  if (QUERY.has(t.type)) return "t-query";
  if (CONSTANTS.has(t.type)) return "t-const";
  if (t.type === "String" || t.type === "Template") return "t-string";
  if (t.type === "Int" || t.type === "Float") return "t-number";
  if (t.type !== "Identifier") return "";
  const w = t.lexeme;
  const nextIsName = next?.type === "Identifier";
  if ((w === "first" || w === "count") && prev?.type === "query") return "t-query";
  if ((w === "insert" || w === "update" || w === "delete" || w === "model") && nextIsName) return "t-query";
  if ((w === "order" && next?.lexeme === "by") || (w === "by" && prev?.lexeme === "order")) return "t-query";
  if (["asc", "desc", "limit", "offset", "select", "set"].includes(w)) return "t-query";
  if ((w === "from" || w === "as") && prev?.type !== "Dot") return "t-keyword";
  if (TYPES.has(w) || /^[A-Z]/.test(w)) return "t-type";
  if (next?.type === "(") return BUILTINS.has(w) ? "t-builtin" : "t-fn";
  if (prev?.type === "fn") return "t-fn";
  return "";
}

function renderMK(src, diagnostics = []) {
  const { tokens, comments } = Lexer.tokenize(src);
  const marks = comments.map((c) => [c.span.start.offset, c.span.end.offset, "t-comment"]);
  tokens.forEach((t, i) => {
    if (t.type === "Newline" || t.type === "EOF") return;
    const cls = tokenClass(t, tokens[i - 1], tokens[i + 1]);
    if (cls || diagnostics.length) marks.push([t.span.start.offset, t.span.end.offset, cls]);
  });
  marks.sort((a, b) => a[0] - b[0]);

  let html = "";
  let pos = 0;
  for (const [start, end, cls] of marks) {
    if (start < pos) continue;
    const d = diagnostics.find((x) => start < x.span.end.offset && end > x.span.start.offset);
    const classes = [cls, d ? (d.severity === "error" ? "t-err" : "t-warn") : ""].filter(Boolean).join(" ");
    html += escapeHtml(src.slice(pos, start));
    html += classes ? `<span class="${classes}">${escapeHtml(src.slice(start, end))}</span>` : escapeHtml(src.slice(start, end));
    pos = end;
  }
  return html + escapeHtml(src.slice(pos)) + "\n";
}

const TS_TOKENS =
  /(\/\/.*$|\/\*[\s\S]*?\*\/)|(`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|\b(async|await|function|const|let|return|if|else|for|of|while|break|continue|new|import|from|export|as|interface)\b|\b(true|false|null|undefined)\b|\b(number|string|boolean|void|any|Promise)\b|(\$mk)\b|\b(\d[\d_]*(?:\.\d+)?)\b/gm;
const TS_CLASSES = ["t-comment", "t-string", "t-keyword", "t-const", "t-type", "t-query", "t-number"];

function renderTS(code) {
  let html = "";
  let pos = 0;
  for (const m of code.matchAll(TS_TOKENS)) {
    const group = m.slice(1).findIndex((g) => g !== undefined);
    html += escapeHtml(code.slice(pos, m.index)) + `<span class="${TS_CLASSES[group]}">${escapeHtml(m[0])}</span>`;
    pos = m.index + m[0].length;
  }
  return html + escapeHtml(code.slice(pos));
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

// ---------------------------------------------------------------------------
// Compile on every keystroke
// ---------------------------------------------------------------------------

let timer;
function onInput() {
  highlight.innerHTML = renderMK(editor.value);
  syncScroll();
  clearTimeout(timer);
  timer = setTimeout(compileNow, 120);
}

function compileNow() {
  const src = editor.value;
  const started = performance.now();
  let diagnostics = [];
  try {
    const ts = compile(src, { file: "main.mk", target: "ts", runtimeImport: "mk-lang/runtime" });
    const js = compile(src, { file: "main.mk", target: "js", runtimeImport: "mk-lang/runtime" });
    diagnostics = ts.warnings;
    last = { ts: ts.code, js: js.code, ast: astJson(src), ok: true };
  } catch (e) {
    if (!(e instanceof CompileError)) throw e;
    diagnostics = e.diagnostics;
    last = { ...last, ast: astJson(src), ok: false };
  }
  const ms = (performance.now() - started).toFixed(1);
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  status.textContent = errors ? `✗ ${errors} error${errors === 1 ? "" : "s"}` : `✓ compiled in ${ms} ms`;
  status.className = `status ${errors ? "bad" : "ok"}`;
  highlight.innerHTML = renderMK(src, diagnostics);
  renderDiagnostics(diagnostics);
  renderOutput();
}

function astJson(src) {
  const { program } = Parser.parse(src);
  return JSON.stringify(program, (key, value) => (key === "span" || key.endsWith("Span") ? undefined : value), 2);
}

function renderDiagnostics(diagnostics) {
  diagnosticsList.replaceChildren(
    ...diagnostics.map((d) => {
      const li = document.createElement("li");
      li.className = d.severity;
      const notes = (d.notes ?? [])
        .map((n) => `<span class="note">note: ${escapeHtml(n.message)}${n.span ? ` (${n.span.start.line}:${n.span.start.column})` : ""}</span>`)
        .join("");
      li.innerHTML =
        `<span class="code-tag">${d.severity}[${d.code}]</span><span class="where">${d.span.start.line}:${d.span.start.column}</span>` +
        `${escapeHtml(d.message)}${notes}`;
      li.addEventListener("click", () => {
        editor.focus();
        editor.setSelectionRange(d.span.start.offset, Math.max(d.span.end.offset, d.span.start.offset + 1));
      });
      return li;
    }),
  );
}

function renderOutput() {
  output.classList.toggle("stale", !last.ok && (tab === "ts" || tab === "js"));
  if (tab === "ts") output.innerHTML = renderTS(last.ts);
  else if (tab === "js") output.innerHTML = renderTS(last.js);
  else if (tab === "ast") output.textContent = last.ast;
  else output.innerHTML = consoleLines.join("\n") || `<span class="log-meta">Press ▶ Run (Ctrl+Enter) to execute the program.</span>`;
}

function selectTab(name) {
  tab = name;
  for (const b of document.querySelectorAll("[data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === name));
  renderOutput();
}

// ---------------------------------------------------------------------------
// Running programs
// ---------------------------------------------------------------------------

for (const level of ["log", "info", "warn", "error"]) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    original(...args);
    const text = args.map((a) => (typeof a === "string" ? a : inspect(a))).join(" ");
    const cls = level === "error" ? "log-error" : level === "warn" ? "log-warn" : "";
    consoleLines.push(cls ? `<span class="${cls}">${escapeHtml(text)}</span>` : escapeHtml(text));
    if (tab === "console") renderOutput();
  };
}

/** A compact take on Node's util.inspect, so output looks like `mk run`. */
function inspect(value, depth = 0) {
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return depth === 0 ? value : `'${value.replace(/'/g, "\\'")}'`;
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (value instanceof Error) return value.stack ?? String(value);
  if (value instanceof Uint8Array) return `<Buffer ${value.length} bytes>`;
  if (depth > 4) return Array.isArray(value) ? "[Array]" : "[Object]";
  const pad = "  ".repeat(depth + 1);
  const items = Array.isArray(value)
    ? value.map((v) => inspect(v, depth + 1))
    : Object.entries(value).map(([k, v]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${k}'`}: ${inspect(v, depth + 1)}`);
  const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  if (items.length === 0) return open + close;
  const flat = `${open} ${items.join(", ")} ${close}`;
  return flat.length <= 72 && !flat.includes("\n") ? flat : `${open}\n${items.map((i) => pad + i).join(",\n")}\n${"  ".repeat(depth)}${close}`;
}

let running = false;
async function run() {
  if (running) return;
  running = true;
  consoleLines.length = 0;
  selectTab("console");
  let js;
  try {
    js = compile(editor.value, { file: "main.mk", target: "js", runtimeImport: RUNTIME_URL }).code;
  } catch (e) {
    if (!(e instanceof CompileError)) throw e;
    consoleLines.push(`<span class="log-error">${escapeHtml(e.message)}</span>`);
    renderOutput();
    running = false;
    return;
  }

  runtime.db.use(new runtime.MemoryAdapter());
  if ($("seed").checked) for (const row of DEMO_USERS) await runtime.db.insert("User", row);

  const url = URL.createObjectURL(new Blob([js], { type: "text/javascript" }));
  const started = performance.now();
  try {
    await import(url);
    consoleLines.push(`<span class="log-meta">— finished in ${(performance.now() - started).toFixed(0)} ms</span>`);
  } catch (e) {
    consoleLines.push(`<span class="log-error">${escapeHtml(e?.stack ?? String(e))}</span>`);
  } finally {
    URL.revokeObjectURL(url);
    running = false;
    renderOutput();
  }
}

// ---------------------------------------------------------------------------
// Sharing, examples and editor ergonomics
// ---------------------------------------------------------------------------

function encode(text) {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decode(data) {
  const binary = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

async function share() {
  history.replaceState(null, "", `#code=${encode(editor.value)}`);
  try {
    await navigator.clipboard.writeText(location.href);
    toast("Link copied — share it!");
  } catch {
    toast("Link is in the address bar");
  }
}

function toast(message) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 2200);
}

function load(code) {
  editor.value = code;
  editor.scrollTop = 0;
  consoleLines.length = 0;
  onInput();
  compileNow();
}

function syncScroll() {
  highlight.scrollTop = editor.scrollTop;
  highlight.scrollLeft = editor.scrollLeft;
}

function insertText(text) {
  // execCommand keeps the browser's undo history intact.
  if (!document.execCommand("insertText", false, text)) editor.setRangeText(text, editor.selectionStart, editor.selectionEnd, "end");
  onInput();
}

editor.addEventListener("input", onInput);
editor.addEventListener("scroll", syncScroll);
editor.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    run();
  } else if (e.key === "Tab" && !e.shiftKey) {
    e.preventDefault();
    insertText("    ");
  } else if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
    const before = editor.value.slice(0, editor.selectionStart);
    const line = before.slice(before.lastIndexOf("\n") + 1);
    const indent = line.match(/^\s*/)[0] + (/\{\s*$/.test(line) ? "    " : "");
    e.preventDefault();
    insertText("\n" + indent);
  }
});

for (const b of document.querySelectorAll("[data-tab]")) b.addEventListener("click", () => selectTab(b.dataset.tab));
$("run").addEventListener("click", run);
$("share").addEventListener("click", share);

for (const ex of EXAMPLES) examples.append(new Option(ex.title, ex.id));
examples.addEventListener("change", () => {
  history.replaceState(null, "", location.pathname);
  load(EXAMPLES.find((x) => x.id === examples.value).code);
});

document.title = `MK ${VERSION} Playground`;
const shared = location.hash.match(/^#code=([\w-]+)/);
let initial = EXAMPLES[0].code;
if (shared) {
  try {
    initial = decode(shared[1]);
  } catch {
    toast("Could not read the shared link");
  }
}
load(initial);
