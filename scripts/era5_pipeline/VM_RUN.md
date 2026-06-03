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
workers). It does **not** need much CPU or disk (25–40 GB is plenty — zarr chunks
stream through RAM, not to disk).

- **Oracle Cloud Always-Free ARM** (`VM.Standard.A1.Flex`, up to 4 OCPU / 24 GB) — $0 forever.
- **Hetzner CPX21** (3 vCPU / 4 GB / ~€5/mo) — simplest; destroy when done. On
  4 GB, lower `--batch-years` (see RAM note below).

Use Ubuntu 22.04 or 24.04.

## Steps

### 1. Install deps (on the VM)
```bash
sudo apt update && sudo apt install -y python3-venv git tmux rclone gdal-bin libgdal-dev
# gdal-bin/libgdal-dev are for rasterio (select_cells.py); skip if only running download_cells.py.
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
scp ~/.netrc user@vm:~/                                                  # DestinE / EarthDataHub — the one that matters
scp scripts/era5_pipeline/.cdsapirc user@vm:~/HowHotWasIt/scripts/era5_pipeline/
```
Then on the VM:
```bash
chmod 600 ~/.netrc ~/HowHotWasIt/scripts/era5_pipeline/.cdsapirc
```
`download_cells.py` opens the zarr store with `trust_env: True`, so auth is read
from `~/.netrc` of the user running python. The `~/.netrc` must have an entry for
`data.earthdatahub.destine.eu`. If your local runs work, your local `~/.netrc` is
correct — copy that one.

### 5. Run in tmux (survives SSH disconnect)
```bash
tmux new -s era5
source .venv/bin/activate

# Smoke-test one tile end-to-end on the VM first:
python download_cells.py --tile 9_5 --start-year 1950

# Then the full pull:
python download_cells.py --start-year 1950 --batch-years 20 --parallel-tiles 2

# Detach: Ctrl-b then d.   Reattach: tmux attach -t era5
```
The job is resumable: it reads existing archives and fetches only missing years
(including interior gaps), always re-fetching the trailing year. If the VM
reboots or you Ctrl-C, just rerun the same command.

### 6. Upload output to R2 (incrementally is fine)
```bash
rclone config   # one-time: add an "r2" remote — S3-compatible, your R2 keys + account endpoint
rclone copy data/era5-land/archive r2:your-bucket/era5-land/archive --progress
```
`rclone copy` only uploads new/changed files, so you can run it periodically
*during* the multi-day pull to land partial progress.

### 7. Tear down
Destroy the VM (Hetzner) or stop it (Oracle free). The archive now lives in R2
and is served as immutable static files — no compute in prod.

## RAM note

`--batch-years 20` ≈ 3 GB per variable in memory per tile; `--var-workers`
(default 4) and `--parallel-tiles` multiply that. On a 4 GB box use
`--batch-years 10 --var-workers 2 --parallel-tiles 1` or the OOM killer hits.
The script prints a peak-RAM estimate before fetching — heed it.
