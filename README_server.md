# HowHotWasIt — local development

A web app that answers "how hot was it?" for any place and date, against ~75
years of ERA5-Land climate history.

> **Architecture in one line:** the frontend (React) reads immutable
> `archive/recent/forecast` `.csv.gz` tier files **directly from R2**, and a thin
> **Cloudflare Worker** tops up the volatile `recent`/`forecast` tiers from
> Open-Meteo on demand. See `ARCHITECTURE.md` for the full design and `DEPLOY.md`
> for shipping.

## Dev = local code, remote data

Local dev runs **all code locally** but reads/writes **all data on the real R2
bucket** — dev and prod use the *same* `worker/src/*` control-plane code and the
*same* R2 bucket, so there's no second implementation to keep in sync:

- **Frontend** — local Vite dev server (hot reload). Reads the tier files
  straight from R2's public URL (`VITE_DATA_BASE`, committed in `frontend/.env`).
- **Control plane** (`/api/ensure-fresh`, `/api/geo`, `/api/health`) — the prod
  Worker run locally via `wrangler dev --remote`, bound to the live R2 bucket
  `weather-baseline`. `ensure-fresh` writes the refreshed tiers back to **R2**,
  exactly as in production.

```
Frontend (local, :5173) ── data (read) ──▶ R2 public URL  ┐ same R2
        └─ /api/* (Vite proxy) ──▶ Worker (local, :8787) ──┘ bucket
                                   = worker/src/* (prod code) ─▶ R2 (write)
```

The legacy Node server in `backend/` and the on-disk `data/era5-land/` tree are
**no longer used** by dev or prod — they're kept only for reference.

## Quick start

Two terminals (both on **Node 22**; the scripts switch via `nvm`):

### Terminal 1 — control plane (Worker on real R2)
```bash
npm run dev          # → cd worker && wrangler dev --remote --port 8787
```
First run, `wrangler` must be authenticated to the Cloudflare account that owns
the `weather-baseline` bucket:
```bash
cd worker && npx wrangler whoami     # should list the account + R2/Workers scopes
npx wrangler login                   # if not logged in (opens a browser)
```

### Terminal 2 — frontend (Vite, hot reload)
```bash
cd frontend && npm install   # first time only
cd ..
npm run dev:frontend         # → Vite on http://localhost:5173
```

Open **http://localhost:5173**. The Vite proxy forwards `/api/*` to the local
Worker on `:8787`; data files load directly from R2.

> `npm run dev:all` runs both in one terminal, but two terminals are easier to
> read (the Worker logs every `ensure-fresh` / Open-Meteo call).

## Routes (the Worker)

- `GET /api/ensure-fresh?lat=&lon=` — top up `recent`/`forecast` for the snapped
  cell in R2 from Open-Meteo (forecast ≥12h stale, recent ≥24h stale).
- `GET /api/geo` — a starting location for a bare visit (from Cloudflare edge
  geolocation; under local `--remote` it resolves the dev tunnel's egress).
- `GET /api/health` — liveness.

There is **no** `/data` route in dev — data reads go to R2's public URL.

## Notes

- **Why `--remote`:** it binds the local Worker to the *real* R2 bucket, so dev
  exercises the exact data path prod uses. Plain `wrangler dev` (local Miniflare
  R2) would be an empty, separate store.
- **`/api/geo` 200 ≠ your location** locally — it geolocates the tunnel egress.
  The frontend only uses it as a best-effort starting guess and falls back to a
  default city otherwise.
- **Production build smoke test:**
  `cd frontend && nvm use 22 && VITE_API_BASE=<worker-origin> npm run build`,
  then preview `../dist`. See `DEPLOY.md`.

## License

MIT License
