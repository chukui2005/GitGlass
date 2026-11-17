# Releasing GitGlass

GitGlass uses a reviewed, two-stage release process. Maintainers do not manually create a GitHub Release or upload build files.

## End-to-end flow

1. Contributors open normal PRs against `main` and use Conventional Commits (`feat:`, `fix:`, and so on). The `GitGlass CI / Quality (test and build)` check runs `npm ci`, `npm test`, and `npm run build`.
2. After the PR is approved and merged, Release Please parses the Conventional Commits and creates or updates a separate release PR. It maintains the version, `package-lock.json`, and `CHANGELOG.md`; do not edit those release-managed files in normal PRs.
3. A maintainer reviews the release PR. Merging it is the explicit confirmation to release. A normal feature PR never publishes a release by itself.
4. Release Please creates the corresponding `v<version>` tag and a draft prerelease. The tag starts `Publish Release` on a Windows runner.
5. The publishing workflow runs `npm ci` and `npm run dist:win`, verifies the expected files, updates that draft with the build assets, then publishes the complete release. Tags containing a prerelease suffix are marked as GitHub prereleases.

The published assets are:

- `GitGlass-Setup-<version>-x64.exe`
- `GitGlass-<version>-win-x64.zip`
- `GitGlass-Setup-<version>-x64.exe.blockmap`
- `latest.yml`
- `SHA256SUMS.txt`

The package command retains `--publish never`; electron-builder never uploads artifacts directly.

`latest.yml` and the EXE must come from the same build. The Windows NSIS updater reads the manifest and checks SHA-512 before offering installation. Keep the blockmap with the release so differential downloads work; the updater can fall back to a full download. GitHub provider prereleases use the GitHub release flag; `latest.yml` is intentionally also included in Beta releases (the provider supports this fallback). Do not change the installed application ID, owner/repository or artifact naming without planning compatibility for existing clients.

The first version with an updater must be installed manually once. Previous builds have no update code. Windows ZIP builds remain manual downloads; only NSIS installs receive the `resources/gitglass-installed` marker required to enable in-app updates. See [in-app updates and acceptance](UPDATES.md).

## One-time administrator checklist

Complete the repository settings in [CI/CD setup](CI_CD.md) before relying on this flow. In particular:

- Protect `main`, require `GitGlass CI / Quality (test and build)`, at least one maintainer approval, and PR-only merges.
- Enable GitHub native Auto-merge. Authors or maintainers decide whether to enable it for each PR.
- Add a repository Actions secret named `RELEASE_PLEASE_TOKEN`. Use a fine-grained personal access token that can create release PRs and push tags: repository **Contents: read/write** and **Pull requests: read/write**. This non-default token is required because events created with the built-in `GITHUB_TOKEN` do not start the tag-triggered publishing workflow. Do not paste a GitHub App installation token here: it expires after one hour. A GitHub App requires a separate workflow step that mints a fresh token for each run.
- Keep Actions workflow permissions limited. The publishing workflow is read-only by default: its Windows build job has read-only access, and only the final job that creates the GitHub Release gets `contents: write`.

## Local Windows package check

Before changing packaging-related code, validate locally:

```powershell
npm ci
npm run dist:win
```

This creates the same ignored `release/` files listed above but does not tag, publish, or upload anything. Do not commit `dist/`, `release/`, or `node_modules/`.

## Optional code signing

Unsigned Windows builds remain supported. Code signing is an optional future enhancement, not a requirement for CI success. When a certificate is available, store it only as GitHub Actions secrets such as `CSC_LINK` and `CSC_KEY_PASSWORD`, and update the publishing workflow to pass them to electron-builder. Never commit certificates, private keys, real certificate paths, or their passwords.

## Troubleshooting

- **A normal PR did not publish:** expected. Check whether Release Please created or updated a release PR after merge.
- **No release PR appears:** confirm the merge used a Conventional Commit and that `RELEASE_PLEASE_TOKEN` exists with the permissions above. Inspect the `Release Please` workflow run.
- **The release PR cannot merge:** resolve the same approval and `GitGlass CI / Quality (test and build)` requirements as any other PR.
- **Tag exists but no GitHub Release:** inspect `Publish Release`; ensure the tag begins with `v` and exactly matches the version in `package.json`.
- **The publishing job cannot find an asset:** reproduce with `npm ci` and `npm run dist:win`, then check that electron-builder still emits the EXE and ZIP and that the checksum script writes `SHA256SUMS.txt`.
- **Release creation is forbidden:** verify the job-level `contents: write` permission and the repository Actions policy. Do not broaden permissions for the PR CI workflow.
