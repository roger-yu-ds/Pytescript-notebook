# Polyglot Tutor

**Notebooks for learning to code, with an AI tutor that has read your notebook.**

Write Python, TypeScript or SQL in notebook cells, run them, and ask questions in **Tutor Prompt** cells. The tutor (Claude) sees every cell above the question, including code, outputs, errors, type errors and charts, and answers in the context of what you actually did. By default it teaches Socratically: you get a hint and a guiding question, and the full answer only when you ask for it.

## Features

- **Three languages in one notebook.** Python (Jupyter), TypeScript (Deno) and SQL (DuckDB) cells share data: `share("name", value)` and `get("name")` work in every language, and SQL can query Python DataFrames by name.
- **Tutor Prompt cells.** Pick *Tutor Prompt* as the cell language and run the cell. Answers stream in as Markdown. Code blocks have **Copy** and **Insert as cell** buttons.
  - 💡 **Hint** (default) or ✅ **Answer** mode: click the item under the cell to switch.
  - 🙈 **Hide Cell from Tutor** and 📌 **Always Send Cell in Full**, from the cell toolbar.
  - **Ask about this error** appears under failed cells and as a quick fix on TypeScript type errors.
- **Real type checking for TypeScript cells**, with Deno's types and cross-cell declarations. Type errors also go to the tutor.
- **Imports in TypeScript cells.** `npm:zod@4`, `jsr:@std/expect`, `node:path`, URLs, and bare names from a `deno.json` import map next to the notebook all work, with their real types: Deno fetches the package, and the checker, completions and hover use its declarations. A cell with an import keeps its names for the cells below it, as in the kernel. A package Deno can't find shows "Cannot find module" with Deno's own message.
- **Run All** runs the code cells and skips Tutor Prompt cells, so a run never bills your API key for questions you didn't just ask. Run prompt cells one at a time.
- **Delta Lake tables.** `share("t", df, persist=True)` saves a versioned table next to the notebook (`.data/<notebook>/`). Read old versions with `get("t", version=0)` or `select * from delta_at('t', 0)`.
- **Long notebooks stay cheap.** Context is compressed in frozen blocks: older cells are sent compact, and the oldest are summarised when the context passes your token budget. The ring in the status bar shows how full it is.
- **Prompt caching.** A quiet countdown in the status bar shows how long the cache stays warm (1 hour by default); click it to keep it warm. Set `polyglotTutor.cacheLifetime` to `off` to turn caching off.
- **Plain `.ipynb` files** that open in Jupyter and on GitHub. Prompt cells are saved as readable Markdown.

## Getting started

1. Open the walkthrough with **Help → Welcome → Get started with Polyglot Tutor**, or run the commands below from the Command Palette.
2. **Polyglot Tutor: Set Anthropic API Key.** Get a key at [console.anthropic.com](https://console.anthropic.com/). It is stored in VS Code's secret storage. `ANTHROPIC_API_KEY` in the environment or a workspace `.env` also works.
3. **Polyglot Tutor: Set Up Runtimes.** This installs Python 3.13 (with Jupyter, pandas, DuckDB and Delta Lake) and Deno into the extension's own folder, after asking you to confirm each download. To use your own installs instead, set `polyglotTutor.pythonPath` and `polyglotTutor.denoPath`.
4. **Polyglot Tutor: Open Welcome Tour**, then keep pressing **Shift+Enter**.

Existing notebooks open with **Reopen Editor With… → Polyglot Tutor**. Notebooks made with Polyglot Tutor offer to reopen themselves, and can remember that choice for the workspace.

## Commands

| Command | |
|---|---|
| New Notebook / Open Welcome Tour | Start a notebook |
| Insert Prompt Cell Below | Add a Tutor Prompt cell (also in the notebook toolbar) |
| Set Anthropic API Key / Remove Anthropic API Key | Manage the key |
| Set Up Runtimes (Python, Deno) | Check or install the runtimes |
| Select Tutor Model | Also from the model name in the status bar |
| Keep Prompt Cache Warm | Re-reads the cache to reset its timer; no answer is generated |
| Kernel Actions… / Restart Kernels / Interrupt Kernels | Also from the kernel items in the status bar |

Running cells uses VS Code's usual notebook keys (Shift+Enter, Ctrl+Enter, Alt+Enter, and so on).

## Settings

| Setting | Default | |
|---|---|---|
| `polyglotTutor.model` | Sonnet 5.5 | Model that answers prompt cells (Sonnet 5.5, Opus 5.5, Haiku 5.5, Fable 5.1) |
| `polyglotTutor.effort` | medium | How much the tutor thinks before answering |
| `polyglotTutor.learnerProfile` | | Sent with every question: your background and preferences |
| `polyglotTutor.showReasoning` | off | Collapsible summary of the tutor's reasoning |
| `polyglotTutor.cacheLifetime` | 1 hour | Prompt cache lifetime: 1 hour, 5 minutes, or off |
| `polyglotTutor.context.*` | 10 / 10 / 40k / 2000 | Recent cells sent in full, block size, token budget, output limit |
| `polyglotTutor.summaryModel` | Haiku 5.5 | Writes the summaries of old blocks |
| `polyglotTutor.pythonPath` / `denoPath` | | Your own runtimes instead of the managed ones |
| `polyglotTutor.tintPromptCells` | on | Tint Tutor Prompt cells (and mark them in the scrollbar) so they stand out |

The tint is a theme colour, so you can pick your own in `settings.json`:

```json
"workbench.colorCustomizations": {
  "polyglotTutor.promptCellBackground": "#b48cff26",
  "polyglotTutor.promptCellRuler": "#b48cff"
}
```

VS Code doesn't let an extension colour a whole cell, so the tint covers the cell's lines, not its frame.

## Privacy and costs

- When you **run a prompt cell**, the visible cells above it (sources, outputs, errors, type errors, earlier answers and recent charts) and your learner profile are sent to the Anthropic API with your key. Nothing is sent otherwise. Cells marked 🙈 are never sent.
- The extension collects **no telemetry**.
- API usage is billed to your Anthropic account. Each answer shows its tokens and cost under the cell.
- Kernels run your code locally with your user's permissions, like any Jupyter kernel. Only open notebooks you trust.

## Requirements

- VS Code 1.90 or newer, on Linux, macOS or Windows. Remote setups (WSL, SSH, Dev Containers) work too: the extension runs where your files are.
- An Anthropic API key.
- Network access for Set Up Runtimes, unless you point the settings at your own Python and Deno.

There is also a standalone web version of the same notebook in the [project repository](https://github.com/roger-yu-ds/Pytescript-notebook).
