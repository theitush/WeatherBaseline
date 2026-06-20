#!/usr/bin/env python3
"""Local CatBoost confidence-interval server for the `ci-ui` front-end work.

DEV / LOCAL ONLY. Loads the unweighted MultiQuantile CatBoost *bias* models
(`QU_<var>_n488_s0.cbm`, target = ERA5-Land − IFS-HRES at alpha 0.05/0.5/0.95)
and returns a 90% band per (date, metric) for a cell's forecast rows.

The front-end already fetched the cell's forecast values from R2; it POSTs them
here, we bolt on the same geo + seasonal features the notebook trained with
(`scripts/bias_study/quantile_cat_bakeoff.ipynb`) and return the bias-corrected
[q05, q50, q95] in native units (°C / mm / m·s⁻¹).

  cell key seen in the 488 training cells  → cell-tuned band (real `key`)
  any other cell                           → unseen `key` → CatBoost prior,
                                             prediction carried by lat/lon/elev/
                                             season/forecast-value (cell-agnostic)

No external web deps — stdlib http.server only.

    $ python scripts/bias_study/ci_server.py        # listens on :8800
"""
import json
import math
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import pandas as pd
from catboost import CatBoostRegressor

BIAS_DIR = Path(__file__).resolve().parent
REPO     = BIAS_DIR.parents[1]
MODELS   = BIAS_DIR / 'models'
CELLS    = REPO / 'data' / 'cells.csv'
ELEV     = BIAS_DIR / 'data' / 'cell_elevation.csv'
LEDGER   = BIAS_DIR / 'data' / 'hres-forecast' / '.hres_progress.json'
TAG      = 'n488_s0'
PORT     = 8800

# front-end metric key -> (model var, hres feature column, non-negative metric)
METRICS = {
    'max_temperature':    ('tmax',   'hres_tmax_C',      False),
    'min_temperature':    ('tmin',   'hres_tmin_C',      False),
    'precipitation_sum':  ('precip', 'hres_precip_mm',   True),
    'wind_speed_10m_max': ('wind',   'hres_wind_max_ms', True),
}
PRECIP_TRACE_MM = 1.0  # matches the front-end / training trace clamp

# Open-Meteo `ecmwf_ifs` cycle changeovers in-window (same as the notebook).
FC_CHANGES = [(pd.Timestamp('2024-11-12'), '49r1'),
              (pd.Timestamp('2026-05-12'), '50r1')]   # ascending; later overrides
FC_BASE = '48r1'


def snap(c: float) -> float:
    return round(c * 10) / 10


def key_of(lat: float, lon: float) -> str:
    return f'{snap(lat):.1f}_{snap(lon):.1f}'


def fc_version(ts: pd.Timestamp) -> str:
    v = FC_BASE
    for t, label in FC_CHANGES:
        if ts >= t:
            v = label
    return v


def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi, dlmb = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


# --- load models + static per-cell features once ----------------------------
print('loading QU models…')
MODEL = {}
for _fk, (var, _hcol, _nn) in METRICS.items():
    m = CatBoostRegressor()
    m.load_model(str(MODELS / f'QU_{var}_{TAG}.cbm'))
    MODEL[var] = m

cells = pd.read_csv(CELLS)
cells['key'] = [key_of(la, lo) for la, lo in zip(cells.lat, cells.lon)]
cells = cells.drop_duplicates('key').merge(pd.read_csv(ELEV), on='cell_id', how='left')
KEY2ELEV = dict(zip(cells.key, cells.elevation))
LEDGER_DONE = json.load(open(LEDGER))['done']   # key -> {hres_lat, hres_lon, hres_elevation, ...}
print(f'  {len(MODEL)} models | {len(KEY2ELEV)} elevations | {len(LEDGER_DONE)} hres-geo cells')


def static_feats(lat: float, lon: float) -> dict:
    """The cell's geo features (elevation/hres geometry). NaN where unknown —
    CatBoost handles NaN in *numeric* features; only the categoricals must be set."""
    k = key_of(lat, lon)
    slat, slon = snap(lat), snap(lon)
    elev = KEY2ELEV.get(k, np.nan)
    led = LEDGER_DONE.get(k)
    if led is not None:
        hres_elev = led['hres_elevation']
        dist = haversine_km(slat, slon, led['hres_lat'], led['hres_lon'])
        elev_diff = (elev - hres_elev) if not (isinstance(elev, float) and math.isnan(elev)) else np.nan
    else:
        hres_elev = dist = elev_diff = np.nan
    return {'key': k, 'lat': slat, 'lon': slon, 'elevation': elev,
            'hres_elevation': hres_elev, 'elev_diff_m': elev_diff, 'dist_to_hres_km': dist}


def predict_bands(lat: float, lon: float, rows: list[dict]) -> dict:
    """rows: [{date, max_temperature?, min_temperature?, precipitation_sum?, wind_speed_10m_max?}]
    -> {date: {metricKey: {lo, mid, hi}}} in native units (bias-corrected band)."""
    sf = static_feats(lat, lon)
    dates = [r['date'] for r in rows]
    ts = pd.to_datetime(dates)
    doy = ts.dayofyear.to_numpy()
    cos_doy = np.cos(2 * np.pi * doy / 365.25)
    sin_doy = np.sin(2 * np.pi * doy / 365.25)
    fcv = [fc_version(t) for t in ts]

    out: dict[str, dict] = {d: {} for d in dates}
    for fk, (var, hcol, nn) in METRICS.items():
        vals = np.array([r.get(fk) for r in rows], dtype='float64')   # None -> nan
        if nn:  # apply the precip trace clamp identically to training
            pass
        idx = [i for i, v in enumerate(vals) if np.isfinite(v)]
        if not idx:
            continue
        v = vals[idx].copy()
        if var == 'precip':
            v[v < PRECIP_TRACE_MM] = 0.0
        feat = pd.DataFrame({
            hcol: v,
            'elevation': sf['elevation'], 'hres_elevation': sf['hres_elevation'],
            'elev_diff_m': sf['elev_diff_m'], 'dist_to_hres_km': sf['dist_to_hres_km'],
            'lat': sf['lat'], 'lon': sf['lon'],
            'cos_doy': cos_doy[idx], 'sin_doy': sin_doy[idx],
            'fc_version': [fcv[i] for i in idx], 'key': sf['key'],
        })
        m = MODEL[var]
        q = np.sort(np.asarray(m.predict(feat[m.feature_names_])), axis=1)  # [n,3] bias quantiles
        for j, i in enumerate(idx):
            lo = v[j] + q[j, 0]
            mid = v[j] + q[j, 1]
            hi = v[j] + q[j, 2]
            if nn:
                lo, mid, hi = max(0.0, lo), max(0.0, mid), max(0.0, hi)
            out[dates[i]][fk] = {'lo': round(lo, 3), 'mid': round(mid, 3), 'hi': round(hi, 3)}
    return out


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        if self.path.split('?')[0] != '/ci':
            self.send_response(404); self._cors(); self.end_headers(); return
        try:
            n = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(n) or b'{}')
            bands = predict_bands(float(body['lat']), float(body['lon']), body.get('rows', []))
            payload = json.dumps({'bands': bands}).encode()
            self.send_response(200)
            self._cors()
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except Exception as e:  # never 500 the dev page silently
            msg = json.dumps({'error': f'{type(e).__name__}: {e}'}).encode()
            self.send_response(400)
            self._cors()
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(msg)

    def log_message(self, fmt, *args):  # quieter console
        return


if __name__ == '__main__':
    print(f'CI server on http://localhost:{PORT}  (POST /ci)')
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
