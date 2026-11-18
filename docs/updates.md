# Application updates

## Scope and behavior

Windows x64 NSIS installs support in-app updates through the public `chukui2005/GitGlass` GitHub Releases feed. Development, other platforms and ZIP builds display an explanation and do not check or launch an installer. A one-time manual installation is required for users on releases that predate the updater.

The toolbar download icon opens Software updates. With automatic updates enabled (the default), the app checks after 10 seconds and every hour, then downloads without opening a dialog. The red dot appears only after the downloaded package is verified and its metadata saved. Manual checking and downloading still work when automatic updates are off. Turning the option off stops scheduled checks; an already running download may finish and stay cached. Normal app exit never installs an update.

Clicking **重启并更新** revalidates the local package, saves the repository location and commit message draft, and starts NSIS. The app quits only after the installer process starts. Installation is silent and restarts GitGlass in the existing installation directory. The next launch restores the repository, message draft and workspace/history view. It does not commit, stash or change the user's working tree as part of updating.

## Main-process boundaries

- `update-service.cjs` owns update state, channel policy, automatic scheduling and explicit installation. Stable builds accept stable versions; Beta builds accept later Beta or stable versions. Equal and lower versions are rejected.
- Electron's single-instance lock keeps a second launch from creating another independent Git workbench during installation. `operation-gate.cjs` counts entire repository IPC requests, including prechecks and refreshes. Update installation requires zero active requests and atomically blocks new ones until exit. A blocked install requires another click after the operation finishes.
- `windows-updater.cjs` wraps the pinned `electron-updater` NSIS implementation. It uses the library for network downloads, its normal cache and publisher verification. Its small cache adapter restores a downloaded installer without requesting network metadata, rechecks SHA-512 and publisher identity before installation, and waits for installer process creation before quitting. It passes the existing installation directory to NSIS. Tests exercise this adapter against the real pinned package; review it when upgrading that dependency.
- `update-store.cjs` atomically persists automatic-update preferences, the cached release metadata and the temporary restart draft in `updates.json` under Electron's local user-data directory. Drafts remain local. A successful renderer restore consumes the restart state. A damaged or obsolete package cannot be offered for installation; download and install failures retain the running app.
- Preload exposes only state, check, download, automatic preference, explicit install and draft restore/acknowledgment methods. The renderer never supplies an executable path, update URL, Git argv or installer command. Requests are restricted to the application's main frame. Release notes render as text.
- The NSIS install macro creates an installation marker after installing. It is absent from the shared unpacked payload and ZIP archive, preventing accidental ZIP-to-installer migration.

Current unsigned Beta packages are protected by the HTTPS release source and SHA-512 integrity checks, not by a separate application signing key. When Windows signing is configured, the library's configured publisher verification also applies to cached/offline installation. Never disable that verification or embed publication credentials in the app.

## Legacy releases and error messages

The original `v0.5.6-beta.1` release predates in-app updating and has no `latest.yml`. The pinned GitHub provider tries to read the manifest before comparing versions, so a reachable old release used to appear as a network failure. For its specific missing-channel-file error, the Windows adapter parses only the version in this repository's official release URL. If that version is equal to or older than the running app, it reports no available update. This fallback never supplies an installer, skips integrity validation, or treats an unavailable network as a successful check. A newer release missing its manifest remains an error and must be completed by the publisher.

Errors distinguish incomplete releases, unavailable release feeds, invalid response formats, certificate failures, timeouts and connectivity failures. Unknown errors use a neutral retry message rather than blaming the network. Error stacks, response bodies and token-bearing URLs are not exposed in the update panel.

## Release artifacts

The tag workflow verifies and uploads the installer, ZIP, installer blockmap, `latest.yml` and `SHA256SUMS.txt` to a draft, and only publishes after all assets are uploaded. Version tags and package versions must match. Checksums derive their filenames from the package version rather than a fixed Beta number. Normal feature PRs do not publish releases.

## Validation

Run:

```powershell
npm test
npm run dist:win
npm audit --omit=dev
```

The automated suite covers channel/version policy, duplicate requests, automatic-update preferences, corrupt caches, offline restoration, Git/update concurrency, restart-draft write failures, installer launch failures, the real dependency's cache API, and the actual React update dialog in an isolated Electron window. That window checks progress, ready status, keyboard containment, restored drafts, failed-install retry and 1024px layout.

Before publishing the first updater release, run a two-version upgrade in an isolated Windows VM using a separate test GitHub repository/build configuration (do not send test versions to the production feed):

1. Install the older updater-enabled NSIS build into a custom directory. Record the current version and prepare an uncommitted working tree and commit-message draft.
2. Publish the higher test version with all matching update artifacts. Confirm background download produces no pop-up, then shows the ready dot.
3. Start a long Git operation; installation must be refused without cancelling the Git operation. After completion, installation must still require a fresh click.
4. Exit normally without clicking install; the app must not update. Disconnect the network, reopen, and confirm the cached update remains installable.
5. Corrupt the cached installer or simulate a draft-save/installer-launch failure; the app must remain running and offer recovery.
6. Click restart/update. Confirm the new version starts from the same installation directory, the repository and draft return, and the uncommitted working tree and staged changes are unchanged.
7. Launch the ZIP build; confirm it explains that in-app installation is unsupported and never launches NSIS.

Real installer replacement and restart across two published versions require the VM acceptance above. Unit/UI tests alone do not establish that result. ZIP in-place replacement is a separate second phase.
