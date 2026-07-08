"""
Run TrOCR handwriting recognition on a PNB (Police Notebook) page image.

Optimized for PNB log book entries:
- White background, ruled lines, date/time margin on left
- Handwriting in right-hand column in any color pen
- Uses ruled line detection for accurate line segmentation

Usage:
    python run_trocr.py --image <path> [--output <json_path>]

Outputs JSON with recognized text lines to stdout or file.
Requires: pip install transformers torch pillow scipy
"""

import argparse
import json
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description="TrOCR handwriting OCR for PNB pages")
    parser.add_argument("--image", required=True, help="Path to input image (PNG/JPEG)")
    parser.add_argument("--output", help="Optional output JSON path (default: stdout)")
    parser.add_argument(
        "--model",
        default="microsoft/trocr-base-handwritten",
        help="HuggingFace model ID"
    )
    args = parser.parse_args()

    image_path = Path(args.image)
    if not image_path.exists():
        print(f"Error: image not found: {image_path}", file=sys.stderr)
        sys.exit(1)

    from PIL import Image
    import numpy as np
    import torch
    from transformers import VisionEncoderDecoderModel, AutoTokenizer

    print("Loading TrOCR model...", file=sys.stderr)
    model = VisionEncoderDecoderModel.from_pretrained(args.model, local_files_only=True)
    model.eval()

    # Load tokenizer from cached RoBERTa vocab files
    from transformers import RobertaTokenizer
    cache_dir = Path.home() / ".cache" / "huggingface" / "hub" / "models--FacebookAI--roberta-base" / "snapshots"
    snap_dirs = list(cache_dir.iterdir()) if cache_dir.exists() else []
    if snap_dirs:
        tokenizer = RobertaTokenizer(
            vocab_file=str(snap_dirs[0] / "vocab.json"),
            merges_file=str(snap_dirs[0] / "merges.txt"),
        )
    else:
        tokenizer = AutoTokenizer.from_pretrained("FacebookAI/roberta-base")

    # Image processor (no download needed - configure programmatically)
    from transformers import ViTImageProcessor
    processor = ViTImageProcessor(
        size={"height": 384, "width": 384},
        do_center_crop=False, do_resize=True, do_normalize=True,
        image_mean=[0.5, 0.5, 0.5], image_std=[0.5, 0.5, 0.5],
    )

    # Open and segment into lines (PNB-specific)
    img = Image.open(str(image_path)).convert("RGB")
    lines = segment_pnb_lines(img)

    if not lines:
        # Fallback: treat whole image as one line
        lines = [img]

    print(f"Processing {len(lines)} line(s)...", file=sys.stderr)

    results = []
    for i, line_img in enumerate(lines):
        # Enhance the line image for better recognition
        line_img = enhance_line_for_ocr(line_img)

        pixel_values = processor(images=line_img, return_tensors="pt").pixel_values
        with torch.no_grad():
            # Use beam search for higher accuracy on handwriting
            generated_ids = model.generate(
                pixel_values,
                max_new_tokens=128,
                num_beams=5,
                early_stopping=True,
            )
        text = tokenizer.batch_decode(generated_ids, skip_special_tokens=True)[0]
        text = text.strip()

        # Filter obvious hallucinations
        if is_hallucination(text):
            continue

        if text:
            results.append(text)

    full_text = "\n".join(results)
    output = {"text": full_text, "lines": results, "line_count": len(results)}

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            json.dump(output, f, indent=2, ensure_ascii=False)
        print(f"Written to {args.output}", file=sys.stderr)
    else:
        print(json.dumps(output, ensure_ascii=False))


def is_hallucination(text):
    """Detect obvious TrOCR hallucination patterns (conservative filter)."""
    if not text:
        return True
    # Single character that isn't a letter/number
    if len(text) == 1 and not text.isalnum():
        return True
    # Repeated words (e.g. "Spanish Spanish Spanish Spanish...")
    words = text.split()
    if len(words) >= 5:
        unique = set(words)
        if len(unique) == 1:
            return True
    return False


def enhance_line_for_ocr(line_img):
    """Enhance a line crop for better TrOCR recognition.
    
    - Removes ruled line remnants (thin horizontal lines)
    - Increases contrast of handwriting ink
    - Creates clean white background with dark text
    """
    import numpy as np
    from PIL import Image

    arr = np.array(line_img.convert("L")).astype(np.float64)
    h, w = arr.shape

    # Step 1: Remove horizontal ruled lines
    # Ruled lines are rows where most pixels have similar (light grey) value
    # Detect rows that are uniformly grey (ruled lines)
    for y in range(h):
        row = arr[y, :]
        row_mean = row.mean()
        row_std = row.std()
        # Ruled lines have low variance and mid-grey value (150-220)
        if row_std < 25 and 140 < row_mean < 230:
            # Check if this is a ruled line (most of the row is similar shade)
            dark_pixel_count = np.sum(row < row_mean - 30)
            if dark_pixel_count < w * 0.15:
                # This is likely a ruled line - bleach it to white
                arr[y, :] = 255

    # Step 2: Increase contrast - make ink darker, background whiter
    # Simple contrast stretch: pixels darker than threshold become ink,
    # lighter become background
    ink_threshold = 160
    ink_mask = arr < ink_threshold

    # Stretch: map [0, ink_threshold] to [0, 60] and [ink_threshold, 255] to [240, 255]
    result = np.where(
        ink_mask,
        (arr / ink_threshold) * 60,         # Darken ink
        240 + (arr - ink_threshold) / (255 - ink_threshold) * 15  # Whiten bg
    ).clip(0, 255).astype(np.uint8)

    # Convert back to RGB
    return Image.fromarray(np.stack([result] * 3, axis=-1))


def segment_pnb_lines(img):
    """Segment a PNB page into individual handwritten lines.
    
    Strategy:
    1. Detect the vertical margin line (separates date/time from writing area)
    2. Detect horizontal ruled lines using peak detection on projection profile
    3. Use ruled line positions as row boundaries
    4. Only keep rows that contain actual handwriting ink
    """
    import numpy as np

    gray = np.array(img.convert("L"))
    h, w = gray.shape

    # --- Step 1: Find the vertical margin line ---
    # Look for a strong vertical line in the left portion of the image
    # Use vertical projection on a binarized version
    # The margin line will show as a column with very high dark pixel count
    margin_x = find_margin_line(gray)

    # Crop to writing area (right of margin)
    if margin_x is not None:
        writing_x_start = margin_x + 5
    else:
        writing_x_start = int(w * 0.12)  # Default: assume 12% left margin

    # --- Step 2: Detect horizontal ruled lines ---
    # Work with the writing area only
    writing_area = gray[:, writing_x_start:]

    # Find ruled line positions using horizontal projection
    ruled_positions = find_ruled_lines(writing_area)

    if len(ruled_positions) < 3:
        # Fallback: if we can't detect ruled lines, use fixed strips
        line_height = max(30, h // 25)
        ruled_positions = list(range(0, h, line_height))

    # --- Step 3: Extract rows between ruled lines ---
    line_images = []
    writing_img = img.crop((writing_x_start, 0, w, h))
    writing_gray = gray[:, writing_x_start:]
    
    for i in range(len(ruled_positions) - 1):
        y_top = ruled_positions[i]
        y_bot = ruled_positions[i + 1]
        row_height = y_bot - y_top

        # Skip very thin rows (likely just line artifacts)
        if row_height < 15:
            continue

        # Check if this row has actual handwriting content
        row_pixels = writing_gray[y_top:y_bot, :]
        if not has_handwriting(row_pixels):
            continue

        # Crop the line image with small vertical padding
        pad = 2
        cy1 = max(0, y_top + pad)  # Skip just below the ruled line
        cy2 = min(h, y_bot - pad)  # Stop just above next ruled line
        
        if cy2 - cy1 < 10:
            continue

        line_img = writing_img.crop((0, cy1, writing_img.width, cy2))
        line_images.append(line_img)

    return line_images


def find_margin_line(gray):
    """Find the vertical margin line position in a PNB page."""
    import numpy as np

    h, w = gray.shape
    # Look in the left 30% of the image
    search_width = int(w * 0.30)
    left_region = gray[:, :search_width]

    # Binarize (dark pixels)
    binary = (left_region < 150).astype(np.uint8)

    # Vertical projection: count dark pixels per column
    v_projection = binary.sum(axis=0)

    # The margin line will be a column with significantly more dark pixels
    # than its neighbors (it runs the full height of the page)
    # Look for columns where > 60% of pixels are dark
    threshold = h * 0.4
    candidates = np.where(v_projection > threshold)[0]

    if len(candidates) == 0:
        return None

    # Find the rightmost strong vertical line (the main writing margin)
    # Group consecutive candidates
    groups = []
    current_group = [candidates[0]]
    for i in range(1, len(candidates)):
        if candidates[i] - candidates[i - 1] <= 3:
            current_group.append(candidates[i])
        else:
            groups.append(current_group)
            current_group = [candidates[i]]
    groups.append(current_group)

    # Take the rightmost group (the margin line closest to writing area)
    if groups:
        margin_group = groups[-1]
        return int(margin_group[-1])

    return None


def find_ruled_lines(gray_area):
    """Detect horizontal ruled line positions using horizontal projection."""
    import numpy as np

    h, w = gray_area.shape

    # Binarize to find dark pixels (ruled lines are usually printed/grey)
    # Use a moderate threshold — ruled lines may be lighter than pen ink
    binary = (gray_area < 180).astype(np.uint8)

    # Horizontal projection: count dark pixels per row
    h_projection = binary.sum(axis=1).astype(np.float64)

    # Ruled lines appear as rows with high dark pixel count spanning most of width
    # A ruled line should span at least 50% of the writing width
    line_threshold = w * 0.3

    # Find peaks: rows where projection exceeds threshold
    is_line_row = h_projection > line_threshold

    # Find line positions (take the center of each cluster of True rows)
    positions = []
    in_line = False
    start = 0
    for y in range(h):
        if not in_line and is_line_row[y]:
            in_line = True
            start = y
        elif in_line and not is_line_row[y]:
            in_line = False
            center = (start + y) // 2
            positions.append(center)
    if in_line:
        positions.append((start + h) // 2)

    # Validate: ruled lines should be roughly evenly spaced
    if len(positions) >= 3:
        spacings = np.diff(positions)
        median_spacing = np.median(spacings)
        # Filter out positions that don't match the regular spacing
        # (removes false detections from handwriting crossing)
        if median_spacing > 15:
            filtered = [positions[0]]
            for i in range(1, len(positions)):
                gap = positions[i] - filtered[-1]
                if gap > median_spacing * 0.5:
                    filtered.append(positions[i])
            positions = filtered

    # If we didn't find enough ruled lines, try with a different threshold
    if len(positions) < 5:
        # Try looking for lighter ruled lines
        binary_light = (gray_area < 200).astype(np.uint8)
        h_proj_light = binary_light.sum(axis=1).astype(np.float64)
        line_threshold_light = w * 0.5
        is_line_row_light = h_proj_light > line_threshold_light

        positions = []
        in_line = False
        start = 0
        for y in range(h):
            if not in_line and is_line_row_light[y]:
                in_line = True
                start = y
            elif in_line and not is_line_row_light[y]:
                in_line = False
                center = (start + y) // 2
                positions.append(center)
        if in_line:
            positions.append((start + h) // 2)

    return positions


def has_handwriting(row_pixels):
    """Determine if a row between ruled lines contains actual handwriting.
    
    Distinguishes handwriting (irregular dark strokes) from empty rows
    (just the white background or faint ruled line residue).
    """
    import numpy as np

    h, w = row_pixels.shape

    # Strong ink threshold — actual pen strokes are darker than ruled lines
    # Pen ink is typically < 120 on 0-255 scale regardless of color
    ink_pixels = (row_pixels < 130).astype(np.uint8)

    # Count ink pixel ratio
    ink_ratio = ink_pixels.sum() / ink_pixels.size

    # Need at least 2% ink coverage to consider it has writing
    if ink_ratio < 0.02:
        return False

    # Also check that ink isn't just a thin horizontal line (ruled line residue)
    # Real handwriting has vertical variation — check multiple row bands
    band_h = max(1, h // 3)
    bands_with_ink = 0
    for b in range(3):
        band = ink_pixels[b * band_h:(b + 1) * band_h, :]
        if band.sum() > 0:
            bands_with_ink += 1

    # Handwriting should span at least 2 of 3 vertical bands
    return bands_with_ink >= 2


if __name__ == "__main__":
    main()
