"""批量计划边界、定向读取和多状态联系图；不提供任意 Action/脚本透传。"""
from __future__ import annotations

import base64
from io import BytesIO
import json
import re
from pathlib import Path
from typing import Any

from mcp.types import CallToolResult, ImageContent, TextContent

from .capture import MAX_BYTES, capture_result


BATCH_FIELDS = {
    "create_object": {"objectType", "name", "x", "y", "width", "height", "insertIndex", "groupMemberIds"},
    "insert_object": {"url", "name", "x", "y", "insertIndex"},
    "set_properties": {"target", "properties"}, "set_text_style": {"target", "style"},
    "set_button_binding": {"target", "settings"}, "set_list_settings": {"target", "settings"},
    "set_list_item_resources": {"target", "settings"},
    "set_group_settings": {"target", "settings"}, "set_input_settings": {"target", "settings"}, "set_mask_settings": {"settings"},
    "replace_object_resource": {"target", "resourceURL", "expectedType", "preserveSize"},
    "set_scroll_settings": {"target", "settings"}, "set_loader": {"target", "settings"},
    "set_group": {"target", "groupId"}, "add_relation": {"target", "relationTargetId", "relationType", "usePercent"},
    "remove_relation": {"target", "relationTargetId", "relationType"},
    "set_gear": {"target", "gearType", "controllerName", "defaultValue", "pageValues", "visiblePageIds"},
    "create_controller": {"name", "pages"}, "set_controller_page": {"controllerName", "pageId", "pageName", "pageIndex"},
    "set_component_instance_controller": {"target", "controllerName", "pageId", "pageName", "pageIndex"},
    "set_component_instance_property": {"target", "childPath", "propertyId", "value"},
    "upsert_component_property": {"childPath", "propertyId", "label"}, "remove_component_property": {"childPath", "propertyId"},
    "set_controller_properties": {"controllerName", "settings"},
    "remove_object": {"target"},
}


def validate_operation_key(key: str) -> None:
    """操作键只用安全 ASCII；它绑定整批参数，不是可以循环复用的会话名。"""
    if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,95}", key):
        raise ValueError("operation_key 必须为 1..96 位字母数字、横线或下划线")


def validate_batch(operations: list[dict[str, Any]], operation_key: str) -> None:
    """写队列前拒绝越权/未知操作；原生类型、布局和引用约束由 Editor 再验证。"""
    validate_operation_key(operation_key)
    if not isinstance(operations, list) or not 1 <= len(operations) <= 200:
        raise ValueError("operations 必须包含 1..200 项")
    if len(json.dumps(operations, ensure_ascii=False)) > 262144:
        raise ValueError("批量计划超过 256 KiB 字符限制")
    refs = set()
    for index, op in enumerate(operations):
        if not isinstance(op, dict) or set(op) - {"action", "params", "ref"} or op.get("action") not in BATCH_FIELDS:
            raise ValueError(f"第 {index} 项 action 不在批量白名单")
        params = op.get("params")
        if not isinstance(params, dict) or set(params) - BATCH_FIELDS[op["action"]]:
            raise ValueError(f"第 {index} 项参数无效；禁止单步 save、任意调用和资源写入")
        if "ref" in op:
            ref = op["ref"]
            if op["action"] not in {"create_object", "insert_object"} or not isinstance(ref, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,31}", ref) or ref in refs:
                raise ValueError(f"第 {index} 项 ref 无效或重复")
            refs.add(ref)


def batch_tool_result(value: dict[str, Any]) -> CallToolResult:
    """保留部分执行详情，并让 MCP 明确标记失败/未完成，而非把传输成功当编辑成功。"""
    return CallToolResult(content=[TextContent(type="text", text=json.dumps(value, ensure_ascii=False))],
                          structuredContent=value, isError=value.get("status") not in {"succeeded", "preflight"})


def capture_states_result(queue_root: Path, result: dict[str, Any], columns: int = 3, max_cell: int = 640) -> CallToolResult:
    """验证所有原生 PNG 后生成一张有界联系图；保留原始图路径供放大验收。"""
    from PIL import Image, ImageDraw

    if not 1 <= columns <= 4 or not 128 <= max_cell <= 1024:
        raise ValueError("columns 范围 1..4，max_cell 范围 128..1024")
    captures = result.get("captures", [])
    if not 1 <= len(captures) <= 12:
        raise ValueError("未取得 1..12 张有效截图")
    cols = min(columns, len(captures))
    rows = (len(captures) + cols - 1) // cols
    cell_limit = min(max_cell, 4096 // cols, 4096 // rows - 28, int((8_000_000 / len(captures)) ** 0.5) - 28)
    pictures = []
    for capture in captures:
        checked = capture_result(queue_root, capture)
        block = next((c for c in checked.content if isinstance(c, ImageContent)), None)
        if block is None:
            return CallToolResult(content=[TextContent(type="text", text=json.dumps(result, ensure_ascii=False))], isError=False)
        with Image.open(BytesIO(base64.b64decode(block.data, validate=True))) as source:
            picture = source.convert("RGBA")
        picture.thumbnail((cell_limit, cell_limit))
        pictures.append(picture)
    cell_width = max(p.width for p in pictures)
    cell_height = max(p.height for p in pictures) + 28
    rows = (len(pictures) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cell_width, rows * cell_height), "#303030")
    drawing = ImageDraw.Draw(sheet)
    # Numbers are portable even where no CJK font is installed; the text metadata maps them to full labels.
    for index, picture in enumerate(pictures):
        x, y = index % cols * cell_width, index // cols * cell_height
        drawing.text((x + 8, y + 6), f"{index + 1}", fill="white")
        sheet.paste(picture, (x, y + 28), picture)
    output = BytesIO()
    sheet.save(output, format="PNG")
    if len(output.getvalue()) > MAX_BYTES:
        raise ValueError("联系图超过 16 MiB，请减小 max_cell 或状态数量")
    metadata = {**result, "contactSheet": {"width": sheet.width, "height": sheet.height, "columns": cols},
                "labels": [{"index": i + 1, "label": c["label"], "path": c.get("path")} for i, c in enumerate(captures)]}
    return CallToolResult(content=[TextContent(type="text", text=json.dumps(metadata, ensure_ascii=False)),
                                  ImageContent(type="image", mimeType="image/png", data=base64.b64encode(output.getvalue()).decode("ascii"))])
