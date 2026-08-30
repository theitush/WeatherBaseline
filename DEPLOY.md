# Deploying WeatherBaseline

How the live site is hosted, and how to ship updates. **Deploys are manual** —
`git push` backs up code to GitHub but does **not** update the live site. You
deploy by running the commands below.

The one-command path is [`scripts/deploy_prod.sh`](scripts/deploy_prod.sh),
which does the Worker and the frontend in order. The rest of this file is what
that script encodes, plus the pieces it deliberately leaves manual (data
uploads, CORS, DNS).

## The three independent pieces

| Piece | Lives at | What it is |
|---|---|---|
| **Frontend** | `https://www.weatherbaseline.com` (Cloudflare Pages project `weather-baseline`; `https://weather-baseline.pages.dev` still serves the same deploy) | The static site users visit. The apex `weatherbaseline.com` 301s to `www`. |
| **Worker** | `https://www.weatherbaseline.com/api/*` (also reachable direct at `https://howhotwasit.yajna-auth.workers.dev`) | Control-plane API: `/api/geo`, `/api/ensure-fresh`, `/api/health`, plus the private `/dashboard`. Tops up the volatile R2 tiers from Open-Meteo. |
| **Data** | R2 bucket `weather-baseline`, public at `https://data.weatherbaseline.com` (custom domain; the rate-limited dev fallback `https://pub-403d94ceb15c48af9cb6005b1d541e82.r2.dev` still works) | The `archive/recent/forecast` `.csv.gz` tier files and the static `debias-vN/` tables. The frontend reads these **directly** from R2 — reads never touch the Worker. |

> **Naming note (cosmetic):** the Worker is named `howhotwasit` and the account
> subdomain is `yajna-auth` — leftovers from the old product name / account.
> **Users never see either**: the site and its `/api/*` both serve from
> `www.weatherbaseline.com`, and the `workers.dev` URL survives only as a direct
> handle for smoke tests.

### The `/api/*` route is dashboard-managed

`www.weatherbaseline.com/api/*` reaches the Worker via a **route configured in
the Cloudflare dashboard**, not in [`worker/wrangler.toml`](worker/wrangler.toml).
Nothing in this repo recreates it, so `wrangler deploy` will never restore it:
if `/api/*` starts returning the SPA's HTML instead of JSON, the route is gone
and has to be re-added by hand (Workers → `howhotwasit` → Settings → Domains &
Routes → `www.weatherbaseline.com/api/*`).

Because that route exists, the frontend calls `/api/*` **same-origin** and
`VITE_API_BASE` is no longer needed for a prod build (see below).

## Prerequisites

- `wrangler` is authenticated as the Cloudflare account owner:
  ```bash
  cd worker && npx wrangler whoami     # should show the account, R2 + Workers scopes
  npx wrangler login                   # if not logged in (opens a browser)
  ```
- Frontend builds on **Node 22** (`nvm use 22`). Local dev runs the **same
  Worker code as prod** via `wrangler dev --remote` (`npm run dev`).
- **`DASHBOARD_TOKEN` is set as a Worker secret.** It is the password for
  `/dashboard` and `/api/analytics`, is deliberately not in `wrangler.toml`, and
  does not survive a fresh Worker: without it the dashboard returns 503.
  ```bash
  cd worker && npx wrangler secret put DASHBOARD_TOKEN
  ```

## Deploy everything

```bash
nvm use 22
bash scripts/deploy_prod.sh
```

That deploys the Worker, then builds the frontend and deploys it to Pages. The
two halves are independent — the sections below are the manual equivalents, for
when you only want one of them.

## Deploy the frontend (Pages)

The frontend reads two **build-time** env vars, because Vite inlines them into
the bundle:

- `VITE_DATA_BASE` → the R2 public origin. Committed in
  [`frontend/.env`](frontend/.env), so you never pass it.
- `VITE_API_BASE` → the Worker origin. **Leave it unset.** Empty means the app
  calls relative `/api/*`, which the dashboard route serves same-origin in prod
  and the Vite proxy forwards to the local Worker (`:8787`) in dev. Set it only
  to point a build at a Worker on some *other* origin.

```bash
cd frontend
nvm use 22
npm run build
#   → outputs to repo-root  dist/  (vite outDir is ../dist)

cd ..
npx wrangler pages deploy dist --project-name weather-baseline --branch main --commit-dirty=true
```

The last command prints the live URL. The stable ones are
`https://www.weatherbaseline.com` and `https://weather-baseline.pages.dev`; the
`<hash>.weather-baseline.pages.dev` line is that single deploy's immutable alias.

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

## Deploy the Worker

```bash
cd worker
npx wrangler deploy
```

Config is [`worker/wrangler.toml`](worker/wrangler.toml): the R2 binding
`BUCKET` → `weather-baseline`, the D1 binding `DB` →
`howhotwasit-analytics` (unique-visitor logging; the Worker no-ops logging if
the binding is absent), and the tier TTL vars. A brand-new database also needs
every migration in `worker/migrations/` applied once, in order:

```bash
for m in migrations/*.sql; do
  npx wrangler d1 execute howhotwasit-analytics --remote --file="$m"
done
```

Verify after deploy — both the route and the direct origin:

```bash
curl -s https://www.weatherbaseline.com/api/health      # must be JSON, not HTML
curl -s https://howhotwasit.yajna-auth.workers.dev/api/health
curl -s "https://www.weatherbaseline.com/api/geo"
curl -s "https://www.weatherbaseline.com/api/ensure-fresh?lat=51.5&lon=-0.1"
```

## R2 data + CORS

- **Uploading tier files:** `era5_pipeline/r2_upload.py` (boto3, needs
  `set -a; source era5_pipeline/r2.env` first), or the VM data job with
  `--upload-r2`. Object keys are `{tier}/{tier}_{lat}_{lon}.csv.gz` — **no**
  `data/` or `era5-land/` prefix.
- **Caching** is per-object `Cache-Control` metadata, set by `r2_upload.py` /
  the Worker's `cellStore.js` and backfillable with `r2_set_cache_control.py`:
  `archive/` gets `max-age=86400`, `recent/` + `forecast/` get `no-store`.
  > What the edge actually serves for `archive/` is `max-age=14400` — the zone's
  > **Browser Cache TTL** (4 h) rewrites the response header downward. The
  > origin object is unchanged and the edge still holds it for a day; only the
  > browser's copy expires sooner. Not a bug, but don't be surprised by it when
  > you `curl -I` a tier file.
  >
  > Re-uploading an `archive/` object does **not** flush the edge — purge the
  > zone cache after an archive re-upload, or ship under a new key prefix
  > (which is how `debias-vN/` avoids the problem entirely).
- **CORS is required** and easy to get wrong. The frontend fetches the `.csv.gz`
  files cross-origin (page on `www.weatherbaseline.com`, files on
  `data.weatherbaseline.com`), so the bucket's CORS allowlist must contain the
  **exact** serving origins — `https://www.weatherbaseline.com` and the
  hyphenated `https://weather-baseline.pages.dev`. If one is missing, the
  browser blocks every data fetch on that origin and the chart shows "No weather
  data received".
  > `curl` does **not** send an `Origin` header by default, so a passing bare
  > `curl` does **not** prove CORS works. Send one explicitly:
  > ```bash
  > curl -s -o /dev/null -D - -H "Origin: https://www.weatherbaseline.com" \
  >   https://data.weatherbaseline.com/archive/archive_51.5_-0.1.csv.gz \
  >   | grep -i access-control-allow-origin
  > ```

  The canonical origin list lives in **one** place,
  `era5_pipeline/r2_set_cors.py`; `era5_pipeline/r2-cors.json` is the same list
  in wrangler's `{"rules":[{"allowed":{...}}]}` shape (which differs from
  boto3's). Keep them in step — applying a stale JSON is a live-site outage.

  ```bash
  npx wrangler r2 bucket cors list weather-baseline          # show
  npx wrangler r2 bucket cors set weather-baseline --file era5_pipeline/r2-cors.json
  ```

## Smoke-test the live site

After a frontend deploy, open `https://www.weatherbaseline.com` and confirm the
chart renders with data and the browser console has **no CORS / fetch errors**.
The page should geolocate, redirect to a `/{lat},{lon}/{date}/tmax` route, and
draw "The Data" / "The Stats" sections. Then switch a metric and confirm
`/dashboard` still loads with the token.

## Rollback

Pages keeps every deploy. The fastest rollback is to redeploy a known-good
build directory (`wrangler pages deploy dist-v7 …`) or to promote an earlier
deploy from the Pages dashboard. The Worker rolls back with
`npx wrangler rollback` from `worker/`.
