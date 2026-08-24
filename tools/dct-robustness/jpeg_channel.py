#!/usr/bin/env python3
"""JPEG channel helper for the DCT robustness harness.

Raw format on disk: 4-byte LE uint32 width, 4-byte LE uint32 height, then
width*height*3 bytes of RGB. This is the interchange between the JS engine
(embed/extract) and PIL (the actual JPEG compressor).

Subcommands:
  png2raw <in_image> <out_raw>                     decode any image -> raw RGB
  jpeg    <in_raw> <out_raw> <quality>             raw -> JPEG(quality) -> raw
  jpeg_resize <in_raw> <out_raw> <quality> <scale> downscale by <scale>, JPEG,
                                                   then upscale back to original
                                                   size (simulates a messenger)
"""
import struct
import sys
from io import BytesIO

from PIL import Image


def read_raw(path):
    with open(path, "rb") as f:
        w, h = struct.unpack("<II", f.read(8))
        data = f.read(w * h * 3)
    return Image.frombytes("RGB", (w, h), data)


def write_raw(img, path):
    img = img.convert("RGB")
    w, h = img.size
    with open(path, "wb") as f:
        f.write(struct.pack("<II", w, h))
        f.write(img.tobytes())


def main():
    cmd = sys.argv[1]
    if cmd == "png2raw":
        write_raw(Image.open(sys.argv[2]), sys.argv[3])
    elif cmd == "jpeg":
        img = read_raw(sys.argv[2])
        quality = int(sys.argv[4])
        buf = BytesIO()
        img.save(buf, format="JPEG", quality=quality)  # the recompression
        buf.seek(0)
        write_raw(Image.open(buf), sys.argv[3])
    elif cmd == "jpeg_resize":
        img = read_raw(sys.argv[2])
        quality = int(sys.argv[4])
        scale = float(sys.argv[5])
        w, h = img.size
        small = img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.BICUBIC)
        buf = BytesIO()
        small.save(buf, format="JPEG", quality=quality)
        buf.seek(0)
        back = Image.open(buf).resize((w, h), Image.BICUBIC)  # what the app would see
        write_raw(back, sys.argv[3])
    else:
        print(f"unknown command: {cmd}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
