// Code run silently in each kernel when it starts (and after every restart).
// It defines share()/get() talking to the backend hub, and — in Python — the
// DuckDB connection that SQL cells run on.

const lit = (s: string) => JSON.stringify(s); // safe string literal for Python and TS

export interface PreludeOptions {
  hubUrl: string; // this notebook's namespace on the share/get hub
  token: string; // hub token (sent as x-polyglot-token)
  dataDir: string; // where this notebook's Delta tables live
  cwd: string; // the notebook's folder (relative paths in cells resolve here)
}

export function pythonPrelude({ hubUrl, token, dataDir, cwd }: PreludeOptions): string {
  return `
def __pn_setup():
    import json, os, re, urllib.request, urllib.error, urllib.parse
    import duckdb, pyarrow as pa
    from IPython import get_ipython

    URL, TOKEN, DATA = ${lit(hubUrl)}, ${lit(token)}, ${lit(dataDir)}
    os.chdir(${lit(cwd)})
    ip = get_ipython()

    def _sqlpath(p):  # a path inside a SQL string literal
        return p.replace("\\\\", "/").replace("'", "''")
    con = duckdb.connect()
    con.execute("SET python_scan_all_frames = true")  # SQL can see your DataFrames by name
    seen = {}

    # Delta Lake: delta-rs writes, DuckDB's delta extension reads (incl. time travel).
    try:
        con.execute("INSTALL delta; LOAD delta")
        delta_sql = True
        con.execute(f"CREATE OR REPLACE MACRO delta_at(name, v) AS TABLE SELECT * FROM delta_scan('{_sqlpath(DATA)}/' || name, version => v)")
    except Exception:
        delta_sql = False  # offline first run: fall back to Arrow datasets (no SQL time travel)

    def _req(method, name="", data=None, ctype=None, query=None):
        url = URL + ("/" + urllib.parse.quote(name, safe="") if name else "")
        if query:
            url += "?" + urllib.parse.urlencode(query)
        headers = {"x-polyglot-token": TOKEN}
        if ctype:
            headers["content-type"] = ctype
        r = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(r) as resp:
                return resp.headers.get("content-type", ""), resp.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None, None
            raise RuntimeError(e.read().decode() or str(e)) from None

    def _to_arrow(value):
        if isinstance(value, pa.Table):
            return value
        try:
            import pandas as pd
            if isinstance(value, pd.DataFrame):
                return pa.Table.from_pandas(value, preserve_index=False)
        except ImportError:
            pass
        if hasattr(value, "to_arrow"):  # polars, duckdb relations
            return value.to_arrow()
        if isinstance(value, list) and value and all(isinstance(r, dict) for r in value):
            return pa.Table.from_pylist(value)
        return None

    def _arrow_bytes(table):
        sink = pa.BufferOutputStream()
        with pa.ipc.new_stream(sink, table.schema) as w:
            w.write_table(table)
        return sink.getvalue().to_pybytes()

    def _forget(name):
        for stmt in (f'DROP VIEW IF EXISTS "{name}"',):
            try:
                con.execute(stmt)
            except Exception:
                pass
        try:
            con.unregister(name)
        except Exception:
            pass

    # ---- Delta persistence ----
    def _dpath(name):
        if not re.fullmatch(r"[A-Za-z_][\\w]*", name):
            raise ValueError("persisted names must be identifiers, e.g. sales_2024")
        return os.path.join(DATA, name)

    def _persisted():
        if not os.path.isdir(DATA):
            return []
        return sorted(n for n in os.listdir(DATA) if os.path.isdir(os.path.join(DATA, n, "_delta_log")))

    def _register_delta(name):
        from deltalake import DeltaTable
        _forget(name)
        if delta_sql:
            con.execute(f"CREATE VIEW \\"{name}\\" AS SELECT * FROM delta_scan('{_sqlpath(_dpath(name))}')")
        else:
            con.register(name, DeltaTable(_dpath(name)).to_pyarrow_dataset())

    def _write_delta(name, table):
        from deltalake import write_deltalake, DeltaTable
        os.makedirs(DATA, exist_ok=True)
        write_deltalake(_dpath(name), table, mode="overwrite", schema_mode="overwrite")
        _register_delta(name)
        return DeltaTable(_dpath(name)).version()

    def share(name, value, persist=False):
        """Share a value with the other languages. DataFrames/tables become SQL tables too.
        persist=True also saves a table as a versioned Delta table that survives restarts."""
        __tracebackhide__ = True
        table = _to_arrow(value)
        if table is not None:
            _req("PUT", name, _arrow_bytes(table), "application/vnd.apache.arrow.stream", {"from": "python"})
            if persist:
                v = _write_delta(name, table)
                print(f'⇄ shared "{name}": table {table.num_rows}×{table.num_columns} · saved as Delta v{v}')
            else:
                _forget(name)
                con.register(name, table)
                print(f'⇄ shared "{name}": table {table.num_rows}×{table.num_columns}')
        else:
            if persist:
                raise ValueError("persist=True only works for tables (DataFrames, lists of dicts, Arrow tables)")
            _req("PUT", name, json.dumps(value, default=str).encode(), "application/json", {"from": "python"})
            print(f'⇄ shared "{name}"')

    def get(name, version=None):
        """Get a value shared from any language. Tables come back as pandas DataFrames.
        For persisted (Delta) tables, version=N reads an older version."""
        __tracebackhide__ = True
        if version is not None:
            if name not in _persisted():
                raise KeyError(f'"{name}" is not a persisted table, so it has no versions.')
            from deltalake import DeltaTable
            return DeltaTable(_dpath(name), version=version).to_pandas()
        ctype, body = _req("GET", name, query={"format": "arrow"})
        if body is None:
            if name in _persisted():
                from deltalake import DeltaTable
                return DeltaTable(_dpath(name)).to_pandas()
            raise KeyError(f'Nothing has been shared as "{name}" yet.')
        if "arrow" in ctype:
            return pa.ipc.open_stream(body).read_all().to_pandas()
        return json.loads(body)

    def history(name):
        """Versions of a persisted (Delta) table."""
        import pandas as pd
        from deltalake import DeltaTable
        if name not in _persisted():
            raise KeyError(f'"{name}" is not a persisted table. Use share("{name}", df, persist=True).')
        rows = DeltaTable(_dpath(name)).history()
        return pd.DataFrame([{"version": r.get("version"), "timestamp": pd.to_datetime(r.get("timestamp"), unit="ms"), "operation": r.get("operation")} for r in rows])

    def _persist_from_hub(name):
        # Called by the backend when TypeScript shares with persist: true.
        _, data = _req("GET", name, query={"format": "arrow"})
        return _write_delta(name, pa.ipc.open_stream(data).read_all())

    def _publish(name):
        # Called by the backend when another language asks for a persisted table the hub doesn't hold.
        from deltalake import DeltaTable
        table = DeltaTable(_dpath(name)).to_pyarrow_table()
        _req("PUT", name, _arrow_bytes(table), "application/vnd.apache.arrow.stream", {"from": "python"})

    def _sync():
        # Register tables shared from other languages so SQL can query them by name.
        _, body = _req("GET")
        for item in json.loads(body or b"[]"):
            if item["name"] in _persisted():
                continue  # already a view over the Delta table
            if item["kind"] == "table" and item["from"] != "python" and seen.get(item["name"]) != item["version"]:
                _, data = _req("GET", item["name"], query={"format": "arrow"})
                _forget(item["name"])
                con.register(item["name"], pa.ipc.open_stream(data).read_all())
                seen[item["name"]] = item["version"]

    def sql(query, as_name=None):
        __tracebackhide__ = True
        _sync()
        try:
            rel = con.sql(query)
        except duckdb.Error as e:
            raise RuntimeError(f"SQL error: {e}") from None
        if rel is None:
            return None
        df = rel.df()
        if as_name:
            ip.user_ns[as_name] = df
            share(as_name, df)
        return df

    for name in _persisted():  # tables saved in earlier sessions are queryable right away
        try:
            _register_delta(name)
        except Exception as e:
            print(f"could not load persisted table {name}: {e}")

    ip.user_ns.update(share=share, get=get, history=history, __pn_sql=sql, __pn_duckdb=con,
                      __pn_persist=_persist_from_hub, __pn_publish=_publish)

__pn_setup()
del __pn_setup
`;
}

export function denoPrelude({ hubUrl, token, cwd }: PreludeOptions): string {
  return `
{
  Deno.chdir(${lit(cwd)});
  const URL = ${lit(hubUrl)};
  const headers = { "x-polyglot-token": ${lit(token)} };
  const isRows = (v: unknown) =>
    Array.isArray(v) && v.length > 0 && v.every((r) => r !== null && typeof r === "object" && !Array.isArray(r) && !(r instanceof Date));

  (globalThis as any).share = async (name: string, value: unknown, opts: { persist?: boolean } = {}): Promise<void> => {
    const table = isRows(value);
    if (opts.persist && !table) throw new Error("persist only works for tables (non-empty arrays of objects)");
    const res = await fetch(\`\${URL}/\${encodeURIComponent(name)}?from=typescript\${opts.persist ? "&persist=1" : ""}\`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json", "x-polyglot-kind": table ? "table" : "json" },
      body: JSON.stringify(value),
    });
    if (!res.ok) throw new Error(\`share failed: \${await res.text()}\`);
    const item = await res.json();
    console.log(\`⇄ shared "\${name}": \${item.summary}\`);
  };

  (globalThis as any).get = async (name: string): Promise<any> => {
    const res = await fetch(\`\${URL}/\${encodeURIComponent(name)}?format=json\`, { headers });
    if (res.status === 404) throw new Error(\`Nothing has been shared as "\${name}" yet.\`);
    if (!res.ok) throw new Error(\`get failed: \${await res.text()}\`);
    return await res.json();
  };
}
`;
}

/** Wrap a SQL cell so it runs on DuckDB in the Python kernel. `-- as: name` on the first line saves + shares the result. */
export function sqlToPython(query: string): string {
  const as = /^\s*--\s*as:\s*([A-Za-z_]\w*)/.exec(query)?.[1];
  let bin = "";
  for (const byte of new TextEncoder().encode(query)) bin += String.fromCharCode(byte);
  const b64 = btoa(bin);
  return `__pn_sql(__import__("base64").b64decode("${b64}").decode(), ${as ? lit(as) : "None"})`;
}
