import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MODELS,
  type AskRequest,
  cacheInfoFor,
  type CacheHit,
  type CacheInfo,
  type Cell,
  type Effort,
  type KernelState,
  type KernelLang,
  type Lang,
  type SharedItem,
  kernelOf,
  type Notebook,
  type Output,
  type Settings,
} from "@polyglot-tutor/core/browser";
import { api, newId } from "../api.ts";
import { contextCells } from "../context.ts";
import { cellMarkers, disposeModelsExcept, monaco } from "../monaco.ts";
import { importTypes } from "../types.ts";
import { send, subscribe } from "../ws.ts";
import { CellView, kindOf, type CellActions, type CellKind } from "./CellView.tsx";
import { StatusBar } from "./StatusBar.tsx";

interface Props {
  name: string;
  settings: Settings;
  onSettings: (patch: Partial<Settings>) => void;
}

const loadCache = (nb: string): Record<string, CacheInfo> => {
  try {
    return JSON.parse(localStorage.getItem(`cache:${nb}`) ?? "{}");
  } catch {
    return {};
  }
};

const requestSettings = (s: Settings) => ({
  model: s.model,
  effort: s.effort,
  learnerProfile: s.learnerProfile,
  context: s.context,
  cacheTtl: s.cacheTtl,
  summaryModel: s.summaryModel,
  showThinking: s.showThinking,
});

function makeCell(kind: CellKind, source = ""): Cell {
  const base = { id: newId(), source, outputs: [] as Output[] };
  if (kind === "prompt") return { ...base, type: "prompt", mode: "hint", response: "" };
  if (kind === "markdown") return { ...base, type: "markdown" };
  return { ...base, type: "code", lang: kind, executionCount: null };
}

function appendOutput(outputs: Output[], o: Output): Output[] {
  const last = outputs[outputs.length - 1];
  if (o.kind === "stream" && last?.kind === "stream" && last.name === o.name) {
    return [...outputs.slice(0, -1), { ...last, text: last.text + o.text }];
  }
  return [...outputs, o];
}

export function NotebookView({ name, settings, onSettings }: Props) {
  const [cells, setCells] = useState<Cell[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [asking, setAsking] = useState<Set<string>>(new Set());
  const [kernels, setKernels] = useState<Record<KernelLang, KernelState>>({ python: "off", typescript: "off" });
  const [shared, setShared] = useState<SharedItem[]>([]);
  const [cache, setCache] = useState<Record<string, CacheInfo>>(() => loadCache(name));
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const [markerTick, setMarkerTick] = useState(0);
  const ranSource = useRef(new Map<string, string>());
  const sentReqs = useRef(new Map<string, AskRequest>()); // cellId (or "warm") → request in flight
  const deleted = useRef<{ cell: Cell; index: number }[]>([]);
  const lastLang = useRef<Lang>("typescript");

  const cellsRef = useRef(cells);
  cellsRef.current = cells;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const editingRef = useRef(editing);
  editingRef.current = editing;

  // ---- load ----
  useEffect(() => {
    let alive = true;
    setCells(null);
    setError(null);
    setCache(loadCache(name));
    api.load(name).then(
      (nb) => {
        if (!alive) return;
        disposeModelsExcept(new Set(nb.cells.map((c) => c.id)));
        importTypes.activate(name);
        ranSource.current = new Map(nb.cells.map((c) => [c.id, c.source]));
        setCells(nb.cells);
        setSelectedId(nb.cells[0]?.id ?? null);
        setEditing(false);
        setKernels({ python: "off", typescript: "off" });
        fetch(`/api/shared/${encodeURIComponent(name)}`)
          .then((r) => r.json())
          .then((items) => alive && setShared(items))
          .catch(() => {});
      },
      (e) => alive && setError(String(e.message ?? e)),
    );
    return () => {
      alive = false;
    };
  }, [name]);

  // ---- autosave ----
  const loadedOnce = useRef<string | null>(null);
  useEffect(() => {
    if (!cells) return;
    if (loadedOnce.current !== name) {
      loadedOnce.current = name;
      return;
    }
    setSaveState("saving");
    const t = setTimeout(() => {
      const nb: Notebook = { name, cells };
      api.save(nb).then(
        () => setSaveState("saved"),
        () => setSaveState("error"),
      );
    }, 800);
    return () => clearTimeout(t);
  }, [cells, name]);

  useEffect(() => {
    try {
      localStorage.setItem(`cache:${name}`, JSON.stringify(cache));
    } catch {
      /* storage unavailable */
    }
  }, [cache, name]);

  // ---- type-error markers (and import types arriving) → re-render the cells' error lists ----
  useEffect(() => {
    const d = monaco.editor.onDidChangeMarkers(() => setMarkerTick((t) => t + 1));
    const u = importTypes.onChange(() => setMarkerTick((t) => t + 1));
    return () => {
      d.dispose();
      u();
    };
  }, []);

  const patchCell = useCallback((id: string, f: (c: Cell) => Cell) => {
    setCells((cs) => cs && cs.map((c) => (c.id === id ? f(c) : c)));
  }, []);

  // The cached prefix is exactly the cells we sent; remember them to detect later edits.
  const recordCache = useCallback((key: string, hit: CacheHit | null) => {
    const req = sentReqs.current.get(key);
    sentReqs.current.delete(key);
    const info = req ? cacheInfoFor(req, hit) : null;
    if (info) setCache((cc) => ({ ...cc, [info.model]: info }));
  }, []);

  // ---- server messages ----
  useEffect(
    () =>
      subscribe((m) => {
        switch (m.t) {
          case "output":
            patchCell(m.cellId, (c) => ({ ...c, outputs: appendOutput(c.outputs, m.output) }));
            break;
          case "clearOutput":
            patchCell(m.cellId, (c) => ({ ...c, outputs: [] }));
            break;
          case "runDone":
            patchCell(m.cellId, (c) => ({ ...c, executionCount: m.executionCount }));
            setRunning((s) => {
              const n = new Set(s);
              n.delete(m.cellId);
              return n;
            });
            break;
          case "kernel":
            if (m.notebook === name) setKernels((k) => ({ ...k, [m.lang]: m.state }));
            break;
          case "shared":
            if (m.notebook === name) setShared(m.items);
            break;
          case "askDelta":
            patchCell(m.cellId, (c) => ({ ...c, response: (c.response ?? "") + m.text }));
            break;
          case "askThinking":
            patchCell(m.cellId, (c) => ({ ...c, thinking: (c.thinking ?? "") + m.text }));
            break;
          case "askDone":
            patchCell(m.cellId, (c) => ({ ...c, usage: m.usage }));
            recordCache(m.cellId, m.cache);
            setAsking((s) => {
              const n = new Set(s);
              n.delete(m.cellId);
              return n;
            });
            break;
          case "askError":
            sentReqs.current.delete(m.cellId);
            patchCell(m.cellId, (c) => ({ ...c, response: `${c.response ?? ""}\n\n> ⚠️ ${m.message}` }));
            setAsking((s) => {
              const n = new Set(s);
              n.delete(m.cellId);
              return n;
            });
            break;
          case "warmDone":
            recordCache("warm", m.cache);
            break;
          case "warmError":
            sentReqs.current.delete("warm");
            alert(`Keep warm failed: ${m.message}`);
            break;
        }
      }),
    [name, patchCell, recordCache],
  );

  // ---- actions (stable; read current state through refs) ----
  const actions = useMemo<CellActions & { runAll: (until?: number) => void; insertAt: (index: number, kind: CellKind) => void }>(() => {
    const cs = () => cellsRef.current ?? [];
    const indexOf = (id: string) => cs().findIndex((c) => c.id === id);

    const runCell = async (cell: Cell) => {
      if (cell.type === "code") {
        lastLang.current = cell.lang ?? "python";
        ranSource.current.set(cell.id, cell.source);
        setRunning((s) => new Set(s).add(cell.id));
        send({ t: "run", notebook: name, cellId: cell.id, lang: cell.lang ?? "python", code: cell.source });
      } else if (cell.type === "prompt") {
        if (!cell.source.trim()) return;
        patchCell(cell.id, (c) => ({ ...c, response: "", thinking: undefined, usage: undefined }));
        setAsking((x) => new Set(x).add(cell.id));
        const all = cs();
        const idx = all.findIndex((c) => c.id === cell.id);
        const s = settingsRef.current;
        const req: AskRequest = {
          notebook: name,
          cellId: cell.id,
          cells: await contextCells(all, idx),
          question: cell.source,
          mode: cell.mode ?? "hint",
          ...requestSettings(s),
        };
        sentReqs.current.set(cell.id, req);
        send({ t: "ask", req });
      }
    };

    const insertAt = (index: number, kind: CellKind, source = "", edit = true) => {
      const cell = makeCell(kind, source);
      setCells((c) => {
        const next = [...(c ?? [])];
        next.splice(index, 0, cell);
        return next;
      });
      ranSource.current.set(cell.id, source);
      setSelectedId(cell.id);
      setEditing(edit);
      return cell;
    };

    return {
      select: (id, edit) => {
        setSelectedId(id);
        setEditing(edit);
      },
      update: (id, patch) => patchCell(id, (c) => ({ ...c, ...patch })),
      setKind: (id, kind) =>
        patchCell(id, (c) => {
          if (kindOf(c) === kind) return c;
          if (kind === "prompt") return { ...c, type: "prompt", lang: undefined, outputs: [], mode: c.mode ?? "hint", response: c.response ?? "" };
          if (kind === "markdown") return { ...c, type: "markdown", lang: undefined, outputs: [] };
          return { ...c, type: "code", lang: kind, outputs: [], executionCount: null };
        }),
      run: (id, after) => {
        const i = indexOf(id);
        const cell = cs()[i];
        if (!cell) return;
        void runCell(cell);
        if (after === "stay") {
          if (cell.type === "markdown") setEditing(false);
          return;
        }
        if (after === "insert" || i === cs().length - 1) {
          insertAt(i + 1, cell.type === "code" ? (cell.lang ?? "python") : cell.type === "prompt" ? "prompt" : lastLang.current);
          return;
        }
        setSelectedId(cs()[i + 1].id);
        setEditing(false);
      },
      stopAsk: (id) => send({ t: "cancelAsk", cellId: id }),
      remove: (id) => {
        const i = indexOf(id);
        if (i < 0) return;
        deleted.current.push({ cell: cs()[i], index: i });
        for (const m of monaco.editor.getModels()) if (m.uri.path.startsWith(`/cells/${id}.`)) m.dispose();
        const next = cs().filter((c) => c.id !== id);
        setCells(next);
        setSelectedId(next[Math.min(i, next.length - 1)]?.id ?? null);
        setEditing(false);
      },
      move: (id, dir) =>
        setCells((c) => {
          if (!c) return c;
          const i = c.findIndex((x) => x.id === id);
          const j = i + dir;
          if (i < 0 || j < 0 || j >= c.length) return c;
          const next = [...c];
          [next[i], next[j]] = [next[j], next[i]];
          return next;
        }),
      insertAfter: (kind, source, afterId, edit = false) => {
        const i = indexOf(afterId);
        insertAt(i + 1, kind.type === "code" ? kind.lang : kind.type, source, edit);
      },
      escape: () => setEditing(false),
      runAll: (until) => {
        const list = cs();
        const end = until ?? list.length;
        for (const c of list.slice(0, end)) if (c.type === "code" && c.source.trim()) void runCell(c);
      },
      insertAt: (index, kind) => void insertAt(index, kind),
    };
  }, [name, patchCell]);

  // ---- Jupyter command-mode shortcuts ----
  useEffect(() => {
    let lastKey = "";
    let lastTime = 0;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (cellsRef.current) api.save({ name, cells: cellsRef.current }).then(() => setSaveState("saved"));
        return;
      }
      if (editingRef.current) return;
      if (target.closest("input, textarea, select, .monaco-editor, .modal")) return;
      const list = cellsRef.current ?? [];
      const i = list.findIndex((c) => c.id === selectedRef.current);
      const cell = list[i];
      const double = (k: string) => {
        const now = Date.now();
        const hit = lastKey === k && now - lastTime < 600;
        lastKey = hit ? "" : k;
        lastTime = now;
        return hit;
      };
      const go = (j: number) => {
        const c = list[Math.max(0, Math.min(list.length - 1, j))];
        if (c) {
          setSelectedId(c.id);
          document.querySelector(`[data-cell-id="${c.id}"]`)?.scrollIntoView({ block: "nearest" });
        }
      };
      if (e.key === "Enter" && cell) {
        e.preventDefault();
        if (e.shiftKey) actions.run(cell.id, "next");
        else if (e.ctrlKey || e.metaKey) actions.run(cell.id, "stay");
        else if (e.altKey) actions.run(cell.id, "insert");
        else setEditing(true);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      switch (e.key) {
        case "ArrowUp":
        case "k":
          e.preventDefault();
          go(i - 1);
          break;
        case "ArrowDown":
        case "j":
          e.preventDefault();
          go(i + 1);
          break;
        case "a":
          actions.insertAt(Math.max(0, i), lastLang.current);
          setEditing(false);
          break;
        case "b":
          actions.insertAt(i + 1, lastLang.current);
          setEditing(false);
          break;
        case "d":
          if (double("d") && cell) actions.remove(cell.id);
          break;
        case "z": {
          const d = deleted.current.pop();
          if (d) {
            setCells((c) => {
              const next = [...(c ?? [])];
              next.splice(Math.min(d.index, next.length), 0, d.cell);
              return next;
            });
            setSelectedId(d.cell.id);
          }
          break;
        }
        case "m":
          if (cell) actions.setKind(cell.id, "markdown");
          break;
        case "y":
          if (cell) actions.setKind(cell.id, "python");
          break;
        case "t":
          if (cell) actions.setKind(cell.id, "typescript");
          break;
        case "p":
          if (cell) actions.setKind(cell.id, "prompt");
          break;
        case "i":
          if (double("i") && cell?.type === "code") send({ t: "interrupt", notebook: name, lang: kernelOf(cell.lang ?? "python") });
          break;
        case "0":
          if (double("0") && cell?.type === "code" && confirm(`Restart the ${kernelOf(cell.lang ?? "python")} kernel?`))
            send({ t: "restart", notebook: name, lang: kernelOf(cell.lang ?? "python") });
          break;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [actions, name]);

  if (error) return <div className="empty">Could not open {name}: {error}</div>;
  if (!cells) return <div className="empty">Loading…</div>;

  const restartAndRunAll = () => {
    if (!confirm("Restart both kernels and run all cells?")) return;
    send({ t: "restart", notebook: name, lang: "python" });
    send({ t: "restart", notebook: name, lang: "typescript" });
    actions.runAll(); // the server queues these behind the restarts
  };
  const selectedIndex = cells.findIndex((c) => c.id === selectedId);

  const keepWarm = async () => {
    const c = cache[settings.model];
    if (!c) return;
    const ids = new Set(c.cells.map((x) => x.id));
    let end = 0;
    cells.forEach((cell, i) => ids.has(cell.id) && (end = i + 1));
    const req: AskRequest = {
      notebook: name,
      cellId: "",
      cells: (await contextCells(cells, end)).slice(0, c.cells.length),
      question: "",
      mode: "hint",
      ...requestSettings(settings),
    };
    sentReqs.current.set("warm", req);
    send({ t: "keepWarm", req });
  };

  return (
    <div className="notebook">
      <header className="nb-header">
        <h1>{name.replace(/\.ipynb$/, "")}</h1>
        <span className={`save-state ${saveState}`}>{saveState === "saving" ? "saving…" : saveState === "error" ? "save failed" : "saved"}</span>
        <span className="spacer" />
        <button onClick={() => actions.runAll()} title="Run all code cells">
          ▶▶ Run all
        </button>
        <button onClick={() => actions.runAll(Math.max(0, selectedIndex))} title="Run all code cells above the selected cell">
          ▶ Run above
        </button>
        <button onClick={restartAndRunAll} title="Restart kernels, then run everything">
          ⟲ Restart &amp; run all
        </button>
        <select value={settings.model} onChange={(e) => onSettings({ model: e.target.value })} title="Tutor model">
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <select value={settings.effort} onChange={(e) => onSettings({ effort: e.target.value as Effort })} title="Effort: how hard the model thinks">
          {(["low", "medium", "high", "xhigh", "max"] as Effort[]).map((e) => (
            <option key={e} value={e}>
              effort: {e}
            </option>
          ))}
        </select>
      </header>

      <div className="cells">
        {cells.map((cell, i) => (
          <CellView
            key={cell.id}
            cell={cell}
            index={i}
            selected={cell.id === selectedId}
            editing={cell.id === selectedId && editing}
            running={running.has(cell.id)}
            asking={asking.has(cell.id)}
            staleOutput={cell.type === "code" && cell.outputs.length > 0 && ranSource.current.get(cell.id) !== cell.source}
            typeErrors={cell.type === "code" && cell.lang === "typescript" && markerTick >= 0 ? cellMarkers(cell.id) : []}
            actions={actions}
          />
        ))}
        <div className="add-row">
          {(["typescript", "python", "sql", "markdown", "prompt"] as CellKind[]).map((k) => (
            <button key={k} onClick={() => actions.insertAt(cells.length, k)}>
              + {{ typescript: "TypeScript", python: "Python", sql: "SQL", markdown: "Markdown", prompt: "✨ Prompt" }[k]}
            </button>
          ))}
        </div>
      </div>

      <StatusBar
        cells={cells}
        cache={cache[settings.model] ?? null}
        model={settings.model}
        settings={settings}
        kernels={kernels}
        shared={shared}
        onKeepWarm={keepWarm}
        onInterrupt={(lang) => send({ t: "interrupt", notebook: name, lang })}
        onRestart={(lang) => send({ t: "restart", notebook: name, lang })}
      />
    </div>
  );
}
