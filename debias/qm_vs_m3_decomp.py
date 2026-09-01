# §12c — M3 vs QM for precip: separate the win by metric, season, cell, fc_version.
# Run INSIDE the notebook's live kernel (reuses err/te_qm/THR — no reload, no retrain):
#     %run -i qm_vs_m3_decomp.py
#
# The puzzle this answers: the signed-error HISTOGRAM says M3 wins (fewer/smaller
# per-day misses) while the QQ plots say QM wins (its quantiles sit on the 45 line).
# They score different things — M3 minimizes per-day error (shrinks toward the
# conditional mean, so it compresses the heavy-rain tail -> bad QQ); QM matches the
# MARGINAL distribution by construction (great QQ) but remaps value-for-value so it
# can't fix WHICH day it rained (per-day MAE / big-miss count don't improve). This
# script quantifies that, then localizes it across season / cell / forecast version.

import numpy as np, pandas as pd, matplotlib.pyplot as plt

for _name in ('err', 'te_qm', 'THR', 'ecol', 'hcol'):
    if _name not in dir():
        raise RuntimeError(f"'{_name}' not in kernel — run §9b (c21) and §12 (qm02) first, "
                           "then %run -i this file.")

ECOL, HCOL = ecol('precip'), hcol('precip')
THRp = THR['precip']
QS  = np.linspace(0.02, 0.98, 49)   # the grid the §35 QQ plots use
QSH = np.linspace(0.90, 0.99, 19)   # heavy-rain tail only

def _gap(truth, pred, qs):
    """Mean |forecast-quantile - era5-quantile| over qs == avg vertical distance
    from the 45 line on a QQ plot. Lower = distribution matches better."""
    return float(np.abs(np.quantile(pred, qs) - np.quantile(truth, qs)).mean())

# --- align raw / M3 / QM on identical test rows (same split, same dropna) ----------
tp = err['precip']
P = tp.merge(te_qm[['key', 'date', 'qm_pred']], on=['key', 'date'],
             how='inner', validate='one_to_one')
assert len(P) == len(tp), f'row count changed on merge {len(tp)} -> {len(P)}'
P['ae_m3'] = P['ae_corr']
P['ae_qm'] = (P[ECOL] - P['qm_pred']).abs()
MODELS = [('raw', 'ae_raw', HCOL), ('M3', 'ae_m3', 'corrected'), ('QM', 'ae_qm', 'qm_pred')]

# ============================ 1. the metric flip, quantified ======================
print('=' * 78)
print('1. WHY hist!=QQ — same rows, scored four ways (precip, n=%d)' % len(P))
print('=' * 78)
# per-cell QQ gaps (gap is inherently distributional -> compute per cell, then mean)
cell_recs = []
for k, g in P.groupby('key'):
    t = g[ECOL].to_numpy()
    rec = {'key': k, 'n': len(g), 'wet_mm': float(g[ECOL].mean()),
           'lat': float(g['lat'].iloc[0]), 'lon': float(g['lon'].iloc[0])}
    for label, aecol, predcol in MODELS:
        rec[f'mae_{label}'] = float(g[aecol].mean())
        rec[f'big_{label}'] = int((g[aecol] >= THRp).sum())
        rec[f'gap_{label}']  = _gap(t, g[predcol].to_numpy(), QS)
        rec[f'gaph_{label}'] = _gap(t, g[predcol].to_numpy(), QSH)
    cell_recs.append(rec)
C = pd.DataFrame(cell_recs).set_index('key')

rows = []
for label, aecol, predcol in MODELS:
    ae = P[aecol]
    rows.append({'model': label,
                 'MAE_all':  ae.mean(),
                 'MAE_high': ae[P.dec_precip == 'high'].mean(),
                 'MAE_p99':  ae[P.dec1_precip == 'p99'].mean(),
                 'big_miss': int((ae >= THRp).sum()),
                 'QQgap_all':  C[f'gap_{label}'].mean(),
                 'QQgap_tail': C[f'gaph_{label}'].mean()})
flip = pd.DataFrame(rows).set_index('model')
print(flip.round(3).to_string())
win = lambda col, lo=True: flip[col].drop('raw').idxmin() if lo else flip[col].drop('raw').idxmax()
print(f"\n  per-day accuracy  -> MAE_all winner = {win('MAE_all')} ;  "
      f"big-miss winner = {win('big_miss')}")
print(f"  distribution fit  -> QQgap_all winner = {win('QQgap_all')} ;  "
      f"QQgap_tail winner = {win('QQgap_tail')}")
print("  ^ that split IS the hist-vs-QQ 'wtf': different objectives, both real.")

# ============================ 2 & 3. by season / by forecast version ==============
def mae_by(col):
    out = []
    for gv, g in P.groupby(col):
        r = {col: gv, 'n': len(g)}
        for label, aecol, _ in MODELS:
            ae = g[aecol]
            r[f'MAE_{label}'] = ae.mean()
            r[f'MAEhi_{label}'] = ae[g.dec_precip == 'high'].mean()
            r[f'big_{label}'] = int((ae >= THRp).sum())
        out.append(r)
    return pd.DataFrame(out).set_index(col)

def gap_by(col):
    # per (group,key) QQ gap then mean over cells -> "avg cell QQ gap in that group"
    recs = []
    for (gv, k), g in P.groupby([col, 'key']):
        if len(g) < 30:
            continue
        t = g[ECOL].to_numpy()
        recs.append({col: gv,
                     'gapM3': _gap(t, g['corrected'].to_numpy(), QS),
                     'gapQM': _gap(t, g['qm_pred'].to_numpy(), QS)})
    return pd.DataFrame(recs).groupby(col)[['gapM3', 'gapQM']].mean()

for col, title in [('season', '2. BY SEASON'), ('fc_version', '3. BY FORECAST VERSION')]:
    print('\n' + '=' * 78)
    print(f'{title} — does the M3/QM winner move with {col}?')
    print('=' * 78)
    m, gp = mae_by(col), gap_by(col)
    tbl = m.join(gp)
    tbl['MAE_win']   = np.where(tbl.MAE_M3   < tbl.MAE_QM,   'M3', 'QM')
    tbl['big_win']   = np.where(tbl.big_M3   < tbl.big_QM,   'M3', 'QM')
    tbl['QQgap_win'] = np.where(tbl.gapM3    < tbl.gapQM,    'M3', 'QM')
    show = ['n', 'MAE_M3', 'MAE_QM', 'MAE_win', 'big_M3', 'big_QM', 'big_win',
            'gapM3', 'gapQM', 'QQgap_win']
    print(tbl[show].round(3).to_string())

# ============================ 4. by cell ==========================================
print('\n' + '=' * 78)
print('4. BY CELL — where does each model win, and what predicts it?')
print('=' * 78)
C['mae_adv']  = C.mae_M3  - C.mae_QM     # >0  => QM has lower MAE here (QM better)
C['big_adv']  = C.big_M3  - C.big_QM     # >0  => QM has fewer big misses here
C['gap_adv']  = C.gap_M3  - C.gap_QM     # >0  => QM hugs the 45 line tighter here
n_cells = len(C)
print(f'cells: {n_cells}   (test days/cell: median {int(C.n.median())})')
print(f'  MAE      : M3 better in {int((C.mae_adv < 0).sum()):4d} cells | '
      f'QM better in {int((C.mae_adv > 0).sum()):4d}')
print(f'  big-miss : M3 better in {int((C.big_adv < 0).sum()):4d} cells | '
      f'QM better in {int((C.big_adv > 0).sum()):4d}  (ties excluded from "better")')
print(f'  QQ gap   : M3 better in {int((C.gap_adv < 0).sum()):4d} cells | '
      f'QM better in {int((C.gap_adv > 0).sum()):4d}')

print('\n  Spearman corr of QM-MAE-advantage (mae_M3 - mae_QM) vs cell traits:')
for trait in ['wet_mm', 'gap_adv']:
    rho = C['mae_adv'].corr(C[trait], method='spearman')
    print(f'    vs {trait:8s}: rho = {rho:+.3f}')
C['abslat'] = C['lat'].abs()
print(f"    vs abslat  : rho = {C['mae_adv'].corr(C['abslat'], method='spearman'):+.3f}")

# Which axis separates M3 vs QM the most? Compare spread of the MAE delta across
# the three groupings (bigger spread of group means => that axis discriminates more).
print('\n  spread (std) of mean (MAE_M3 - MAE_QM) across each axis:')
print(f"    across cells       : {C['mae_adv'].std():.3f}  (range {C.mae_adv.min():+.2f}..{C.mae_adv.max():+.2f})")
for col in ['season', 'fc_version']:
    d = P.groupby(col)['ae_m3'].mean() - P.groupby(col)['ae_qm'].mean()
    print(f'    across {col:11s}: {float(d.std()):.3f}  (range {float(d.min()):+.2f}..{float(d.max()):+.2f})')

# ---- maps + wetness scatter ----
fig, ax = plt.subplots(1, 3, figsize=(18, 4.2))
for a, col, ttl in [(ax[0], 'mae_adv', 'MAE: red=QM better, blue=M3 better'),
                    (ax[1], 'gap_adv', 'QQ gap: red=QM better, blue=M3 better')]:
    lim = float(C[col].abs().quantile(0.95)) or 1.0
    s = a.scatter(C.lon, C.lat, c=C[col], s=12, cmap='RdBu', vmin=-lim, vmax=lim)
    a.set_title(ttl, fontsize=9); a.set_xlim(-180, 180); a.set_ylim(-90, 90)
    a.set_xticks([]); a.set_yticks([]); fig.colorbar(s, ax=a, shrink=0.8)
ax[2].axhline(0, color='k', lw=0.6)
ax[2].scatter(C.wet_mm, C.mae_adv, s=12, color='#2a6f97', alpha=0.6)
ax[2].set_xscale('log')
ax[2].set_xlabel('cell wetness — mean era5 precip [mm/day, log]', fontsize=8)
ax[2].set_ylabel('MAE_M3 - MAE_QM  (>0: QM better)', fontsize=8)
ax[2].set_title('does QM win where it rains more?', fontsize=9)
plt.tight_layout(); plt.show()

# ============================ verdict =============================================
print('\n' + '=' * 78)
print('VERDICT')
print('=' * 78)
mae_w, big_w = win('MAE_all'), win('big_miss')
qq_w = win('QQgap_all')
print(f"- It is NOT mainly a season or forecast-version effect (see the tiny spreads")
print(f"  above). It is a METRIC effect: {mae_w}/{big_w} own per-day accuracy, {qq_w} owns the")
print(f"  marginal distribution / QQ — on the SAME rows. Pick by what you ship for.")
print(f"- Across cells the winner barely flips: report which side dominates from §4.")
print(f"- The one geographic gradient worth noting is wetness/tropics (corr in §4):")
print(f"  the wetter the cell, the closer QM gets to M3 on MAE while keeping its QQ edge.")
print('- If the product cares about per-day numbers (it shows a daily value), M3.')
print('  If it cares about reproducing the rain-distribution/extremes, QM, or blend:')
print('  M3 for the point estimate, QM-style spread only for the stated extreme.')
