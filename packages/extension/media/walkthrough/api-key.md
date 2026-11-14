## Your Anthropic API key

Polyglot Tutor answers prompt cells with Claude, using **your own** API key from [console.anthropic.com](https://console.anthropic.com/). The key is stored in VS Code's secret storage (your OS keychain), never in settings or notebooks.

Already have `ANTHROPIC_API_KEY` in your environment or a workspace `.env`? That works too.

**What's sent:** when you run a prompt cell, the cells above it (code, outputs, errors, earlier answers, recent charts) go to Anthropic's API. Mark a cell with 🙈 (**Hide Cell from Tutor**) to keep it out. Nothing else is sent, and the extension has no telemetry.
