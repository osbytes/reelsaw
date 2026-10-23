# Security policy

Reelsaw is self-hosted software that takes uploads and links from its users, runs media tools on
them and talks to model providers with keys the admin entered. Bugs in those paths matter to every
instance, so please report them privately first.

## Reporting a vulnerability

Use GitHub's private reporting: **Security → Report a vulnerability** on
[github.com/osbytes/reelsaw](https://github.com/osbytes/reelsaw/security/advisories/new). It opens a
private advisory only the maintainers can read. Do not open a public issue or discussion for
anything that could be a vulnerability.

What helps: the version (`reelsaw version`, or Settings → System), how the instance is deployed
(Compose install, GPU profile, behind which proxy), steps to reproduce, and what an attacker gains.
A proof of concept against your own instance is welcome. Please do not test against instances you
do not run.

You will get an acknowledgement within 7 days and a fix or a plan within 30. Fixes ship as a
patch release with a changelog entry; the advisory is published once a release carries the fix.
Credit goes to the reporter unless they ask otherwise.

## Scope

In scope, with examples of what we consider serious:

- Authentication and authorization: session or API-key bypass, one user reaching another user's
  projects, clips, library items or settings, non-admins reaching admin tools (web, tRPC, MCP, CLI).
- The MCP server (`/api/mcp`, `reelsaw mcp`) and OAuth issuer.
- Source handling: SSRF through link sources beyond what `ALLOW_PRIVATE_SOURCE_URLS` permits,
  path traversal in uploads, transcript imports or issue-report zips, command injection into
  ffmpeg or yt-dlp.
- Secrets at rest: provider keys the admin entered, API keys, session material.
- The published Docker image and the installer scripts (`deploy/`).

Out of scope: denial of service from large media on an instance without the documented limits
(`MAX_UPLOAD_MB`, `MAX_SOURCE_FILE_MB`, quotas), findings that need a compromised admin account or
host, vulnerabilities in model providers or in Ollama itself, and reports from automated scanners
without a reproduction.

## Supported versions

Reelsaw is pre-1.0. Fixes land on `main` and ship in the next release; only the
[latest release](https://github.com/osbytes/reelsaw/releases/latest) is supported. Instances
should follow the update check (Settings → System) or watch releases.

## Hardening an instance

- Set `SIGNUP_MODE=closed` or `approval` after creating the first account.
- Keep `BETTER_AUTH_SECRET` long and private; rotating it invalidates sessions and the provider
  keys stored in Settings.
- Leave `ALLOW_PRIVATE_SOURCE_URLS` off unless the instance must read from a NAS.
- Put the instance behind an HTTPS reverse proxy and keep `TRUST_PROXY` matched to the
  deployment (`false` when the app is exposed directly).

Dependencies are watched by Dependabot and CodeQL on every pull request.
