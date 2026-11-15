#!/usr/bin/env python3
"""Export a pinned Ultralytics YOLO checkpoint to ONNX and write a manifest.

The TypeScript detector refuses to load a model whose SHA-256 does not match the
manifest, and it resolves the target class ("elephant") by label from the
manifest rather than by a hard-coded index.

Usage (in a Python venv):
    pip install ultralytics onnx onnxslim
    python scripts/export_model.py --weights yolo11n.pt --out models

LICENSE NOTE: Ultralytics YOLO weights and code are AGPL-3.0 (or an Ultralytics
Enterprise licence). Review that before sharing or deploying the model or a
service that uses it.
"""
import argparse
import hashlib
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--weights", default="yolo11n.pt")
    p.add_argument("--out", default="models")
    p.add_argument("--imgsz", type=int, default=640)
    p.add_argument("--opset", type=int, default=17)
    args = p.parse_args()

    import ultralytics
    from ultralytics import YOLO

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    model = YOLO(args.weights)
    names = {int(k): v for k, v in model.names.items()}
    if "elephant" not in names.values():
        raise SystemExit("Checkpoint has no 'elephant' class label; refusing to export.")

    exported = Path(model.export(format="onnx", imgsz=args.imgsz, opset=args.opset, simplify=True))
    stem = Path(args.weights).stem
    dest = out / f"{stem}.onnx"
    if exported.resolve() != dest.resolve():
        shutil.copyfile(exported, dest)

    weights_path = Path(args.weights)
    manifest = {
        "name": stem,
        "file": dest.name,
        "sha256": sha256(dest),
        "inputSize": args.imgsz,
        "outputLayout": "yolo-v8-detect",  # [1, 4 + numClasses, numAnchors], boxes are cx,cy,w,h in input pixels
        "labels": [names[i] for i in sorted(names)],
        "source": {
            "weights": weights_path.name,
            "weightsSha256": sha256(weights_path) if weights_path.exists() else None,
            "ultralyticsVersion": ultralytics.__version__,
            "opset": args.opset,
            "exportedAt": datetime.now(timezone.utc).isoformat(),
        },
        "license": "AGPL-3.0 (Ultralytics). Review before sharing or deploying.",
    }
    manifest_path = out / f"{stem}.manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Wrote {dest} and {manifest_path}")
    print(f"elephant class index: {manifest['labels'].index('elephant')}")


if __name__ == "__main__":
    main()
