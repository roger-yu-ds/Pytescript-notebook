import type { Output } from "@polyglot-tutor/core/browser";
import { CopyButton } from "./Markdown.tsx";
import { Ansi, stripAnsi } from "./Ansi.tsx";

function rawText(o: Output): string {
  switch (o.kind) {
    case "stream":
      return o.text;
    case "error":
      return o.traceback.length ? o.traceback.join("\n") : `${o.ename}: ${o.evalue}`;
    case "display":
      return typeof o.data["text/plain"] === "string" ? (o.data["text/plain"] as string) : "";
  }
}

function Display({ data }: { data: Record<string, unknown> }) {
  if (typeof data["image/png"] === "string") return <img className="out-img" src={`data:image/png;base64,${data["image/png"]}`} />;
  if (typeof data["image/svg+xml"] === "string")
    return <div className="out-svg" dangerouslySetInnerHTML={{ __html: data["image/svg+xml"] as string }} />;
  if (typeof data["text/html"] === "string")
    // Local, single-user app running your own code — HTML output is trusted like in Jupyter.
    return <div className="out-html" dangerouslySetInnerHTML={{ __html: data["text/html"] as string }} />;
  if (typeof data["text/plain"] === "string") return (
      <pre className="out-text">
        <Ansi text={data["text/plain"] as string} />
      </pre>
    );
  return <pre className="out-text muted">[{Object.keys(data).join(", ")}]</pre>;
}

export function Outputs({ outputs, stale, onAskError }: { outputs: Output[]; stale: boolean; onAskError?: () => void }) {
  if (!outputs.length) return null;
  const all = outputs.map((o) => stripAnsi(rawText(o))).filter(Boolean).join("\n");
  return (
    <div className={`outputs ${stale ? "stale" : ""}`}>
      <div className="outputs-tools">
        {stale && <span className="stale-note" title="The code changed since this output was produced">edited since run</span>}
        {all && <CopyButton text={all} label="Copy output" />}
      </div>
      {onAskError && outputs.some((o) => o.kind === "error") && (
        <button className="mini ask-error ask-error-out" onClick={onAskError} title="Insert a prompt cell below asking the tutor about this error">
          🤔 Ask about this error
        </button>
      )}
      {outputs.map((o, i) => {
        if (o.kind === "stream")
          return (
            <pre key={i} className={`out-text ${o.name === "stderr" ? "stderr" : ""}`}>
              <Ansi text={o.text} />
            </pre>
          );
        if (o.kind === "error")
          return (
            <pre key={i} className="out-text out-error">
              <Ansi text={rawText(o)} />
            </pre>
          );
        return <Display key={i} data={o.data} />;
      })}
    </div>
  );
}
