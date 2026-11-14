import { useEffect, useState } from "react";
import { CELL_COLOR_KINDS, DEFAULT_CELL_COLORS, DEFAULT_SETTINGS, MODELS, cellColorVars, resolveCellColors, type CellColors, type Settings } from "@polyglot-tutor/core/browser";
import { api } from "./api.ts";
import { onConnection } from "./ws.ts";
import { NotebookView } from "./components/NotebookView.tsx";

function NumberField({ label, hint, value, min, max, step = 1, onChange }: { label: string; hint: string; value: number; min: number; max: number; step?: number; onChange: (n: number) => void }) {
  return (
    <label title={hint}>
      {label}
      <input type="number" value={value} min={min} max={max} step={step} onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || min)))} />
    </label>
  );
}

const COLOR_LABELS: Record<(typeof CELL_COLOR_KINDS)[number], string> = {
  markdown: "Markdown",
  python: "Python",
  typescript: "TypeScript",
  sql: "SQL",
  prompt: "✨ Prompt",
};

function CellColorFields({ colors, onChange }: { colors: CellColors; onChange: (c: CellColors) => void }) {
  const set = (patch: Partial<CellColors>) => onChange({ ...colors, ...patch });
  return (
    <>
      <label className="check" title="A stripe in each language's colour along the top of the cell, and a tinted background for prompt cells">
        <input type="checkbox" checked={colors.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Colour cells by type
      </label>
      <div className="color-grid">
        {CELL_COLOR_KINDS.map((kind) => (
          <label key={kind}>
            <input type="color" value={colors[kind]} disabled={!colors.enabled} onChange={(e) => set({ [kind]: e.target.value })} aria-label={`${COLOR_LABELS[kind]} colour`} />
            {COLOR_LABELS[kind]}
          </label>
        ))}
        <label title="Background of Tutor Prompt cells">
          <input type="color" value={colors.promptBackground} disabled={!colors.enabled} onChange={(e) => set({ promptBackground: e.target.value })} aria-label="Prompt background colour" />
          Prompt background
        </label>
      </div>
      <button type="button" onClick={() => onChange({ ...DEFAULT_CELL_COLORS })}>
        Reset colours
      </button>
    </>
  );
}

function SettingsModal({ settings, onSave, onClose }: { settings: Settings; onSave: (s: Settings) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<Settings>({ ...DEFAULT_SETTINGS, ...settings, context: { ...DEFAULT_SETTINGS.context, ...settings.context } });
  const set = (patch: Partial<Settings>) => setDraft((d) => ({ ...d, ...patch }));
  const setCtx = (patch: Partial<Settings["context"]>) => setDraft((d) => ({ ...d, context: { ...d.context, ...patch } }));
  const [status, setStatus] = useState<{ apiKey: boolean; notebookDir: string } | null>(null);
  useEffect(() => void api.status().then(setStatus), []);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <label>
          Learner profile
          <span className="hint">Sent to the tutor with every question (and cached), e.g. "Comfortable with Python, new to TypeScript generics. Prefer short explanations."</span>
          <textarea rows={4} value={draft.learnerProfile} onChange={(e) => set({ learnerProfile: e.target.value })} />
        </label>

        <h3>Tutor</h3>
        <div className="settings-grid">
          <label className="check" title="Show a collapsible summary of the model's reasoning above each answer">
            <input type="checkbox" checked={draft.showThinking} onChange={(e) => set({ showThinking: e.target.checked })} /> Show reasoning
          </label>
          <label title="Prompt cache lifetime. 1 hour costs 2× input to write; 5 minutes costs 1.25× but expires quickly.">
            Cache lifetime
            <select value={draft.cacheTtl} onChange={(e) => set({ cacheTtl: e.target.value as Settings["cacheTtl"] })}>
              <option value="1h">1 hour</option>
              <option value="5m">5 minutes</option>
            </select>
          </label>
        </div>

        <h3>Context sent to the tutor</h3>
        <div className="settings-grid">
          <NumberField label="Recent cells in full" hint="Cells sent verbatim (outputs and charts). Rounded up to whole blocks, plus the block in progress." value={draft.context.recentCells} min={1} max={200} onChange={(n) => setCtx({ recentCells: n })} />
          <NumberField label="Block size (cells)" hint="Older cells are compressed in fixed blocks of this size, so the cached prefix only changes once per block." value={draft.context.blockSize} min={1} max={100} onChange={(n) => setCtx({ blockSize: n })} />
          <NumberField label="Token budget" hint="Above this (estimated), the oldest blocks are replaced by short summaries." value={draft.context.tokenBudget} min={1000} max={500000} step={1000} onChange={(n) => setCtx({ tokenBudget: n })} />
          <NumberField label="Output limit (chars)" hint="Characters kept per output in full cells (head + tail). 📌 pinned cells are never cut." value={draft.context.outputLimit} min={200} max={100000} step={100} onChange={(n) => setCtx({ outputLimit: n })} />
          <label title="Model that writes the summaries of old blocks (each block is summarised once and cached).">
            Summary model
            <select value={draft.summaryModel} onChange={(e) => set({ summaryModel: e.target.value })}>
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <h3>Cell colours</h3>
        <CellColorFields colors={resolveCellColors(draft.cellColors)} onChange={(c) => set({ cellColors: c })} />

        <p className="hint">
          API key: {status ? (status.apiKey ? "✓ configured" : "✗ missing — add ANTHROPIC_API_KEY to .env and restart the server") : "…"}
          <br />
          Notebooks folder: <code>{status?.notebookDir ?? "…"}</code>
        </p>
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            onClick={() => {
              onSave(draft);
              onClose();
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

export function App() {
  const [list, setList] = useState<{ name: string; mtime: number }[]>([]);
  const [current, setCurrent] = useState<string | null>(() => {
    try {
      return localStorage.getItem("current");
    } catch {
      return null;
    }
  });
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  const [connected, setConnected] = useState(true);

  const refresh = () => api.list().then(setList);
  useEffect(() => {
    refresh();
    api.settings().then((s) => setSettings({ ...DEFAULT_SETTINGS, ...s, context: { ...DEFAULT_SETTINGS.context, ...s.context } }));
    return onConnection(setConnected);
  }, []);

  useEffect(() => {
    if (!current && list.length) setCurrent(list[0].name);
    try {
      if (current) localStorage.setItem("current", current);
    } catch {
      /* ignore */
    }
  }, [current, list]);

  // Cell colours → CSS variables on <html> (styles.css reads them), or plain cells when turned off.
  useEffect(() => {
    const colors = resolveCellColors(settings.cellColors);
    const root = document.documentElement;
    for (const [name, value] of Object.entries(cellColorVars(colors))) root.style.setProperty(name, value);
    root.classList.toggle("cell-colors-off", !colors.enabled);
  }, [settings.cellColors]);

  const updateSettings = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    api.saveSettings(next);
  };

  const create = async () => {
    const name = prompt("Notebook name", "learning-typescript");
    if (!name) return;
    try {
      const nb = await api.create(name);
      await refresh();
      setCurrent(nb.name);
    } catch (e) {
      alert(String((e as Error).message));
    }
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">Polyglot Notebook</div>
        <button className="new-nb" onClick={create}>
          + New notebook
        </button>
        <nav>
          {list.map((n) => (
            <button key={n.name} className={n.name === current ? "active" : ""} onClick={() => setCurrent(n.name)} title={n.name}>
              {n.name.replace(/\.ipynb$/, "")}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        {!connected && <div className="offline">server disconnected — retrying…</div>}
        <button className="settings-btn" onClick={() => setShowSettings(true)}>
          ⚙ Settings
        </button>
      </aside>
      <main>
        {current ? (
          <NotebookView key={current} name={current} settings={settings} onSettings={updateSettings} />
        ) : (
          <div className="empty">
            <p>No notebooks yet.</p>
            <button onClick={create}>Create your first notebook</button>
          </div>
        )}
      </main>
      {showSettings && <SettingsModal settings={settings} onSave={(s) => updateSettings(s)} onClose={() => setShowSettings(false)} />}
    </div>
  );
}
