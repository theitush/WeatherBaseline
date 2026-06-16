#!/usr/bin/env bash
# Deploy HowHotWasIt to production — Worker + frontend (Cloudflare Pages) — in one
# go. Encodes the exact steps from DEPLOY.md so you don't have to remember them.
#
#   bash scripts/deploy_prod.sh
#
# Needs: wrangler logged in (`cd worker && npx wrangler login`, opens a browser
# once) and Node 22 active (the project builds on 22).
set -euo pipefail
cd "$(dirname "$0")/.."            # repo root
WORKER_API="https://howhotwasit.yajna-auth.workers.dev"

node_major="$(node -v | sed 's/v\([0-9]*\).*/\1/')"
if [ "$node_major" != "22" ]; then
  echo "⚠  Node $(node -v) detected — this project builds on Node 22."
  echo "   If the build fails, switch with:  nvm use 22"
  echo
fi

echo "▶ 1/2  Deploying the Worker…"
( cd worker && npx wrangler deploy )

echo
echo "▶ 2/2  Building the frontend and deploying to Cloudflare Pages…"
( cd frontend && VITE_API_BASE="$WORKER_API" npm run build )
# pages deploy runs from the repo root so it picks up functions/ (link previews);
# `npm run build` writes to repo-root dist/ (vite outDir is ../dist).
npx wrangler pages deploy dist --project-name weather-baseline --branch main --commit-dirty=true

echo
echo "============================================================"
echo "✅ Deployed — Worker + frontend are live with metric capture."
echo "============================================================"
echo "Try it: open your site, switch a metric, then check the private /dashboard."
