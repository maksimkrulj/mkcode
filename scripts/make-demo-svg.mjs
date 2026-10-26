// Generates assets/demo.svg: an animated MK → TypeScript comparison built from real compiler output.
// Usage: npm run build && node scripts/make-demo-svg.mjs
import { writeFileSync } from "node:fs";
import path from "node:path";
import { compile } from "../dist/src/index.js";

const root = path.resolve(import.meta.dirname, "..");

const SOURCE = `model User { id: int, name: string, score: int }

signal minScore = 50
signal leaders = live query User where score >= minScore

fn topUsers(min: int) -> List<User> {
    return query User where score >= min
}

fn main() {
    let users = topUsers(80)
    print(users |> map(fn(u) => u.name))
}`;

const ts = compile(SOURCE, { file: "app.mk", runtimeImport: "mk-lang/runtime" })
  .code.split("\n")
  .filter((line) => !line.startsWith("// Generated"))
  .join("\n")
  .trim();

const COLORS = { text: "#d7dce8", keyword: "#c792ea", query: "#22d3ee", type: "#ffcb6b", string: "#c3e88d", number: "#f78c6c", comment: "#637089", fn: "#82aaff" };
const MK_KEYWORDS = /\b(fn|let|var|signal|return|model|live|effect|if|else|for|in)\b/;
const TS_KEYWORDS = /\b(async|await|function|const|let|return|import|from|interface|export|as)\b/;

function highlight(line, keywords, queryWords) {
  const re = new RegExp(
    `(//.*$)|("(?:\\\\.|[^"\\\\])*"|\`[^\`]*\`)|${keywords.source}|${queryWords.source}|\\b(int|string|float|bool|List|number|Promise|User)\\b|\\b(\\d+)\\b|\\b([a-z]\\w*)(?=\\()`,
    "g",
  );
  const colors = [COLORS.comment, COLORS.string, COLORS.keyword, COLORS.query, COLORS.type, COLORS.number, COLORS.fn];
  let out = "";
  let pos = 0;
  for (const m of line.matchAll(re)) {
    const group = m.slice(1).findIndex((g) => g !== undefined);
    out += esc(line.slice(pos, m.index)) + `<tspan fill="${colors[group]}">${esc(m[0])}</tspan>`;
    pos = m.index + m[0].length;
  }
  return out + esc(line.slice(pos));
}

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const mkLines = SOURCE.split("\n");
const tsLines = ts.split("\n");
const LINE = 19;
const TOP = 74;
const height = TOP + Math.max(mkLines.length, tsLines.length) * LINE + 28;
const width = 1320;
const LEFT = { x: 16, w: 450 };
const ARROW = 498;
const RIGHT = { x: 530, w: width - 530 - 16 };
const CYCLE = 14; // seconds

// Phase 1 (0–38%): MK lines appear one by one. Phase 2 (45–75%): the TypeScript appears.
const keyframes = [];
const line = (text, x, y, i, from, to, total, keywords, query) => {
  const at = (from + ((to - from) * i) / Math.max(1, total)).toFixed(2);
  const shown = (Number(at) + 1.2).toFixed(2);
  keyframes.push(`@keyframes a${keyframes.length}{0%,${at}%{opacity:0;transform:translateX(-6px)}${shown}%,93%{opacity:1;transform:none}100%{opacity:0}}`);
  return `<text x="${x}" y="${y}" style="animation:a${keyframes.length - 1} ${CYCLE}s infinite" xml:space="preserve">${highlight(text, keywords, query)}</text>`;
};

const mkQuery = /\b(query|where|order|by)\b/;
const tsQuery = /(\$mk)\b/;
const left = mkLines.map((t, i) => line(t, LEFT.x + 16, TOP + i * LINE, i, 2, 36, mkLines.length, MK_KEYWORDS, mkQuery)).join("\n");
const right = tsLines.map((t, i) => line(t, RIGHT.x + 16, TOP + i * LINE, i, 45, 75, tsLines.length, TS_KEYWORDS, tsQuery)).join("\n");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="MK source compiling to TypeScript">
<style>
text{font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;fill:${COLORS.text};opacity:0}
.label{font:600 13px system-ui,-apple-system,Segoe UI,sans-serif;opacity:1;fill:#8790a6}
.arrow{animation:pulse ${CYCLE}s infinite}
@keyframes pulse{0%,38%{opacity:.25}42%,93%{opacity:1}100%{opacity:.25}}
${keyframes.join("\n")}
</style>
<rect width="${width}" height="${height}" rx="16" fill="#0d1017"/>
<rect x="${LEFT.x}" y="16" width="${LEFT.w}" height="${height - 32}" rx="12" fill="#131822" stroke="#252d3f"/>
<rect x="${RIGHT.x}" y="16" width="${RIGHT.w}" height="${height - 32}" rx="12" fill="#131822" stroke="#252d3f"/>
<circle cx="36" cy="38" r="5" fill="#f87171"/><circle cx="52" cy="38" r="5" fill="#fbbf24"/><circle cx="68" cy="38" r="5" fill="#34d399"/>
<text class="label" x="86" y="42">app.mk — what you write</text>
<text class="label" x="${RIGHT.x + 16}" y="42">app.ts — what mk build emits (async/await inferred)</text>
<g class="arrow"><circle cx="${ARROW}" cy="${height / 2}" r="20" fill="#7c3aed"/><path d="M${ARROW - 8} ${height / 2}h14m-6-6 6 6-6 6" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g>
${left}
${right}
</svg>
`;

writeFileSync(path.join(root, "assets", "demo.svg"), svg);
console.log(`wrote assets/demo.svg (${mkLines.length} MK lines → ${tsLines.length} TS lines)`);
