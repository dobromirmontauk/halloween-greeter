"""Pure tiling helpers (no OpenCV/numpy): SAHI-style crops of a band at the top of the frame, and merging of boxes from several passes.

Boxes are normalized [x1, y1, x2, y2] (0..1 of the image they refer to), dicts {"bbox": [...], "score": float}.
"""


def plan_tiles(width, height, band=0.40, tile=640, overlap=0.25):
    """Pixel tiles (x0, y0, x1, y1) covering the band y in [0, band*height) over the full width.

    Tiles are tile x tile (clamped to the image), step = tile*(1-overlap) horizontally, the last tile is flush with the right edge.
    The band is covered vertically by a single row anchored at the top edge (tile >= band height for 1440p: band = 576 px).
    """
    th = min(tile, height)
    if band * height > th:  # more than one row needed: stack rows with the same overlap
        ys = []
        y = 0
        step_y = max(1, int(th * (1 - overlap)))
        while True:
            ys.append(y)
            if y + th >= band * height:
                break
            y += step_y
    else:
        ys = [0]
    tw = min(tile, width)
    step = max(1, int(tw * (1 - overlap)))
    xs = []
    x = 0
    while True:
        if x + tw >= width:
            xs.append(max(0, width - tw))
            break
        xs.append(x)
        x += step
    return [(x0, y0, x0 + tw, min(height, y0 + th)) for y0 in ys for x0 in xs]


def tile_to_full(boxes, tile, width, height):
    """Map boxes normalized to a tile (x0, y0, x1, y1 in pixels) to boxes normalized to the full width x height image."""
    x0, y0, x1, y1 = tile
    tw, th = x1 - x0, y1 - y0
    out = []
    for b in boxes:
        bb = b["bbox"]
        out.append({"bbox": [round((x0 + bb[0] * tw) / width, 5), round((y0 + bb[1] * th) / height, 5),
                             round((x0 + bb[2] * tw) / width, 5), round((y0 + bb[3] * th) / height, 5)], "score": b["score"]})
    return out


def edge_clipped(box_tile, tile, width, height, eps=0.01):
    """True when a tile-normalized box touches a tile edge that is NOT the image edge (the person is cut by the crop, so the box is truncated)."""
    x0, y0, x1, y1 = tile
    bb = box_tile["bbox"]
    return ((bb[0] <= eps and x0 > 0) or (bb[2] >= 1 - eps and x1 < width) or (bb[1] <= eps and y0 > 0) or (bb[3] >= 1 - eps and y1 < height))


def _iou(a, b):
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    if w <= 0 or h <= 0:
        return 0.0
    inter = w * h
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def _ioa(a, b):
    """Intersection over the smaller box's area (catches a truncated tile box inside the full-frame box)."""
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    if w <= 0 or h <= 0:
        return 0.0
    small = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
    return (w * h) / small if small > 0 else 0.0


def merge_boxes(boxes, iou_thr=0.5, contain_thr=0.85):
    """Greedy NMS by descending score. A box is dropped when its IoU with a kept box >= iou_thr, or it is >= contain_thr inside a kept box. Returns a new list sorted by score."""
    kept = []
    for b in sorted(boxes, key=lambda d: -d["score"]):
        if any(_iou(b["bbox"], k["bbox"]) >= iou_thr or _ioa(b["bbox"], k["bbox"]) >= contain_thr for k in kept):
            continue
        kept.append(b)
    return kept
