"""Person-detector sidecar (experiment). Line-delimited JSON on stdin/stdout. Never opens a camera, never touches the network.

Request:  {"id": 1, "cmd": "detect", "jpeg": "<base64>"}
Reply:    {"id": 1, "ok": true, "persons": [{"bbox": [x1, y1, x2, y2], "score": 0.83}], "ms": 41.2, "width": 1920, "height": 1080}
          bbox is normalized to 0..1 of the image. {"id": 1, "ok": false, "error": "..."} on failure.
Band:     {"id": 3, "cmd": "detect_band", "jpeg": "<base64 native jpeg>"}: crops the top DETECTOR_BAND (default 0.40) of the frame at full width, letterboxes it to
          DETECTOR_BAND_SIZE (default 1280x320, non-square) and replies like detect, with bbox normalized to the WHOLE frame (so zones apply unchanged).
Other:    {"id": 2, "cmd": "status"} and {"cmd": "shutdown"}.
On start the sidecar prints {"ready": true, ...} (or {"fatal": true, "error": "..."} and exits).

Model: YOLOX (Apache-2.0, Megvii) ONNX run with OpenCV DNN on CPU. See fetch-models.sh.
Env: DETECTOR_MODEL (path, default models/yolox_tiny.onnx), DETECTOR_SIZE (square input, default 416 for nano/tiny, else 640),
     DETECTOR_MIN_SCORE (default 0.25: boxes 0.25-0.5 feed only the tracker low-score bridge, never presence), DETECTOR_NMS (default 0.45), DETECTOR_THREADS (OpenCV threads, default 2; 0 = auto).
"""
import base64
import json
import os
import sys
import time

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
STRIDES = (8, 16, 32)
PERSON_CLASS = 0


def env_float(name, default):
    try:
        v = float(os.environ.get(name, ""))
        return v if v == v else default
    except ValueError:
        return default


def decode_jpeg(data):
    arr = np.frombuffer(data, dtype=np.uint8)
    if arr.size < 4:
        return None
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)


def wh_of(size):
    """size is an int (square) or a (width, height) pair for a rectangular input."""
    return (size, size) if isinstance(size, int) else (int(size[0]), int(size[1]))


def grids(size):
    """Centre offsets and strides for the three YOLOX heads, in the exporter's row order (row-major per stride)."""
    sw, sh = wh_of(size)
    xy, st = [], []
    for s in STRIDES:
        nx, ny = sw // s, sh // s
        gy, gx = np.meshgrid(np.arange(ny), np.arange(nx), indexing="ij")
        xy.append(np.stack((gx, gy), 2).reshape(-1, 2))
        st.append(np.full((nx * ny, 1), s))
    return np.concatenate(xy, 0).astype(np.float32), np.concatenate(st, 0).astype(np.float32)


def preprocess(img, size):
    """Letterbox to size x size (top-left, pad 114). Returns the blob and the scale ratio. YOLOX takes BGR 0..255, no mean/std."""
    sw, sh = wh_of(size)
    h, w = img.shape[:2]
    r = min(sh / h, sw / w)
    nh, nw = max(1, int(round(h * r))), max(1, int(round(w * r)))
    canvas = np.full((sh, sw, 3), 114, np.uint8)
    canvas[:nh, :nw] = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
    return cv2.dnn.blobFromImage(canvas, 1.0, (sw, sh), (0, 0, 0), swapRB=False), r


def postprocess(out, ratio, shape, size, min_score, nms_iou):
    """out: (N, 85) raw YOLOX head output. Returns [{'bbox': normalized xyxy, 'score': float}] for class person only."""
    h, w = shape
    xy, st = grids(size)
    if out.shape[0] != xy.shape[0]:
        raise ValueError("model output has %d rows, expected %d for input size %s" % (out.shape[0], xy.shape[0], size))
    score = out[:, 4] * out[:, 5 + PERSON_CLASS]
    keep = score >= min_score
    if not keep.any():
        return []
    o, s, xy, st = out[keep], score[keep], xy[keep], st[keep]
    c = (o[:, :2] + xy) * st
    wh = np.exp(np.clip(o[:, 2:4], -10, 10)) * st
    boxes = np.concatenate((c - wh / 2, c + wh / 2), 1) / ratio
    boxes[:, [0, 2]] = np.clip(boxes[:, [0, 2]], 0, w)
    boxes[:, [1, 3]] = np.clip(boxes[:, [1, 3]], 0, h)
    xywh = [[float(b[0]), float(b[1]), float(b[2] - b[0]), float(b[3] - b[1])] for b in boxes]
    idx = cv2.dnn.NMSBoxes(xywh, [float(v) for v in s], float(min_score), float(nms_iou))
    result = []
    for i in np.array(idx).flatten():
        b = boxes[i]
        if b[2] - b[0] < 2 or b[3] - b[1] < 2:
            continue
        result.append({"bbox": [round(float(b[0]) / w, 5), round(float(b[1]) / h, 5), round(float(b[2]) / w, 5), round(float(b[3]) / h, 5)], "score": round(float(s[i]), 4)})
    result.sort(key=lambda p: -p["score"])
    return result


class Detector:
    def __init__(self, model, size, min_score=0.25, nms_iou=0.45):
        self.model, self.size, self.min_score, self.nms_iou = model, size, min_score, nms_iou
        if not os.path.isfile(model):
            raise FileNotFoundError("model not found: %s (run detector/fetch-models.sh)" % model)
        self.net = cv2.dnn.readNetFromONNX(model)
        self.net.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV)
        self.net.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU)
        self.last_ms = None

    def detect(self, img):
        t = time.perf_counter()
        blob, ratio = preprocess(img, self.size)
        self.net.setInput(blob)
        out = self.net.forward()
        out = np.asarray(out).reshape(-1, out.shape[-1])
        persons = postprocess(out, ratio, img.shape[:2], self.size, self.min_score, self.nms_iou)
        self.last_ms = round((time.perf_counter() - t) * 1000, 1)
        return persons


def make_detector():
    model = os.environ.get("DETECTOR_MODEL") or os.path.join(HERE, "models", "yolox_tiny.onnx")
    if not os.path.isabs(model):
        model = os.path.join(HERE, model)
    default_size = 416 if any(k in os.path.basename(model) for k in ("nano", "tiny")) else 640
    size = int(env_float("DETECTOR_SIZE", default_size))
    if size % 32 or not 160 <= size <= 1280:
        raise ValueError("DETECTOR_SIZE must be a multiple of 32 between 160 and 1280")
    threads = int(env_float("DETECTOR_THREADS", 2))
    if threads > 0:
        cv2.setNumThreads(threads)
    return Detector(model, size, env_float("DETECTOR_MIN_SCORE", 0.25), env_float("DETECTOR_NMS", 0.45))


def band_detector(det):
    """Lazily built second Detector for the band crop (same model, rectangular input)."""
    if getattr(det, "band_det", None) is None:
        m = (os.environ.get("DETECTOR_BAND_SIZE") or "1280x320").lower().split("x")
        bw, bh = int(m[0]), int(m[1])
        if bw % 32 or bh % 32 or not 160 <= bw <= 2560 or not 96 <= bh <= 1280:
            raise ValueError("DETECTOR_BAND_SIZE must be WxH in multiples of 32")
        det.band_det = Detector(det.model, (bw, bh), det.min_score, det.nms_iou)
        det.band_frac = min(1.0, max(0.1, env_float("DETECTOR_BAND", 0.40)))
    return det.band_det


def detect_band(det, img):
    bd = band_detector(det)
    H, W = img.shape[:2]
    rows = max(1, int(round(H * det.band_frac)))
    persons = bd.detect(img[:rows])
    for p in persons:  # crop-normalized -> whole-frame normalized (x unchanged, y scaled by the band height)
        b = p["bbox"]
        p["bbox"] = [b[0], round(b[1] * rows / H, 5), b[2], round(b[3] * rows / H, 5)]
    det.last_ms = bd.last_ms
    return persons


def handle(det, req):
    cmd = req.get("cmd")
    if cmd == "detect_band":
        img = decode_jpeg(base64.b64decode(req.get("jpeg") or ""))
        if img is None:
            raise ValueError("bad jpeg")
        persons = detect_band(det, img)
        return {"persons": persons, "ms": det.last_ms, "width": int(img.shape[1]), "height": int(img.shape[0])}
    if cmd == "detect":
        img = decode_jpeg(base64.b64decode(req.get("jpeg") or ""))
        if img is None:
            raise ValueError("bad jpeg")
        persons = det.detect(img)
        return {"persons": persons, "ms": det.last_ms, "width": int(img.shape[1]), "height": int(img.shape[0])}
    if cmd == "status":
        return {"model": os.path.basename(det.model), "size": det.size, "min_score": det.min_score, "last_ms": det.last_ms}
    raise ValueError("unknown cmd")


def emit(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main():
    try:
        det = make_detector()
    except Exception as e:  # missing model, bad env: tell the server once and stop
        emit({"fatal": True, "error": str(e)[:200]})
        return 1
    emit({"ready": True, "model": os.path.basename(det.model), "size": det.size, "min_score": det.min_score})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        if req.get("cmd") == "shutdown":
            break
        try:
            emit({"id": req.get("id"), "ok": True, **handle(det, req)})
        except Exception as e:
            emit({"id": req.get("id"), "ok": False, "error": str(e)[:160]})
    return 0


if __name__ == "__main__":
    sys.exit(main())
