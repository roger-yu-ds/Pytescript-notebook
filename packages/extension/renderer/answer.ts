// Notebook renderer for tutor answers (runs in the notebook's output webview).
// Streams Markdown, highlights code blocks and gives each a Copy button and,
// for runnable languages, an "Insert as cell" button.

import type { ActivationFunction, RendererContext } from "vscode-notebook-renderer";
import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import { STYLE } from "./style.ts";

for (const [name, lang] of Object.entries({ bash, javascript, json, python, sql, typescript })) hljs.registerLanguage(name, lang);

interface Answer {
  cellId?: string;
  response: string;
  mode: "hint" | "answer";
  thinking?: string;
  status: "streaming" | "done" | "error";
  error?: string;
}

/** Fence tag → (highlight.js language, notebook cell language when runnable). */
const LANGS: Record<string, { hl: string; cell?: string }> = {
  ts: { hl: "typescript", cell: "typescript" },
  typescript: { hl: "typescript", cell: "typescript" },
  tsx: { hl: "typescript", cell: "typescript" },
  js: { hl: "javascript", cell: "typescript" },
  javascript: { hl: "javascript", cell: "typescript" },
  py: { hl: "python", cell: "python" },
  python: { hl: "python", cell: "python" },
  sql: { hl: "sql", cell: "sql" },
  bash: { hl: "bash" },
  sh: { hl: "bash" },
  shell: { hl: "bash" },
  json: { hl: "json" },
};

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function createMarkdown(canInsert: boolean): MarkdownIt {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const tag = token.info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    const lang = LANGS[tag];
    const code = token.content;
    const body = lang ? hljs.highlight(code, { language: lang.hl, ignoreIllegals: true }).value : escapeHtml(code);
    const insert = canInsert && lang?.cell ? `<button class="pt-btn" data-action="insert" data-lang="${lang.cell}" title="Insert as a new cell below the prompt">Insert as cell</button>` : "";
    return `<div class="pt-code"><div class="pt-code-bar"><span class="pt-lang">${escapeHtml(tag || "text")}</span><span class="pt-actions"><button class="pt-btn" data-action="copy" title="Copy to clipboard">Copy</button>${insert}</span></div><pre><code class="hljs">${body}</code></pre><textarea class="pt-src" hidden>${escapeHtml(code)}</textarea></div>`;
  };
  return md;
}

function ensureStyle() {
  if (document.getElementById("pt-answer-style")) return;
  const style = document.createElement("style");
  style.id = "pt-answer-style";
  style.textContent = STYLE;
  document.head.appendChild(style);
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

export function renderAnswer(element: HTMLElement, a: Answer, md: MarkdownIt) {
  const parts: string[] = [];
  if (a.thinking) parts.push(`<details class="pt-thinking"><summary>Reasoning</summary>${md.render(a.thinking)}</details>`);
  if (a.response) parts.push(`<div class="pt-md">${md.render(a.response)}</div>`);
  else if (a.status === "streaming") parts.push(`<div class="pt-waiting">${a.mode === "answer" ? "Writing an answer" : "Thinking of a hint"}…</div>`);
  if (a.status === "streaming" && a.response) parts.push(`<span class="pt-caret"></span>`);
  if (a.status === "error") parts.push(`<div class="pt-error">${escapeHtml(a.error ?? "Something went wrong.")}</div>`);
  const open = element.querySelector<HTMLDetailsElement>("details.pt-thinking")?.open ?? false;
  element.innerHTML = `<div class="pt-answer pt-${a.status}">${parts.join("")}</div>`;
  const details = element.querySelector<HTMLDetailsElement>("details.pt-thinking");
  if (details) details.open = open;
}

export const activate: ActivationFunction = (ctx: RendererContext<unknown>) => {
  ensureStyle();
  const md = createMarkdown(!!ctx.postMessage);
  return {
    renderOutputItem(item, element) {
      if (!element.dataset.ptWired) {
        element.dataset.ptWired = "1";
        element.addEventListener("click", (ev) => {
          const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-action]");
          if (!btn) return;
          const code = btn.closest(".pt-code")?.querySelector<HTMLTextAreaElement>("textarea.pt-src")?.value ?? "";
          if (btn.dataset.action === "copy") {
            void copy(code).then(() => {
              btn.textContent = "Copied";
              setTimeout(() => (btn.textContent = "Copy"), 1200);
            });
          } else if (btn.dataset.action === "insert") {
            ctx.postMessage?.({ type: "insertCell", code, lang: btn.dataset.lang, cellId: element.dataset.cellId });
            btn.textContent = "Inserted";
            setTimeout(() => (btn.textContent = "Insert as cell"), 1200);
          }
        });
      }
      const answer = item.json() as Answer;
      element.dataset.cellId = answer.cellId ?? "";
      renderAnswer(element, answer, md);
    },
  };
};
