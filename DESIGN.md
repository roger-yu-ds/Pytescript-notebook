# Polyglot Tutor — Design

(Originally "Polyglot Notebook"; the first part below describes the web app.)

A local notebook for learning to code. Cells can be Markdown,
Python, TypeScript, SQL, or **Prompt** — an AI tutor that sees every cell above
it (source, outputs, errors, earlier Q&A) and answers in context.

Agreed in a design interview on 2026-11-03.

## Principles

- **Learning first.** The AI is a Socratic tutor: hints before answers. It never
  edits your notebook — copying code in is always your action.
- **Local, single-user.** Runs on WSL, binds to `127.0.0.1`, no auth, no sandbox.
- **Built in TypeScript**, so building it is TypeScript practice too.

## Cells

| Type       | Notes |
|------------|-------|
| Markdown   | Rendered with highlighted code fences (copy / insert-as-cell buttons). |
| Python     | ipykernel. Rich output: images, HTML tables, plots. |
| TypeScript | Deno's Jupyter kernel. Monaco gives full type-checking (squiggles, hover, autocomplete). Type errors are shown on the cell, don't block execution, and are included in AI context. |
| SQL        | DuckDB inside the Python kernel; queries Python DataFrames by name, shared tables, and earlier SQL tables. `-- as: name` saves + shares the result. |
| Prompt     | One question + one answer per cell. Streams markdown. Editable / regenerable. Hint ↔ Answer toggle (default Hint). |

- Execution model: Jupyter-style (any order, persistent state), plus *Run all
  above*, *Restart & run all*, and an "edited since run" marker.
- Shortcuts: standard Jupyter (Shift/Ctrl/Alt+Enter, A, B, D D, M, Y, Z, Esc/Enter,
  J/K/arrows), plus T (TypeScript) and P (prompt), also in the VS Code extension
  (keybindings on `polyglotTutor.cellTo*`, command mode only). Language and
  prompt type are also chosen from a per-cell dropdown (web) or the language picker (VS Code).
- Per-cell flags: 🙈 hide from AI, 📌 always send in full.

## Architecture

```
Browser (React + Vite + Monaco)
   │  REST (notebooks, settings) + one WebSocket (execution + LLM streaming)
Node backend (Hono + ws, 127.0.0.1)
   ├── spawns `jupyter server` (uv venv) ── ipykernel (Python, SQL via DuckDB)
   │                                     └─ deno jupyter kernel (TypeScript)
   └── Anthropic API (@anthropic-ai/sdk), key in .env
```

- The backend speaks the Jupyter kernel WebSocket protocol directly
  (`/api/kernels/{id}/channels`), one Python + one Deno kernel per open notebook,
  started lazily.
- `share(name, value)` / `get(name)` helpers preloaded in every kernel (a silent
  prelude, re-run after restarts), with the Node backend as hub
  (`/api/shared/:notebook/:name`, guarded by a per-run token). Tables are stored
  as Arrow IPC; Python sends/receives Arrow, TypeScript sends/receives JSON rows
  and the hub converts. SQL cells sync shared tables into DuckDB before running.
- `share(..., persist=True)` (Python) / `share(name, rows, { persist: true })`
  (TypeScript) writes a Delta table to `<notebooks>/.data/<notebook>/<name>` via
  delta-rs (`deltalake`); each share is a new version. DuckDB's `delta`
  extension reads it: SQL sees the latest version by name, `delta_at(name, v)`
  time-travels, Python has `get(name, version=v)` and `history(name)`. Persisted
  tables are registered when the Python kernel starts, and the hub loads them on
  demand for TypeScript `get()`.
  *Checked 2026-11-03: DuckDB 2.0 cannot write Delta (`COPY … (FORMAT delta)`
  doesn't exist), so writes go through delta-rs.*
- Notebooks are `.ipynb` files in `~/notebooks`, autosaved. Polyglot-specific
  data lives in `cell.metadata.polyglot`; prompt cells are stored as markdown
  cells (question + answer visible on GitHub).

## AI context

The request for a prompt cell is:

1. `system`: tutor instructions + learner profile (from Settings). Stable →
   cached with a 1-hour breakpoint.
2. `user`: one content block per visible cell above the prompt, then the question
   block (with the Hint/Answer mode). A 1-hour cache breakpoint sits on the last
   cell block, so the question itself is never cached.

Context tiers:

- **v1:** every cell above, outputs truncated (head + tail, `outputLimit` chars).
- **Frozen-block compression (v3):** cells are grouped into fixed blocks
  (`blockSize`, default 10). The last `ceil(recentCells / blockSize) + 1` blocks
  are verbatim (with charts). Older blocks are *compact*: full source, one-line
  output stubs, answers cut to ~600 chars. If the estimated total exceeds the
  token budget, the oldest compact blocks are replaced, oldest first, by a
  summary written once by the summary model (Haiku 5.5) and cached on disk
  (`~/.cache/polyglot-notebook/summaries.json`, keyed by model + block text).
  Rendering changes only when the window moves (every `blockSize` cells) or the
  budget is crossed, so the prefix stays byte-identical in between.
  📌 pinned cells are never compacted.
- Chart images (PNG) are attached for cells in the last two blocks of 10 context
  cells; older charts become a one-line stub. The window moves only every 10
  cells, so the cached prefix stays stable in between.

## Prompt cache

- 1-hour TTL (`cache_control: {type: "ephemeral", ttl: "1h"}`): writes cost 2×
  input, reads 0.1× (0.05× on Opus 5.5). Reads reset the timer for free; the
  timer runs from the **start** of each request. Minimum cacheable prefix is
  ~512 tokens on current models.
- Status bar shows a subtle countdown (`cache 47:12`), coloured only in the last
  5 minutes or when stale. Editing a cell inside the cached prefix shows
  `cache stale from cell N`.
- **Keep warm** (manual): re-sends the cached prefix with `max_tokens: 0` —
  a cache read only, no output — to reset the timer.
- Caches are per model; switching models shows the other model's cache state.

## Model

- Default `claude-sonnet-5-5`, effort `medium`; model + effort pickers in the
  header (Sonnet 5.5, Opus 5.5, Haiku 5.5, Fable 5.1).
- Thinking hidden by default; Settings → "Show reasoning" streams a summarised
  reasoning section (collapsed) above the answer. Each prompt shows tokens and
  cost (including any summarisation).
- Cache TTL is a setting (1 hour default, or 5 minutes); the countdown follows it.
- Server-side refusal fallback (`fallbacks: "default"`) enabled where supported.

## Roadmap

1. **v1** ✅ — Markdown/Python/TypeScript/Prompt cells, full context with simple
   truncation, 1-hour cache + countdown + keep-warm, code-block buttons, `.ipynb`,
   Monaco type-checking, model/effort pickers, learner profile, Hint/Answer.
2. **v2** ✅ — SQL via DuckDB, `share`/`get`, "Ask about this error" button, charts
   to the AI.
3. **v3** ✅ — Frozen-block compression with Haiku summaries, Delta persistence,
   full Settings panel (N, block size, budget, TTL, models, show thinking).

---

# Polyglot Tutor for VS Code — Design

Agreed in a second design interview on 2026-11-03. The project is renamed
**Polyglot Tutor** (Microsoft's "Polyglot Notebooks" is deprecated but still
listed, and a near-identical name would confuse people).

## Decisions

| # | Decision |
|---|---|
| Architecture | Native VS Code notebook: our own notebook type, kernel controller, renderer and status bar items. No webview app-in-a-box. |
| Web app | Kept. Backend logic moves to a shared `core` package used by both the web server and the extension. |
| Distribution | VS Code Marketplace **and** Open VSX, publisher `roger-yu-ds`, MIT license, public repo. |
| API key | VS Code SecretStorage ("Polyglot Tutor: Set Anthropic API Key"); falls back to `ANTHROPIC_API_KEY` in the environment or a workspace `.env`. |
| Runtimes | A "Set up runtimes" walkthrough installs a private venv (via `uv`) and Deno into the extension's storage, after confirming each download. `polyglotTutor.pythonPath` / `polyglotTutor.denoPath` override it. Each language lights up on its own. |
| Platforms | Linux, macOS, Windows, and remote (WSL/SSH/containers; the extension runs where the files are). |
| Notebook type | Own type `polyglot-tutor`, plain `.ipynb` in the web app's format. Registered as an *optional* editor for `*.ipynb`; opening one of our notebooks in the Jupyter editor offers "Reopen with Polyglot Tutor (and always in this workspace)". |
| Settings | VS Code settings under `polyglotTutor.*`. |
| TypeScript intelligence | Self-contained: our own TypeScript checker in the extension host reports type errors on cells (built-in TS hides semantic errors in notebooks); a tsserver plugin adds the Deno and `share`/`get` declarations for completions and hover. Steps back when the Deno extension is enabled for the file. |
| Python intelligence | Pylance works on our notebook type. Ask once per workspace whether to point the Python extension at the tutor's environment. |
| Context ring | A ring in the status bar (eighths) showing the estimated context of the next question as % of the token budget; the hover breaks it down by tier and also shows % of the model's window. Also in the web app. |
| Testing | Unit tests for `core`, the existing e2e suite for the web app, and VS Code integration tests (`@vscode/test-electron`) with the mock Anthropic server and real kernels. CI on Linux, Windows and macOS. |

## Where things live in VS Code

| Feature | VS Code |
|---|---|
| Prompt cell | Code cell with language `tutor-prompt` ("Tutor Prompt"); running it asks the tutor. |
| Answer | Output with mime `application/vnd.polyglot-tutor.answer+json`, drawn by our notebook renderer: streaming Markdown, highlighted code blocks with Copy and Insert-as-cell, collapsible reasoning, usage line. |
| Hint/Answer, 🙈, 📌 | Cell status bar items (click to toggle). |
| Ask about this error | Cell status bar item on failed cells; quick fix on TypeScript type errors. |
| Kernels | Status bar (left), click for interrupt/restart. |
| Cache countdown, keep warm, context ring, model | Status bar (right), low prominence. |
| Shared values | "Shared values" view in the Explorer (💾 = Delta). |
| Welcome tour | Command + walkthrough step. |

## Packages

```
packages/core       types, .ipynb codec, Jupyter client, preludes, share/get hub,
                    tutor (request building, compression, streaming), context
                    planning/estimates, runtime paths
packages/server     web backend (Hono + ws) on top of core
packages/web        React UI
packages/extension  VS Code extension (esbuild bundle) + notebook renderer
```

Kernels are per notebook file. A notebook's Delta tables live in
`<notebook dir>/.data/<notebook name>/` for both front ends, and kernels `chdir`
into the notebook's folder. The Deno kernel spec is written by us (into a
private `JUPYTER_PATH` dir), so no global `deno jupyter --install` is needed.

## Phases

- **E1 — works on this machine** ✅: package split + rename, serializer, controller
  (Python/TypeScript/SQL), share/get + Delta, prompt cell with streaming renderer,
  settings, SecretStorage, runtimes from configured paths.
- **E2 — parity** ✅: TypeScript diagnostics + tsserver plugin, cell status bar
  toggles, ask-about-error, shared-values view, cache countdown + keep warm,
  context ring (VS Code + web), Pylance environment prompt, reopen-and-remember.
- **E3 — publishable** ✅: runtime setup walkthrough, Windows/macOS paths, CI
  matrix, icon, Marketplace README with privacy note (notebook content goes to
  Anthropic; no telemetry), CHANGELOG, packaging for Marketplace + Open VSX.
  Publishing itself waits for the publisher accounts (see PUBLISHING.md).

## Implementation notes

- *TypeScript checker*: TypeScript 7 (the native port) has no JS language-service
  API, so the extension bundles TypeScript 6.0.3 (aliased `typescript-6`) and its
  `lib.*.d.ts` files.
- *tsserver plugin*: `getExternalFiles` only attaches a file to a project; the
  plugin also appends the globals file to the host's `getScriptFileNames`. tsserver
  creates one plugin instance per project, and projects created after
  `configurePlugin` get the config as `info.config` in `create()`.

---

# TypeScript imports, cross-cell modules and the headless runner

Agreed on 2026-11-05, for the "TypeScript for AI engineering" course that runs in
these notebooks (its notebooks import Zod, the Anthropic SDK and friends, and are
checked and run headless in CI).

## The problem

Every TypeScript cell is checked as its own file. That is right for script cells
(declarations are global, as in the kernel), but a cell with an `import` is a
module: its names stay private, so later cells got "Cannot find name", and the
specifiers Deno understands (`npm:`, `jsr:`, `node:`, import-map names, URLs)
were simply ignored by the checkers (2307 was suppressed).

## The design (all in `packages/core`, shared by the three front ends)

| Piece | What it does |
|---|---|
| `cell-links.ts` | For a module cell: an **export appendix** added to the end of the cell's text (every position in the cell stays the same) and a **companion** file `<cell>.globals.d.ts` with `export import x = __c.x` inside `declare global`, which re-exposes every name, type-only imports and generics included. `let`/`var` names are declared with their type so later cells can still assign to them. |
| `module-shims.ts` | `modules.d.ts`: `declare module "npm:zod@4" { export * from "zod"; … }` per specifier; a shorthand `declare module "x";` (types `any`) while a package is still being fetched. A bare import-map name gets no shim: it resolves from `node_modules` directly. |
| `deno-resolver.ts` | `deno info --json <specifier>` **in the notebook's folder**, so its `deno.json` and `deno.lock` apply, exactly as for the kernel. The result becomes a **types dir**: `node_modules/<pkg>` links into Deno's npm cache (a junction on Windows, a copy as fallback), remote modules copied under `remote/<host>/…`, plus `modules.d.ts`. `collectTypes` returns the same layout as text for the browser. Failures are remembered briefly, then retried. |
| `checker.ts` | `CellChecker`: one TypeScript 6 language service per notebook; cells are virtual files `<notebook dir>/.polyglot-cell-<id>.ts`, so relative imports find real files. Bare specifiers imported by a cell are resolved as if imported from the types dir's `modules.d.ts` (TypeScript would otherwise walk up from the notebook's folder). Diagnostics inside the appendix are dropped; 2307/2792 are reported again. |

Each front end does the same dance: update the cells → mark new specifiers
*pending* (typed `any`, so nothing is flagged while a package downloads) →
resolve with Deno asynchronously → rewrite the types dir → check again. A
specifier Deno can't resolve gets no shim, so the cell shows **Cannot find
module** with `Deno: <its message>` appended.

- **VS Code** (`typecheck.ts`): the types dir lives in
  `<globalStorage>/types/notebooks/<sha256(path)[:16]>`. The tsserver plugin
  (`ts-plugin/index.ts`, TypeScript, bundled without `typescript`) adds the
  appendix and companion to `^/vscode-notebook-cell/…` files, resolves the
  companion's import to its cell by hand, resolves bare names from the notebook's
  `modules.d.ts`, and filters companion/appendix locations out of references,
  rename and definitions, so completions and hover know what the checker knows.
- **Web app**: Monaco's TypeScript worker is subclassed (`src/ts-worker/`): same
  appendix and companion, `getImportSpecifiers`. The server resolves a specifier
  with Deno (`GET /api/types/:nb?specifier=`) and returns the cumulative shims plus
  the declaration files; the browser installs them as extra libs (packages at
  `file:///node_modules/<pkg>/…`, so bare names resolve by walking up from the
  cells). `customWorkerPath` can't be used: Vite makes module workers, which have
  no `importScripts`, so the worker is a normal `?worker` entry.
- **CLI** (`packages/cli`): `polyglot-tutor run` type-checks with `CellChecker`
  (types dir in a temp folder), then runs code cells in order on core's `Runtime`.

## Kernels start in the notebook's folder

Deno reads `deno.json` from its working directory at start-up, and Jupyter only
starts kernels inside its root dir. So a session links
`<stateDir>/nb/<session id>` (a junction on Windows) to the notebook's folder and
starts its kernels at that path; the preludes still `chdir` there for safety.
`Runtime` takes an `env` option (the CLI sets `POLYGLOT_TUTOR_MODE` and `--env`
pairs) which the Jupyter server passes on to every kernel.

## Run All

Running more than one cell skips prompt cells in every front end: a Run All that
asked the tutor once per prompt cell would bill the API key for questions the
learner didn't just ask.

## Tests

Core: unit tests for links, shims, the resolver (parsed `deno info` output, and
one test against the real Deno that downloads `npm:zod@4`) and the checker. CLI:
tests on real kernels (mixed languages, runtime error, type error, `--mode`,
`deno.json` import map, `--timeout`, `--json`, arguments). Web: Playwright checks
for real Zod types across cells, hover, an unresolvable package, the import map
and Run All. VS Code: integration tests for the same, through the real tsserver.
Coverage runs under c8 (`npm run coverage`), reporting everything and gating only
the files new or changed on a branch.
- *Packaging*: vsce only includes `node_modules` entries it sees as production
  dependencies, which npm workspaces hide, so `scripts/package.mjs` packages from a
  clean staging folder where the tsserver plugin is a regular dependency.
- *Runtime setup*: uv and Deno come from their GitHub releases (SHA-256 checked);
  uv installs Python 3.13 into the extension's folder (`UV_PYTHON_INSTALL_DIR`)
  and the packages pinned in `requirements.txt`.
