# GitHub CI/CD administrator setup

Repository files define the workflows, but GitHub branch protection and Auto-merge are repository settings. An administrator must complete the following in the GitHub web UI once.

## Protect `main`

In **Settings → Branches** (or **Settings → Rules → Rulesets**), create a rule for `main` that:

1. Requires a pull request before merging.
2. Requires at least **one approving review** from a maintainer. To make this enforceable, list the maintainers in `CODEOWNERS` and enable **Require review from Code Owners** for the protected paths.
3. Requires the status check **`GitGlass CI / Quality (test and build)`** and requires it to be up to date before merging.
4. Blocks direct pushes to `main`. If the UI offers it, restrict pushes so no ordinary contributor can push directly, and apply the rule to administrators / disallow bypassing.
5. Optionally requires resolved conversations; this is recommended for reviewable changes.

Do not configure a bot account to bypass this rule. The repository workflow files cannot enforce these GitHub settings on their own.

## Enable native Auto-merge

In **Settings → General → Pull Requests**, enable **Allow auto-merge**. Then an author or maintainer can select Auto-merge on an individual PR. GitHub merges it only after the required approval and CI check pass; it does not force a merge or bypass the branch rule.

## Enable Release Please and publishing

In **Settings → Secrets and variables → Actions**, add the repository secret `RELEASE_PLEASE_TOKEN`:

- Create a **fine-grained personal access token**. Do not use a GitHub App installation token directly: it expires after one hour, while this workflow expects a saved repository secret.
- Limit it to this repository with **Contents: read/write** and **Pull requests: read/write** only.
- Do not use a token in source files, workflow logs, command lines, or documentation examples.

The token is necessary so Release Please can create the draft prerelease and its matching `v*` tag after a merged release PR. The tag triggers `Publish Release`, which uploads the Windows assets and publishes that draft. The built-in `GITHUB_TOKEN` intentionally does not trigger follow-on workflows from its own events.

Under **Settings → Actions → General**, allow repository Actions to run and do not grant broad default write permissions. The workflows request their own minimal permissions: CI reads contents, Release Please can write release PRs/tags, the Windows build job reads contents, and only the final GitHub Release job gets `contents: write`.

## Optional Windows signing

No signing secret is required: unsigned EXE/ZIP builds remain valid. When signing is introduced, add only encrypted Actions secrets such as `CSC_LINK` and `CSC_KEY_PASSWORD`; never commit a certificate, private key, password, or real local path. Update the release workflow in the same reviewed PR that enables signing.
