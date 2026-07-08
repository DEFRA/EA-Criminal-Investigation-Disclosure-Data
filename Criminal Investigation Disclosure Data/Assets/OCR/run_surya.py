"""
Run Surya OCR on a PNB (Police Notebook) page image.

Uses Surya's full-page OCR via llamacpp backend (local, no data leaves device).
All model files are pre-cached; no network access required at runtime.

Usage:
    python run_surya.py --image <path> [--output <json_path>]

Outputs JSON: {"lines": ["line1", "line2", ...], "blocks": [...], "error": null}
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path


# ---------------------------------------------------------------------------
# Paths to pre-downloaded model files.
# These are resolved relative to the script's own directory so they work
# from the published EXE output folder too.
# ---------------------------------------------------------------------------
SCRIPT_DIR = Path(__file__).parent.resolve()

def _resolve(env_var: str, relative_path: str) -> str:
    """Return env var value if set, else path relative to this script."""
    if os.environ.get(env_var):
        return os.environ[env_var]
    candidate = SCRIPT_DIR / relative_path
    if candidate.exists():
        return str(candidate)
    # Fallback: absolute default install location
    return relative_path


def _setup_env():
    """Configure Surya environment before importing surya modules."""
    llama_bin = _resolve(
        "LLAMA_CPP_BINARY",
        r"C:\Users\da000087\AppData\Local\llama-cpp\extracted\llama-server.exe"
    )
    gguf_snap = (
        r"C:\Users\da000087\.cache\huggingface\hub"
        r"\models--datalab-to--surya-ocr-2-gguf"
        r"\snapshots\6a3a4c30e5e74446d4f8b6afd05b2f2da970f470"
    )
    model_gguf = _resolve("SURYA_GGUF_LOCAL_MODEL_PATH", os.path.join(gguf_snap, "surya-2.gguf"))
    mmproj_gguf = _resolve("SURYA_GGUF_LOCAL_MMPROJ_PATH", os.path.join(gguf_snap, "surya-2-mmproj.gguf"))

    os.environ.setdefault("LLAMA_CPP_BINARY", llama_bin)
    os.environ.setdefault("SURYA_GGUF_LOCAL_MODEL_PATH", model_gguf)
    os.environ.setdefault("SURYA_GGUF_LOCAL_MMPROJ_PATH", mmproj_gguf)
    os.environ.setdefault("SURYA_INFERENCE_BACKEND", "llamacpp")
    # Suppress HuggingFace symlink warning
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")


def _html_to_text(html: str) -> str:
    """Strip HTML tags, unescape HTML entities, and collapse whitespace."""
    import html as html_module
    text = re.sub(r"<[^>]+>", " ", html)
    text = html_module.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def main():
    parser = argparse.ArgumentParser(description="Surya OCR for PNB pages")
    parser.add_argument("--image", required=True, help="Path to input image (PNG/JPEG)")
    parser.add_argument("--output", help="Optional output JSON path (default: stdout)")
    args = parser.parse_args()

    image_path = Path(args.image)
    if not image_path.exists():
        result = {"lines": [], "blocks": [], "error": f"Image not found: {image_path}"}
        _write_result(result, args.output)
        sys.exit(1)

    _setup_env()

    try:
        from PIL import Image
        from surya.detection import DetectionPredictor
        from surya.inference import SuryaInferenceManager
        from surya.recognition import RecognitionPredictor
    except ImportError as e:
        result = {"lines": [], "blocks": [], "error": f"Import error: {e}"}
        _write_result(result, args.output)
        sys.exit(1)

    print("Loading image...", file=sys.stderr)
    image = Image.open(image_path).convert("RGB")

    print("Loading DetectionPredictor...", file=sys.stderr)
    det_predictor = DetectionPredictor()

    print("Running text detection...", file=sys.stderr)
    # Detection not strictly needed for full-page OCR but improves accuracy
    det_results = det_predictor([image])
    num_boxes = len(det_results[0].bboxes)
    print(f"Detected {num_boxes} text regions", file=sys.stderr)

    print("Running recognition...", file=sys.stderr)
    manager = SuryaInferenceManager()
    rec_predictor = RecognitionPredictor(manager)
    page_results = rec_predictor([image], full_page=True)

    result_page = page_results[0]
    blocks = []
    lines = []

    # Sort blocks by reading order
    sorted_blocks = sorted(result_page.blocks, key=lambda b: b.reading_order)

    for block in sorted_blocks:
        if block.skipped or block.error or not block.html:
            continue
        text = _html_to_text(block.html)
        if not text:
            continue
        blocks.append({"label": block.label, "text": text, "reading_order": block.reading_order})
        # Split into lines for compatibility with existing VB consumer
        for line in text.splitlines():
            line = line.strip()
            if line:
                lines.append(line)

    result = {"lines": lines, "blocks": blocks, "error": None}
    _write_result(result, args.output)
    print(f"Done: {len(lines)} lines, {len(blocks)} blocks", file=sys.stderr)


def _write_result(result: dict, output_path: str | None):
    json_str = json.dumps(result, ensure_ascii=False, indent=2)
    if output_path:
        Path(output_path).write_text(json_str, encoding="utf-8-sig")  # utf-8-sig writes BOM for .NET compatibility
    else:
        sys.stdout.write(json_str)
        sys.stdout.write("\n")


if __name__ == "__main__":
    main()
