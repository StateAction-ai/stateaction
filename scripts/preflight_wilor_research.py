#!/usr/bin/env python3
"""Hash-pinned, local-GPU WiLoR research preflight; no MANO download.

Legacy object-pickle loading is explicit and restricted to the SHA-verified
official detector. The hand state dictionary uses weights_only=True.
No global torch.load replacement or unsafe environment
override is used. Models remain research-only under upstream license terms.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import importlib.metadata
import json
from pathlib import Path
import subprocess
import sys
import time

# Upstream tracks some Python bytecode; keep all audited checkout files intact.
sys.dont_write_bytecode = True

SOURCE_COMMIT = "fcb911312a38fa8badd30d9656a167485d61b8f9"
HF_REVISION = "99fe3d7acff8104ecca1055df7467709506c2fa6"
ASSETS = {
    "pretrained_models/detector.pt": "5ef3df44e42d2db52d4ffe91f83a22ce9925e2acc9abebf453f2c5d22e380033",
    "pretrained_models/wilor_final.ckpt": "3e97aafc7dd08d883a4cc5a027df61fdb6fda6136dbd1319405413862ada6bb2",
    "pretrained_models/hf_pinned/model_config.yaml": "f69cb52704df88ef29a7cfe03f35a677a92c1ce08169b729ca7f5862f05d4297",
    "pretrained_models/hf_pinned/dataset_config.yaml": "781da7fc454be8974a534ed7ed8ded38ba3af43c3b6f45b28bbf154a5a5aa77c",
}


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(8*1024*1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verified_asset(root, relative):
    path = (root/relative).resolve(strict=True)
    digest = sha256(path)
    if digest != ASSETS[relative]:
        raise RuntimeError(f"Refusing unverified official asset: {relative}, SHA256 {digest}")
    return path


@contextmanager
def official_detector_loader(detector_path):
    """Adapt only Ultralytics' helper for this verified legacy detector.

    Upstream Ultralytics8.1.34 omits weights_only. This adapter intercepts its
    helper only for the exact official detector path, uses explicit trusted
    pickle loading, and restores the helper even if construction fails.
    Every other checkpoint retains the original loader behavior.
    """
    import torch
    import ultralytics.nn.tasks as tasks

    expected = detector_path.resolve(strict=True)
    if sha256(expected) != ASSETS["pretrained_models/detector.pt"]:
        raise RuntimeError("Detector changed before loading")
    original = tasks.torch_safe_load

    def load(weight):
        if Path(weight).resolve() != expected:
            return original(weight)
        return torch.load(expected, map_location="cpu", weights_only=False), str(expected)

    tasks.torch_safe_load = load
    try:
        yield
    finally:
        tasks.torch_safe_load = original


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wilor", type=Path, default=Path("artifacts/research-models/WiLoR"))
    parser.add_argument("--frame", type=Path, default=Path("captures/session_20261022_152005/inspection/rgb_frames/000020.jpg"))
    parser.add_argument("--output", type=Path, default=Path("docs/validation/wilor-research-preflight.json"))
    parser.add_argument("--detector-overlay", type=Path, default=Path("artifacts/research-models/wilor-detector-preflight.jpg"))
    parser.add_argument("--mano-asset", type=Path, help="Explicit local MANO_RIGHT.pkl; does not download or establish license rights")
    parser.add_argument("--mano-source-receipt", type=Path, help="Optional provenance JSON; its SHA256 must match the supplied MANO asset")
    args = parser.parse_args()
    root = args.wilor.resolve(strict=True)
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    if commit != SOURCE_COMMIT:
        raise RuntimeError(f"Unexpected WiLoR source revision {commit}")
    if subprocess.check_output(["git", "diff", "HEAD", "--"], cwd=root):
        raise RuntimeError("WiLoR tracked source differs from pinned revision")
    sys.path.insert(0, str(root))
    report = {"started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "status": "running", "python": sys.version, "python_executable": sys.executable,
              "source": {"url": "https://github.com/rolpotamias/WiLoR", "commit": commit, "tracked_source_clean": True},
              "hf_revision": HF_REVISION,
              "license_scope": "Noncommercial research only; WiLoR CC-BY-NC-ND4.0, MANO and Ultralytics have separate terms.",
              "remaining_mano_asset": str(root/"mano_data/MANO_RIGHT.pkl"),
              "checkpoint_loading": "Detector: explicit weights_only=False only after matching official asset SHA256. Hand state dictionary: weights_only=True. Ultralytics helper is intercepted only for the exact detector path and restored; torch.load itself is unchanged.",
              "pickle_class_policy": "No additional safe-global classes are registered. The trusted official detector uses unrestricted pickle reconstruction (Ultralytics/Torch layers and dill helpers), scoped to its verified file. The hand checkpoint uses PyTorch's restricted state-dictionary loader.",
              "script_sha256": sha256(__file__), "assets": []}
    try:
        paths = {}
        for relative in ASSETS:
            path = verified_asset(root, relative); paths[relative] = path
            report["assets"].append({"path": str(path), "sha256": ASSETS[relative], "bytes": path.stat().st_size,
                "url": f"https://huggingface.co/spaces/rolpotamias/WiLoR/resolve/{HF_REVISION}/pretrained_models/{path.name}"})
        import torch
        import cv2
        import numpy as np
        import chumpy
        from ultralytics import YOLO
        from wilor.models import WiLoR
        from wilor.datasets.vitdet_dataset import ViTDetDataset
        from wilor.configs import get_config
        report["runtime"] = {name: importlib.metadata.version(name) for name in (
            "torch", "torchvision", "numpy", "opencv-python", "pytorch-lightning", "ultralytics", "smplx", "chumpy", "timm")}
        report["installed_packages"] = dict(sorted((d.metadata["Name"], d.version)
                                                    for d in importlib.metadata.distributions()))
        report["environment_scope"] = "Standalone WiLoR research environment. SDK package is not installed: its NumPy>=1.24 requirement needs a separate compatibility decision with legacy Chumpy/NumPy1.23.5. SDK-style torch.amp.autocast API is tested here."
        report["model_and_dataset_imports"] = "pass"
        assert torch.cuda.is_available(), "Local CUDA is unavailable"
        torch.manual_seed(0)
        a = torch.randn(256, 256, device="cuda")
        with torch.amp.autocast("cuda", dtype=torch.float16):
            product = a@a
        torch.cuda.synchronize()
        assert bool(torch.isfinite(product).all())
        report["cuda"] = {"torch_cuda": torch.version.cuda, "gpu": torch.cuda.get_device_name(0),
                          "driver": subprocess.check_output(["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"], text=True).strip(),
                          "actual_device_allocation_and_matmul": "pass", "autocast_dtype": str(product.dtype)}
        detector_path = paths["pretrained_models/detector.pt"]
        with official_detector_loader(detector_path):
            detector = YOLO(str(detector_path))
        bgr = cv2.imread(str(args.frame.resolve(strict=True)))
        if bgr is None:
            raise RuntimeError("Cannot decode detector test frame")
        detection = detector.predict(source=bgr, device=0, half=True, conf=.3, imgsz=640, verbose=False)[0]
        torch.cuda.synchronize()
        boxes = detection.boxes.xyxy.cpu().numpy()
        report["detector"] = {"frame": str(args.frame), "frame_sha256": sha256(args.frame),
            "input_transform": "unchanged native raster, OpenCV BGR", "device": str(next(detector.model.parameters()).device),
            "classes": detection.boxes.cls.cpu().numpy().tolist(), "class_names": detection.names,
            "confidence": detection.boxes.conf.cpu().numpy().tolist(), "xyxy": boxes.tolist(),
            "count": len(boxes), "actual_cuda_inference": "pass"}
        args.detector_overlay.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(args.detector_overlay), detection.plot())
        report["detector"]["overlay"] = str(args.detector_overlay)
        # Inspect the official checkpoint without constructing a fake MANO or
        # recovering protected assets from checkpoint buffers.
        checkpoint = torch.load(paths["pretrained_models/wilor_final.ckpt"], map_location="cpu", weights_only=True)
        state = checkpoint["state_dict"]
        report["hand_checkpoint"] = {"explicit_verified_deserialization": "pass", "weights_only": True,
            "top_level_keys": sorted(checkpoint), "state_dict_entries": len(state),
            "tensor_elements": sum(v.numel() for v in state.values() if torch.is_tensor(v))}
        mano = args.mano_asset.resolve(strict=True) if args.mano_asset else root/"mano_data/MANO_RIGHT.pkl"
        if not mano.exists():
            report["status"] = "preflight_ready_awaiting_licensed_mano"
            report["full_hand_inference"] = "not run: licensed MANO_RIGHT.pkl is absent"
        else:
            mano_digest = sha256(mano)
            report["mano_asset"] = {"path": str(mano), "sha256": mano_digest,
                                    "explicit_path": args.mano_asset is not None,
                                    "license_rights_established_by_preflight": False,
                                    "loading": "SMPL-X reconstructs this explicit trusted legacy MANO pickle; PyTorch weights_only applies to the separate hand checkpoint."}
            if args.mano_source_receipt:
                source = json.loads(args.mano_source_receipt.read_text())
                if source.get("sha256") != mano_digest:
                    raise RuntimeError("MANO asset does not match its provenance receipt")
                report["mano_asset"]["provenance"] = source
                report["mano_asset"]["provenance_receipt_sha256"] = sha256(args.mano_source_receipt)
            cfg = get_config(str(paths["pretrained_models/hf_pinned/model_config.yaml"]))
            cfg.defrost()
            cfg.MODEL.BACKBONE.pop("PRETRAINED_WEIGHTS", None)
            cfg.MODEL.BBOX_SHAPE = [192, 256]
            cfg.MANO.DATA_DIR = str(mano.parent)
            cfg.MANO.MODEL_PATH = str(mano)
            cfg.MANO.MEAN_PARAMS = str(root/"mano_data/mano_mean_params.npz")
            cfg.freeze()
            model = WiLoR(cfg, init_renderer=False)
            incompatible = model.load_state_dict(state, strict=False)
            report["hand_checkpoint"]["missing_keys"] = incompatible.missing_keys
            report["hand_checkpoint"]["unexpected_keys"] = incompatible.unexpected_keys
            if any(k.startswith(("backbone.", "refine_net.", "mano.")) for k in incompatible.missing_keys):
                raise RuntimeError("Critical learned/model state is missing; refusing a partial random model")
            model = model.cuda().eval()
            report["mano_sha256"] = sha256(mano)
            report["remaining_mano_asset"] = None
            if len(boxes):
                dataset = ViTDetDataset(cfg, bgr, boxes[:1], detection.boxes.cls.cpu().numpy()[:1])
                batch = next(iter(torch.utils.data.DataLoader(dataset, batch_size=1, num_workers=0)))
                batch = {k: v.cuda() if torch.is_tensor(v) else v for k, v in batch.items()}
                with torch.no_grad(), torch.amp.autocast("cuda", dtype=torch.float16):
                    output = model(batch)
                joints = output["pred_keypoints_3d"]
                assert joints.shape == (1, 21, 3) and bool(torch.isfinite(joints).all())
                report["full_hand_inference"] = {"status": "pass", "shape": list(joints.shape), "finite": True,
                                                  "accuracy_evaluated": False}
            else:
                report["full_hand_inference"] = "model loaded, but detector produced no hand crop"
            report["status"] = "hand_model_loaded_research_only"
    except Exception as error:
        report["status"] = "failed"; report["error"] = repr(error)
        raise
    finally:
        report["finished_utc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2)+"\n")
    print(json.dumps({"status": report["status"], "cuda": report.get("cuda"),
                      "detector": report.get("detector"), "remaining_mano_asset": report["remaining_mano_asset"]}, indent=2))


if __name__ == "__main__":
    main()
