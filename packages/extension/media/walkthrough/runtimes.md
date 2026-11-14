## Python and Deno

- **Python and SQL cells** run in a Jupyter kernel with pandas, DuckDB and Delta Lake.
- **TypeScript cells** run on Deno.

**Set Up Runtimes** checks what you have and offers to install what's missing into the extension's own folder (it asks before each download, verifies checksums, and doesn't touch your other installations):

| | Downloads |
|---|---|
| Python | uv (if you don't have it), Python 3.13, and Jupyter + pandas + DuckDB + Delta Lake from PyPI (~300 MB) |
| Deno | Deno (~45 MB) from github.com/denoland/deno |

Prefer your own? Set `polyglotTutor.pythonPath` (a Python with `jupyter_server ipykernel pandas duckdb pyarrow deltalake`) and `polyglotTutor.denoPath`.
