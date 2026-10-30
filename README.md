# Danny

A personal AI assistant. One chat, one boss. Danny remembers what you tell him, keeps goals and plans, drafts work, and asks for a tap before anything goes out.

This repo has the API (`apps/api`), the app (`apps/web`, a phone and desktop app from one build) and the marketing site (`site`). More on the design in `docs/STACK.md`.

## Run it on a computer

You need `git` and Docker (Docker Desktop on Windows or Mac, with a bash shell: WSL or Git Bash on Windows). Nothing else.

```bash
git clone https://github.com/JuiceTwn/danny.git && cd danny
./setup.sh
docker compose exec api node dist/cli/create-owner.js you@example.com 'a long password' 'Your Name'
```

Open <http://localhost:8787> and sign in. That's it.

- `setup.sh` writes a `.env` with fresh secrets, builds the images (Postgres and the API with the app inside), and runs the database migrations.
- **Back up `DATA_KEYS` in `.env`** somewhere separate. It encrypts everything you write to Danny. Lose it and the stored data cannot be read.
- Without an `ANTHROPIC_API_KEY` Danny runs in demo mode: the app works, but replies are a fixed line. Add your key to `.env`, then `docker compose up -d`.
- Spend caps default to US$2 a day and US$30 a month. Change them in Settings.
- It listens on this computer only. To use it from a phone or a second machine, give it a domain with `./setup.sh app.example.com` (automatic HTTPS), pointed at a server.

### Update

```bash
git pull
docker compose up -d --build
docker compose exec -T api node dist/cli/migrate.js
```

### Without Docker

Node 22 and PostgreSQL 16. See `apps/api/README.md`.

## Develop

```bash
npm ci
bash apps/api/scripts/test-db.sh     # a throwaway Postgres for the tests
npm test -w @danny/api
npm run check -w @danny/web
```

`npm run build:preview -w @danny/web` builds a single-file preview of the app with a simulated backend, for clicking through the screens with no server.
