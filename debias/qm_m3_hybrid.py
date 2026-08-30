# §12d — best of both? Switch/blend to QM only where the FORECAST is high.
# Deployable: the gate keys on hres (known at predict time), NEVER on era5 truth.
# Both predictions already exist per row (corrected=M3, qm_pred=QM) -> no retrain;
# a hybrid is just np.where / a convex blend, re-scored with the §1 metrics.
# Run after qm6c (defines P, _gap, QS, ECOL, THRp).  %run -i works too.

assert 'P' in dir(), 'run §12c setup cell (qm6c) first — needs P, _gap, QS, ECOL, THRp'

H     = P['hres_precip_mm'].to_numpy()   # the forecast — the only thing we may gate on
truth = P[ECOL].to_numpy()
m3    = P['corrected'].to_numpy()
qm    = P['qm_pred'].to_numpy()
_cell_idx = {k: v for k, v in P.groupby('key').groups.items()}   # built once

def _qqgap(pred):
    """mean per-cell QQ gap, same definition as §1 QQgap_all."""
    s = pd.Series(pred, index=P.index)
    return float(np.mean([_gap(P.loc[ix, ECOL].to_numpy(), s.loc[ix].to_numpy(), QS)
                          for ix in _cell_idx.values()]))

def _score(pred):
    ae = np.abs(truth - pred)
    return ae.mean(), int((ae >= THRp).sum()), _qqgap(pred)

# ---- the crux: on HIGH-forecast days only, is QM actually better than M3? --------
# If QM isn't better than M3 here on MAE/big-miss, the switch only buys QQ, not accuracy.
print('=' * 78)
print('A. on HIGH-forecast days only (hres >= cut): is QM really better than M3?')
print('=' * 78)
for cut in [10, 20, 30, 50]:
    sel = H >= cut
    if sel.sum() < 50:
        continue
    out = {lab: (np.abs(truth[sel] - pr[sel]).mean(), int((np.abs(truth[sel] - pr[sel]) >= THRp).sum()))
           for lab, pr in [('raw', H), ('M3', m3), ('QM', qm)]}
    print(f'  hres>={cut:>3}mm (n={int(sel.sum()):5d}):  '
          f"MAE  raw={out['raw'][0]:5.1f} M3={out['M3'][0]:5.1f} QM={out['QM'][0]:5.1f}   |   "
          f"big-miss  raw={out['raw'][1]:3d} M3={out['M3'][1]:3d} QM={out['QM'][1]:3d}")

# ---- hard switch: pred = QM if hres >= cut else M3 -------------------------------
print('\n' + '=' * 78)
print('B. hard switch  pred = QM if hres>=cut else M3   (cut=0 -> pure QM, inf -> pure M3)')
print('=' * 78)
cuts = [0, 2, 5, 10, 15, 20, 30, 50, np.inf]
rows = []
for c in cuts:
    mae, big, gap = _score(np.where(H >= c, qm, m3))
    rows.append({'switch_at_mm': c, '%rows_QM': round(100 * float((H >= c).mean()), 1),
                 'MAE_all': mae, 'big_miss': big, 'QQgap_all': gap})
sweep = pd.DataFrame(rows)
print(sweep.round(3).to_string(index=False))

# ---- smooth blend: w ramps 0->1 over [lo,hi], pred = (1-w)*M3 + w*QM -------------
print('\n' + '=' * 78)
print('C. convex blend  pred = (1-w)*M3 + w*QM,  w = ramp(hres; lo..hi)')
print('=' * 78)
rows = []
for lo, hi in [(5, 30), (10, 40), (10, 60), (20, 80)]:
    w = np.clip((H - lo) / (hi - lo), 0, 1)
    mae, big, gap = _score((1 - w) * m3 + w * qm)
    rows.append({'ramp_lo': lo, 'ramp_hi': hi, 'MAE_all': mae, 'big_miss': big, 'QQgap_all': gap})
blend = pd.DataFrame(rows)
print(blend.round(3).to_string(index=False))
mae_m3, big_m3, gap_m3 = _score(m3)
mae_qm, big_qm, gap_qm = _score(qm)
print(f'\n  reference  M3: MAE={mae_m3:.3f} big={big_m3} gap={gap_m3:.3f}   |   '
      f'QM: MAE={mae_qm:.3f} big={big_qm} gap={gap_qm:.3f}')

# ---- plot the hard-switch sweep vs pure-M3 / pure-QM lines -----------------------
sw = sweep[np.isfinite(sweep.switch_at_mm)]
fig, ax = plt.subplots(1, 3, figsize=(16, 4))
for a, col, ttl in [(ax[0], 'MAE_all', 'MAE (lower=better)'),
                    (ax[1], 'big_miss', 'big-miss count (lower=better)'),
                    (ax[2], 'QQgap_all', 'QQ gap (lower=better)')]:
    a.plot(sw.switch_at_mm, sw[col], '-o', color='#444', label='hard switch')
    ref = {'MAE_all': (mae_m3, mae_qm), 'big_miss': (big_m3, big_qm), 'QQgap_all': (gap_m3, gap_qm)}[col]
    a.axhline(ref[0], color='#bc4b51', ls='--', lw=1, label='pure M3')
    a.axhline(ref[1], color='#2a6f97', ls='--', lw=1, label='pure QM')
    a.set_title(ttl, fontsize=10); a.set_xlabel('switch threshold (hres mm)', fontsize=8)
ax[0].legend(fontsize=8)
plt.suptitle('hybrid: switch to QM above a forecast threshold — does any cut beat both?', fontsize=11)
plt.tight_layout(); plt.show()

print('\nREAD IT:  a switch/blend "works" only if a row in B or C lands BELOW the pure-M3')
print('line on the metric you ship for. Expect MAE/big-miss to favor M3 (so the switch')
print('costs accuracy) while QQgap improves — i.e. it buys distribution, not accuracy.')
print('Tune the cutoff on TRAIN/val, never on this test sweep (that would overfit it).')
