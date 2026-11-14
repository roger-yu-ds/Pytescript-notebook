# Polyglot Tutor

Notebooks for learning to code: Markdown, Python, TypeScript and SQL cells, plus
**Tutor Prompt** cells where an AI tutor (Claude) sees every cell above the
question. You write code, run it, and ask about what you see. By default the
tutor teaches Socratically: hints first, the full answer when you ask.

It comes in two forms that share one engine and one file format (plain `.ipynb`):

- **A VS Code extension**: [`packages/extension`](packages/extension/README.md)
- **A standalone web app** that runs locally in your browser

See [DESIGN.md](DESIGN.md) for the design decisions and roadmap.

## VS Code extension

Install it from the VS Code Marketplace or Open VSX (search for "Polyglot
Tutor"), or build it from this repo:

```bash
npm install
npm run package:extension
code --install-extension packages/extension/polyglot-tutor.vsix
```

Then follow the walkthrough (**Get started with Polyglot Tutor**): set your
Anthropic API key, let **Set Up Runtimes** install Python and Deno, and open the
welcome tour. The [extension README](packages/extension/README.md) has the
details.

## Web app

```bash
cp .env.example .env        # then edit .env: ANTHROPIC_API_KEY=sk-ant-...
npm run dev                 # starts the backend (:8787) and the UI
```

Open **http://127.0.0.1:5173** (on WSL, your Windows browser works) and stop
with `Ctrl+C`. It needs the one-time setup below.

On first start, an empty notebooks folder gets **`welcome.ipynb`**, a guided
tour. Select its first code cell and keep pressing **Shift+Enter**. Notebooks
are saved in `~/notebooks` (override with `NOTEBOOK_DIR` in `.env`).

| Keys (command mode) | |
|---|---|
| `Enter` / `Esc` | edit cell / back to command mode |
| `Shift+Enter` | run (or ask) and move to next cell |
| `Ctrl+Enter` | run (or ask) in place |
| `Alt+Enter` | run and insert a cell below |
| `A` / `B` | insert cell above / below |
| `D D` / `Z` | delete cell / undo delete |
| `M` / `Y` / `T` / `P` | to Markdown / Python / TypeScript / ✨ Prompt (the same keys work in VS Code, in command mode) |
| `↑ ↓` or `K J` | move selection |
| `I I` / `0 0` | interrupt / restart the cell's kernel |
| `Ctrl+S` | save now (it also autosaves) |

- **Prompt cells**: pick "✨ Prompt" in the cell's type dropdown. 💡 Hint (default) makes the tutor nudge you; ✅ Answer gets the full solution.
- **Run all** runs the code cells in order and skips prompt cells, so it never bills your API key for questions you didn't just ask (the same in VS Code and the CLI). Run prompt cells one at a time.
- 🙈 hides a cell from the tutor; 📌 sends it untruncated. 🤔 **Ask about this error** inserts a prompt cell below a failed cell.
- Status bar: kernel states, the **context ring** (how full the tutor's context is, as % of your token budget), and a quiet prompt-cache countdown with ↻ keep warm.
- **Cell colours**: each cell has a stripe in its language's colour (Python, TypeScript, SQL, Markdown, ✨ Prompt) and prompt cells have a tinted background. Change the colours, or turn them off, in ⚙ Settings → Cell colours. (In VS Code, prompt cells are tinted; see the extension's README.)
- ⚙ Settings: learner profile, model, reasoning, cache lifetime, and how much context the tutor gets, and cell colours.

### One-time setup (web app and development)

```bash
# Python side: Jupyter + kernel + data libraries in a local venv
uv venv --python 3.13 .venv
uv pip install --python .venv -r requirements.txt

# TypeScript side: Deno (the kernel spec is written automatically)
curl -fsSL https://deno.land/install.sh | sh    # installs to ~/.deno/bin

npm install
```

`PYTHON_BIN` and `DENO_BIN` in `.env` point the web app at other runtimes.

## Imports in TypeScript cells

TypeScript cells run on Deno, so they can import packages the way Deno does:

```ts
import { z } from "npm:zod@4";          // npm
import { expect } from "jsr:@std/expect"; // jsr
import path from "node:path";            // Node built-ins
import { z } from "zod";                  // a bare name from deno.json next to the notebook
```

The type checker (in VS Code, the web app and the CLI) resolves every import the
same way the kernel does: Deno fetches the package into its cache, and the
package's own declarations are used for errors, completions and hover. A
`deno.json` in the notebook's folder applies to both: its import map resolves
bare names, and its `deno.lock` pins versions. A `deno.json` in a parent folder
works too (a course repo can keep one at its root and its notebooks in a subfolder). While a package downloads, its
imports are typed as `any`; a package Deno can't resolve shows **Cannot find
module** with Deno's own message.

A cell with an import is a module. Its top-level names (imports included) still
reach the cells below it, as they do in the kernel.

## Running notebooks headless

```bash
npx polyglot-tutor run notebooks/00-intro.ipynb notebooks/01-types.ipynb
```

`polyglot-tutor run` type-checks the TypeScript cells first, then runs the code
cells in order on real kernels and prints their output. Prompt cells are skipped.
The exit code is 0 when every cell passed, 1 when a cell or the type check
failed, and 2 for bad arguments.

| Option | |
|---|---|
| `--mode learner\|solutions` | sets `POLYGLOT_TUTOR_MODE` in the kernels (default `learner`) |
| `--env KEY=VALUE` | extra environment variables for the kernels (repeatable) |
| `--python <path>`, `--deno <path>` | the runtimes (defaults: `$POLYGLOT_PYTHON` / `$PYTHON_BIN` / `./.venv`, and `$POLYGLOT_DENO` / `$DENO_BIN` / `~/.deno/bin/deno` / `deno` on PATH) |
| `--timeout <seconds>` | per-cell limit; a cell over it is interrupted (default 600) |
| `--keep-going` | carry on after a failing cell or type error |
| `--json` | a machine-readable report: per-cell status, outputs and type errors |
| `--no-typecheck` | skip the type check |

Kernels start in the notebook's folder, so relative paths, `deno.json` and
`.data/` work as in the editors.

## Sharing data between languages

```python
share("sales", df)            # Python: DataFrames travel as tables
df = get("people")            # tables come back as pandas DataFrames
```

```ts
await share("people", [{ name: "Ada", age: 36 }]);   // arrays of objects → tables
const sales = await get<{ region: string; amt: number }[]>("sales");
```

```sql
-- as: by_region
select region, sum(amt) as total from sales group by region
```

SQL cells run on DuckDB inside the Python kernel. They can query Python
DataFrames by variable name, anything shared as a table, and tables created by
earlier SQL cells. A first line `-- as: name` saves the result as a Python
DataFrame and shares it.

### Saving tables (Delta Lake)

```python
share("scores", df, persist=True)    # a new Delta version in .data/<notebook>/scores next to the notebook
get("scores", version=0)             # time travel
history("scores")                    # versions + timestamps
```

```ts
await share("rows", data, { persist: true });
```

```sql
select * from scores;                -- latest version, also after restarts
select * from delta_at('scores', 0); -- an older version
```

## Repository layout

```
packages/core        shared engine: .ipynb codec, Jupyter client, kernel preludes,
                     share/get hub, Delta, tutor (requests, compression, caching),
                     TypeScript cell checker and Deno import resolution
packages/server      web app backend (Hono + WebSocket)
packages/web         web app UI (React + Monaco, with a custom TypeScript worker)
packages/extension   VS Code extension (notebook serializer, controller, renderer,
                     type checker, tsserver plugin, runtime setup)
packages/cli         `polyglot-tutor run`: notebooks headless on real kernels
examples/            welcome tour (generated by scripts/build-welcome.ts)
tests/               web app end-to-end tests and the mock Anthropic API
scripts/             the welcome builder and the coverage runner
```

## Tests

```bash
npm test                 # typecheck, unit tests, CLI tests, web e2e, VS Code integration tests
npm run test:unit        # core + extension unit tests
npm run test:cli         # the CLI on real kernels
npm run test:web         # web app e2e: mock API, real kernels, headless Chromium
npm run test:extension   # VS Code integration tests (downloads VS Code; needs a display)
npm run test:vsix -w polyglot-tutor   # the same, against the packaged .vsix
npm run coverage         # unit + CLI tests under c8; add -- --web for the e2e too (CI does)
```

Coverage reports every source file and gates per-file thresholds only on files
that are new or changed (the list is in `scripts/coverage.mjs`; the extension's
host code runs inside VS Code, so it is reported but not gated).

If Chromium can't find system libraries (`libnss3` etc.), install them
(`npx playwright install --with-deps chromium`) or point `LD_LIBRARY_PATH` at a
folder containing them; `CHROMIUM_PATH` points the e2e at another Chromium
build, and `ONLY=kernel,ui,types` runs a subset of its sections. On a Linux
machine without a display, run the extension tests under `xvfb-run -a`.

To debug the extension, open this folder in VS Code and press **F5** (Run
Polyglot Tutor extension).

Releasing to the Marketplace and Open VSX: see [PUBLISHING.md](PUBLISHING.md).

## License

[MIT](LICENSE)
