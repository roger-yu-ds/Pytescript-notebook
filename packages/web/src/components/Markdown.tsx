import { memo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Lang } from "@polyglot-tutor/core/browser";

export type InsertCell = (kind: { type: "code"; lang: Lang } | { type: "markdown" }, source: string) => void;

const LANG_MAP: Record<string, Lang> = {
  ts: "typescript",
  typescript: "typescript",
  tsx: "typescript",
  js: "typescript",
  javascript: "typescript",
  py: "python",
  python: "python",
  sql: "sql",
};

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="mini"
      title="Copy to clipboard"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? "✓ Copied" : `📋 ${label}`}
    </button>
  );
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) return textOf((node as any).props.children);
  return "";
}

function CodeBlock({ children, onInsert }: { children: ReactNode; onInsert?: InsertCell }) {
  const code = Array.isArray(children) ? children[0] : children;
  const className: string = (code as any)?.props?.className ?? "";
  const fence = /language-([\w+-]+)/.exec(className)?.[1]?.toLowerCase() ?? "";
  const text = textOf((code as any)?.props?.children).replace(/\n$/, "");
  const lang = LANG_MAP[fence];
  return (
    <div className="codeblock">
      <div className="codeblock-bar">
        <span className="codeblock-lang">{fence || "text"}</span>
        <span className="spacer" />
        <CopyButton text={text} />
        {onInsert && (
          <button
            className="mini"
            title={lang ? `Insert as a new ${lang} cell below` : "Insert as a new markdown cell below"}
            onClick={(e) => {
              e.stopPropagation();
              if (lang) onInsert({ type: "code", lang }, text);
              else onInsert({ type: "markdown" }, "```" + fence + "\n" + text + "\n```");
            }}
          >
            ＋ Insert as cell
          </button>
        )}
      </div>
      <pre>{children}</pre>
    </div>
  );
}

export const Markdown = memo(function Markdown({ text, onInsert }: { text: string; onInsert?: InsertCell }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={{ pre: ({ children }) => <CodeBlock onInsert={onInsert}>{children}</CodeBlock> }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
