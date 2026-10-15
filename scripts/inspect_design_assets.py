#!/usr/bin/env python3
"""只读提取 PNG 可见边界及可选 PSD 图层坐标，避免透明留白导致布局误判。"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image


def inspect_png(path: Path) -> dict:
    """返回源画布和非透明像素边界；空图的 visibleBounds 为 null。"""
    with Image.open(path) as source:
        if source.width * source.height > 32_000_000:
            raise ValueError(f"图片像素过多：{path.name}")
        size = [source.width, source.height]
        bounds = source.convert("RGBA").getchannel("A").getbbox()
    return {"file": str(path), "size": size, "visibleBounds": list(bounds) if bounds else None,
            "transparentInsets": [bounds[0], bounds[1], size[0] - bounds[2], size[1] - bounds[3]] if bounds else None}


def inspect_psd(path: Path) -> dict:
    """只读取 PSD 结构，不合成/导出图片或改写图层；依赖可选 design extra。"""
    try:
        from psd_tools import PSDImage
    except ImportError as error:
        raise ValueError("读取 PSD 需先运行 uv sync --extra design；PNG 检查不需要此依赖") from error
    psd = PSDImage.open(path)
    layers = []
    for layer in psd.descendants():
        entry = {"name": layer.name, "kind": layer.kind, "bbox": list(layer.bbox), "visible": layer.is_visible()}
        if layer.kind == "type":
            entry["text"] = layer.text
        layers.append(entry)
    return {"file": str(path), "size": list(psd.size), "layers": layers}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="+", type=Path, help="PNG、PSD 文件或 PNG 所在目录")
    parser.add_argument("--limit", type=int, default=200)
    args = parser.parse_args()
    if not 1 <= args.limit <= 1000:
        parser.error("limit 必须为 1..1000")
    files = []
    for path in args.paths:
        files.extend(sorted(path.rglob("*.png")) if path.is_dir() else [path])
    if len(files) > args.limit:
        parser.error("文件数超过 limit，请缩小目录范围")
    results = [inspect_psd(path) if path.suffix.lower() == ".psd" else inspect_png(path) for path in files]
    print(json.dumps(results, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
