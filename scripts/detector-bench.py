"""Detector input-strategy benchmark. Reads native JPEGs, never writes images. Output: NDJSON (0600) + a summary table on stdout.

  detector/.venv/bin/python -I scripts/detector-bench.py --frames data/captures/2026-10-26 --max 200 --out /tmp/bench.ndjson \
      [--night <dir-or-jpeg> ...] [--truth truth.ndjson] [--zones data/detector-zones.json] [--threads 2] [--strategies a,b,c,d,e,f]

--frames / --night: directories (searched recursively for *.jpg, evenly subsampled), single JPEGs, or @listfile (one path per line).
--max is required: the cap on frames per group (day, night and truth are capped separately; hard ceiling 500).
--spread samples evenly within each clip directory (every clip contributes), --stride N takes every Nth path first. With --truth, the labelled native
frames (c:<clip>:<idx> keys, found under --data/captures, default <repo>/data) form their own group `truth`; recall/precision are computed there
(and on any other frame whose key is labelled). Keys that match no sampled frame are reported on stderr.

Strategies (all run on the same CPU OpenCV-DNN code path as the live sidecar, same NMS/score floor; min score here is 0.2):
  a  preview 960 -> 416            (today: the native frame is downscaled to 960 and JPEG-encoded untimed, decode is timed)
  b  native -> 640
  c  native -> 960
  d  native -> 416 full frame + native-resolution top-band tiles (640x640, 25% overlap, y 0..0.40), merged by NMS
  e  native -> 640 full frame + the same tiles
  f  yolox_s at 640 (needs detector/models/yolox_s.onnx: `detector/fetch-models.sh all`, Apache-2.0; weights stay out of git)
  g  b with --threads4 OpenCV threads (default 4)
  h  a + ONE band crop (native y 0..0.40, full width) letterboxed to --band-size (default 1280x320, non-square), merged by NMS
  i  hybrid: a on every frame; the band crop (as h) only on frames where a sees a non-ignored box in sidewalk/path/porch at >= --gate-score (0.2). ms/fps are the per-frame mean over the sample
  j  hybrid like i but with b (native->640) as the extra pass
  (d, e: tiles, ~1.8 s on the device: not in the default list)
Model: DETECTOR_MODEL or detector/models/yolox_tiny.onnx for a-e. The official tiny ONNX may be exported at a fixed 416 input: a strategy
that the model cannot run at is reported as `error` (not fatal). `--model640 <path>` supplies another model for the 640/960 sizes.

Truth (--truth): zone-eval NDJSON (sidewalk truth = elsewhere_location == "sidewalk" when present, else person_on_sidewalk) {"key","person_in_area":"yes|no|unsure","count_in_area":n}; optional "person_on_sidewalk":"yes|no".
Keys: captures/<date>/<clip>/frames/<idx>_<ms>.jpg -> "c:<clip>:<idx>", judge-log/<date>/<stem>.jpg -> "j:<date>/<stem>".
Recall/precision are frame-level: area = any non-ignored box with foot in path/porch at score >= 0.5; sidewalk = any with foot in sidewalk at score >= --sidewalk-score (0.35).
"""
import argparse
import importlib.util
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
DETECTOR_DIR = os.path.join(ROOT, "detector")
HARD_MAX = 500
BUCKETS = (("ge050", 0.5, 9), ("035_050", 0.35, 0.5), ("020_035", 0.2, 0.35))
ZONES = ("sidewalk", "path", "porch", "other", "ignored")
STRATS = {
    "a": "preview960->416",
    "b": "native->640",
    "c": "native->960",
    "d": "native->416 + band tiles",
    "e": "native->640 + band tiles",
    "f": "yolox_s native->640",
    "g": "native->640 threads4",
    "h": "a + band crop NMS",
    "i": "hybrid a (+band if active)",
    "j": "hybrid a (+b if active)",
}
DEFAULT_STRATS = "a,b,c,f,g,h,i,j"


def load_mod(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    sys.modules[name] = m
    spec.loader.exec_module(m)
    return m


def key_of(path):
    p = path.replace(os.sep, "/")
    m = re.search(r"captures/\d{4}-\d{2}-\d{2}/([A-Za-z0-9_-]+)/frames/(\d{6})_\d+\.jpg$", p)
    if m:
        return "c:%s:%d" % (m.group(1), int(m.group(2)))
    m = re.search(r"judge-log/(\d{4}-\d{2}-\d{2})/([A-Za-z0-9_.-]+)\.jpg$", p)
    return "j:%s/%s" % (m.group(1), m.group(2)) if m else None


def collect(specs, cap, spread=False, stride=1):
    paths = []
    for s in specs:
        if s.startswith("@"):
            with open(s[1:]) as f:
                paths += [l.strip() for l in f if l.strip()]
        elif os.path.isdir(s):
            for d, _, files in os.walk(s):
                paths += [os.path.join(d, n) for n in files if n.lower().endswith(".jpg") and not n.endswith("_prev.jpg")]
        elif os.path.isfile(s):
            paths.append(s)
    return sample(sorted(set(paths)), cap, spread, stride)


def even(items, k):
    if len(items) <= k:
        return list(items)
    step = len(items) / k
    return [items[int(i * step)] for i in range(k)]


def sample(paths, cap, spread=False, stride=1):
    if stride > 1:
        paths = paths[::stride]
    if spread:  # every clip directory contributes: even sample inside each, quota split across clips
        by = {}
        for p in paths:
            by.setdefault(os.path.dirname(p), []).append(p)
        quota = max(1, cap // max(1, len(by)))
        paths = sorted(q for v in by.values() for q in even(v, quota))
    return even(paths, cap)


def truth_paths(truth, data):
    """Native frames for the labelled c:<clip>:<idx> keys, found under <data>/captures/<date>/<clip>/frames/<idx>_<ms>.jpg."""
    want = {k for k, t in truth.items() if k.startswith("c:") and (t.get("person_in_area") in ("yes", "no") or t.get("person_on_sidewalk") in ("yes", "no"))}
    found = {}
    root = os.path.join(data, "captures")
    for d, _, files in os.walk(root):
        for n in files:
            k = key_of(os.path.join(d, n))
            if k in want:
                found[k] = os.path.join(d, n)
    return found, len(want)


class Runner:
    """One (model, size) pair; detectors are cached and shared between strategies."""

    def __init__(self, detect, cv2, np, tiling, min_score, nms):
        self.detect, self.cv2, self.np, self.tiling, self.min_score, self.nms = detect, cv2, np, tiling, min_score, nms
        self.cache = {}

    def det(self, model, size):
        k = (model, size)
        if k not in self.cache:
            try:
                self.cache[k] = self.detect.Detector(model, size, self.min_score, self.nms)
            except Exception as e:
                self.cache[k] = e
        d = self.cache[k]
        if isinstance(d, Exception):
            raise d
        return d

    def run(self, model, size, img):
        return self.det(model, size).detect(img)

    def tiles(self, model, img, band, tile):
        H, W = img.shape[:2]
        out = []
        for t in self.tiling.plan_tiles(W, H, band, tile):
            crop = img[t[1]:t[3], t[0]:t[2]]
            boxes = self.run(model, tile, crop)
            boxes = [b for b in boxes if not self.tiling.edge_clipped(b, t, W, H)]  # a person cut by a tile edge is found by the neighbouring tile or the full-frame pass
            out += self.tiling.tile_to_full(boxes, t, W, H)
        return out


def classify(ys, persons, zones):
    boxes, _ = ys.classify(persons, zones)
    return boxes


def bucket(score):
    for name, lo, hi in BUCKETS:
        if lo <= score < hi:
            return name
    return None


def pct(vals, q):
    if not vals:
        return None
    s = sorted(vals)
    return s[min(len(s) - 1, int(round(q * (len(s) - 1))))]


def prf(tp, fp, fn, tn=0):
    return {"tp": tp, "fp": fp, "fn": fn, "tn": tn, "precision": round(tp / (tp + fp), 3) if tp + fp else None, "recall": round(tp / (tp + fn), 3) if tp + fn else None}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", nargs="+", default=[], help="native JPEG dir(s)/files/@list (daytime)")
    ap.add_argument("--night", nargs="+", default=[], help="night frames (dir(s)/files/@list)")
    ap.add_argument("--max", type=int, required=True, help="cap on frames per group (<= %d)" % HARD_MAX)
    ap.add_argument("--out", required=True, help="NDJSON output path (0600)")
    ap.add_argument("--spread", action="store_true", help="sample evenly within every clip directory")
    ap.add_argument("--stride", type=int, default=1, help="take every Nth path before sampling")
    ap.add_argument("--truth")
    ap.add_argument("--data", help="data dir (for --truth frame lookup); default <repo>/data")
    ap.add_argument("--zones", help="default: data/detector-zones.json if present else detector/zones.default.json")
    ap.add_argument("--strategies", default=DEFAULT_STRATS)
    ap.add_argument("--threads", type=int, default=int(os.environ.get("DETECTOR_THREADS", "2") or 2), help="OpenCV threads (match the live sidecar's DETECTOR_THREADS, default 2)")
    ap.add_argument("--threads4", type=int, default=4, help="threads for strategy g")
    ap.add_argument("--model", help="default: DETECTOR_MODEL or detector/models/yolox_tiny.onnx")
    ap.add_argument("--model640", help="model for sizes 640/960 if the default cannot run them")
    ap.add_argument("--yolox-s", help="default detector/models/yolox_s.onnx")
    ap.add_argument("--band", type=float, default=0.40)
    ap.add_argument("--band-size", default="1280x320", help="non-square input for the band crop (h, i); multiples of 32")
    ap.add_argument("--tile", type=int, default=640)
    ap.add_argument("--gate-score", type=float, default=0.2, help="hybrids i/j: a box this strong in sidewalk/path/porch activates the extra pass")
    ap.add_argument("--min-score", type=float, default=0.2)
    ap.add_argument("--sidewalk-score", type=float, default=0.35)
    ap.add_argument("--warmup", type=int, default=3)
    a = ap.parse_args()
    if not 1 <= a.max <= HARD_MAX:
        ap.error("--max must be 1..%d" % HARD_MAX)
    if not (a.frames or a.night):
        ap.error("--frames and/or --night is required")
    if a.tile % 32 or a.tile < 160:
        ap.error("--tile must be a multiple of 32")
    m = re.match(r"^(\d+)x(\d+)$", a.band_size)
    if not m or int(m.group(1)) % 32 or int(m.group(2)) % 32:
        ap.error("--band-size must be WxH, multiples of 32")
    bandwh = (int(m.group(1)), int(m.group(2)))
    import cv2
    import numpy as np
    sys.path.insert(0, DETECTOR_DIR)
    sys.path.insert(0, os.path.join(HERE, "zone-eval"))
    import detect  # the live sidecar code (importing does not start it)
    import tiling
    import yolo_zones as ys
    if a.threads > 0:
        cv2.setNumThreads(a.threads)
    strategies = [s for s in a.strategies.split(",") if s in STRATS]

    def mpath(p):
        return p if os.path.isabs(p) else os.path.join(DETECTOR_DIR, p)

    tiny = mpath(a.model or os.environ.get("DETECTOR_MODEL") or os.path.join("models", "yolox_tiny.onnx"))
    big = mpath(a.model640) if a.model640 else tiny
    ysm = mpath(a.yolox_s or os.path.join("models", "yolox_s.onnx"))
    own = os.path.join(ROOT, "data", "detector-zones.json")
    zpath = a.zones or (own if os.path.isfile(own) else os.path.join(DETECTOR_DIR, "zones.default.json"))
    zones = ys.load_zones(zpath)
    truth = {}
    if a.truth:
        with open(a.truth) as f:
            for line in f:
                line = line.strip()
                if line:
                    t = json.loads(line)
                    truth[t["key"]] = t
    groups = []
    taken = set()
    if truth:
        found, want = truth_paths(truth, a.data or os.path.join(ROOT, "data"))
        tp = sample(sorted(found.values()), a.max, a.spread)
        taken = set(tp)
        print("truth: %d labelled native (c:) frames, %d found on disk, %d sampled into group `truth`" % (want, len(found), len(tp)), file=sys.stderr)
        if tp:
            groups.append(("truth", tp))
    day = [p for p in collect(a.frames, 10 ** 9, False, 1) if p not in taken]
    groups.append(("day", sample(day, a.max, a.spread, a.stride)))
    groups.append(("night", collect(a.night, a.max, a.spread, a.stride)))
    groups = [(g, p) for g, p in groups if p]
    if not groups:
        print("no frames found", file=sys.stderr)
        return 2
    R = Runner(detect, cv2, np, tiling, a.min_score, 0.45)

    def decode_native(nb):
        return cv2.imdecode(np.frombuffer(nb, np.uint8), cv2.IMREAD_COLOR)

    class Ctx:
        """One frame: components are measured once (ms, cpu) and shared by the strategies that use them."""

        def __init__(self, nb, pj):
            self.nb, self.pj, self.c = nb, pj, {}

        def comp(self, name):
            if name not in self.c:
                c0, w0 = time.process_time(), time.perf_counter()
                if name == "a":
                    p = R.run(tiny, 416, cv2.imdecode(np.frombuffer(self.pj, np.uint8), cv2.IMREAD_COLOR))
                elif name in ("b", "g"):
                    if name == "g":
                        cv2.setNumThreads(a.threads4)
                    try:
                        p = R.run(big, 640, decode_native(self.nb))
                    finally:
                        if name == "g":
                            cv2.setNumThreads(a.threads)
                elif name == "c":
                    p = R.run(big, 960, decode_native(self.nb))
                elif name == "f":
                    p = R.run(ysm, 640, decode_native(self.nb))
                elif name == "band":
                    img = decode_native(self.nb)
                    H, W = img.shape[:2]
                    bh = max(1, int(round(a.band * H)))
                    p = tiling.tile_to_full(R.run(big, bandwh, img[:bh]), (0, 0, W, bh), W, H)
                elif name == "d":
                    img = decode_native(self.nb)
                    p = tiling.merge_boxes(R.run(tiny, 416, img) + R.tiles(big, img, a.band, a.tile))
                elif name == "e":
                    img = decode_native(self.nb)
                    p = tiling.merge_boxes(R.run(big, 640, img) + R.tiles(big, img, a.band, a.tile))
                else:
                    raise ValueError(name)
                self.c[name] = (p, (time.perf_counter() - w0) * 1000, time.process_time() - c0)
            return self.c[name]

    def active(persons):
        return any(b["zone"] in ("sidewalk", "path", "porch") and b["score"] >= a.gate_score for b in classify(ys, persons, zones))

    def compute(s, ctx):
        """-> (persons, ms, cpu_s, extra_pass_ran or None)"""
        if s in "abcdefg":
            p, ms, cpu = ctx.comp(s)
            return p, ms, cpu, None
        pa, ma, ca = ctx.comp("a")
        extra = {"h": "band", "i": "band", "j": "b"}[s]
        if s in ("i", "j") and not active(pa):
            return pa, ma, ca, False
        pe, me, ce = ctx.comp(extra)
        return tiling.merge_boxes(pa + pe), ma + me, ca + ce, True

    # probe: which strategies can run at all
    ok = {}
    first = groups[0][1][0]
    with open(first, "rb") as f:
        nb = f.read()
    img0 = decode_native(nb)
    if img0 is None:
        print("cannot decode %s" % first, file=sys.stderr)
        return 2
    h0, w0 = img0.shape[:2]

    def prev_jpeg(im):
        h, w = im.shape[:2]
        return cv2.imencode(".jpg", cv2.resize(im, (960, int(round(960 * h / w))), interpolation=cv2.INTER_AREA), [cv2.IMWRITE_JPEG_QUALITY, 80])[1].tobytes()

    pj = prev_jpeg(img0)
    print("first frame %dx%d; model(a,d)=%s model(640/960/band)=%s yolox_s=%s threads=%d (g: %d) band=%dx%d zones=%s" % (w0, h0, os.path.basename(tiny), os.path.basename(big), os.path.basename(ysm), a.threads, a.threads4, bandwh[0], bandwh[1], zpath), file=sys.stderr)
    for s in strategies:
        try:
            for _ in range(a.warmup):
                compute(s, Ctx(nb, pj))
            ok[s] = None
        except Exception as e:
            ok[s] = str(e)[:160]
            print("strategy %s (%s) unavailable: %s" % (s, STRATS[s], ok[s]), file=sys.stderr)
    live = [s for s in strategies if ok[s] is None]

    fd = os.open(a.out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    out = os.fdopen(fd, "w")
    acc = {}

    def A(g, s):
        return acc.setdefault((g, s), {"ms": [], "cpu": [], "frames": 0, "extra": 0, "boxes": {z: {b[0]: 0 for b in BUCKETS} for z in ZONES},
                                       "area": [0, 0, 0, 0], "side": [0, 0, 0, 0], "errors": 0})

    total = sum(len(p) for _, p in groups)
    n = 0
    matched = set()
    for g, paths in groups:
        for path in paths:
            try:
                with open(path, "rb") as f:
                    nb = f.read()
                im = decode_native(nb)
                if im is None:
                    raise ValueError("bad jpeg")
                h, w = im.shape[:2]
                pj = prev_jpeg(im)
            except Exception as e:
                out.write(json.dumps({"path": os.path.basename(path), "error": str(e)[:100]}) + "\n")
                continue
            key = key_of(path)
            t = truth.get(key) if key else None
            ctx = Ctx(nb, pj)
            for s in live:
                try:
                    persons, ms, cpu, extra = compute(s, ctx)
                except Exception:
                    A(g, s)["errors"] += 1
                    continue
                st = A(g, s)
                st["ms"].append(ms)
                st["cpu"].append(cpu)
                st["frames"] += 1
                st["extra"] += 1 if extra else 0
                boxes = classify(ys, persons, zones)
                for b in boxes:
                    bk = bucket(b["score"])
                    if bk:
                        st["boxes"][b["zone"] if b["zone"] in ZONES else "other"][bk] += 1
                area = any(b["zone"] in ("path", "porch") and b["score"] >= 0.5 for b in boxes)
                side = any(b["zone"] == "sidewalk" and b["score"] >= a.sidewalk_score for b in boxes)
                if t:
                    el = t.get("elsewhere_location")  # zone-eval truth: where a person OUTSIDE the area is ("sidewalk", ...)
                    sv = t.get("person_on_sidewalk") if t.get("person_on_sidewalk") in ("yes", "no") else (("yes" if el == "sidewalk" else "no") if isinstance(el, str) and el else None)
                    for name, pred, v in (("area", area, t.get("person_in_area")), ("side", side, sv)):
                        if v in ("yes", "no"):
                            matched.add(key)
                            r = st[name]  # tp, fp, fn, tn
                            r[(0 if pred else 2) if v == "yes" else (1 if pred else 3)] += 1
                out.write(json.dumps({"group": g, "key": key, "path": os.path.basename(path), "strategy": s, "ms": round(ms, 1), "cpu_s": round(cpu, 4), "w": w, "h": h, "extra_pass": extra,
                                      "boxes": [{"bbox": b["bbox"], "score": b["score"], "zone": b["zone"]} for b in boxes if b["score"] >= a.min_score]}, separators=(",", ":")) + "\n")
            n += 1
            if n % 20 == 0:
                out.flush()
                print("%d/%d frames" % (n, total), file=sys.stderr)
    if truth:
        print("truth: %d of %d labelled keys were matched to a processed frame" % (len(matched), len(truth)), file=sys.stderr)

    summary = []
    for (g, s), st in sorted(acc.items()):
        fr = max(1, st["frames"])
        mean = sum(st["ms"]) / fr
        row = {"group": g, "strategy": s, "name": STRATS[s], "frames": st["frames"], "errors": st["errors"],
               "ms_mean": round(mean, 1), "ms_p95": round(pct(st["ms"], 0.95) or 0, 1),
               "cpu_pct": round(100 * sum(st["cpu"]) / (sum(st["ms"]) / 1000), 0) if st["ms"] else None,
               "max_fps": round(1000 / mean, 2) if st["ms"] else None,
               "extra_pass_frac": round(st["extra"] / fr, 3) if s in "ij" else None,
               "boxes_per_frame": {z: {b: round(c / fr, 3) for b, c in v.items()} for z, v in st["boxes"].items()}}
        if truth:
            row["truth_area"] = prf(*st["area"])
            row["truth_sidewalk"] = prf(*st["side"])
        summary.append(row)
        out.write(json.dumps({"summary": row}, separators=(",", ":")) + "\n")
    for s, e in ok.items():
        if e:
            out.write(json.dumps({"summary": {"strategy": s, "name": STRATS[s], "unavailable": e}}) + "\n")
    out.close()

    print("\nthreads=%d (g=%d) band=%dx%d zones=%s frames: %s" % (a.threads, a.threads4, bandwh[0], bandwh[1], zpath, ", ".join("%s=%d" % (g, len(p)) for g, p in groups)))
    print("%-6s %-3s %-27s %6s %8s %8s %6s %7s %6s | sidewalk>=.5 .35-.5 .2-.35 | path+porch>=.5 .35-.5 .2-.35 | other>=.5" % ("group", "st", "name", "frames", "ms_mean", "ms_p95", "cpu%", "maxfps", "extra"))
    for r in summary:
        b = r["boxes_per_frame"]
        pp = {k: round(b["path"][k] + b["porch"][k], 3) for k in b["path"]}
        print("%-6s %-3s %-27s %6d %8.1f %8.1f %6s %7s %6s | %.2f %.2f %.2f | %.2f %.2f %.2f | %.2f" % (
            r["group"], r["strategy"], r["name"], r["frames"], r["ms_mean"], r["ms_p95"], r["cpu_pct"], r["max_fps"], r["extra_pass_frac"] if r["extra_pass_frac"] is not None else "-",
            b["sidewalk"]["ge050"], b["sidewalk"]["035_050"], b["sidewalk"]["020_035"], pp["ge050"], pp["035_050"], pp["020_035"], b["other"]["ge050"]))
        if truth:
            print("        truth area(path+porch>=.5): %s   sidewalk(>=%.2f): %s" % (r["truth_area"], a.sidewalk_score, r["truth_sidewalk"]))
    for s, e in ok.items():
        if e:
            print("UNAVAILABLE %s (%s): %s" % (s, STRATS[s], e))
    print("NDJSON: %s" % a.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
