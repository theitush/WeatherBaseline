#!/usr/bin/env bash
# Live progress console for the 2026 archive top-up.
#   ./topup_progress.sh          # refreshes every 10s until the run ends
#   ./topup_progress.sh 1        # print one snapshot and exit
set -u
cd "$(dirname "$0")"
LOG=topup_2026_resume.log
PID=$(cat topup_2026.pid 2>/dev/null || echo 0)
TOT_TILES=331; TOT_CELLS=7897
ONESHOT="${1:-}"

bar() { # $1=frac $2=width
  local w=$2
  local f=$(printf '%.0f' "$(echo "$1 * $w" | bc -l)")
  printf '['; for ((i=0;i<w;i++)); do ((i<f)) && printf '#' || printf '.'; done; printf ']'
}

while true; do
  n=$(grep -c 'wrote [0-9]* archives' "$LOG" 2>/dev/null); n=${n:-0}
  c=$(grep -oE 'wrote [0-9]+ archives' "$LOG" 2>/dev/null | awk '{s+=$2} END {print s+0}')
  t=$(grep -oE '\+ *[0-9.]+s' "$LOG" 2>/dev/null | tail -1 | tr -dc '0-9.')
  t=${t:-1}
  alerts=$(grep -c '!! ' "$LOG" 2>/dev/null); alerts=${alerts:-0}
  alive=$(kill -0 "$PID" 2>/dev/null && echo RUNNING || echo "STOPPED")
  rss=$(ps -o rss= -p "$PID" 2>/dev/null | awk '{printf "%.1fGB", $1/1048576}')
  rate=$(echo "scale=3; $c / $t" | bc -l)
  eta=$(echo "scale=0; ($TOT_CELLS - $c) / ($rate + 0.0001)" | bc -l)
  last=$(tail -1 "$LOG" 2>/dev/null | cut -c1-96)

  [ -z "$ONESHOT" ] && printf '\033[H\033[2J'
  echo "  2026 archive top-up — $alive (pid $PID, ${rss:-–})   alerts: $alerts"
  echo
  printf '  cells  %s %5d/%d  (%d%%)\n' "$(bar "$(echo "$c/$TOT_CELLS" | bc -l)" 40)" "$c" "$TOT_CELLS" "$((c*100/TOT_CELLS))"
  printf '  tiles  %s %5d/%d  (%d%%)\n' "$(bar "$(echo "$n/$TOT_TILES" | bc -l)" 40)" "$n" "$TOT_TILES" "$((n*100/TOT_TILES))"
  echo
  printf '  elapsed %dm   rate %.2f cells/s   ETA ~%dm (%s)\n' \
    "$(echo "$t/60" | bc)" "$rate" "$(echo "$eta/60" | bc)" \
    "$(date -d "+$(echo "$eta/60" | bc) minutes" '+%H:%M' 2>/dev/null)"
  echo
  echo "  $last"
  [ -n "$ONESHOT" ] && break
  [ "$alive" = "STOPPED" ] && { echo; echo "  run has stopped — re-audit R2 before assuming success"; break; }
  sleep 10
done
