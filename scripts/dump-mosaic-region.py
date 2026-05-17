#!/usr/bin/env python3
"""Dump a fixed pixel rectangle from a mosaic. Used to inspect the top-left
corner where the separator/tile structure starts, so we can confirm tile_size
independent of any per-family assumption.

Usage:  python3 scripts/dump-mosaic-region.py <png> [width=30] [height=22]
"""
import sys
from pathlib import Path
from PIL import Image

if len(sys.argv) < 2:
    print(__doc__)
    sys.exit(2)
path = Path(sys.argv[1])
w = int(sys.argv[2]) if len(sys.argv) > 2 else 30
h = int(sys.argv[3]) if len(sys.argv) > 3 else 22

img = Image.open(path).convert("L")
W, H = img.size
print(f"{path.name}  full {W}×{H}  showing top-left {w}×{h}")
print("    " + "".join(str(c % 10) for c in range(w)))
px = img.load()
for y in range(min(h, H)):
    line = "".join("█" if px[x, y] < 128 else "·" for x in range(min(w, W)))
    print(f"{y:3} {line}")
