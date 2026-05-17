#!/usr/bin/env python3
"""ASCII-dump the first few tiles of a mosaic so we can see the actual on-disk
tile layout (separator, quiet zone, black border, data) for each family.

Usage:  python3 scripts/dump-mosaic-tile.py <family>_mosaic.png <tileSize_px>
        python3 scripts/dump-mosaic-tile.py --all
"""
import sys
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / "public" / "resources"

FAMILIES = [
    ("tag36h11_mosaic.png",         10),
    ("tagStandard41h12_mosaic.png",  9),
    ("tagStandard52h13_mosaic.png", 10),
    ("tagCustom48h12_mosaic.png",   10),
    ("tagCircle21h7_mosaic.png",     9),
    ("tagCircle49h12_mosaic.png",   11),
]

def dump(path: Path, tile_size: int, tile_id: int = 0) -> None:
    img = Image.open(path).convert("L")  # grayscale
    W, H = img.size
    stride = tile_size + 1
    cols = (W + 1) // stride
    rows = (H + 1) // stride
    col = tile_id % cols
    row = tile_id // cols
    # We want to see the surrounding separator too — back off 1 px and read
    # tile_size + 2 px in each dimension.
    x0 = col * stride - 1
    y0 = row * stride - 1
    side = tile_size + 2
    print(f"\n{path.name}  tile #{tile_id} (incl. 1-px context)  tile_size={tile_size}")
    print(f"  mosaic {W}×{H}  grid {cols}×{rows}")
    px = img.load()
    for dy in range(side):
        line = ""
        for dx in range(side):
            xx, yy = x0 + dx, y0 + dy
            if 0 <= xx < W and 0 <= yy < H:
                v = px[xx, yy]
                line += "█" if v < 128 else "·"
            else:
                line += " "
        print(f"  {line}")

if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] != "--all":
        dump(Path(sys.argv[1]), int(sys.argv[2]))
    else:
        for name, ts in FAMILIES:
            dump(RES / name, ts)
            dump(RES / name, ts, tile_id=1)
