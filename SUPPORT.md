# Support

## Where to go

| For | Go to |
| --- | --- |
| A question, or help installing | [GitHub Discussions](https://github.com/osbytes/reelsaw/discussions) |
| A bug | An issue, through the [bug form](https://github.com/osbytes/reelsaw/issues/new/choose). Attach the zip from "Report an issue" (or `reelsaw report <projectId>`) |
| A security problem | Private vulnerability reporting ([SECURITY.md](SECURITY.md)). Never a public issue |
| Your hosted account at app.reelsaw.com | "Report an issue" in the app, or a discussion for anything that is not private |

This is a small project. A first reply usually comes within a few working days, and there is no
private support for self-hosted installs. Operator recipes for the common problems are in
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Supported versions

Reelsaw is pre-1.0: only the [latest release](https://github.com/osbytes/reelsaw/releases/latest)
gets fixes and security fixes. The update check (Settings → System, `reelsaw version`) says when
an instance is behind. A support period per major version will be published here with 1.0.

## Upgrades

- Take a `pg_dump` before every upgrade; migrations do not run backwards
  ([deploy/README.md](deploy/README.md)).
- Upgrading from the previous minor is always supported. Read the release notes for an
  `Upgrade:` line before skipping further.

## What counts as a breaking change

Removing or renaming an API field, a CLI command or flag, an MCP tool or parameter, or an
environment variable, or changing what one means. Before 1.0 these ship in a minor release, are
listed under "Upgrade" in the notes, and a renamed setting keeps its old name working for at
least one release.

Exports and issue-report zips carry a version and stay readable by later releases.

## End of life

If the project or the hosted service ends: at least 90 days' notice, a full export, and the
last image left available.
