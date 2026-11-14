import { useEffect, useMemo, useState } from "react";
import { MODELS, describeEstimate, estimateContext, formatCountdown as fmt, staleFrom, toContextCells, type CacheInfo, type Settings, type Cell, type KernelLang as Lang, type KernelState, type SharedItem } from "@polyglot-tutor/core/browser";

interface Props {
  cells: Cell[];
  cache: CacheInfo | null;
  model: string;
  settings: Settings;
  kernels: Record<Lang, KernelState>;
  shared: SharedItem[];
  onKeepWarm: () => void;
  onInterrupt: (lang: Lang) => void;
  onRestart: (lang: Lang) => void;
}

function Kernel({ label, lang, state, onInterrupt, onRestart }: { label: string; lang: Lang; state: KernelState } & Pick<Props, "onInterrupt" | "onRestart">) {
  return (
    <span className={`kernel k-${state}`} title={`${label} kernel: ${state}`}>
      <span className="dot" /> {label}
      {state !== "off" && (
        <>
          <button className="link" onClick={() => onInterrupt(lang)} title="Interrupt (I I)">
            ■
          </button>
          <button className="link" onClick={() => confirm(`Restart the ${label} kernel?`) && onRestart(lang)} title="Restart (0 0)">
            ⟲
          </button>
        </>
      )}
    </span>
  );
}

/** Deliberately quiet: muted text, colour only when it needs attention. */
function CacheBadge({ cells, cache, model, onKeepWarm }: Pick<Props, "cells" | "cache" | "model" | "onKeepWarm">) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const label = MODELS.find((m) => m.id === model)?.label ?? model;
  if (!cache) return <span className="cache muted" title={`No ${label} cache yet. Ask a question to create one (needs ~512+ tokens of context).`}>cache —</span>;

  const ttl = cache.ttlMs ?? 60 * 60 * 1000;
  const left = cache.startedAt + ttl - now;
  const stale = staleFrom(cells, cache);
  const detail = `${label} prompt cache · ${cache.cells.length} cells · last request: ${cache.readTokens.toLocaleString()} tokens read, ${cache.writeTokens.toLocaleString()} written`;

  if (left <= 0) return <span className="cache muted" title={`${detail}\nExpired: the next question re-writes the cache (2× input price once).`}>cache cold</span>;
  if (stale !== null)
    return (
      <span className="cache warn" title={`${detail}\nYou edited cell ${stale}, which is inside the cached context. Cells from there on will be re-sent at full price on the next question.`}>
        cache stale from cell {stale}
      </span>
    );
  return (
    <span className={`cache ${left < Math.min(5 * 60_000, ttl / 5) ? "warn" : "muted"}`} title={`${detail}\nTime until the ${ttl >= 3_600_000 ? "1-hour" : "5-minute"} cache expires. Every question that reuses it resets the timer.`}>
      cache {fmt(left)}
      <button className="link" onClick={onKeepWarm} title={`Keep warm: re-read the cache (no answer generated) to reset the timer to ${fmt(ttl)}`}>
        ↻
      </button>
    </span>
  );
}

/** A quiet ring that fills as the context approaches the token budget. */
function ContextRing({ cells, settings }: Pick<Props, "cells" | "settings">) {
  const e = useMemo(() => estimateContext(toContextCells(cells), settings), [cells, settings]);
  const frac = Math.min(1, e.tokens / e.budget);
  const r = 5.5;
  const c = 2 * Math.PI * r;
  return (
    <span className={`ring ${frac >= 0.9 ? "warn" : "muted"}`} title={describeEstimate(e).join("\n")} aria-label={`Context ${Math.round(frac * 100)}% of budget`}>
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
        <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
        <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray={`${frac * c} ${c}`} transform="rotate(-90 7 7)" strokeLinecap="round" />
      </svg>
      {Math.round(frac * 100)}%
    </span>
  );
}

export function StatusBar(p: Props) {
  return (
    <footer className="statusbar">
      <Kernel label="Python" lang="python" state={p.kernels.python} onInterrupt={p.onInterrupt} onRestart={p.onRestart} />
      <Kernel label="TypeScript" lang="typescript" state={p.kernels.typescript} onInterrupt={p.onInterrupt} onRestart={p.onRestart} />
      {p.shared.length > 0 && (
        <span
          className="shared"
          title={"Values shared with share()/get():\n" + p.shared.map((s) => `${s.persisted ? "💾 " : ""}${s.name} — ${s.summary} (from ${s.from})`).join("\n")}
        >
          ⇄ {p.shared.length === 1 ? p.shared[0].name : `${p.shared.length} shared`}
        </span>
      )}
      <span className="spacer" />
      <ContextRing cells={p.cells} settings={p.settings} />
      <CacheBadge cells={p.cells} cache={p.cache} model={p.model} onKeepWarm={p.onKeepWarm} />
    </footer>
  );
}
