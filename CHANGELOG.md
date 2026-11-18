# Changelog

## [0.6.3](https://github.com/chukui2005/GitGlass/compare/v0.6.2...v0.6.3) (2026-11-18)

### Features

* refresh automatically when the repository or the window changes ([e590b5b](https://github.com/chukui2005/GitGlass/commit/e590b5b8d9596c5f6b4eb4b1f7311838e1142cf5))
* auto-dismiss transient notices after six seconds ([836df74](https://github.com/chukui2005/GitGlass/commit/836df7468ea4856c622bbef9d35340000f940ca9))
* add a recent repositories switcher ([78eaabb](https://github.com/chukui2005/GitGlass/commit/78eaabbe106a78483c1f287fe8a70a120a3c0f72))

### Bug Fixes

* keep a single changelog title on Windows ([96097e9](https://github.com/chukui2005/GitGlass/commit/96097e943125600fda733d3c0076d9f5bf4d48cc))
* keep the title bar on one line when window controls take space ([3903b8d](https://github.com/chukui2005/GitGlass/commit/3903b8dd6d3379a4795c2192885bfdc91d2ee419))
* let head and refs changes through the renderer quiet window ([19fb0c0](https://github.com/chukui2005/GitGlass/commit/19fb0c0246ff690d92b957daa4d4aa07d79fb1ff))
* make the remote entry point say it only opens a plan ([b8db667](https://github.com/chukui2005/GitGlass/commit/b8db667df5206d6a7c4e0f0f7253db58cfd02485))

### Refactors

* give small text and toolbar buttons a clear hierarchy ([e847e4a](https://github.com/chukui2005/GitGlass/commit/e847e4a6bee6cc30f085cfdd21a907e345655743))

## [0.6.2](https://github.com/chukui2005/GitGlass/compare/v0.6.1-beta.1...v0.6.2) (2026-11-18)

### Features

* remember recent repositories and explain in-progress git operations ([5919340](https://github.com/chukui2005/GitGlass/commit/5919340c44ee6d4c414b1da3bc259805b1021d91))

### Bug Fixes

* support releasing through a pull request on a protected main ([9c2d09b](https://github.com/chukui2005/GitGlass/commit/9c2d09bb082d2d40654f9d8a445fe4fdc04402dd))
* anchor the changelog to the previous tag even when it is a prerelease ([94808f0](https://github.com/chukui2005/GitGlass/commit/94808f05a3b8a408456ef12cf773f9b90797a901))
* give the workspace notice its own grid row ([e165d98](https://github.com/chukui2005/GitGlass/commit/e165d98632354d192679aecc98c818469ae5b415))
* show workspace notices under the title bar instead of inside the ledger ([b9e3995](https://github.com/chukui2005/GitGlass/commit/b9e3995d50048536341297a7c59ebb05320b41c1))
* tell the user when a working-tree diff was truncated ([b852aec](https://github.com/chukui2005/GitGlass/commit/b852aecdc42efd7d83741608075f3a805026a2c7))
* bound command runtime and keep credentials out of the ledger ([8d7f20e](https://github.com/chukui2005/GitGlass/commit/8d7f20e7a6aae6a4814e0045197cb35c1d803a6d))

### Performance

* stop the redaction patterns from backtracking on long output ([3e9123f](https://github.com/chukui2005/GitGlass/commit/3e9123f6859e4b3491ac5fbae445a5d9eb4e6105))

## [0.6.1-beta.1](https://github.com/chukui2005/GitGlass/compare/v0.6.0-beta.1...v0.6.1-beta.1) (2026-11-17)


### Bug Fixes

* restore release please tag creation ([03036c2](https://github.com/chukui2005/GitGlass/commit/03036c2a77c2ee37f51402d630b3cac8c1618eaa))
* restore Release Please tag creation ([e9d71af](https://github.com/chukui2005/GitGlass/commit/e9d71afbf922022f28c64c34129a1219f722c91d))
* verify Windows packaging before release ([1aa496a](https://github.com/chukui2005/GitGlass/commit/1aa496a84c2b1af9489f6ca7ef8a752a4c073b19))
* verify Windows packaging before release ([ef365b8](https://github.com/chukui2005/GitGlass/commit/ef365b85a4ec3205e0617fa0b90b5548260dd591))

## [0.6.0-beta.1](https://github.com/chukui2005/GitGlass/compare/v0.5.6-beta.1...v0.6.0-beta.1) (2026-11-17)


### Features

* add in-app updates for Windows NSIS installs ([1405c38](https://github.com/chukui2005/GitGlass/commit/1405c385ccf8daee53aa1afd67749f3a9fc08a55))
* add in-app updates for Windows NSIS installs ([5758907](https://github.com/chukui2005/GitGlass/commit/575890778741863c5da50e021605835117f1f06b))
* improve Chinese diff review with line coordinates ([9459e1d](https://github.com/chukui2005/GitGlass/commit/9459e1dca22d224fc016fd625062c981f4538cc4))


### Bug Fixes

* derive release artifact names from the package version ([2f63c9a](https://github.com/chukui2005/GitGlass/commit/2f63c9a8314e512baffb3e4841dfd22720a9a0f9))
* make workspace panels resizable ([a169741](https://github.com/chukui2005/GitGlass/commit/a169741ad75a98bb7370f5637e1fa35daaa2c26c))
