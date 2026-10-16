# Reelsaw

Turns long videos into short vertical clips: finds the moments, cleans up the transcript, frames
speakers and burns in captions. Runs on your machine with Docker.

## Install

Requires Docker with Compose (Docker Desktop on macOS/Windows), 8 GB RAM and ~10 GB disk.

```bash
cp .env.example .env          # set BETTER_AUTH_SECRET, POSTGRES_PASSWORD and an AI provider
docker compose up -d
open http://localhost:3000    # create your account, then set ALLOW_SIGNUP=false
```

### AI providers

- **Hosted:** set `AI_MODEL` / `TRANSCRIPTION_MODEL` and the matching API key in `.env`.
- **Fully local:** install [Ollama](https://ollama.com), `ollama pull qwen2.5:14b`, uncomment the
  "fully local" block in `.env`, and start with `docker compose --profile local-ai up -d`.

The app checks every provider at startup and exits with a message naming what's wrong. See it with
`docker compose logs app`.

## Upgrade

```bash
docker compose pull && docker compose up -d
```

Pin a version with `REELSAW_IMAGE=ghcr.io/osbytes/reelsaw:<version>` in `.env`. Settings shows
the running version.

## Back up

Everything lives in two volumes: `reelsaw_pgdata` (database) and `reelsaw_data` (videos, clips).

```bash
docker compose exec -T db pg_dump -U reelsaw reelsaw > reelsaw.sql
```

## Reporting an issue

Use **Report an issue** in the app (project ⋯ menu, a failed clip, or your account menu). It
saves a zip with the project's data, logs and your description. API keys and passwords are never
included; you can see the contents before saving. Send the zip to the Reelsaw team.

## Troubleshooting

```bash
docker compose logs app                      # boot and job logs
docker compose exec app reelsaw status <id>  # one project's pipeline state (id from the URL)
```
