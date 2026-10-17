# Releasing

Reelsaw is one application shipped as one image, versioned with
[changesets](https://github.com/changesets/changesets). Only `@reelsaw/server` carries the
version (`apps/server/package.json`); web and shared are built into the same image and are not
versioned on their own.

## Every pull request

1. Make the change. Add a test, an eval fixture or a browser check as `docs/PRINCIPLES.md` asks.
2. `pnpm changeset`: pick `@reelsaw/server`, pick the bump, write the note **as a user reads it**
   ("Clips can be re-ordered in the editor", not "refactor clip store"). One changeset per
   user-visible change; a PR can have several. Docs-only or internal PRs: `pnpm changeset --empty`.
3. If the change needs anything from the operator at upgrade time (new required env, a manual
   step, a behaviour that changed), add an `**Upgrade:**` line to the changeset. It ends up in the
   changelog and the GitHub release.
4. CI (`ci.yml`) typechecks, builds both bundles, runs the stack-free tests and refuses a PR
   without a changeset.

## Versions (before 1.0)

- **patch**: fixes, small improvements, dependency updates, anything with no new setting.
- **minor**: new features, new settings, changed defaults, migrations that cannot be rolled back,
  anything a user would call "new".
- **major**: reserved for 1.0. Until then, breaking changes are minor and say so in `**Upgrade:**`.

The database migrates forward at boot (`drizzle/`). A release whose migration cannot be reversed
says so; otherwise downgrading one minor is supported by pinning `REELSAW_IMAGE`.

## Cutting a release

1. Merging to `main` runs `version.yml`, which keeps a **"Release …"** pull request open. It bumps
   the version, writes `apps/server/CHANGELOG.md` from the pending changesets and deletes them.
   Review it like any PR: is the changelog readable, are upgrade notes present.
2. Before merging the release PR, on the release candidate commit:
   `docker build -t reelsaw:rc --target runtime .`, `sh scripts/check-image.sh reelsaw:rc`, boot
   `deploy/` in a scratch directory with only a `.env` pointing at `reelsaw:rc`, open the app.
3. Merge. `version.yml` runs `pnpm release:tag`, which pushes `vX.Y.Z`. `release.yml` builds
   amd64 + arm64, checks the image, publishes `ghcr.io/osbytes/reelsaw:X.Y.Z`, `:X.Y` and
   `:latest`, and attaches `reelsaw-X.Y.Z.zip` to the GitHub release. The release notes are the
   changelog section.
4. Pull the published image on a real install (`docker compose pull && docker compose up -d`) and
   watch the boot log for the migration and the health check.

By hand, without the workflow: `pnpm release:version` on `main`, commit, `pnpm release:tag`.

## Pre-releases

`pnpm changeset pre enter beta` on `main` (or a release branch); every release is then
`X.Y.Z-beta.N` and the image gets the version tag only, never `:latest` (`release.yml` skips
`latest` for tags containing `-`). `pnpm changeset pre exit` before the final release.

## Hotfixes

Branch from the tag (`git switch -c hotfix/1.2.1 v1.2.0`), cherry-pick the fix with its
changeset, `pnpm release:version`, commit, `pnpm release:tag`. Merge the branch back into `main` so the
changelog and version stay ahead.

## Setup (once per repository)

- `secrets.RELEASE_TOKEN`: fine-grained PAT or GitHub App token with `contents: write` and
  `pull-requests: write`. Required: tags pushed with the default `GITHUB_TOKEN` do not trigger
  `release.yml`.
- Settings → Actions → "Allow GitHub Actions to create and approve pull requests".
- Branch protection on `main`: require `ci` to pass; the release PR is merged like any other.

The installers (`deploy/install.sh`, `deploy/install.ps1`) are served from `main` via
raw.githubusercontent.com, so the scripts on `main` must always work against the `:latest` image.
