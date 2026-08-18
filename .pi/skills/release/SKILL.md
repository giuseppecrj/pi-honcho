---
name: release
description: Release Pi Honcho when the user asks to publish, deploy, or create a new version; verify versioning, notes, GitHub release, and npm publication.
---

# Release Pi Honcho

## When to use

Use when the user explicitly asks to release, publish, deploy, or ship a Pi Honcho version.

## Procedure

1. Confirm that the user explicitly authorizes the commit, push, GitHub release, and npm deployment. Inspect `CONTRIBUTING.md`, `package.json`, `.github/workflows/publish.yml`, the current version, tags, release state, and working-tree status.
2. Choose the semantic version from the completed change. Run `npm version <major|minor|patch> --no-git-tag-version` so `package.json` and `package-lock.json` stay aligned.
3. Review the generated `CHANGELOG.md`. The version script generates its entry before the release commit exists, so add concise release notes under the new version header before committing.
4. Run `npm run check`, `npm run verify`, and `./node_modules/.bin/pi -ne -e . --list-models`. Use `-ne` when a globally installed Pi Honcho package would conflict with the checkout; explicit `-e .` still loads the checkout.
5. Inspect the complete staged diff, run `git diff --check`, confirm no credentials or unrelated files are included, then commit the release changes. Fetch before pushing; never force-push unless the user separately approves it.
6. Push the release commit to `main`. Create the matching published GitHub release with non-empty notes. The `publish.yml` release workflow performs the OIDC npm publish; do not run `npm publish` locally.
7. Watch the publish workflow to completion. Verify the exact version with `npm view pi-honcho@<version> version`, inspect the release URL and notes, and confirm the working tree is clean.

## Pitfalls

- Keep the release tag exactly `v` plus the `package.json` version; the publish workflow rejects mismatches.
- Do not treat `npm view pi-honcho version` as proof immediately after release because registry metadata can lag. Query the exact version instead.
- Do not include API keys, OAuth tokens, or private test artifacts in the commit, changelog, or release notes.
- A documentation-only correction after publishing does not republish npm. Push it and update the existing GitHub release notes explicitly.

## Verification

1. The release workflow completes successfully, including its checks and OIDC publish step.
2. `npm view pi-honcho@<version> version` returns the requested version.
3. The GitHub release has the matching tag and non-empty notes.
4. `git status -sb` reports a clean branch aligned with `origin/main`.
