# GitHub CI/CD administrator setup

Repository files define the workflows, but GitHub branch protection and Auto-merge are repository settings. An administrator must complete the following in the GitHub web UI once.

## Protect `main`

In **Settings → Branches** (or **Settings → Rules → Rulesets**), create a rule for `main` that:

1. Requires a pull request before merging.
2. Requires at least **one approving review** from a maintainer. To make this enforceable, list the maintainers in `CODEOWNERS` and enable **Require review from Code Owners** for the protected paths.
3. Requires **`GitGlass CI / Quality (test and build)`**, with the branch up to date before merging. The same check tests the app, builds EXE/ZIP and verifies checksums and updater metadata on every PR; no additional required-check name is needed for packaging.
4. Blocks direct pushes to `main`. If the UI offers it, restrict pushes so no ordinary contributor can push directly, and apply the rule to administrators / disallow bypassing.
5. Optionally requires resolved conversations; this is recommended for reviewable changes.

Consequence to plan for: the manual release step commits `chore(release): <version>`, and this repository keeps `main` PR-only. The release commit therefore travels through a short-lived `chore/release-<version>` pull request (`npm run release -- <version> --no-tag`), and the tag is placed on the merged `main` commit afterwards. See [release steps](releasing.md#end-to-end-flow).

Do not configure a bot account to bypass this rule. The repository workflow files cannot enforce these GitHub settings on their own.

## Enable native Auto-merge

In **Settings → General → Pull Requests**, enable **Allow auto-merge**. Then an author or maintainer can select Auto-merge on an individual PR. GitHub merges it only after the required approval and CI check pass; it does not force a merge or bypass the branch rule.

## Enable publishing

Publishing needs no repository secret. A maintainer runs `npm run release -- <version>` and pushes the tag (`git push origin main --follow-tags`); a tag pushed by a real user starts `Publish Release` like any other push event. This is deliberate: a tag created by the built-in `GITHUB_TOKEN` does not trigger another workflow, which is why bot-driven releases needed a personal token and this flow does not.

Under **Settings → Actions → General**, allow repository Actions to run and do not grant broad default write permissions. The workflows request their own minimal permissions: CI reads contents, the Windows build job reads contents, and only the final GitHub Release job gets `contents: write`.

## Optional Windows signing

No signing secret is required: unsigned EXE/ZIP builds remain valid. When signing is introduced, add only encrypted Actions secrets such as `CSC_LINK` and `CSC_KEY_PASSWORD`; never commit a certificate, private key, password, or real local path. Update the release workflow in the same reviewed PR that enables signing.
