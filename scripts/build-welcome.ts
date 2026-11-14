// Generates examples/welcome.ipynb (the guided tour) with core's .ipynb writer.
//   npx tsx scripts/build-welcome.ts
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toIpynb, type Cell } from "@polyglot-tutor/core/browser";

let n = 0;
const id = () => `w${String(++n).padStart(2, "0")}`;
const md = (source: string): Cell => ({ id: id(), type: "markdown", source, outputs: [] });
const code = (lang: "python" | "typescript" | "sql", source: string): Cell => ({ id: id(), type: "code", lang, source, outputs: [], executionCount: null });
const ask = (source: string, mode: "hint" | "answer" = "hint"): Cell => ({ id: id(), type: "prompt", source, mode, response: "", outputs: [] });

const cells: Cell[] = [
  md(`# 👋 Welcome to Polyglot Tutor

A notebook for learning by doing: write code in **TypeScript**, **Python** or **SQL**, run it, then ask the **AI tutor** about what you see. The tutor reads every cell above its question, including outputs and errors.

**How to use this tour:** select the first code cell and keep pressing **Shift+Enter**. That runs the cell and moves to the next one. For ✨ Prompt cells, Shift+Enter (or Ctrl+Enter) sends the question.

| Keys | |
|---|---|
| Shift+Enter | run / ask, then go to the next cell |
| Enter / Esc | start / stop editing a cell |
| A / B | new cell above / below |
| D D | delete a cell (Z undoes) |

Change a cell's language with its language picker (web app: the dropdown at the cell's top left; VS Code: the language name at the cell's bottom right). "Tutor Prompt" makes a prompt cell.`),

  md(`## 1. TypeScript (runs on Deno)

The editor type-checks as you type. Cell 3 has a deliberate mistake: look for the red squiggle and the "1 type error" badge. The cell still runs, because TypeScript types are erased at runtime.`),
  code(
    "typescript",
    `interface User {
  name: string;
  age: number;
}

const ada: User = { name: "Ada", age: "36" }; // 👈 type error on purpose

function greet(user: User): string {
  return \`Hello, \${user.name}! Next year you'll be \${user.age + 1}.\`;
}

console.log(greet(ada));`,
  ),
  md(`Notice the output says **361**, not 37. The type error predicted a real bug: \`"36" + 1\` joins strings instead of adding numbers.

The next cell is a ✨ **Prompt** cell. It's in 💡 **Hint** mode, so the tutor nudges you toward the fix instead of handing it over. Switch to ✅ **Answer** for the full solution. Select it and press Shift+Enter.`),
  ask("Why does cell 3 print 361 instead of 37, and what is the red squiggle telling me?"),

  md(`## 2. Python

Python cells run in a real Jupyter kernel, so pandas tables and matplotlib charts work. Recent charts are also sent to the tutor as images.`),
  code(
    "python",
    `import pandas as pd
import matplotlib.pyplot as plt

sales = pd.DataFrame({
    "region": ["north", "south", "east", "west", "north", "east"],
    "month":  ["jan", "jan", "jan", "jan", "feb", "feb"],
    "amount": [120, 80, 95, 60, 140, 110],
})

sales.groupby("month", sort=False)["amount"].sum().plot(kind="bar", title="Sales by month")
plt.show()
sales`,
  ),

  md(`## 3. SQL (DuckDB)

SQL cells can query Python DataFrames **by variable name**. Here that's \`sales\` from cell 7. The first line \`-- as: by_region\` saves the result as a Python DataFrame and **shares** it with the other languages.`),
  code(
    "sql",
    `-- as: by_region
select region, sum(amount) as total
from sales
group by region
order by total desc`,
  ),

  md(`## 4. Sharing data between languages

\`share(name, value)\` and \`get(name)\` work in every language. In TypeScript they're \`async\`, so use \`await\`. Tables arrive as arrays of plain objects, typed however you like. Shared values are listed at the bottom of the window (⇄).`),
  code(
    "typescript",
    `type RegionTotal = { region: string; total: number };

const byRegion = await get<RegionTotal[]>("by_region");
const best = byRegion.reduce((a, b) => (b.total > a.total ? b : a));
console.log(\`Best region: \${best.region} (\${best.total})\`);

// Send something back: arrays of objects travel as tables
const targets = byRegion.map((r) => ({ region: r.region, target: Math.round(r.total * 1.1) }));
await share("targets", targets);`,
  ),
  code(
    "python",
    `targets = get("targets")   # comes back as a pandas DataFrame
targets.merge(get("by_region"), on="region")`,
  ),

  md(`## 5. Saving tables (Delta Lake)

\`persist=True\` saves a table as a **versioned Delta table** in \`.data/welcome/\` next to the notebook. It survives restarts, and every save is a new version you can go back to.`),
  code(
    "python",
    `share("monthly", sales.groupby("month", as_index=False)["amount"].sum(), persist=True)

sales.loc[len(sales)] = ["west", "mar", 75]           # new data arrives…
share("monthly", sales.groupby("month", as_index=False)["amount"].sum(), persist=True)

history("monthly")`,
  ),
  code(
    "sql",
    `-- latest version vs. the first one
select 'latest' as version, count(*) as months from monthly
union all
select 'v0', count(*) from delta_at('monthly', 0)`,
  ),

  md(`## 6. Asking the tutor well

- Prompt cells see **everything above them**. Ask about "cell 10" and the tutor knows what you mean.
- 🤔 **Ask about this error** appears on failed cells and TypeScript type errors.
- 🙈 hides a cell from the tutor; 📌 always sends it in full.
- The quiet \`cache 59:59\` at the bottom right is the prompt cache. Questions within the hour reuse the context cheaply, and ↻ keeps it warm.
- The ring next to the countdown shows how full the tutor's context is (as % of your token budget); older cells get summarised when it fills up.
- **Settings** (⚙ in the web app, \`polyglotTutor.*\` in VS Code): tell the tutor about yourself (learner profile), show its reasoning, and tune how much context it gets.

Try it: run the prompt below, then make your own cells. Delete this tour whenever you like; \`examples/welcome.ipynb\` in the project has a fresh copy.`),
  ask("In cell 11, why do I need `await` before get(), and what does the <RegionTotal[]> part do?"),
];

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../examples/welcome.ipynb");
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(toIpynb({ name: "welcome.ipynb", cells }), null, 1) + "\n");
console.log(`wrote ${cells.length} cells to ${out}`);
