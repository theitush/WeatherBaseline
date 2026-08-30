# Running the HRES forecast pull on a VM

`pull_hres_all.py` grabs ~2 years of settled IFS-HRES daily forecasts (tmax, tmin,
precip, wind_max) for **every cell**, at the same snapped 0.1° point + nearest-cell
selection the prod Worker uses, and uploads each cell to its **own R2 prefix**
`hres-forecast/` by default. It's the forecast side of the archive↔forecast bias
model.

It is **resumable from any machine**: on start it lists what's already in R2 and
fetches only the missing cells. Run it on your laptop, on a VM, restart it, run it
from a different box — it always continues, never re-pulls. So you can do **both**
the one-off backfill and later top-ups with the same command.

For a corrected/reproducible rebuild without replacing the old data, choose a new
prefix such as `hres-forecast-ifs-hres/`. A fresh prefix is also truly resumable:
the normal (non-`--overwrite`) run skips the objects and ledger entries it has
already completed. Do **not** add `--overwrite` for this workflow; overwrite starts
from the beginning on a new invocation.

---

## The two ways to run it (pick one)

### A. FREE tier — no signup, slow, single machine
The free API is limited **per IP** to 10k calls/day. The full grid is ~550k calls,
so it takes **~2 months** of daily runs. The script paces itself at 6 calls/min and
**stops cleanly when it hits the daily wall** — you just rerun it the next day and
it continues. No key, no cost.

> ⚠️ Don't try to "get more requests" by running it on several VMs at once. The
> free limit is per-IP and farming IPs to dodge it is against their terms and gets
> the IP range blocked. The legitimate way to go fast is the paid key (option B).

### B. Standard plan — $29, one machine, ~1 day  ← recommended for the backfill
The paid plan authenticates with an **API key, not your IP**, and removes the daily
cap. The whole grid finishes in **~1 day**. Subscribe, run, **cancel when done** —
it's month-to-month (their page: *"Cancellation takes effect at the end of the
current billing period"*), so one $29 month covers the entire backfill.

1. Subscribe at https://open-meteo.com/en/pricing → **API Standard** ($29/mo, 1M
   calls — your full pull is ~550k, comfortable headroom).
2. Copy the API key they give you.
3. Set it in the environment before running (see step 5 below):
   `export OPENMETEO_API_KEY=your_key_here`
4. **After the pull finishes, cancel the plan** in the same customer portal.

---

## Run it on your laptop (simplest — no VM at all)

This job is light (network + small CSV writes, no heavy RAM like the era5 pull). If
your laptop can stay on, you don't need a VM:

```bash
cd debias
source ../era5_pipeline/.venv/bin/activate
export $(grep -v '^#' ../era5_pipeline/r2.env | xargs)   # R2 upload creds
export OPENMETEO_API_KEY=your_key      # OMIT this line for the free tier

python pull_hres_all.py --only Chicago --years 99 --r2-prefix hres-forecast-ifs-hres
python pull_hres_all.py --years 99 --r2-prefix hres-forecast-ifs-hres
```

If it stops (quota, laptop sleep, Ctrl-C), just rerun the last command — it resumes
from R2. **This is genuinely the easiest path. Use a VM only if you can't leave a
machine on for a day (Standard) or ~2 months (free).**

---

## Run it on a throwaway GCP VM (self-terminating)

Use this if you'd rather not tie up your laptop. The VM does the job and **deletes
itself** at the end, so billing stops automatically — no separate scheduler needed.

### 1. Create the VM with a startup script
Save this as `hres_startup.sh` on your laptop, filling in `REPO_URL` and the key:

```bash
#!/bin/bash
set -e
export OPENMETEO_API_KEY="your_key_here"   # delete this line for the free tier
apt-get update && apt-get install -y python3-venv git
cd /root
git clone REPO_URL HowHotWasIt
cd HowHotWasIt/era5_pipeline
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
# R2 creds: paste the three R2_* values (from era5_pipeline/r2.env) here:
export R2_ACCOUNT_ID=...
export R2_ACCESS_KEY_ID=...
export R2_SECRET_ACCESS_KEY=...
cd ../debias
# loop so a transient daily-stop on the FREE tier retries; on Standard it finishes
# in one pass. Exit 2 = "more to do", anything else = done/failed -> stop looping.
while :; do
  python pull_hres_all.py && break
  [ $? -eq 2 ] || break
  sleep 3600
done
# self-destruct: the box deletes itself, billing stops.
NAME=$(curl -s -H "Metadata-Flavor: Google" http://metadata/computeMetadata/v1/instance/name)
ZONE=$(curl -s -H "Metadata-Flavor: Google" http://metadata/computeMetadata/v1/instance/zone | awk -F/ '{print $NF}')
gcloud compute instances delete "$NAME" --zone="$ZONE" --quiet
```

### 2. Launch it
```bash
gcloud compute instances create hres-pull \
  --machine-type=e2-small --image-family=ubuntu-2404-lts-amd64 \
  --image-project=ubuntu-os-cloud --boot-disk-size=20GB --zone=us-central1-a \
  --scopes=cloud-platform \
  --metadata-from-file=startup-script=hres_startup.sh
```
`e2-small` (2 GB) is plenty — this job is network-bound, not RAM-bound. `--scopes=
cloud-platform` is what lets the VM delete itself at the end.

That's it. The VM boots, runs the pull (resuming from R2 if it was ever interrupted),
then deletes itself. Check progress any time by listing R2: the selected prefix
fills up as it goes, and `<prefix>/.hres_progress.json` is the ledger.

> Don't want it to self-delete (e.g. to inspect logs)? Drop the last 4 lines of the
> startup script and `gcloud compute instances delete hres-pull --zone=...` by hand
> when you're satisfied.

---

## Why not a Lambda / Cloud Function?
Serverless functions hard-cap at 15–60 min; this run is hours (Standard) to weeks
(free). It needs a long-lived, resumable process — a VM (or your laptop), not a
function. A self-terminating VM gives you the "turns itself off when done" behavior
without the timeout.

## Output layout (separate from the live serving tiers)
```
hres-forecast/hres_{lat}_{lon}.csv.gz     date,tmax_C,tmin_C,precip_mm,wind_max_ms
hres-forecast/.hres_progress.json         resume ledger + per-cell HRES cell
                                          center lat/lon/elevation (bias feature)
```
Nothing here touches the live `archive/`, `recent/`, `forecast/` objects the app
serves. It's a standalone research dataset for the bias study.
