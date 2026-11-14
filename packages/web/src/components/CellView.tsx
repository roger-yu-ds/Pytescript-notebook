import { memo } from "react";
import type { Cell } from "@polyglot-tutor/core/browser";
import { CodeEditor, type EditorKeys } from "./CodeEditor.tsx";
import { Markdown, type InsertCell } from "./Markdown.tsx";
import { Outputs } from "./Outputs.tsx";

/** The run/ask modifier as shown to the user (Monaco binds Cmd on macOS, Ctrl elsewhere). */
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

export type CellKind = "markdown" | "python" | "typescript" | "sql" | "prompt";

export const kindOf = (c: Cell): CellKind => (c.type === "code" ? (c.lang ?? "python") : c.type);

export interface CellActions {
  select: (id: string, edit: boolean) => void;
  update: (id: string, patch: Partial<Cell>) => void;
  setKind: (id: string, kind: CellKind) => void;
  run: (id: string, after: "stay" | "next" | "insert") => void;
  stopAsk: (id: string) => void;
  remove: (id: string) => void;
  move: (id: string, dir: -1 | 1) => void;
  insertAfter: (kind: Parameters<InsertCell>[0] | { type: "prompt" }, source: string, afterId: string, edit?: boolean) => void;
  escape: () => void;
}

interface Props {
  cell: Cell;
  index: number;
  selected: boolean;
  editing: boolean;
  running: boolean;
  asking: boolean;
  staleOutput: boolean;
  /** Messages of the TypeScript checker's error markers. */
  typeErrors: string[];
  actions: CellActions;
}

export const CellView = memo(function CellView({ cell, index, selected, editing, running, asking, staleOutput, typeErrors, actions }: Props) {
  const typeErrorCount = typeErrors.length;
  const kind = kindOf(cell);
  const keys: EditorKeys = {
    onShiftEnter: () => actions.run(cell.id, "next"),
    onCtrlEnter: () => actions.run(cell.id, "stay"),
    onAltEnter: () => actions.run(cell.id, "insert"),
    onEscape: () => actions.escape(),
    onFocus: () => actions.select(cell.id, true),
  };
  const insertBelow: InsertCell = (k, src) => actions.insertAfter(k, src, cell.id);
  const askAbout = (question: string) => actions.insertAfter({ type: "prompt" }, question, cell.id, true);

  const gutter =
    kind === "prompt" ? (asking ? "[…]" : "[?]") : cell.type === "code" ? (running ? "[*]" : `[${cell.executionCount ?? " "}]`) : "";

  return (
    <div
      className={`cell cell-${kind} ${selected ? "selected" : ""} ${editing ? "editing" : ""} ${cell.hidden ? "hidden-from-ai" : ""}`}
      onMouseDown={() => !selected && actions.select(cell.id, false)}
      data-cell-id={cell.id}
    >
      <div className="cell-gutter">
        <span className="cell-index">{index + 1}</span>
        <span className="cell-count">{gutter}</span>
      </div>
      <div className="cell-body">
        <div className="cell-toolbar">
          <select
            value={kind}
            onChange={(e) => actions.setKind(cell.id, e.target.value as CellKind)}
            title="Cell type"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <option value="markdown">Markdown</option>
            <option value="python">Python</option>
            <option value="typescript">TypeScript</option>
            <option value="sql">SQL</option>
            <option value="prompt">✨ Prompt</option>
          </select>
          {kind === "prompt" && (
            <div className="mode-toggle" title="Hint: the tutor nudges you. Answer: the tutor gives the full solution.">
              {(["hint", "answer"] as const).map((m) => (
                <button key={m} className={(cell.mode ?? "hint") === m ? "on" : ""} onClick={() => actions.update(cell.id, { mode: m })}>
                  {m === "hint" ? "💡 Hint" : "✅ Answer"}
                </button>
              ))}
            </div>
          )}
          {kind === "typescript" && typeErrorCount > 0 && (
            <>
              <span className="type-errors" title={`${typeErrors.join("\n\n")}\n\n(The cell still runs.)`}>
                {typeErrorCount} type error{typeErrorCount > 1 ? "s" : ""}
              </span>
              <button className="mini ask-error" onClick={() => askAbout(`What does the type error in cell ${index + 1} mean?`)} title="Ask the tutor about this">
                🤔 Ask
              </button>
            </>
          )}
          <span className="spacer" />
          {kind === "prompt" && asking ? (
            <button className="tool" onClick={() => actions.stopAsk(cell.id)} title="Stop">
              ■ Stop
            </button>
          ) : (
            <button className="tool" onClick={() => actions.run(cell.id, "stay")} title={kind === "prompt" ? `Ask (${MOD}+Enter)` : `Run (${MOD}+Enter)`}>
              {kind === "prompt" ? (cell.response ? "↻ Ask again" : "➤ Ask") : "▶"}
            </button>
          )}
          <button className={`tool ${cell.hidden ? "on" : ""}`} onClick={() => actions.update(cell.id, { hidden: !cell.hidden })} title="Hide this cell from the AI">
            🙈
          </button>
          <button className={`tool ${cell.pinned ? "on" : ""}`} onClick={() => actions.update(cell.id, { pinned: !cell.pinned })} title="Always send this cell to the AI in full (no truncation)">
            📌
          </button>
          <button className="tool" onClick={() => actions.move(cell.id, -1)} title="Move up">
            ↑
          </button>
          <button className="tool" onClick={() => actions.move(cell.id, 1)} title="Move down">
            ↓
          </button>
          <button className="tool" onClick={() => actions.remove(cell.id)} title="Delete (D D)">
            🗑
          </button>
        </div>

        {kind === "markdown" && !editing && cell.source.trim() ? (
          <div className="md-rendered" onDoubleClick={() => actions.select(cell.id, true)}>
            <Markdown text={cell.source} onInsert={insertBelow} />
          </div>
        ) : (
          <CodeEditor
            id={cell.id}
            language={kind === "prompt" || kind === "markdown" ? "markdown" : kind}
            value={cell.source}
            onChange={(v) => actions.update(cell.id, { source: v })}
            focused={editing}
            keys={keys}
            placeholder={
              kind === "prompt"
                ? `Ask the tutor about the cells above…  (${MOD}+Enter to send)`
                : kind === "markdown"
                  ? "Markdown…  (Shift+Enter to render)"
                  : undefined
            }
          />
        )}

        {cell.type === "code" && (
          <Outputs outputs={cell.outputs} stale={staleOutput} onAskError={() => askAbout(`Why did cell ${index + 1} fail?`)} />
        )}

        {kind === "prompt" && (cell.response || asking) && (
          <div className="response">
            {cell.thinking && (
              <details className="reasoning">
                <summary>Reasoning</summary>
                <div className="reasoning-text">{cell.thinking}</div>
              </details>
            )}
            {cell.response ? <Markdown text={cell.response} onInsert={insertBelow} /> : <div className="thinking">Thinking…</div>}
            {cell.usage && !asking && (
              <div
                className="usage"
                title={`input ${cell.usage.inputTokens} · cache read ${cell.usage.cacheReadTokens} · cache write ${cell.usage.cacheWriteTokens} · output ${cell.usage.outputTokens}${
                  cell.usage.summarizedBlocks ? `\n${cell.usage.summarizedBlocks} older block(s) summarised ($${(cell.usage.summaryCostUsd ?? 0).toFixed(4)})` : ""
                }`}
              >
                {cell.usage.model.replace("claude-", "")} · {(cell.usage.inputTokens + cell.usage.cacheReadTokens + cell.usage.cacheWriteTokens).toLocaleString()} in /{" "}
                {cell.usage.outputTokens.toLocaleString()} out · ${cell.usage.costUsd.toFixed(4)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
