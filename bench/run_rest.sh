#!/bin/sh
# After the V0 baseline: V1 prebuffer sweep, then V2-V4 at P* (rule in analyze.py), then the analysis.
# Resume an interrupted V1 sweep with: V1_START=<run index> sh run_rest.sh
set -e
cd "$(dirname "$0")"
if [ "${V1_START:-0}" -gt 0 ]; then resume="--no-flash --start $V1_START"; fi
python -u run.py --env bench-v1 --prebuf 0 50 100 250 500 --reps 20 --seed 101 $resume
PSTAR=$(python -c "
import pandas as pd
d = pd.read_csv('data/bench.csv'); v = d[d.variant == 'V1']
print(min(p for p, g in v.groupby('prebuf_ms') if g.starves.sum() == 0))")  # amended rule, see analyze.py
echo "P* = $PSTAR"
for v in 2 3 4; do python -u run.py --env bench-v$v --prebuf "$PSTAR" --reps 20 --seed 10$v; done
python analyze.py
