#!/usr/bin/env bash
# Downloads YOLOX COCO detectors (Apache-2.0, Megvii-BaseDetection/YOLOX release 0.1.1rc0), verifies sha256 and
# installs into detector/models/ (gitignored, mode 0600). Default is tiny; nano/s are for experiments.
#   ./fetch-models.sh            # tiny only (20 MB)
#   ./fetch-models.sh all        # nano + tiny + s
set -euo pipefail
cd "$(dirname "$0")"
BASE=https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0
mkdir -p models
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
fetch() { # file sha
  if [ -f "models/$1" ] && [ "$(sha "models/$1")" = "$2" ]; then chmod 600 "models/$1"; echo "ok (cached) $1"; return; fi
  tmp="$(mktemp)"; curl -fsSL "$BASE/$1" -o "$tmp"
  if [ "$(sha "$tmp")" != "$2" ]; then rm -f "$tmp"; echo "sha256 mismatch for $1" >&2; exit 1; fi
  mv "$tmp" "models/$1"; chmod 600 "models/$1"; echo "ok $1"
}
fetch yolox_tiny.onnx 427cc366d34e27ff7a03e2899b5e3671425c262ea2291f88bb942bc1cc70b0f7
if [ "${1:-}" = "all" ]; then
  fetch yolox_nano.onnx c789161ed43c8269fcd4e67c67eeeb4e80c622da2eb296a20bc6007bd18a0b7d
  fetch yolox_s.onnx c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063
fi
