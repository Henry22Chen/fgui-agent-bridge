"""组件截图读取边界；获取失败不改变文档，也不撤销已经完成的写操作。"""

from __future__ import annotations

import base64
import json
import struct
import zlib
from pathlib import Path
from typing import Any

from mcp.types import CallToolResult, ImageContent, TextContent

MAX_BYTES = 16 * 1024 * 1024


def validate_png_pixels(data: bytes, expected_size: tuple[int, int]) -> None:
    """有界解压并验证 Unity 输出的非交错 8-bit PNG 扫描行。

    CRC 正确并不代表 IDAT 可解码。限定截图编码格式后，完整 zlib 流、扫描行长度
    和滤波器取值共同保证像素数据可重建，避免把坏图发送给 MCP 客户端。
    """
    offset, dimensions, pixel_parts, complete = 8, None, [], False
    channels = 0
    pixels_ended = False
    while offset < len(data):
        if offset + 12 > len(data):
            raise ValueError("PNG 块不完整")
        size = struct.unpack_from(">I", data, offset)[0]
        kind = data[offset + 4:offset + 8]
        end = offset + 12 + size
        if end > len(data):
            raise ValueError("PNG 块长度无效")
        if zlib.crc32(data[offset + 4:end - 4]) != struct.unpack_from(">I", data, end - 4)[0]:
            raise ValueError("PNG 校验失败")
        if offset == 8:
            if kind != b"IHDR" or size != 13:
                raise ValueError("PNG 缺少 IHDR")
            width, height, depth, color, compression, filtering, interlace = struct.unpack_from(">IIBBBBB", data, offset + 8)
            dimensions = (width, height)
            if not (0 < width <= 4096 and 0 < height <= 4096 and width * height <= 8388608):
                raise ValueError("PNG 尺寸超过限制")
            if dimensions != expected_size:
                raise ValueError("PNG 实际尺寸与 Editor 响应不符")
            channels = {0: 1, 2: 3, 4: 2, 6: 4}.get(color, 0)
            if depth != 8 or not channels or compression != 0 or filtering != 0 or interlace != 0:
                raise ValueError("PNG 编码不是受支持的 Unity 非交错 8-bit 截图")
        elif kind == b"IHDR":
            raise ValueError("PNG 包含重复 IHDR")
        elif kind == b"IDAT":
            if pixels_ended:
                raise ValueError("PNG IDAT 块不连续")
            pixel_parts.append(data[offset + 8:end - 4])
        elif kind == b"IEND":
            complete = size == 0 and end == len(data)
            break
        else:
            if pixel_parts:
                pixels_ended = True
            if kind == b"PLTE":
                if pixel_parts or size == 0 or size % 3 or size > 768:
                    raise ValueError("PNG PLTE 无效")
            elif not (kind[0] & 32):
                raise ValueError("PNG 包含不支持的关键块")
        offset = end
    if not complete or not pixel_parts or dimensions is None:
        raise ValueError("PNG 缺少完整图像数据")
    stride = dimensions[0] * channels + 1
    expected_bytes = stride * dimensions[1]
    try:
        decoder = zlib.decompressobj()
        # 上限由已经校验的 IHDR 推导，多读一个字节即可发现解压超量，禁止无界 flush。
        pixels = decoder.decompress(b"".join(pixel_parts), expected_bytes + 1)
        if len(pixels) != expected_bytes or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
            raise ValueError("PNG 像素流截断、超量或包含尾随数据")
    except zlib.error as error:
        raise ValueError("PNG IDAT 无法解码") from error
    if any(pixels[row] > 4 for row in range(0, expected_bytes, stride)):
        raise ValueError("PNG 扫描行滤波器无效")


def manual_verification(reason: str) -> CallToolResult:
    """返回独立的视觉待验结果；不能把缺图转换成写操作失败或回滚指令。"""
    value = {
        "visualVerificationStatus": "manual_required", "reason": reason,
        "mutationPerformed": False,
        "instruction": "未取得可验证图像。请在 FairyGUI Editor 自行检查资源、布局、遮挡、皮肤和可见性。保留已完成修改，不自动回滚。",
    }
    return CallToolResult(content=[TextContent(type="text", text=json.dumps(value, ensure_ascii=False))])


def capture_result(queue_root: Path, result: dict[str, Any]) -> CallToolResult:
    """只读取当前工程 captures 内 PNG，验证大小、块完整性与返回尺寸。"""
    if result.get("visualVerificationStatus") == "manual_required":
        return manual_verification(str(result.get("reason", "Editor 未取得图像")))
    relative = Path(result["path"])
    root = (queue_root / "captures").resolve()
    path = (queue_root / relative).resolve()
    if relative.is_absolute() or not root.is_relative_to(queue_root.resolve()) or not path.is_relative_to(root) or path.suffix.lower() != ".png":
        raise ValueError("截图路径不在当前工程 captures 目录内")
    # 有界读取同时覆盖 stat 后文件增长的情况。
    with path.open("rb") as stream:
        data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES or len(data) < 45 or data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("无效 PNG 或文件超过 16 MiB")
    validate_png_pixels(data, (result.get("width"), result.get("height")))
    metadata = {**result, "visualVerificationStatus": "pending_review", "spineCaptured": None}
    return CallToolResult(content=[
        TextContent(type="text", text=json.dumps(metadata, ensure_ascii=False)),
        ImageContent(type="image", mimeType="image/png", data=base64.b64encode(data).decode("ascii")),
    ])
