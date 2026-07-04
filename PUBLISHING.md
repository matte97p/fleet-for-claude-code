# Publishing Fleet for Claude Code

Current status: **published** on the VS Code Marketplace as `matte97p.claude-fleet`
for `darwin-arm64`, `linux-x64`, `linux-arm64`, `win32-x64`.
Listing: <https://marketplace.visualstudio.com/items?itemName=matte97p.claude-fleet>

## How releases work

`.github/workflows/release.yml` builds a **per-platform** vsix (each OS runner bundles the
Agent SDK's own-platform `claude` binary) and publishes it via `.github/scripts/publish.sh`,
which pushes to the **VS Code Marketplace** and — if `OVSX_PAT` is set — to **Open VSX**.
The publish step is **idempotent**: a target/version that already exists is treated as
success, so re-running a release never fails on duplicates.

To cut a release:

```bash
# bump "version" in package.json, then:
npm install --package-lock-only    # keep package-lock version in sync (npm ci needs it)
git commit -am "Release vX.Y.Z" && git push
git tag vX.Y.Z && git push origin vX.Y.Z
```

The tag push runs the 4-target matrix (arm64 mac, x64 linux, arm64 linux, x64 win).

## Secrets (repo → Settings ▸ Secrets and variables ▸ Actions)

- **`VSCE_PAT`** (required) — Azure DevOps PAT with **Marketplace: Manage**.
  Create at <https://dev.azure.com/<org>/_usersSettings/tokens> (Organization = *All accessible
  organizations*, Scopes → *Custom defined* → *Marketplace* → *Manage*). Note: creating the
  Azure DevOps org now requires linking a (free) Azure subscription.
- **`OVSX_PAT`** (optional) — enables the Open VSX mirror (see below).

## Open VSX (Cursor / VSCodium / Windsurf)

Open VSX is a separate registry with its own account — **no Azure needed**.

1. Sign in at <https://open-vsx.org> with **GitHub**.
2. Go to your **Settings ▸ Access Tokens** → generate a token.
3. Sign the Eclipse **Publisher Agreement** (Settings page prompts you) — one-time.
4. Create the namespace once (locally, with the token):
   ```bash
   npx ovsx create-namespace matte97p -p <ovsx-token>
   ```
5. Add the token as repo secret **`OVSX_PAT`**. From then on every release also lands on
   Open VSX automatically.

## Intel Mac (darwin-x64) — on demand

`darwin-x64` is **not** in the automatic matrix: GitHub's `macos-13` Intel runners are
scarce/deprecated and reliably stall, which would hang the whole release. To publish it:

- Repo → **Actions ▸ Release ▸ Run workflow** → check **`intel_mac`** → Run.
- If the `macos-13` job sits queued for long, just cancel it — the rest of the release
  is unaffected. (Apple Silicon Macs are covered by `darwin-arm64`.)

## Manual one-platform publish (quick test)

From an Apple Silicon Mac (publishes only `darwin-arm64`):
```bash
npx @vscode/vsce login matte97p     # paste the PAT once
npm run build
npx @vscode/vsce publish --target darwin-arm64
```

## Notes / gotchas

- **Size**: the vsix is ~68 MB (bundled Agent SDK binary). Under the Marketplace limit.
- **`npm ci`** in CI fails if `package-lock.json` is out of sync — always run
  `npm install --package-lock-only` after editing `package.json`.
- **CI** (`.github/workflows/ci.yml`) runs typecheck + tests + build on every PR/push.
- **Trademark/policy**: third-party "Claude" extension — the README carries the
  "not affiliated with Anthropic" disclaimer; keep it.
