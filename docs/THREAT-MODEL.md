# Threat model

Last revised: 2026-11-22. Revise when a surface, a data type or a deployment mode is added.
Reporting and scope: [SECURITY.md](../SECURITY.md). Hardening an instance: the same file.

## What is worth protecting

| Asset | Why it matters | Where it lives |
| --- | --- | --- |
| Source videos, clips, transcripts | A user's own and often unpublished content | Object storage (`STORAGE_DRIVER`), Postgres |
| Accounts and sessions | Reaching another user's projects or the admin tools | Postgres (Better Auth), `BETTER_AUTH_SECRET` |
| API keys and OAuth grants | Each one is a standing login for an agent or integration | Postgres (Better Auth api-key and OAuth plugins) |
| Provider keys entered in Settings | Spend on the admin's model accounts | Postgres, AES-256-GCM under a key derived from `BETTER_AUTH_SECRET` (`apps/server/src/ai/crypto.ts`) |
| Webhook secrets | Forged deliveries to the user's automations | Postgres (`webhooks/`) |
| Public media links | Download without login, by design, until they expire or are revoked | Postgres (`media-links/`) |
| Billing state (hosted) | Quota and plan limits | Postgres (`ee/`), Stripe |
| The host's network | A self-hosted box usually sits next to a NAS, a router and cloud metadata | The app container's network |

## Who would attack, and how capable

| Actor | Wants | Access they start with |
| --- | --- | --- |
| Anonymous internet user | An account, free compute, a way into the host's network | The sign-in and sign-up pages, public media links, `/api/health` |
| Signed-in user | Another account's projects, admin tools, more quota than the plan allows | Their own account, API keys and MCP connections |
| Malicious content (a video's speech, a page behind a link, a subtitle file, an issue-report zip) | To steer the model, the agent driving MCP, or the operator reading a report | Whatever reads it: the pipeline, an agent, `reelsaw import-report` |
| Compromised dependency, image or Action | Code execution, secrets | The process, CI |
| Operator of a shared instance | Users' content | The database and storage (out of scope: they run the box) |

## Entry points and trust boundaries

| Entry point | Authenticated by | Data crossing | Trusted? |
| --- | --- | --- | --- |
| Web UI / tRPC | Session cookie | Every user action | After auth, scoped to the owner |
| MCP endpoint (`/api/mcp`) | API key (Bearer) or OAuth token; admin tools need an admin key with "Allow instance administration", never OAuth | The same actions as the UI | After auth, scoped to the owner |
| CLI (`reelsaw …`) | Shell on the box | Operator commands | Yes (the operator) |
| Uploads and transcript imports | Session or API key | Media, SRT / VTT / text | Never: parsed, size-capped (`MAX_UPLOAD_MB`) |
| Link sources | Session or API key | URLs fetched by Reelsaw and by yt-dlp | Never: `lib/safe-url.ts` refuses private addresses unless `ALLOW_PRIVATE_SOURCE_URLS` |
| Issue-report zips (`import-report`) | Shell on the box | Projects, transcripts, logs from another instance | Never: instruction-like passages are flagged, paths checked |
| Model output | n/a | Moments, titles, corrections | Never: parsed with zod, bounds clamped to the source |
| Stripe webhooks (hosted) | Stripe signature | Billing events | After signature check |
| Outbound webhooks | Standard Webhooks HMAC signature (`webhooks/deliver.ts`) | Project and clip events | n/a (we send) |
| Model providers, Ollama | Provider key | Transcripts and prompts | Responses are untrusted (above) |

## Threats

STRIDE as a prompt: spoofing, tampering, repudiation, information disclosure, denial of service,
elevation of privilege.

| # | Threat | Boundary | Control | Proven by | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | One user reads or changes another's project, clip or library item | tRPC, MCP | Ownership checked in the same transaction as the write ([PRINCIPLES.md](PRINCIPLES.md), "Validate at the edge") | `project-edits`, `projects-bulk`, `soft-delete`, `search` tests | controlled |
| 2 | A non-admin or an OAuth connector reaches admin tools | MCP | Admin tools need an admin API key with instance administration; OAuth never gets them. MCP admin tools call the same admin tRPC procedures | none over MCP | controlled, not tested over MCP (open item) |
| 3 | SSRF through a link source or library import | Link sources | `lib/safe-url.ts`: resolve once, refuse private ranges, connect to that address (rebinding and redirects caught) | `safe-url.test.ts` | controlled for Reelsaw's own fetches |
| 4 | SSRF through yt-dlp following redirects on its own | Link sources | Only the first address is checked; `YTDLP_PROXY` or a network policy for shared instances ([SECURITY.md](../SECURITY.md#url-sources-and-your-network)) | none | accepted for single-user installs; operator control for shared ones |
| 5 | Prompt injection in a transcript or page steers the model | Model input | Model output is data: zod-parsed, clamped, never executed; tools the model can call do not exist in the pipeline | evals (`docs/EVALS.md`) | controlled |
| 6 | Prompt injection in a report or transcript steers an agent or the operator | MCP, `import-report` | `AGENTS.md` and the import flag instruction-like passages; agents told to treat them as data | `import.test.ts` | partly controlled: depends on the agent |
| 7 | Secrets leak into issue reports or logs | Reports, logs | Redaction by name and by shape (`report/redact.ts`, `log.ts`) | `report.test.ts`, `log.test.ts` | controlled |
| 8 | Stored provider keys read from a database dump | Postgres | AES-256-GCM under `BETTER_AUTH_SECRET` | `ai/crypto.ts` | controlled; rotation is all-or-nothing (open item) |
| 9 | Forged or replayed webhook deliveries to a user's endpoint | Outbound webhooks | Standard Webhooks signature with timestamp; secret rotation | `webhooks.test.ts`, `webhooks-delivery.test.ts` | controlled |
| 10 | A public media link outlives its purpose | Media links | Expiry (`ttlDays`), per-link revoke, `clear_media_links` | none found | controlled, not tested (open item) |
| 11 | Sign-up abuse and free-compute farming (hosted) | Sign-up | `SIGNUP_MODE`, sign-up rules, abuse checks, quotas | `abuse`, `signup-rules`, `quota` tests | controlled |
| 12 | Large media exhausts disk or CPU | Uploads, sources | `MAX_UPLOAD_MB`, `MAX_SOURCE_FILE_MB`, quotas, resource leases (disk, cores, memory) | `quota.test.ts` | controlled where the limits are set |
| 13 | Command injection into ffmpeg or yt-dlp | Pipeline | Arguments passed as arrays, never through a shell | none (review) | controlled, not tested |
| 14 | A compromised Action or dependency in CI or the image | Supply chain | Actions pinned by SHA, zizmor, Dependabot, dependency review, Scorecard, SBOM and provenance attestation on release | `security.yml`, `scorecard.yml`, `release.yml` | controlled |
| 15 | The default database password on a Compose-by-hand install | Postgres | The installers generate one (`deploy/install.sh`); the compose file still falls back to `reelsaw` | none | accepted: the install compose file does not publish Postgres outside the Compose network (the development one binds it to `127.0.0.1`), and removing the fallback would break upgrades of installs that relied on it |

## Out of scope, said plainly

The host, its network and firewall, TLS termination, backups and their encryption, and who has
a shell on the box are the self-hoster's to protect. An operator of a shared instance can read
every user's content; Reelsaw does not defend users against their own admin. Model providers
see what is sent to them.

## Open items

- Provider keys are tied to `BETTER_AUTH_SECRET`: rotating it drops every stored key. Move to a
  keyring with key ids so the secret can rotate without losing them.
- No test proves media tools are never invoked through a shell (#13), that MCP refuses admin
  tools to a non-admin key or an OAuth token (#2), or that an expired or revoked media link stops
  serving (#10).
