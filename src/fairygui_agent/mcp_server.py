"""FairyGUI Agent Bridge 的 MCP stdio 服务。"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any, Literal

from mcp.server.fastmcp import FastMCP
from mcp.types import CallToolResult

from . import __version__
from .animation_models import TransitionDefinition, TransitionItem
from .bridge_client import BridgeClient
from .editor_launcher import EditorLauncher
from .project_locator import ProjectLocator
from .capture import capture_result, manual_verification

mcp = FastMCP(
    "FairyGUI Agent Bridge",
    instructions=(
        "先读取工程、包和对象树，再执行修改。文档属性和对象修改默认不保存；"
        "创建组件或按钮会新增包资源，导入/替换图片、声音和 MovieClip 会写入磁盘，调用前必须确认包、目录、名称和冲突策略。"
        "Transition 编辑与已有 MovieClip 更新支持 Agent undo/redo；新建/删除资源不能完整撤销，且资源写入不能由 fgui_discard_document 回滚。"
        "动画预览只改变 Editor 当前状态，不保存资源默认属性。"
        "Gear 编辑前先读取配置；set_gear 完整替换一个 Gear，未列页面回退默认值。display 空列表表示全页可见。"
        "Spine 修复会保存所属包；插入或明确绑定 Spine 默认修复尺寸、锚点和 PMA，独立于组件 save。"
        "未获取截图时要求用户自行验证，保留修改，不自动回滚。"
        "只有用户明确要求时才调用保存工具。发布前先调用 fgui_get_publish_settings，"
        "并确认用户要求的包范围后再调用 fgui_publish。"
    ),
)
# MCP Python SDK 1.x 的 FastMCP 构造器没有公开 version 参数，需向底层 Server 写入工具版本。
mcp._mcp_server.version = __version__

_locator = ProjectLocator()
_launcher = EditorLauncher()
_client = BridgeClient(_locator, _launcher)


def configure_runtime(
    *,
    project: str | None = None,
    editor: str | None = None,
    timeout: float = 10.0,
) -> None:
    global _locator, _launcher, _client
    _locator = ProjectLocator(project)
    _launcher = EditorLauncher(editor)
    _client = BridgeClient(_locator, _launcher, timeout=timeout)


def _target(
    object_id: str | None,
    object_path: str | None,
    object_name: str | None,
) -> dict[str, str]:
    values = [("id", object_id), ("path", object_path), ("name", object_name)]
    selected = [(key, value.strip()) for key, value in values if value and value.strip()]
    if len(selected) != 1:
        raise ValueError("object_id、object_path、object_name 必须且只能提供一个")
    key, value = selected[0]
    return {key: value}

def _resource_target(
    url: str | None,
    package_name: str | None,
    item_name: str | None,
    item_path: str | None,
) -> dict[str, str]:
    if url and url.strip():
        if package_name or item_name or item_path:
            raise ValueError("url 不能与 package_name/item_name/item_path 同时提供")
        return {"url": url.strip()}
    if not package_name or not package_name.strip():
        raise ValueError("必须提供 url，或 package_name 与 item_name/item_path")
    choices = [("itemName", item_name), ("itemPath", item_path)]
    selected = [(key, value.strip()) for key, value in choices if value and value.strip()]
    if len(selected) != 1:
        raise ValueError("使用 package_name 时，item_name、item_path 必须且只能提供一个")
    key, value = selected[0]
    return {"packageName": package_name.strip(), key: value}


@mcp.tool()
def fgui_status() -> dict[str, Any]:
    """读取本地 FairyGUI 工程选择和桥接心跳，不主动唤醒编辑器。"""
    return _client.describe_status()


@mcp.tool()
def fgui_ping() -> dict[str, Any]:
    """唤醒 FairyGUI Editor 并验证桥接协议、版本和能力。"""
    return _client.call("ping")


@mcp.tool()
def fgui_use_project(project_path: str) -> dict[str, Any]:
    """为当前 MCP 会话选择 .fairy 文件、FairyGUI 工程目录或仓库目录。"""
    return _locator.use_project(project_path).as_dict()


@mcp.tool()
def fgui_get_project() -> dict[str, Any]:
    """读取当前 FairyGUI 工程信息。"""
    return _client.call("get_project")


@mcp.tool()
def fgui_list_packages() -> list[dict[str, Any]]:
    """列出当前 FairyGUI 工程中的全部包。"""
    return _client.call("list_packages")


@mcp.tool()
def fgui_list_items(package_name: str, item_type: str | None = None) -> list[dict[str, Any]]:
    """列出指定包中的资源，可按 FairyGUI 资源类型过滤。"""
    params: dict[str, Any] = {"packageName": package_name}
    if item_type:
        params["type"] = item_type
    return _client.call("list_items", params)


@mcp.tool()
def fgui_open_document(package_name: str, item_name: str) -> dict[str, Any]:
    """按包名和资源名打开 FairyGUI 组件文档。"""
    return _client.call("open_document", {"packageName": package_name, "itemName": item_name})


@mcp.tool()
def fgui_create_component(
    package_name: str,
    component_name: str,
    width: float = 800,
    height: float = 600,
    folder_path: str = "",
    extension_id: str | None = None,
    exported: bool = True,
    auto_rename: bool = False,
    create_folders: bool = True,
    open_after_create: bool = True,
) -> dict[str, Any]:
    """在指定包中新建组件文档；默认打开但不保存，重名时默认拒绝。"""
    params: dict[str, Any] = {
        "packageName": package_name,
        "componentName": component_name,
        "width": width,
        "height": height,
        "folderPath": folder_path,
        "exported": exported,
        "autoRename": auto_rename,
        "createFolders": create_folders,
        "openAfterCreate": open_after_create,
    }
    if extension_id:
        params["extensionId"] = extension_id
    return _client.call("create_component", params)


@mcp.tool()
def fgui_import_image(
    package_name: str,
    source_path: str,
    folder_path: str = "",
    resource_name: str | None = None,
    conflict_policy: Literal["error", "auto_rename", "replace"] = "error",
    exported: bool = True,
    create_folders: bool = True,
    timeout_seconds: float = 120,
) -> dict[str, Any]:
    """从绝对本地路径导入图片；这是磁盘写入操作，支持拒绝、自动改名或替换同名图片。"""
    if timeout_seconds <= 0 or timeout_seconds > 1800:
        raise ValueError("timeout_seconds 必须在 0 到 1800 之间")
    resolved_source = Path(source_path).expanduser().resolve()
    params: dict[str, Any] = {
        "packageName": package_name,
        "sourcePath": str(resolved_source),
        "folderPath": folder_path,
        "conflictPolicy": conflict_policy,
        "exported": exported,
        "createFolders": create_folders,
    }
    if resource_name:
        params["resourceName"] = resource_name
    return _client.call("import_image", params, timeout=timeout_seconds)


@mcp.tool()
def fgui_import_font(
    package_name: str,
    source_path: str,
    folder_path: str = "",
    resource_name: str | None = None,
    conflict_policy: Literal["error", "auto_rename", "replace"] = "error",
    exported: bool = True,
    create_folders: bool = True,
    timeout_seconds: float = 120,
) -> dict[str, Any]:
    """从绝对本地路径导入字体；这是磁盘写入操作，支持拒绝、自动改名或替换同名字体。"""
    if timeout_seconds <= 0 or timeout_seconds > 1800:
        raise ValueError("timeout_seconds 必须在 0 到 1800 之间")
    resolved_source = Path(source_path).expanduser().resolve()
    params: dict[str, Any] = {
        "packageName": package_name,
        "sourcePath": str(resolved_source),
        "folderPath": folder_path,
        "conflictPolicy": conflict_policy,
        "exported": exported,
        "createFolders": create_folders,
    }
    if resource_name:
        params["resourceName"] = resource_name
    return _client.call("import_font", params, timeout=timeout_seconds)


@mcp.tool()
def fgui_create_button(
    package_name: str,
    button_name: str,
    width: float = 160,
    height: float = 60,
    folder_path: str = "",
    mode: Literal["common", "check", "radio"] = "common",
    image_urls: list[str] | None = None,
    create_text: bool = True,
    create_icon: bool = True,
    create_relations: bool = True,
    as_list_item: bool = False,
    exported: bool = True,
    auto_rename: bool = False,
    create_folders: bool = True,
    open_after_create: bool = True,
    extension_id: str | None = None,
) -> dict[str, Any]:
    """创建标准 FairyGUI Button 组件；状态图顺序为 up/down/over/selectedOver/disabled/selectedDisabled。"""
    params: dict[str, Any] = {
        "packageName": package_name,
        "buttonName": button_name,
        "width": width,
        "height": height,
        "folderPath": folder_path,
        "mode": mode,
        "imageUrls": image_urls or [],
        "createText": create_text,
        "createIcon": create_icon,
        "createRelations": create_relations,
        "asListItem": as_list_item,
        "exported": exported,
        "autoRename": auto_rename,
        "createFolders": create_folders,
        "openAfterCreate": open_after_create,
    }
    if extension_id:
        params["extensionId"] = extension_id
    return _client.call("create_button", params)


@mcp.tool()
def fgui_get_active_document() -> dict[str, Any]:
    """读取当前活动文档、修改状态和选择数量。"""
    return _client.call("get_active_document")


@mcp.tool()
def fgui_get_tree(max_depth: int = 12) -> dict[str, Any]:
    """读取当前组件对象树；修改前应先取得稳定的对象 ID 或路径。"""
    if max_depth < 0 or max_depth > 64:
        raise ValueError("max_depth 必须在 0 到 64 之间")
    return _client.call("get_tree", {"maxDepth": max_depth})


@mcp.tool()
def fgui_import_sound(
    package_name: str,
    source_path: str,
    folder_path: str = "",
    resource_name: str | None = None,
    conflict_policy: Literal["error", "auto_rename", "replace"] = "error",
    exported: bool = True,
    create_folders: bool = True,
    timeout_seconds: float = 120,
) -> dict[str, Any]:
    """从绝对本地路径导入声音资源；支持替换同名声音，属于磁盘写入。"""
    if timeout_seconds <= 0 or timeout_seconds > 1800:
        raise ValueError("timeout_seconds 必须在 0 到 1800 之间")
    params: dict[str, Any] = {
        "packageName": package_name,
        "sourcePath": str(Path(source_path).expanduser().resolve()),
        "folderPath": folder_path,
        "conflictPolicy": conflict_policy,
        "exported": exported,
        "createFolders": create_folders,
    }
    if resource_name:
        params["resourceName"] = resource_name
    return _client.call("import_sound", params, timeout=timeout_seconds)


@mcp.tool()
def fgui_create_movieclip(
    package_name: str,
    movieclip_name: str,
    frame_paths: list[str],
    folder_path: str = "",
    fps: int = 12,
    repeat_delay: int = 0,
    swing: bool = False,
    frame_delays: list[int] | None = None,
    conflict_policy: Literal["error", "auto_rename", "replace"] = "error",
    exported: bool = True,
    create_folders: bool = True,
    timeout_seconds: float = 120,
) -> dict[str, Any]:
    """用有序绝对图片路径创建或替换 MovieClip；图片序列由 FairyGUI 原生动画资源处理。"""
    if not frame_paths:
        raise ValueError("frame_paths 至少需要一帧")
    if not 1 <= fps <= 255 or not 0 <= repeat_delay <= 255:
        raise ValueError("fps 必须是 1 到 255，repeat_delay 必须是 0 到 255 的额外延迟帧数")
    if timeout_seconds <= 0 or timeout_seconds > 1800:
        raise ValueError("timeout_seconds 必须在 0 到 1800 之间")
    params: dict[str, Any] = {
        "packageName": package_name,
        "movieClipName": movieclip_name,
        "framePaths": [str(Path(path).expanduser().resolve()) for path in frame_paths],
        "folderPath": folder_path,
        "fps": fps,
        "repeatDelay": repeat_delay,
        "swing": swing,
        "conflictPolicy": conflict_policy,
        "exported": exported,
        "createFolders": create_folders,
    }
    if frame_delays is not None:
        if len(frame_delays) != len(frame_paths) or any(delay < 0 or delay > 255 for delay in frame_delays):
            raise ValueError("frame_delays 必须与 frame_paths 等长，且每项在 0 到 255 之间")
        params["frameDelays"] = frame_delays
    return _client.call("create_movieclip", params, timeout=timeout_seconds)


@mcp.tool()
def fgui_get_movieclip(
    url: str | None = None,
    package_name: str | None = None,
    item_name: str | None = None,
    item_path: str | None = None,
) -> dict[str, Any]:
    """读取 MovieClip 的帧、FPS、Swing 和 RepeatDelay 设置。"""
    return _client.call("get_movieclip", _resource_target(url, package_name, item_name, item_path))


@mcp.tool()
def fgui_update_movieclip(
    url: str | None = None,
    package_name: str | None = None,
    item_name: str | None = None,
    item_path: str | None = None,
    frame_paths: list[str] | None = None,
    fps: int | None = None,
    speed: float | None = None,
    repeat_delay: int | None = None,
    swing: bool | None = None,
    frame_delays: list[int] | None = None,
    exported: bool | None = None,
    timeout_seconds: float = 120,
) -> dict[str, Any]:
    """更新已有 MovieClip；传入 frame_paths 时使用新的有序图片序列替换动画帧。"""
    if timeout_seconds <= 0 or timeout_seconds > 1800:
        raise ValueError("timeout_seconds 必须在 0 到 1800 之间")
    if fps is not None and not 1 <= fps <= 255:
        raise ValueError("fps 必须是 1 到 255 之间的整数")
    if repeat_delay is not None and not 0 <= repeat_delay <= 255:
        raise ValueError("repeat_delay 必须是 0 到 255 的额外延迟帧数")
    params = _resource_target(url, package_name, item_name, item_path)
    if frame_paths is not None:
        if not frame_paths:
            raise ValueError("frame_paths 至少需要一帧")
        params["framePaths"] = [str(Path(path).expanduser().resolve()) for path in frame_paths]
    if speed is not None and not 0.001 <= speed <= 1000:
        raise ValueError("speed 必须在 0.001 到 1000 之间")
    if frame_delays is not None and any(delay < 0 or delay > 255 for delay in frame_delays):
        raise ValueError("frame_delays 每项必须在 0 到 255 之间")
    updates = (("fps", fps), ("speed", speed), ("repeatDelay", repeat_delay), ("swing", swing), ("frameDelays", frame_delays), ("exported", exported))
    for key, value in updates:
        if value is not None:
            params[key] = value
    if not any(value is not None for _, value in updates) and frame_paths is None:
        raise ValueError("至少需要提供一个 MovieClip 更新字段")
    return _client.call("update_movieclip", params, timeout=timeout_seconds)


@mcp.tool()
def fgui_remove_movieclip(
    force: bool = False,
    url: str | None = None,
    package_name: str | None = None,
    item_name: str | None = None,
    item_path: str | None = None,
) -> dict[str, Any]:
    """删除 MovieClip 包资源；这是不可逆资源操作，必须显式 force=True。"""
    params = _resource_target(url, package_name, item_name, item_path)
    params["force"] = force
    return _client.call("remove_movieclip", params)


@mcp.tool()
def fgui_list_transitions() -> list[dict[str, Any]]:
    """读取当前组件的全部 Transition 及类型化关键帧。"""
    return _client.call("list_transitions")


@mcp.tool()
def fgui_get_transition(name: str) -> dict[str, Any]:
    """按名称读取当前组件的一个 Transition。"""
    return _client.call("get_transition", {"name": name})


@mcp.tool()
def fgui_upsert_transition(transition: TransitionDefinition) -> dict[str, Any]:
    """声明式创建或完整替换一个 Transition；一次调用可由 fgui_undo/redo 原子回退。"""
    return _client.call("upsert_transition", {"transition": transition})


@mcp.tool()
def fgui_remove_transition(name: str) -> dict[str, Any]:
    """删除当前组件中的一个 Transition；可由 fgui_undo 恢复。"""
    return _client.call("remove_transition", {"name": name})


@mcp.tool()
def fgui_add_transition_item(name: str, item: TransitionItem) -> dict[str, Any]:
    """向 Transition 添加一个类型化关键帧轨道项。"""
    return _client.call("add_transition_item", {"name": name, "item": item})


@mcp.tool()
def fgui_update_transition_item(name: str, item_index: int, item: TransitionItem) -> dict[str, Any]:
    """替换 Transition 指定索引的关键帧项；可用 fgui_undo/redo 回退。"""
    if item_index < 0:
        raise ValueError("item_index 不能小于 0")
    return _client.call("update_transition_item", {"name": name, "itemIndex": item_index, "item": item})


@mcp.tool()
def fgui_remove_transition_item(name: str, item_index: int) -> dict[str, Any]:
    """删除 Transition 指定索引的关键帧项；可用 fgui_undo 恢复。"""
    if item_index < 0:
        raise ValueError("item_index 不能小于 0")
    return _client.call("remove_transition_item", {"name": name, "itemIndex": item_index})


@mcp.tool()
def fgui_preview_animation(
    kind: Literal["transition", "movieclip"],
    operation: Literal["play", "pause", "stop", "seek", "next", "previous", "status"],
    name: str | None = None,
    document_url: str | None = None,
    frame: int | None = None,
    times: int | None = None,
    delay: float | None = None,
    start_frame: int | None = None,
    end_frame: int | None = None,
    object_id: str | None = None,
    object_path: str | None = None,
    object_name: str | None = None,
) -> dict[str, Any]:
    """在 Editor 中播放、暂停、停止、跳帧或查询预览状态；预览不会保存到 FairyGUI 资源。"""
    params: dict[str, Any] = {"kind": kind, "operation": operation}
    if kind == "transition":
        if not name:
            raise ValueError("Transition 预览需要 name")
        params["target"] = {"name": name}
        if document_url:
            params["target"]["documentUrl"] = document_url
    else:
        params["target"] = _target(object_id, object_path, object_name)
    for key, value in (("frame", frame), ("times", times), ("delay", delay), ("startFrame", start_frame), ("endFrame", end_frame)):
        if value is not None:
            params[key] = value
    return _client.call("preview_animation", params)


@mcp.tool()
def fgui_get_history() -> dict[str, Any]:
    """读取 Agent 属性事务栈和 FairyGUI 原生撤销状态。"""
    return _client.call("get_history")


@mcp.tool()
def fgui_select_object(
    object_id: str | None = None,
    object_path: str | None = None,
    object_name: str | None = None,
) -> dict[str, Any]:
    """通过对象 ID、对象树路径或唯一名称选择一个对象。"""
    return _client.call("select_object", {"target": _target(object_id, object_path, object_name)})


@mcp.tool()
def fgui_get_gears(object_id: str | None = None, object_path: str | None = None, object_name: str | None = None) -> dict[str, Any]:
    """读取直属子对象六类 Gear 的绑定、默认值和页面值；其它 Gear 返回原始 XML，只读不创建 Gear。"""
    return _client.call("get_gears", {"target": _target(object_id, object_path, object_name)})


@mcp.tool()
def fgui_set_gear(gear_type: str, controller_name: str, default_value: Any = None,
                  page_values: list[dict[str, Any]] | None = None, visible_page_ids: list[str] | None = None,
                  object_id: str | None = None, object_path: str | None = None, object_name: str | None = None,
                  save: bool = False) -> dict[str, Any]:
    """绑定控制器并完整替换一个 Gear 的配置，其它 Gear 保留；默认不保存，不支持 Agent undo。

    gear_type 为 display/text/icon/xy/size/color。display 使用 visible_page_ids，空数组表示所有页可见。
    其它类型必须提供 default_value 和 page_values=[{pageId: "0", value: ...}]，未列页面用默认值。
    text/icon 的 value 是字符串，图标限图片 ui:// 或空串；xy 为整数像素 {x,y}；size 为 {width,height,scaleX?,scaleY?}；
    color 为 {color:"#RRGGBB",strokeColor?:"#RRGGBB"}。省略缩放为 1，省略描边为黑色。文本不支持竖线。
    仅当前文档直属对象。save=true 保存整个组件并回读 XML；需切页验证布局与可见性，缺图要求人工验证、不回滚。
    """
    params: dict[str, Any] = {"target": _target(object_id, object_path, object_name), "gearType": gear_type, "controllerName": controller_name, "save": save}
    for key, value in (("defaultValue", default_value), ("pageValues", page_values), ("visiblePageIds", visible_page_ids)):
        if value is not None:
            params[key] = value
    return _client.call("set_gear", params)


@mcp.tool()
def fgui_get_controller_actions(controller_name: str) -> dict[str, Any]:
    """读取根控制器联动执行顺序，以及当前/直属子组件的控制器页面 ID 与当前状态；索引从 0 开始。"""
    return _client.call("get_controller_actions", {"controllerName": controller_name})


@mcp.tool()
def fgui_upsert_controller_action(controller_name: str, action: dict[str, Any], action_index: int | None = None,
                                  save: bool = False) -> dict[str, Any]:
    """追加联动，或按 action_index 完整替换一个联动；其它联动保留。配置编辑不触发执行。

    action 通用字段：type、fromPageIds、toPageIds；页面条件省略/空数组匹配任意页，使用源控制器稳定 ID。
    type=change_page：objectId（空串/省略表示当前组件，否则直属子组件 ID）、controllerName、targetPageId。
    type=play_transition：transitionName、repeat（默认 1，-1 循环）、delay（默认 0 秒）、stopOnExit（默认 false）。
    不支持跟随索引/名称等特殊目标页面；拒绝自引用/循环。增删后重新读取索引。
    默认不保存、不支持 Agent undo；save=true 保存整个父组件并校验联动 XML，不写子组件资源。
    """
    params: dict[str, Any] = {"controllerName": controller_name, "action": action, "save": save}
    if action_index is not None:
        params["actionIndex"] = action_index
    return _client.call("upsert_controller_action", params)


@mcp.tool()
def fgui_remove_controller_action(controller_name: str, action_index: int, save: bool = False) -> dict[str, Any]:
    """删除指定索引联动，其余保持顺序；不删除 Controller 页面。默认不保存、不支持 Agent undo。"""
    return _client.call("remove_controller_action", {"controllerName": controller_name, "actionIndex": action_index, "save": save})


@mcp.tool()
def fgui_get_controllers() -> dict[str, Any]:
    """读取当前文档根组件的控制器、页面 ID/名称/索引和当前页；嵌套组件需先打开所属文档。"""
    return _client.call("get_controllers")


@mcp.tool()
def fgui_create_controller(name: str, page_names: list[str] | None = None, save: bool = False) -> dict[str, Any]:
    """创建控制器，可指定初始页面名称；省略时创建空控制器，指定页面时选中第一页。重名拒绝，默认不保存，不支持 Agent undo。"""
    return _client.call("create_controller", {"name": name, "pages": page_names if page_names is not None else [], "save": save})


@mcp.tool()
def fgui_add_controller_page(controller_name: str, name: str, save: bool = False) -> dict[str, Any]:
    """在控制器末尾添加页面，保留已有页面 ID；默认不保存，save=true 保存整个组件并回读 XML。"""
    return _client.call("add_controller_page", {"controllerName": controller_name, "name": name, "save": save})


def _controller_page_target(page_id: str | None, page_name: str | None, page_index: int | None) -> dict[str, Any]:
    values = {key: value for key, value in (("pageId", page_id), ("pageName", page_name), ("pageIndex", page_index)) if value is not None}
    if len(values) != 1:
        raise ValueError("必须且只能提供 page_id、page_name、page_index 之一；优先使用稳定 page_id")
    return values


@mcp.tool()
def fgui_rename_controller_page(controller_name: str, name: str, page_id: str | None = None,
                                page_name: str | None = None, page_index: int | None = None, save: bool = False) -> dict[str, Any]:
    """重命名页面并保留 ID/Gear 引用；页面定位三选一，默认不保存，不支持删除或 Agent undo。"""
    return _client.call("rename_controller_page", {"controllerName": controller_name, "name": name, "save": save,
                                                    **_controller_page_target(page_id, page_name, page_index)})


@mcp.tool()
def fgui_set_controller_page(controller_name: str, page_id: str | None = None, page_name: str | None = None,
                             page_index: int | None = None, save: bool = False) -> dict[str, Any]:
    """切换当前页并应用原生 Gear/联动；不修改运行时 homePage，默认不保存，不支持 Agent undo。

    页面定位三选一，名称重复时使用 page_id。save=true 保存整个组件并校验 XML。
    失败可能已有联动效果，保留实际状态并报告，不假装完整回滚。
    """
    return _client.call("set_controller_page", {"controllerName": controller_name, "save": save,
                                                 **_controller_page_target(page_id, page_name, page_index)})


@mcp.tool()
def fgui_get_loader3d(object_id: str | None = None, object_path: str | None = None, object_name: str | None = None, include_asset_info: bool = True) -> dict[str, Any]:
    """读取 Loader3D 和包内 Spine 动画/皮肤；加载失败明确返回列表不可用。"""
    return _client.call("get_loader3d", {"target": _target(object_id, object_path, object_name), "includeAssetInfo": include_asset_info}, timeout=12)


@mcp.tool()
def fgui_set_loader3d(object_id: str | None = None, object_path: str | None = None, object_name: str | None = None,
                     resource_url: str | None = None, animation_name: str | None = None, skin_name: str | None = None,
                     playing: bool | None = None, loop: bool | None = None, frame: int | None = None,
                     save: bool = False, verify: bool = True, skip_name_validation: bool = False, fix_spine: bool = True) -> dict[str, Any]:
    """修改当前组件直属 Loader3D；缺省不改，空字符串清除。默认不保存，不支持 Agent undo。

    明确绑定 resource_url 时默认按 SpineFixer 修复并保存资源包，独立于组件 save。
    截图与写操作独立；未获取图像应要求用户自行验证，不能因此回滚。
    """
    params = {"target": _target(object_id, object_path, object_name), "save": save, "verify": verify, "skipNameValidation": skip_name_validation, "fixSpine": fix_spine}
    for key, value in (("url", resource_url), ("animationName", animation_name), ("skinName", skin_name), ("playing", playing), ("loop", loop), ("frame", frame)):
        if value is not None:
            params[key] = value
    return _client.call("set_loader3d", params, timeout=12)


@mcp.tool()
def fgui_fix_spine_anchor(url: str | None = None, package_name: str | None = None, item_name: str | None = None, item_path: str | None = None) -> dict[str, Any]:
    """按 SpineFixer 修复包内 Spine 4.2 .skel 的尺寸、锚点和 pma=false，并保存所属包。

    导入完成后可独立调用。包元数据写入不受组件 save 控制，也不能由文档 undo/discard 回滚。
    """
    return _client.call("fix_spine_anchor", _resource_target(url, package_name, item_name, item_path))


@mcp.tool()
def fgui_capture_document(scale: float = 1, expected_document_url: str | None = None) -> CallToolResult:
    """返回当前组件 PNG 图像块；大体正确即可，不要求动画帧一致。

    获取图片失败时保留修改并要求用户在 Editor 自行验证；图片返回后仍需观察，不能自动宣称视觉通过。
    """
    try:
        # 请求前固定工程路径，避免响应后工程选择变化导致读取另一工程。
        root = _client.project_context().queue_root
        result = _client.call("capture_document", {"scale": scale, "expectedDocumentUrl": expected_document_url}, timeout=20)
        return capture_result(root, result)
    except Exception as error:
        return manual_verification(str(error))


@mcp.tool()
def fgui_set_property(
    property_name: str,
    value: Any,
    object_id: str | None = None,
    object_path: str | None = None,
    object_name: str | None = None,
) -> dict[str, Any]:
    """修改白名单属性但不保存；该操作进入 Agent 属性 undo/redo 事务栈。"""
    return _client.call(
        "set_property",
        {
            "target": _target(object_id, object_path, object_name),
            "property": property_name,
            "value": value,
        },
    )


@mcp.tool()
def fgui_replace_object_resource(resource_url: str, object_id: str | None = None, object_path: str | None = None, object_name: str | None = None, expected_type: str = "image", state: str | None = None, save: bool = False, verify: bool = True) -> dict[str, Any]:
    """通过 Editor API 替换 Image/Loader 图片引用；保存后默认比对磁盘 XML。Button 状态暂不支持。"""
    params: dict[str, Any] = {"target": _target(object_id, object_path, object_name), "resourceURL": resource_url, "expectedType": expected_type, "save": save, "verify": verify}
    if state: params["state"] = state
    return _client.call("replace_object_resource", params)


@mcp.tool()
def fgui_get_text_style(object_id: str | None = None, object_path: str | None = None, object_name: str | None = None) -> dict[str, Any]:
    """读取 TextField/RichText 的统一文本样式。"""
    return _client.call("get_text_style", {"target": _target(object_id, object_path, object_name)})


@mcp.tool()
def fgui_set_text_style(style: dict[str, Any], object_id: str | None = None, object_path: str | None = None, object_name: str | None = None, save: bool = False, verify: bool = True) -> dict[str, Any]:
    """设置 TextField/RichText 的统一文本样式。"""
    return _client.call("set_text_style", {"target": _target(object_id, object_path, object_name), "style": style, "save": save, "verify": verify})


@mcp.tool()
def fgui_verify_document(max_depth: int = 12, object_id: str | None = None, object_path: str | None = None, object_name: str | None = None, expected: dict[str, Any] | None = None, read_xml: bool = True) -> dict[str, Any]:
    """只读验证 target 的 expected 属性；默认比对磁盘 XML，不保存、不重载。无 expected 时仅返回快照。"""
    params: dict[str, Any] = {"maxDepth": max_depth, "readXml": read_xml}
    if expected is not None:
        if not any((object_id, object_path, object_name)):
            raise ValueError("expected 必须提供 target")
        params["expected"] = expected
    if any((object_id, object_path, object_name)): params["target"] = _target(object_id, object_path, object_name)
    return _client.call("verify_document", params)


@mcp.tool()
def fgui_insert_object(
    url: str,
    x: float = 0,
    y: float = 0,
    name: str | None = None,
    insert_index: int | None = None,
    fix_spine: bool = True,
) -> dict[str, Any]:
    """插入已有资源，不保存组件；Spine 默认先修复并保存资源包，可用 fix_spine=false 跳过。

    结构操作不能由 Agent 属性事务栈撤销；资源修复保存不受组件保存控制。
    """
    params: dict[str, Any] = {"url": url, "x": x, "y": y, "fixSpine": fix_spine}
    if name:
        params["name"] = name
    if insert_index is not None:
        params["insertIndex"] = insert_index
    return _client.call("insert_object", params)


@mcp.tool()
def fgui_remove_object(
    object_id: str | None = None,
    object_path: str | None = None,
    object_name: str | None = None,
) -> dict[str, Any]:
    """删除非根对象但不保存；需要可靠回退时使用 fgui_discard_document。"""
    return _client.call("remove_object", {"target": _target(object_id, object_path, object_name)})


@mcp.tool()
def fgui_undo() -> dict[str, Any]:
    """优先撤销 Agent 属性事务；事务栈为空时回退到 FairyGUI 原生撤销。"""
    return _client.call("undo")


@mcp.tool()
def fgui_redo() -> dict[str, Any]:
    """优先重做 Agent 属性事务；事务栈为空时回退到 FairyGUI 原生重做。"""
    return _client.call("redo")


@mcp.tool()
def fgui_save_document() -> dict[str, Any]:
    """显式保存当前 FairyGUI 文档，并清空 Agent 属性事务栈。"""
    return _client.call("save_document")


@mcp.tool()
def fgui_save_all() -> dict[str, Any]:
    """显式保存所有 FairyGUI 文档、已打开包和工程，并清空 Agent 属性事务栈。"""
    return _client.call("save_all")


@mcp.tool()
def fgui_get_publish_settings(package_name: str | None = None) -> dict[str, Any]:
    """读取工程发布目录、格式、图集、代码生成和包级覆盖设置。发布前应先调用。"""
    params: dict[str, Any] = {}
    if package_name:
        params["packageName"] = package_name
    return _client.call("get_publish_settings", params)


@mcp.tool()
def fgui_publish(
    scope: Literal["active", "packages", "all"] = "active",
    package_names: list[str] | None = None,
    branch: str | None = None,
    save_before_publish: bool = True,
    publish_desc_only: bool = False,
    timeout_seconds: float = 120,
) -> dict[str, Any]:
    """按工程发布设置导出 FairyGUI 包。默认发布当前文档所属包并先保存；可选择指定包或全部包。"""
    if timeout_seconds <= 0 or timeout_seconds > 1800:
        raise ValueError("timeout_seconds 必须在 0 到 1800 之间")
    params: dict[str, Any] = {
        "scope": scope,
        "saveBeforePublish": save_before_publish,
        "publishDescOnly": publish_desc_only,
    }
    if package_names is not None:
        params["packageNames"] = package_names
    if branch is not None:
        params["branch"] = branch
    return _client.call("publish", params, timeout=timeout_seconds)


@mcp.tool()
def fgui_discard_document() -> dict[str, Any]:
    """放弃当前文档全部未保存修改并重新加载磁盘版本。"""
    return _client.call("discard_document")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=f"FairyGUI Agent Bridge MCP {__version__}")
    parser.add_argument("--project", help=".fairy 文件、FairyGUI 工程目录或仓库目录")
    parser.add_argument("--editor", help="FairyGUI Editor .app 或可执行文件路径")
    parser.add_argument("--timeout", type=float, default=10.0, help="桥接命令超时秒数")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    configure_runtime(project=args.project, editor=args.editor, timeout=args.timeout)
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
