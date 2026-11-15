# Changelog

## Unreleased

- Tutor Prompt cells are tinted (and marked in the scrollbar) so they stand out from code cells. The colours are theme colours (`polyglotTutor.promptCellBackground`, `polyglotTutor.promptCellRuler`) you can override in `workbench.colorCustomizations`; `polyglotTutor.tintPromptCells` turns it off.
- Imports in TypeScript cells are typed for real: `npm:`, `jsr:`, `node:`, URLs and `deno.json` import-map names are resolved by Deno in the notebook's folder, and the checker, completions and hover use the packages' declarations. A package Deno can't resolve reports "Cannot find module" with Deno's message.
- A cell with an import (a module) now shares its names with the cells below it, in the checker and in completions.
- Run All skips Tutor Prompt cells instead of asking the tutor for each one.
- Command-mode keys `T` (TypeScript), `Y` (Python) and `P` (Tutor Prompt) change the selected cells' language, as in the web app; a Markdown cell becomes a code cell first. Also in the Command Palette as "Change Cell to …". `M` (Markdown) is VS Code's own key.
- A cell that imports a module which is a global already (`import process from "node:process"`) no longer loses the types of its other names in later cells: the checker and the tsserver plugin leave such names out of the cell's cross-cell links.
- Relative paths in Python cells resolve from the notebook's folder even when the kernel's Python lacks one of Polyglot Tutor's packages (e.g. `pyarrow`). Before, such a kernel stayed in Polyglot Tutor's storage folder, so `Path("../data/x.json")` failed with a confusing FileNotFoundError.
- When a kernel's setup fails, the next cell run shows why (e.g. `No module named 'pyarrow'`) and what to install, instead of only writing it to the log.

## 0.1.0

First release.

- Notebooks with Python, TypeScript (Deno) and SQL (DuckDB) cells, saved as plain `.ipynb`.
- Tutor Prompt cells: a Socratic AI tutor (Claude) that sees every cell above, with Hint / Answer modes, streaming answers, Copy / Insert-as-cell code blocks and optional reasoning.
- `share()` / `get()` between languages; `persist` saves Delta tables with versions and time travel.
- Type errors in TypeScript cells (with Deno's types), sent to the tutor and offered as a quick fix.
- Status bar: kernels, model, context ring, prompt-cache countdown with keep-warm.
- Shared Values view, Set Up Runtimes command, walkthrough and welcome tour.
