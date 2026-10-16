# Working on Reelsaw

Read [docs/PRINCIPLES.md](docs/PRINCIPLES.md) before changing code. It holds the backend
(transactions, locking, versioned jobs, evals) and frontend (tokens, no layout shift, deep links,
responsive) rules that apply to every change.

Layout: `apps/server` (Hono, tRPC, Drizzle, pg-boss workers), `apps/web` (Vite, React, Tailwind,
Radix), `packages/shared` (zod schemas, shared geometry/caption helpers; rebuild with
`pnpm --filter @reelsaw/shared build` after changing it).

Everyday commands:

```bash
pnpm --filter @reelsaw/web build                      # web bundle (served by the app)
(cd apps/server && npx tsc --noEmit -p .)             # typecheck server
(cd apps/web && npx tsc --noEmit -p .)                # typecheck web
docker compose --profile local-ai up -d --build app   # deploy locally (http://localhost:3100)
docker builder prune -f --keep-storage 3GB; docker image prune -f   # keep Docker's disk in check
(cd apps/server && pnpm eval <suite>)                 # evals; --offline for model-free runs
(cd apps/server && npx drizzle-kit generate --name <change>)        # migration from schema.ts
docker compose exec -T app reelsaw <command>          # operator CLI: status, events, flags, …
```

The language model runs in Ollama on the host (`ollama serve`); the app refuses to start without it
by design.
