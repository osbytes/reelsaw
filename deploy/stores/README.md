# App-store listings

Manifests that list Reelsaw in the places self-hosters and agents go looking, kept here so they
are reviewed with the code they describe and do not drift from `deploy/docker-compose.yml` and
`.env.example`. Each store has its own submission path; the file in this folder is the source,
the store's copy is a mirror.

| Store | File | How it reaches the store |
| --- | --- | --- |
| Unraid Community Applications | `unraid/reelsaw.xml` | Submit the raw URL of this file once at https://ca.unraid.net (moderated); CA re-reads the URL afterwards, so edits here go live on their own |
| Docker MCP Catalog | `docker-mcp-catalog/server.yaml` | Copy into `servers/reelsaw/` in a PR to https://github.com/docker/mcp-registry (`task create` there regenerates it from the image; Docker's CI runs the image and lists tools) |

Not here yet, and why:

- **Umbrel App Store**: a package is a `umbrel-app.yml` plus a compose file with Umbrel's
  `app_proxy`, pinned image digests, a Postgres sidecar under `${APP_DATA_DIR}/data`, a
  dependency on the `ollama` app and per-install secrets from `derive_entropy`. It is a PR to
  https://github.com/getumbrel/umbrel-apps and must be tested on umbrelOS; their `AGENTS.md`
  and `.agents/skills/umbrel-package-app` describe the contract. Worth doing after the first
  Unraid feedback.
- **Runtipi, CasaOS, Coolify**: compose-based like Umbrel, each with its own manifest. Same
  shape of work, smaller audiences.
- **awesome-selfhosted**: requires the first release to be four months old; resubmit on or
  after 2027-02-18.

## Keeping them true

- A new required environment variable, a port change or a new volume goes into every file in
  this folder in the same change as `deploy/docker-compose.yml`.
- The Unraid template lists only what a first install needs; everything else is an admin
  runtime setting (Settings → System) or documented in `docs/CONFIG.md`.
- The Docker MCP entry describes the `reelsaw mcp` stdio bridge, the same package
  `server.json` publishes to the official MCP registry. Change both when the bridge's
  environment changes.
