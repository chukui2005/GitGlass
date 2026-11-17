# Releasing GitGlass

GitGlass ships from `main` with a manual, two-command release. A human chooses the version number; the tag is what publishes.

## End-to-end flow

1. Contributors open normal PRs against `main` and use Conventional Commits (`feat:`, `fix:`, …). The read-only `GitGlass CI / Quality (test and build)` check runs `npm ci`, `npm test`, `npm run build`, `npm run dist:win` and `npm run verify:release`.
2. Merge the PRs you want in the release. Nothing publishes automatically — merging a normal PR never creates a tag.
3. On a clean `main`, run the release helper:

   ```powershell
   npm run release -- 0.6.2          # 稳定版
   npm run release -- 0.6.2 --beta   # Beta：tag 变成 v0.6.2-beta.20261118.1
   npm run release -- 0.6.2 --dry-run
   ```

   The script refuses to run unless you are on `main` with a clean worktree, the new version is higher than `package.json`, and the tag does not exist yet. It then writes `package.json`, `package-lock.json` and the `CHANGELOG.md` section, commits `chore(release): <version>`, and creates the annotated tag.
4. Push the commit and the tag:

   ```powershell
   git push origin main --follow-tags
   ```

   The locally pushed tag starts `Publish Release`. This is the one reason the flow does not need a personal access token: a tag pushed by a real user triggers workflows, while a tag created by the built-in `GITHUB_TOKEN` does not.
5. `Publish Release` runs `npm ci`, `npm run dist:win` and `npm run verify:release` on a Windows runner. Verification checks all five non-empty assets, the tag/package version, EXE/ZIP SHA-256, and the installer's version, size and SHA-512 in `latest.yml`. It uploads them to a draft release and only then publishes it. Tags containing a prerelease suffix are published as GitHub prereleases.

The published assets are:

- `GitGlass-Setup-<version>-x64.exe`
- `GitGlass-<version>-win-x64.zip`
- `GitGlass-Setup-<version>-x64.exe.blockmap`
- `latest.yml`
- `SHA256SUMS.txt`

The package command retains `--publish never`; electron-builder never uploads artifacts directly.

`latest.yml` and the EXE must come from the same build. The Windows NSIS updater reads the manifest and checks SHA-512 before offering installation. Keep the blockmap with the release so differential downloads work; the updater can fall back to a full download. GitHub provider prereleases use the GitHub release flag; `latest.yml` is intentionally also included in Beta releases (the provider supports this fallback). Do not change the installed application ID, owner/repository or artifact naming without planning compatibility for existing clients.

The first version with an updater must be installed manually once. Previous builds have no update code. Windows ZIP builds remain manual downloads; only NSIS installs receive the `resources/gitglass-installed` marker required to enable in-app updates. See [in-app updates and acceptance](updates.md).

## Version policy

The version lives in exactly one place: `package.json` (the script keeps `package-lock.json` in sync). GitGlass stays in `0.x` and uses the patch position as the iteration number, so ordinary releases are `0.6.2`, `0.6.3`, … `0.6.10`. There is no automatic bumping and no bot deciding the number.

Rules:

1. `0.x` is the long-lived series. `0.6 → 0.7` is reserved for a breaking change; `1.0.0` is a deliberate decision made by editing the version yourself.
2. A release contains whatever has landed on `main` since the previous tag. Ship one feature or ten; the version moves one step either way.
3. Never edit `package.json`, `package-lock.json` or `CHANGELOG.md` by hand in a feature PR; the release helper owns them.
4. Tags are immutable. If a tag build fails, fix the cause through a normal PR and cut the next version — do not delete and reuse a tag that already produced artifacts. A tag with no release (for example after a failed first build) can be deleted while no assets exist.
5. Beta builds are ordinary prereleases: tag `v<version>-beta.<YYYYMMDD>.<n>`. `publish-release.yml` marks any tag containing `-` as a prerelease, and stable builds ignore that channel.

## One-time administrator checklist

Complete the repository settings in [CI/CD setup](ci-cd.md) before relying on this flow. In particular:

- Protect `main`, require `GitGlass CI / Quality (test and build)`, and PR-only merges.
- Enable GitHub native Auto-merge if you want it per PR.
- No release token is required. The tag is pushed from a developer machine, so `Publish Release` is triggered by a normal push event.
- Keep Actions workflow permissions limited. The publishing workflow is read-only by default: its Windows build job has read-only access, and only the final job that creates the GitHub Release gets `contents: write`.

## Local Windows package check

Before changing packaging-related code, validate locally:

```powershell
npm ci
npm run dist:win
npm run verify:release
```

This creates the same ignored `release/` files listed above but does not tag, publish, or upload anything. Do not commit `dist/`, `release/`, or `node_modules/`.

Electron downloads its runtime lazily. `pretest` and `prepack:win` run `npm run prepare:electron` (`install-electron`) before tests or packaging, because electron-builder uses the pinned runtime in `node_modules/electron/dist`, which `npm ci` alone does not populate.

## Optional code signing

Unsigned Windows builds remain supported. Code signing is an optional future enhancement, not a requirement for CI success. When a certificate is available, store it only as GitHub Actions secrets such as `CSC_LINK` and `CSC_KEY_PASSWORD`, and update the publishing workflow to pass them to electron-builder. Never commit certificates, private keys, real certificate paths, or their passwords.

## Troubleshooting

- **A normal PR did not publish:** expected. Publishing only happens when a `v*` tag is pushed.
- **`npm run release` refuses to run:** it requires clean `main`; commit or stash your work, switch to `main`, pull, then retry. It also refuses versions at or below the current `package.json` version.
- **Tag exists but no GitHub Release:** inspect the `Publish Release` run for that tag. The workflow refuses to continue when the tag and `package.json` version differ.
- **A tag's build failed:** inspect the failed step. Tags are immutable — fix through a PR and release the next version. Re-running an old tag rebuilds the old source.
- **Release creation is forbidden:** verify the job-level `contents: write` permission and the repository Actions policy. Do not broaden permissions for the PR CI workflow.
- **electron.exe is missing:** check the `prepare:electron` / `prepack:win` logs. Run `npm run prepare:electron` before packaging; do not assume `npm ci` downloaded it.
- **The publishing job cannot find an asset:** reproduce with `npm ci` and `npm run dist:win`, then check that electron-builder emits the EXE, ZIP, blockmap and `latest.yml`, and that the checksum script writes `SHA256SUMS.txt`.
- **Release notes look wrong:** the `CHANGELOG.md` section is generated from Conventional Commit subjects since the previous stable tag; write the section by hand before committing if you want different wording.
