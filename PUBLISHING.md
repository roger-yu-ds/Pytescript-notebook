# Publishing the VS Code extension

The extension is published as **`roger-yu-ds.polyglot-tutor`** to the VS Code
Marketplace and to Open VSX (for Cursor, Windsurf, VSCodium and other VS Code
forks). Everything is automated except creating the two accounts and tokens.

## One-time setup

### VS Code Marketplace

1. Sign in at <https://marketplace.visualstudio.com/manage> with a Microsoft
   account and create a publisher with ID **`roger-yu-ds`** (it must match
   `publisher` in `packages/extension/package.json`).
2. Create a Personal Access Token at <https://dev.azure.com> → User settings →
   Personal access tokens → New token: Organization **All accessible
   organizations**, Scopes → **Marketplace: Manage**.
3. Add it to the GitHub repo as the secret **`VSCE_PAT`**
   (Settings → Secrets and variables → Actions), or run
   `gh secret set VSCE_PAT`.

### Open VSX

1. Sign in at <https://open-vsx.org> with GitHub, link an Eclipse account and
   sign the Publisher Agreement (Profile page).
2. Create an access token (Settings → Access Tokens).
3. Create the namespace once: `npx ovsx create-namespace roger-yu-ds -p <token>`.
4. Add the token to the GitHub repo as the secret **`OVSX_PAT`**.

## Releasing

1. Bump `version` in `packages/extension/package.json` and add a section to
   `packages/extension/CHANGELOG.md`.
2. Commit, then tag and push:

   ```bash
   git tag v0.1.0 && git push origin v0.1.0
   ```

The **Release** workflow builds the `.vsix`, attaches it to a GitHub release and
publishes it to both registries (each step is skipped if its secret is missing).

## By hand

```bash
npm run package:extension                         # → packages/extension/polyglot-tutor.vsix
npx vsce publish --packagePath packages/extension/polyglot-tutor.vsix -p <VSCE_PAT>
npx ovsx publish packages/extension/polyglot-tutor.vsix -p <OVSX_PAT>
```

Before a release, `npm run test:vsix -w polyglot-tutor` runs the integration
tests against the packaged `.vsix`, i.e. exactly what users will install.
