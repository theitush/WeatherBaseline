# Deploying WeatherBaseline

How the live site is hosted, and how to ship updates. **Deploys are manual** —
`git push` backs up code to GitHub but does **not** update the live site. You
deploy by running the commands below.

## The three independent pieces

| Piece | Lives at | What it is |
|---|---|---|
| **Frontend** | `https://weather-baseline.pages.dev` | The static site users visit (Cloudflare Pages project `weather-baseline`). |
| **Worker** | `https://howhotwasit.yajna-auth.workers.dev` | Control-plane API: `/api/geo`, `/api/ensure-fresh`, `/api/health`. Tops up the volatile R2 tiers from Open-Meteo. |
| **Data** | R2 bucket `weather-baseline`, public at `https://pub-403d94ceb15c48af9cb6005b1d541e82.r2.dev` | The `archive/recent/forecast` `.csv.gz` tier files. The frontend reads these **directly** from R2 — reads never touch the Worker. |

> **Naming note (cosmetic):** the Worker is named `howhotwasit` and the account
> subdomain is `yajna-auth` — leftovers from the old product name / account.
> **Users never see these**; the `workers.dev` URL is only called by background
> JS. The only public URL is `weather-baseline.pages.dev`. A custom domain would
> hide all of it (see "Future" below).

## Prerequisites

- `wrangler` is authenticated as the Cloudflare account owner:
  ```bash
  cd worker && npx wrangler whoami     # should show the account, R2 + Workers scopes
  npx wrangler login                   # if not logged in (opens a browser)
  ```
- Frontend builds on **Node 22** (`nvm use 22`). The Node backend (`backend/`)
  is dev-only and is **not** deployed — the Worker replaces it in prod.

## Deploy the frontend (Pages)

The frontend reaches the Worker's `/api/*` and the R2 data via two **build-time**
env vars. They must be set when you build, because Vite inlines them into the
bundle:

- `VITE_API_BASE` → the Worker origin (so `/api/*` calls reach it cross-origin).
- `VITE_DATA_BASE` → the R2 public origin (committed in `frontend/.env`, so you
  don't normally need to pass it).

```bash
cd frontend
nvm use 22
VITE_API_BASE=https://howhotwasit.yajna-auth.workers.dev npm run build
#   → outputs to repo-root  dist/  (vite outDir is ../dist)

cd ..
npx wrangler pages deploy dist --project-name weather-baseline --branch main --commit-dirty=true
```

The last command prints the live URL. The stable one is
`https://weather-baseline.pages.dev`; the `<hash>.weather-baseline.pages.dev`
line is that single deploy's immutable alias.

### Social link previews (Pages Function)

Deep links get a per-link preview card (date + location) when pasted into
Slack, Twitter/X, etc. Crawlers don't run JS, so a **Pages Function**
(`functions/_middleware.js`, at the **repo root**) rewrites the `og:`/`twitter:`
description server-side — but **only for social crawler User-Agents**; real
visitors get the untouched SPA. The title is always the fixed question (static
in `index.html`); the description becomes `<Date> · <City>`, with the city an
exact lat/lon lookup in `/cells.csv`. The bare root and unknown coords keep the
`index.html` default.

> **Location matters:** Pages discovers `functions/` at the project root (where
> you run `wrangler pages deploy`), **not** inside the deployed `dist/`. Keeping
> it at the repo root means it deploys with `wrangler pages deploy dist`
> automatically — **no extra step** — and `pages dev` finds it too.

To test it locally:
```bash
npx wrangler pages dev dist --compatibility-date 2025-04-01
curl -s -A Slackbot http://localhost:8788/23.80,90.40/2025-07-15/tmax | grep og:description
```

> Leave `VITE_API_BASE` **unset** for a local dev build — then the frontend uses
> relative `/api/*`, which the Vite proxy forwards to the local Node backend.

## Deploy the Worker

```bash
cd worker
npx wrangler deploy
```

Config is `worker/wrangler.toml` (R2 binding `BUCKET` → `weather-baseline`, TTL
vars). Verify after deploy:

```bash
BASE=https://howhotwasit.yajna-auth.workers.dev
curl -s "$BASE/api/health"
curl -s "$BASE/api/geo"
curl -s "$BASE/api/ensure-fresh?lat=51.5&lon=-0.1"
```

## R2 data + CORS

- **Uploading tier files:** `scripts/era5_pipeline/r2_upload.py` (boto3, needs
  `source scripts/era5_pipeline/r2.env` first), or the VM data job with
  `--upload-r2`. Object keys are `{tier}/{tier}_{lat}_{lon}.csv.gz` — **no**
  `data/` or `era5-land/` prefix.
- **CORS is required** and easy to get wrong. The frontend fetches the `.csv.gz`
  files cross-origin (page on `pages.dev`, files on `r2.dev`), so the bucket's
  CORS allowlist must contain the **exact** Pages origin, hyphen included:
  `https://weather-baseline.pages.dev`. If it's missing/wrong, the browser
  blocks every data fetch and the chart shows "No weather data received".
  > `curl` does **not** send an `Origin` header, so a passing `curl` does **not**
  > prove CORS works — only a real browser does.

  Current policy / apply:
  ```bash
  npx wrangler r2 bucket cors list weather-baseline          # show
  npx wrangler r2 bucket cors set weather-baseline --file scripts/era5_pipeline/r2-cors.json
  ```
  (`scripts/era5_pipeline/r2_set_cors.py` holds the canonical origin list; the
  wrangler JSON uses the `{"rules":[{"allowed":{...}}]}` shape, which differs
  from boto3's.)

## Smoke-test the live site

After a frontend deploy, open `https://weather-baseline.pages.dev` and confirm
the chart renders with data and the browser console has **no CORS / fetch
errors**. The page should geolocate, redirect to a `/{lat},{lon}/{date}/tmax`
route, and draw "The Data" / "The Stats" sections.

## Future: custom domain (optional, ~$10/yr)

Buying a domain (e.g. via Cloudflare Registrar) and serving Pages + the Worker
on one origin lets you:
- drop `VITE_API_BASE` (relative `/api/*` just works),
- drop the R2 CORS rule (same-origin),
- hide the `howhotwasit` / `yajna-auth` names entirely.

It's a non-breaking upgrade — route `/api/*` on the domain to the Worker, point
the apex/`www` at the Pages project, and rebuild without `VITE_API_BASE`.
