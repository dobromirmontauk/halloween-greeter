# zone-eval

Which is more reliable at "a real person is inside the area of interest" (path + porch; sidewalk is not in it; ignore zones never count): the YOLOX detector or the gpt Judge?

Private data stays on the box: the scripts read frames but never write images; only NDJSON of boxes/keys is produced (0600).

## 1. On the device (from `~/halloween-greeter`)

```
detector/.venv/bin/python -I scripts/zone-eval/yolo_zones.py --self-test
detector/.venv/bin/python -I scripts/zone-eval/yolo_zones.py --data data --out /tmp/yolo-zones.ndjson --max-frames 3000 --captures-every 5
```

Uses the live detector code and `DETECTOR_*` env (min score 0.4 by default; all boxes and scores are kept so cutoffs can be swept later), and `data/detector-zones.json` if present, else `detector/zones.default.json` (`--zones` overrides).

## 2. Pick frames to label (no truth needed)

```
node scripts/zone-eval/compare.mjs --yolo /tmp/yolo-zones.ndjson --data data --candidates --max 400 > /tmp/candidates.ndjson
```

Every in-area/sidewalk frame, every YOLO-vs-Judge disagreement, plus a seeded sample (`--seed`) of up to 150 both-empty frames. Fetch an image to label via `/api/review/read-image?key=<key>`.

## 3. Compare against truth

Truth NDJSON, one line per frame: `{"key":"j:2026-10-26/abc","person_in_area":"yes|no|unsure","count_in_area":1,"notes":""}` (unsure is skipped).

```
node scripts/zone-eval/compare.mjs --yolo /tmp/yolo-zones.ndjson --data data --truth truth.ndjson [--yolo-cutoff 0.4] [--json]
```

Prints TP/FP/FN/TN, precision, recall, accuracy and disagreement keys for: yolo, judge (`real_people_count>=1` and `closest_person_location` in path/porch), judge_persons (any `person_N_location` in path/porch), yolo AND judge, yolo OR judge, tiebreak (confident Judge else YOLO); plus YOLO score-cutoff and Judge confidence-cutoff sweeps. An uncertain Judge answer is an abstention (excluded from n, shown as `abstain`); combined rules fall back to YOLO then.

Tests: `npm test` (`test/zone-eval.test.mjs`); Python geometry: `python3 -I scripts/zone-eval/yolo_zones.py --self-test`.
