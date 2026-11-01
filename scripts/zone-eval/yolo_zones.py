"""Offline YOLOX zone-membership scan. Reads frames, never writes images; writes one NDJSON line per frame (0600).

  detector/.venv/bin/python -I scripts/zone-eval/yolo_zones.py --data data --out /tmp/yolo-zones.ndjson [--max-frames 3000] [--captures-every 5]
  python3 -I scripts/zone-eval/yolo_zones.py --self-test      (geometry only, no OpenCV needed)

Review keys match the review API: judge-log/<date>/<stem>.jpg -> "j:<date>/<stem>", captures/<date>/<clip>/frames/<idx>_<ms>.jpg -> "c:<clip>:<idx>".
Zone rule matches person-detector.mjs: foot point = bottom-centre; first matching of porch, path, sidewalk. Ignore: foot or centre inside an
ignore polygon (or the live IoU rule vs the polygon's bounding box) -> flagged ignored, never counted.
"""
import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DETECTOR_DIR = os.path.normpath(os.path.join(HERE, "..", "..", "detector"))
LOCATION_KINDS = ("porch", "path", "sidewalk")  # priority order, same as person-detector.mjs
AREA_KINDS = ("path", "porch")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
JUDGE_RE = re.compile(r"^([A-Za-z0-9_.-]+)\.jpg$")
FRAME_RE = re.compile(r"^(\d{6})_(\d+)\.jpg$")
CLIP_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def point_in_polygon(pt, pts):
    x, y = pt
    inside = False
    j = len(pts) - 1
    for i in range(len(pts)):
        xi, yi = pts[i]
        xj, yj = pts[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def foot_of(b):
    return ((b[0] + b[2]) / 2, b[3])


def center_of(b):
    return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)


def poly_bbox(pts):
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return [min(xs), min(ys), max(xs), max(ys)]


def iou(a, b):
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    if w <= 0 or h <= 0:
        return 0.0
    inter = w * h
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def locate(bbox, zones):
    foot = foot_of(bbox)
    for kind in LOCATION_KINDS:
        for z in zones:
            if z["kind"] == kind and point_in_polygon(foot, z["points"]):
                return kind, z.get("name")
    return "other", None


def ignored_by(bbox, zones):
    foot, ctr = foot_of(bbox), center_of(bbox)
    for z in zones:
        if z["kind"] != "ignore":
            continue
        if point_in_polygon(foot, z["points"]) or point_in_polygon(ctr, z["points"]):
            return z.get("name")
        if iou(bbox, poly_bbox(z["points"])) >= z.get("min_iou", 0.5):
            return z.get("name")
    return None


def classify(persons, zones):
    """persons: [{bbox,score}] -> annotated boxes + summary counts (all scores kept; sweep cutoffs later)."""
    boxes = []
    for p in persons:
        ign = ignored_by(p["bbox"], zones)
        zone, zname = locate(p["bbox"], zones)
        boxes.append({"bbox": p["bbox"], "score": p["score"], "zone": "ignored" if ign else zone, "zone_name": ign if ign else zname, "ignored": bool(ign)})
    live = [b for b in boxes if not b["ignored"]]
    return boxes, {
        "yolo_in_area": sum(1 for b in live if b["zone"] in AREA_KINDS),
        "yolo_on_sidewalk": sum(1 for b in live if b["zone"] == "sidewalk"),
        "yolo_total": len(live),
    }


def load_zones(path):
    with open(path) as f:
        d = json.load(f)
    return d["zones"] if isinstance(d, dict) else d


def listdir(p):
    try:
        return sorted(os.listdir(p))
    except OSError:
        return []


def iter_frames(data, captures_every):
    """Yield (key, source, path, captured_at_ms_or_None). Judge frames first (skipping *_prev.jpg), then every Kth capture frame."""
    jl = os.path.join(data, "judge-log")
    for day in listdir(jl):
        if not DATE_RE.match(day):
            continue
        for name in listdir(os.path.join(jl, day)):
            m = JUDGE_RE.match(name)
            if not m or m.group(1).endswith("_prev"):
                continue
            yield "j:%s/%s" % (day, m.group(1)), "judge", os.path.join(jl, day, name), None
    cd = os.path.join(data, "captures")
    k = max(1, captures_every)
    for day in listdir(cd):
        if not DATE_RE.match(day):
            continue
        for clip in listdir(os.path.join(cd, day)):
            if not CLIP_RE.match(clip):
                continue
            fdir = os.path.join(cd, day, clip, "frames")
            n = 0
            for name in listdir(fdir):
                m = FRAME_RE.match(name)
                if not m:
                    continue
                n += 1
                if (n - 1) % k:
                    continue
                yield "c:%s:%d" % (clip, int(m.group(1))), "capture", os.path.join(fdir, name), int(m.group(2))


def self_test():
    zones = [
        {"name": "side", "kind": "sidewalk", "points": [[0, 0], [1, 0], [1, 0.2], [0, 0.2]]},
        {"name": "path", "kind": "path", "points": [[0.4, 0.2], [0.6, 0.2], [0.6, 0.8], [0.4, 0.8]]},
        {"name": "porch", "kind": "porch", "points": [[0.4, 0.8], [0.6, 0.8], [0.6, 1], [0.4, 1]]},
        {"name": "skel", "kind": "ignore", "points": [[0.0, 0.5], [0.3, 0.5], [0.3, 0.9], [0.0, 0.9]]},
    ]
    assert point_in_polygon((0.5, 0.5), zones[1]["points"]) and not point_in_polygon((0.7, 0.5), zones[1]["points"])
    assert foot_of([0.4, 0.1, 0.6, 0.5]) == (0.5, 0.5)
    assert locate([0.45, 0.3, 0.55, 0.5], zones) == ("path", "path")
    assert locate([0.45, 0.5, 0.55, 0.9], zones)[0] == "porch"
    assert locate([0.1, 0.0, 0.2, 0.1], zones)[0] == "sidewalk"
    assert locate([0.8, 0.5, 0.9, 0.6], zones)[0] == "other"
    assert ignored_by([0.05, 0.5, 0.25, 0.85], zones) == "skel"
    # foot outside the ignore polygon but centre inside it -> ignored
    assert ignored_by([0.1, 0.3, 0.2, 1.0], zones) == "skel"
    assert ignored_by([0.45, 0.3, 0.55, 0.5], zones) is None
    boxes, s = classify([{"bbox": [0.45, 0.3, 0.55, 0.5], "score": 0.9}, {"bbox": [0.05, 0.5, 0.25, 0.85], "score": 0.8}, {"bbox": [0.1, 0.0, 0.2, 0.1], "score": 0.6}], zones)
    assert s == {"yolo_in_area": 1, "yolo_on_sidewalk": 1, "yolo_total": 2}, s
    assert boxes[1]["ignored"] and boxes[1]["zone"] == "ignored"
    import tempfile
    d = tempfile.mkdtemp()
    for rel in ("judge-log/2026-10-26/a.jpg", "judge-log/2026-10-26/a_prev.jpg", "judge-log/2026-10-26/a.json", "captures/2026-10-26/clip1/frames/000001_1000.jpg", "captures/2026-10-26/clip1/frames/000002_2000.jpg", "captures/2026-10-26/clip1/frames/000003_3000.jpg"):
        os.makedirs(os.path.dirname(os.path.join(d, rel)), exist_ok=True)
        open(os.path.join(d, rel), "wb").close()
    got = [(k, s) for k, s, _, _ in iter_frames(d, 2)]
    assert got == [("j:2026-10-26/a", "judge"), ("c:clip1:1", "capture"), ("c:clip1:3", "capture")], got
    print("self-test ok")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data")
    ap.add_argument("--out")
    ap.add_argument("--zones", help="default: <data>/detector-zones.json, else detector/zones.default.json")
    ap.add_argument("--max-frames", type=int, default=3000)
    ap.add_argument("--captures-every", type=int, default=5)
    ap.add_argument("--min-score", type=float, help="default: DETECTOR_MIN_SCORE or 0.4 (same as the live sidecar)")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        self_test()
        return 0
    if not a.data or not a.out:
        ap.error("--data and --out are required")
    if a.max_frames < 1:
        ap.error("--max-frames must be >= 1")
    own = os.path.join(a.data, "detector-zones.json")
    zpath = a.zones or (own if os.path.isfile(own) else os.path.join(DETECTOR_DIR, "zones.default.json"))
    zones = load_zones(zpath)
    sys.path.insert(0, DETECTOR_DIR)
    import detect  # the live sidecar's code; importing does not start it
    if a.min_score is not None:
        os.environ["DETECTOR_MIN_SCORE"] = str(a.min_score)
    det = detect.make_detector()
    print("model=%s size=%d min_score=%s zones=%s" % (os.path.basename(det.model), det.size, det.min_score, zpath), file=sys.stderr)
    fd = os.open(a.out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    n = 0
    with os.fdopen(fd, "w") as out:
        for key, source, path, at in iter_frames(a.data, a.captures_every):
            if n >= a.max_frames:
                print("reached --max-frames %d; stopping" % a.max_frames, file=sys.stderr)
                break
            try:
                with open(path, "rb") as f:
                    img = detect.decode_jpeg(f.read())
                if img is None:
                    raise ValueError("bad jpeg")
                persons = det.detect(img)
            except Exception as e:
                out.write(json.dumps({"key": key, "source": source, "error": str(e)[:120]}) + "\n")
                n += 1
                continue
            boxes, summary = classify(persons, zones)
            if at is None:
                try:
                    at = int(os.path.getmtime(path) * 1000)
                    with open(path[:-4] + ".json") as jf:
                        at = json.load(jf).get("captured_at", at)
                except Exception:
                    pass
            rec = {"key": key, "source": source, "captured_at": at, "width": int(img.shape[1]), "height": int(img.shape[0]), "min_score": det.min_score, "boxes": boxes, **summary}
            out.write(json.dumps(rec, separators=(",", ":")) + "\n")
            n += 1
            if n % 200 == 0:
                out.flush()
                print("%d frames" % n, file=sys.stderr)
    print("done: %d frames -> %s" % (n, a.out), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
