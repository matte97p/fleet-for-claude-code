# Publishing Claude Fleet to the VS Code Marketplace

Everything code-side is ready. The steps below need **your** Marketplace account and
a Personal Access Token — they can't be automated for you.

## 0. One-time: create a publisher

1. Sign in at <https://marketplace.visualstudio.com/manage> with a Microsoft account.
2. Create a **publisher** (pick an id, e.g. `matteo-perino`). Note the id.
3. Set it in `package.json` → `"publisher": "<your-id>"`.
   Also update `repository`, `bugs`, `homepage` URLs to your real GitHub repo.
   (The extension no longer hardcodes the publisher anywhere, so changing it is safe.)

## 1. One-time: get a Personal Access Token (PAT)

1. Go to <https://dev.azure.com> → your org → **User settings ▸ Personal access tokens**.
2. **New Token** → Organization: *All accessible organizations* → Scopes: **Custom defined**
   → **Marketplace: Manage** (check it). Create and copy the token.

## 2. Publish

The tricky part is the bundled `claude` binary: it is **per-platform**. Don't publish a
single vsix from your Mac — Windows/Linux users would get a broken build. Two options:

### Option A — automated, all platforms (recommended)

A GitHub Actions release workflow (`.github/workflows/release.yml`) builds and publishes a
vsix **per platform** (mac arm64/x64, linux x64/arm64, win x64) from the matching OS runner.

1. Push this repo to GitHub.
2. Repo → **Settings ▸ Secrets and variables ▸ Actions** → add secret `VSCE_PAT` = your token.
3. Tag a release and push it:
   ```bash
   git tag v0.0.7 && git push origin v0.0.7
   ```
4. The workflow publishes all platform targets. Done.

### Option B — manual, one platform (quick test)

From this Mac (publishes only the darwin-arm64 target — fine for a personal/first test):
```bash
cd lab/fleetview
npx @vscode/vsce login <your-publisher-id>   # paste the PAT once
npm run build
npx @vscode/vsce publish --target darwin-arm64
```

## Notes / gotchas

- **Size**: the vsix is ~68 MB (the bundled Agent SDK binary). Under the Marketplace
  limit, but large. To slim it, stop bundling the binary and require a logged-in `claude`
  on the user's machine (bigger change — not done here).
- **`private: true` was removed** from package.json (vsce refuses to publish otherwise).
- **CI** (`.github/workflows/ci.yml`) runs typecheck + tests + build on every PR/push.
- **Trademark/policy**: it's a third-party "Claude" extension. Review Marketplace naming
  guidelines before a public listing to avoid takedown.
- **Open VSX**: to also list on Cursor/VSCodium's registry, publish to <https://open-vsx.org>
  with `npx ovsx publish --pat <ovsx-token>` (separate account/token).
