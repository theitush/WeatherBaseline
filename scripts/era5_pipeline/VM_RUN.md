# Running the archive download on a VM

The full ERA5-Land archive pull (1950→present, all cells) is a long-running,
network-bound, resumable job. You run it **once** on a throwaway VM, then upload
the resulting `data/era5-land/archive/*.csv.gz` to R2 and serve them statically
forever. The multi-GB part is the *input* zarr chunks streaming through memory —
they never land on disk and never touch prod. The *output* archive is small
(~250 KB/cell → ~2.5 GB at 10k cells).

The heavy download is the **EarthDataHub zarr store** (`data.earthdatahub.destine.eu`),
not CDS. CDS is the superseded path. The binding credential is therefore
`~/.netrc`, not `.cdsapirc`.

## Pick a VM

The job is network-bound, long-running, resumable, modest RAM (~3 GB/var ×
workers — this is the binding constraint). It does **not** need much CPU or disk
(25–40 GB is plenty — zarr chunks stream through RAM, not to disk).

**Recommended: GCP $300 / 90-day free trial.** A few days of an 8 GB VM costs
~$5–15 against the $300 credit — effectively free, with full RAM headroom and no
capacity lottery. Create an **`e2-standard-2` (2 vCPU / 8 GB)** in any region,
Ubuntu 24.04 LTS boot image, 40 GB standard disk. Via gcloud:
```bash
gcloud compute instances create era5 \
  --machine-type=e2-standard-2 --image-family=ubuntu-2404-lts-amd64 \
  --image-project=ubuntu-os-cloud --boot-disk-size=40GB --zone=us-central1-a
gcloud compute ssh era5 --zone=us-central1-a
```
At 8 GB you run full settings (`--batch-years 20 --parallel-tiles 2`). **Delete
the instance when done** (`gcloud compute instances delete era5`) so it stops
drawing on the credit.

Alternatives:
- **Hetzner CPX21** (3 vCPU / 4 GB / ~€5/mo) — trivial signup, likely <€1 for the
  run. On 4 GB, lower the batch settings (see RAM note below).
- **Oracle Always-Free ARM** ($0 forever) — only if their signup/capacity
  cooperates; notoriously flaky.

Use Ubuntu 22.04 or 24.04.

## Steps

### 1. Install deps (on the VM)
```bash
sudo apt update && sudo apt install -y python3-venv git tmux
# (gdal-bin/libgdal-dev only needed for rasterio/select_cells.py — NOT for the
#  download. cells.csv is already built and committed. rclone no longer needed:
#  download_cells.py --upload-r2 pushes to R2 itself, see steps 4 & 5.)
```

### 2. Get the code + cells.csv
The pipeline reads `data/era5/cells.csv` and writes `data/era5-land/archive/`,
both relative to the repo root (`REPO/data/...`). Preserve that layout — clone
the repo, or rsync just the pieces:
```bash
git clone <your-repo-url> ~/HowHotWasIt
# OR, minimal:
# rsync -av scripts/era5_pipeline/ data/era5/cells.csv user@vm:~/HowHotWasIt/...
```

### 3. Set up the venv
```bash
cd ~/HowHotWasIt/scripts/era5_pipeline
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

### 4. Copy the secrets — these do NOT come over with git (gitignored)
This is the #1 thing people forget. From your **laptop**:
```bash
scp ~/.netrc user@vm:~/                                                  # DestinE / EarthDataHub — the download credential
scp scripts/era5_pipeline/r2.env user@vm:~/HowHotWasIt/scripts/era5_pipeline/   # R2 S3 keys — the UPLOAD credential
# .cdsapirc is the superseded CDS path; not needed for the zarr download.
```
Then on the VM:
```bash
chmod 600 ~/.netrc ~/HowHotWasIt/scripts/era5_pipeline/r2.env
```
- `~/.netrc` (download): `download_cells.py` opens the zarr store with
  `trust_env: True`, so auth is read from `~/.netrc` of the user running python.
  It must have an entry for `data.earthdatahub.destine.eu`. If your local runs
  work, your local `~/.netrc` is correct — copy that one.
- `r2.env` (upload): `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`
  for the `weather-baseline` bucket. `source` it before running (step 5) so
  `--upload-r2` can authenticate.

### 5. Run in tmux (survives SSH disconnect)
```bash
tmux new -s era5
source .venv/bin/activate
source r2.env                 # exports the R2_* vars for --upload-r2

# Smoke-test one tile end-to-end on the VM first (downloads AND uploads it):
python download_cells.py --tile 11_3 --year 2020 --upload-r2

# Then the full pull — pushes each archive to R2 as it's written:
python download_cells.py --start-year 1950 --batch-years 20 --parallel-tiles 2 --upload-r2

# Detach: Ctrl-b then d.   Reattach: tmux attach -t era5
```
`--upload-r2` uploads each cell's `archive/archive_{lat}_{lon}.csv.gz` to R2 right
after it's written (key = `archive/<name>`, NO `era5-land/` prefix — that matches
how the Worker/`tieredData.ts` read it). Creds are checked up front: a missing
R2_* var exits before the pull starts. Omit the flag to write archives to local
disk only.

The job is resumable: it reads existing **local** archives (or R2, with
`--upload-r2`) and fetches only missing years (including interior gaps),
re-fetching the trailing year **only when it's behind the store's newest day** —
that's the automatic monthly top-up, no flag needed (the old `--refresh-latest`
is gone). A caught-up tile is skipped. If the VM reboots or you Ctrl-C, just
rerun the same command — already-uploaded archives are simply overwritten
(idempotent), no separate sync needed.

> If `data/era5-land/archive/` was wiped but R2 still has the data, the resume
> check (which reads *local* disk) will refetch everything. Keep the local dir
> for cheap resume, or pull it back from R2 first.

### 5b. Correcting already-built data — `--overwrite`

The archive buckets each day by the cell's **local solar day** (offset by
`round(lon/15)h` before the daily min/max/sum). A normal run only fetches
*missing* years, so it will NOT fix cells whose history was built under an older,
wrong definition (e.g. the previous UTC-day bucketing, which mislabeled **tmin**
by ~a day for off-UTC cells like Beijing). To rebuild existing data, add
`--overwrite`:
```bash
python download_cells.py --start-year 1950 --batch-years 20 --parallel-tiles 2 \
  --overwrite --upload-r2
```
`--overwrite` REPLACES each cell's archive from scratch (so stale rows can't
survive the merge) and **refetches every requested year**. It is crash- AND
VM-wipe-resumable via its own per-`(cell, span)` ledger, written locally and
mirrored to R2 at `archive/.overwrite_progress.json`: a recreated box pulls the
ledger back from R2 and skips work already done (worst case redoes ≤30 s of
cells). The ledger is deleted on a clean finish.

> **Run `--overwrite` over the FULL grid once after a definition change.** After
> that, routine monthly top-ups use the *normal* command (no `--overwrite`) — new
> local-day rows then merge onto local-day history. Running a normal top-up on a
> cell that still has old-definition rows would leave a seam.

### 6. Tear down
Destroy the VM (Hetzner) or stop it (Oracle free). The archive now lives in R2
and is served as immutable static files — no compute in prod.

## RAM note

`--batch-years 20` ≈ 3.5 GB per variable in memory per tile (5x10deg tiles
since the July 2026 store revamp, up from 3 GB on the old 6.4deg tiles);
`--var-workers` (default 4) and `--parallel-tiles` multiply that. On the
recommended **8 GB** GCP box the old full settings (`--batch-years 20
--parallel-tiles 2`) are now tight — the script prints a peak-RAM estimate
before fetching, heed it and drop `--batch-years` or `--parallel-tiles` if it
exceeds MemAvailable. On a **4 GB** box (Hetzner CPX21) use `--batch-years 10
--var-workers 2 --parallel-tiles 1` or the OOM killer hits.
