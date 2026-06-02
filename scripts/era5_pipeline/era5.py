"""Shared ERA5-Land daily statistics helpers.

Schema verified against:
  https://github.com/brunomartinsmv/ear5-daily-statistics-data-download
  https://cds.climate.copernicus.eu/datasets/derived-era5-land-daily-statistics

Notes:
  - daily_statistic is one value per request (daily_minimum | daily_maximum | daily_mean | daily_sum).
  - variable name is "2m_temperature" or "total_precipitation"; min/max come from the statistic.
  - ERA5-Land covers land only; ocean grid cells are NaN.
  - Bilinear interp via xarray.Dataset.interp; fallback to nearest for NaN cities (coastlines).
"""
from __future__ import annotations

import os
import shutil
import tempfile
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import xarray as xr

DATASET = "derived-era5-land-daily-statistics"

# (variable, daily_statistic) tuples → output column name
TARGETS = {
    "tmin": ("2m_temperature", "daily_minimum"),
    "tmax": ("2m_temperature", "daily_maximum"),
    "precip": ("total_precipitation", "daily_sum"),
}

COLS = {
    "tmin": "min_temperature",
    "tmax": "max_temperature",
    "precip": "precipitation_mm",
}


@dataclass
class RequestSpec:
    year: int
    target: str  # "tmin" | "tmax" | "precip"
    area: list[float] | None = None  # [N, W, S, E]

    def to_cds(self) -> dict:
        variable, daily_statistic = TARGETS[self.target]
        body = {
            "product_type": "reanalysis",
            "variable": [variable],
            "year": [str(self.year)],
            "month": [f"{m:02d}" for m in range(1, 13)],
            "day": [f"{d:02d}" for d in range(1, 32)],
            "daily_statistic": daily_statistic,
            "time_zone": "utc+00:00",
            "frequency": "1_hourly",
        }
        if self.area is not None:
            body["area"] = self.area
        return body


def submit_and_download(client, spec: RequestSpec, dest: Path, label: str = "") -> dict:
    """Submit a CDS request and download to dest. Returns timing dict.

    Uses the lower-level submit() API so we can heartbeat-log progress while
    the request is queued/processing on CDS (otherwise the high-level retrieve()
    blocks silently for many minutes)."""
    import threading

    t0 = time.time()
    body = spec.to_cds()
    dest.parent.mkdir(parents=True, exist_ok=True)
    tag = f"[{label}] " if label else ""

    # cdsapi 0.7.x: retrieve() with wait_until_complete=False returns Remote.
    submitted = client.retrieve(DATASET, body)

    # Heartbeat loop
    stop_event = threading.Event()

    def _heartbeat():
        i = 0
        while not stop_event.wait(15):
            i += 1
            elapsed = time.time() - t0
            state = "?"
            try:
                submitted.update()
                status_attr = getattr(submitted, "status", None)
                state = status_attr() if callable(status_attr) else (status_attr or "?")
            except Exception:  # noqa: BLE001
                pass
            print(
                f"  {tag}…{elapsed:5.0f}s elapsed, state={state}",
                flush=True,
            )

    hb = threading.Thread(target=_heartbeat, daemon=True)
    hb.start()
    try:
        # Block until ready, then download
        if hasattr(submitted, "download"):
            submitted.download(str(dest))
        else:
            # Very old api: submitted was the final result from retrieve()
            pass
    finally:
        stop_event.set()
        hb.join(timeout=1)

    elapsed = time.time() - t0
    size_mb = dest.stat().st_size / 1e6
    print(
        f"  {tag}DONE {elapsed:.0f}s, {size_mb:.1f}MB",
        flush=True,
    )
    return {"elapsed_s": elapsed, "size_mb": size_mb}


def open_dataset(path: Path) -> xr.Dataset:
    """Open the CDS payload (zip-of-netcdf or plain netcdf) as an xarray Dataset."""
    if zipfile.is_zipfile(path):
        tmpdir = Path(tempfile.mkdtemp(prefix="era5_unzip_"))
        try:
            with zipfile.ZipFile(path) as zf:
                ncs = [n for n in zf.namelist() if n.endswith(".nc")]
                if not ncs:
                    raise RuntimeError(f"No .nc inside {path}")
                zf.extract(ncs[0], tmpdir)
                inner = tmpdir / ncs[0]
                ds = xr.open_dataset(inner, engine="netcdf4").load()
            return ds
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)
    return xr.open_dataset(path, engine="netcdf4").load()


def _detect_coord_names(ds: xr.Dataset) -> tuple[str, str, str]:
    lat = "latitude" if "latitude" in ds.coords else "lat"
    lon = "longitude" if "longitude" in ds.coords else "lon"
    # time coord can be valid_time or time
    if "valid_time" in ds.coords:
        t = "valid_time"
    elif "time" in ds.coords:
        t = "time"
    else:
        raise RuntimeError(f"No time coord in {list(ds.coords)}")
    return lat, lon, t


def interp_cities(
    ds: xr.Dataset, lats: np.ndarray, lons: np.ndarray, var: str
) -> np.ndarray:
    """Interpolate var at (lat, lon) points. Shape: (n_cities, n_days).

    Bilinear interp, with nearest-neighbour fallback for NaN points (coastlines).
    Returns numpy array shaped (n_cities, n_days).
    """
    lat_name, lon_name, _ = _detect_coord_names(ds)

    # ERA5-Land longitudes are typically -180..180. Normalise input to match.
    lon_min = float(ds[lon_name].min())
    lon_max = float(ds[lon_name].max())
    if lon_max > 180.5:  # 0..360 grid
        lons = np.where(lons < 0, lons + 360.0, lons)
    elif lon_min < -0.5:  # -180..180
        lons = np.where(lons > 180, lons - 360.0, lons)

    lat_da = xr.DataArray(lats, dims="city")
    lon_da = xr.DataArray(lons, dims="city")

    bilin = ds[var].interp({lat_name: lat_da, lon_name: lon_da}, method="linear")
    arr = bilin.values  # (time, city) or (city, time)

    # Ensure (city, time)
    if arr.shape[0] != len(lats):
        arr = arr.T

    if np.isnan(arr).any():
        nearest = ds[var].interp(
            {lat_name: lat_da, lon_name: lon_da}, method="nearest"
        ).values
        if nearest.shape[0] != len(lats):
            nearest = nearest.T
        mask = np.isnan(arr)
        arr = np.where(mask, nearest, arr)

    return arr


def convert_units(target: str, arr: np.ndarray) -> np.ndarray:
    if target in ("tmin", "tmax"):
        return arr - 273.15  # K → °C
    if target == "precip":
        return arr * 1000.0  # m → mm
    raise ValueError(target)


def dates_from_ds(ds: xr.Dataset) -> np.ndarray:
    _, _, t = _detect_coord_names(ds)
    return ds[t].values.astype("datetime64[D]")
