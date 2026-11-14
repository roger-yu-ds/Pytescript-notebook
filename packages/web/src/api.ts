import type { Notebook, Settings } from "@polyglot-tutor/core/browser";

async function json<T>(r: Response): Promise<T> {
  const body = await r.json();
  if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
  return body as T;
}

export const api = {
  list: () => fetch("/api/notebooks").then((r) => json<{ name: string; mtime: number }[]>(r)),
  load: (name: string) => fetch(`/api/notebooks/${encodeURIComponent(name)}`).then((r) => json<Notebook>(r)),
  create: (name: string) =>
    fetch("/api/notebooks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) }).then((r) =>
      json<Notebook>(r),
    ),
  save: (nb: Notebook) =>
    fetch(`/api/notebooks/${encodeURIComponent(nb.name)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(nb),
    }).then((r) => json<{ ok: true }>(r)),
  settings: () => fetch("/api/settings").then((r) => json<Settings>(r)),
  saveSettings: (s: Settings) =>
    fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(s) }).then((r) =>
      json<{ ok: true }>(r),
    ),
  status: () => fetch("/api/status").then((r) => json<{ apiKey: boolean; notebookDir: string }>(r)),
};

export const newId = () => crypto.randomUUID().slice(0, 8);
