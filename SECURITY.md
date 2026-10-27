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
  deployment (`false` when the app is exposed directly). Set `TRUSTED_PROXY_HOPS` to the number
  of proxies in front of the app (2 for Cloudflare in front of Caddy) so the client address is
  the entry from the right that your proxies wrote, not one the client sent; use
  `TRUSTED_PROXY_HEADER=cf-connecting-ip` only when the origin accepts traffic from Cloudflare alone.
- Create API keys without "Allow instance administration" unless the agent must change
  instance settings. OAuth connectors never get admin tools. Connected apps can be revoked under
  Settings → Account.

### URL sources and your network

Reelsaw checks the address of every link it fetches itself (library imports, subtitle files):
the name is resolved once, refused if it is inside the network, and the connection goes to that
address, so DNS rebinding and redirects to internal hosts are caught. **yt-dlp**, which
downloads the video behind a project's source link, resolves names and follows redirects and
embedded URLs on its own; Reelsaw only checks the first address. A hosted or shared instance,
where people you do not trust can add links, should not rely on that check alone:

- Send yt-dlp's traffic through an egress proxy that refuses private destinations (`YTDLP_PROXY`,
  for example an HTTP proxy or gateway on a separate network), or
- run the app container under a network policy or firewall rule that blocks RFC1918 ranges
  (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local (`169.254.0.0/16`, which includes
  cloud metadata at `169.254.169.254`) and `fc00::/7`, `fe80::/10`, except for the services it needs
  (database, object storage, Ollama).

A single-user instance on a home network that reads from its own NAS has less to defend; that is
what `ALLOW_PRIVATE_SOURCE_URLS=true` is for.

Dependencies are watched by Dependabot and CodeQL on every pull request.
