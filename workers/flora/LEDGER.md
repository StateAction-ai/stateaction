# SA-93 Modal ledger

Estimates: container seconds (plus a 15 s start allowance) x list price. Not Modal billing data.
Prices/h: RTX PRO 6000 3.03, L40S 1.95; CPU 0.0472 per core-hour; memory 0.0080 per GiB-hour.

| step                           | seconds | $     | running |
| ------------------------------ | ------- | ----- | ------- |
| download tempseg               | 75      | 0.011 | 0.011   |
| merge tempseg                  | 115     | 0.037 | 0.047   |
| download captioner             | 436     | 0.061 | 0.108   |
| gpu tempseg fresh fresh        | 277     | 0.301 | 0.410   |
| export portable tempseg        | 147     | 0.116 | 0.526   |
| gpu tempseg portable portable  | 257     | 0.280 | 0.806   |
| prep captioner inputs          | 1055    | 0.186 | 0.991   |
| gpu captioner fresh fresh      | 327     | 0.356 | 1.347   |
| export portable captioner      | 137     | 0.108 | 1.455   |
| gpu captioner portable restore | 278     | 0.303 | 1.758   |
| finalize captioner             | 99      | 0.009 | 1.767   |
| finalize tempseg               | 46      | 0.004 | 1.771   |
| verify captioner               | 176     | 0.015 | 1.786   |
| verify tempseg                 | 34      | 0.003 | 1.789   |

Total about $1.79 of the $4.00 cap, excluding checkpoint storage (about 42 GB on `stateaction-models`, about $3.6 per month at list price, possibly inside the free tier). All apps stopped.
The first two download rows and the merge row were logged by hand or by an earlier local run of the same entrypoints; the rest are written by `modal_flora.py`.
