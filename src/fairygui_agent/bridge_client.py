"""FairyGUI Editor JSON 文件队列客户端。"""

from __future__ import annotations

import json
import os
import time
import uuid
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Any

from . import PROTOCOL_VERSION, __version__
from .editor_launcher import EditorLaunchError, EditorLauncher, process_scope
from .project_locator import ProjectContext, ProjectLocator

REQUIRED_CAPABILITIES = frozenset(
    {
        "ping",
        "get_project",
        "list_packages",
        "list_items",
        "open_document",
        "create_component",
        "import_image",
        "import_font",
        "create_button",
        "get_active_document",
        "get_tree",
        "select_object",
        "set_property",
        "insert_object",
        "remove_object",
        "save_document",
        "save_all",
        "get_publish_settings",
        "publish",
        "get_history",
        "discard_document",
        "undo",
        "redo",
        "verify_document",
        "replace_object_resource",
        "get_text_style",
        "set_text_style",
    }
)

ANIMATION_CAPABILITIES = frozenset(
    {
        "import_sound",
        "create_movieclip",
        "get_movieclip",
        "update_movieclip",
        "remove_movieclip",
        "list_transitions",
        "get_transition",
        "upsert_transition",
        "remove_transition",
        "add_transition_item",
        "update_transition_item",
        "remove_transition_item",
        "preview_animation",
    }
)

SPINE_CAPABILITIES = frozenset({"get_loader3d", "set_loader3d", "capture_document", "fix_spine_anchor"})
CONTROLLER_CAPABILITIES = frozenset({"get_controllers", "create_controller", "add_controller_page", "rename_controller_page", "set_controller_page"})
GEAR_CAPABILITIES = frozenset({"get_gears", "set_gear"})
CONTROLLER_ACTION_CAPABILITIES = frozenset({"get_controller_actions", "upsert_controller_action", "remove_controller_action"})
EDITING_CAPABILITIES = frozenset({"get_image_settings", "set_image_settings", "create_object", "set_properties", "get_button_binding", "set_button_binding",
    "get_list_settings", "set_list_settings", "get_scroll_settings", "set_scroll_settings", "get_group", "set_group", "get_relations", "add_relation", "remove_relation", "get_loader", "set_loader"})
PERFORMANCE_CAPABILITIES = frozenset({"apply_batch", "get_batch_result", "get_objects", "capture_states", "begin_external_edit", "finish_external_edit"})


class BridgeError(RuntimeError):
    """桥接器连接、协议或命令错误。"""


class BridgeCommandError(BridgeError):
    """FairyGUI Editor 返回的业务错误。"""

    def __init__(self, action: str, message: str, code: str | None = None, details: dict[str, Any] | None = None) -> None:
        super().__init__(f"{action} 失败：{message}")
        self.action = action
        self.bridge_message = message
        self.code = code
        self.details = details


def status_age(status: dict[str, Any] | None) -> float:
    if status is None:
        return float("inf")
    try:
        timestamp = str(status["timestamp"])
        heartbeat = datetime.fromisoformat(timestamp.replace("Z", "+00:00")).timestamp()
        return max(0.0, time.time() - heartbeat)
    except (KeyError, TypeError, ValueError):
        return float("inf")


class BridgeClient:
    """供 CLI 和 MCP 共用的桥接客户端。"""

    def __init__(
        self,
        locator: ProjectLocator,
        launcher: EditorLauncher | None = None,
        *,
        timeout: float = 10.0,
        heartbeat_max_age: float = 15.0,
        timeout_grace: float = 2.0,
    ) -> None:
        self.locator = locator
        self.launcher = launcher if launcher is not None else EditorLauncher()
        self.timeout = timeout
        # 插件心跳按真实时间写入；阈值放宽以容忍编辑器低帧率和短暂主线程停顿。
        self.heartbeat_max_age = heartbeat_max_age
        # 超时后的宽限期：请求可能已被认领并刚好在超时后完成。
        self.timeout_grace = timeout_grace

    def project_context(self) -> ProjectContext:
        return self.locator.resolve()

    def read_status(self) -> dict[str, Any] | None:
        try:
            return self.launcher.read_project_status(self.project_context().project_file)
        except EditorLaunchError as exc:
            raise BridgeError(str(exc)) from exc

    def describe_status(self) -> dict[str, Any]:
        context = self.project_context()
        status = self.read_status()
        plugin_version = status.get("bridgeVersion") if status else None
        version_match = (plugin_version == __version__) if plugin_version else None
        result: dict[str, Any] = {
            "project": context.as_dict(),
            "statusFile": str(context.queue_root / "status.json"),
            "heartbeatAgeSeconds": status_age(status),
            "online": status is not None and status.get("online") is True and status_age(status) <= self.heartbeat_max_age,
            "bridgeClientVersion": __version__,
            "pluginVersion": plugin_version,
            "versionMatch": version_match,
            "status": status,
        }
        if status and plugin_version and not version_match:
            result["updateWarning"] = (
                f"编辑器插件版本 (v{plugin_version}) 与 Bridge 客户端版本 (v{__version__}) 不一致，"
                "建议执行更新同步并在 FairyGUI Editor 中重新打开工程。"
            )
        return result

    def _validate_status(self, status: dict[str, Any]) -> None:
        project = status.get("project")
        base_path = project.get("basePath") if isinstance(project, dict) else None
        if not isinstance(base_path, str) or Path(base_path).resolve() != self.project_context().project_dir.resolve():
            raise BridgeError("插件当前工程路径与目标工程不一致，拒绝发送指令。")
        protocol = str(status.get("protocolVersion", ""))
        expected_major = PROTOCOL_VERSION.split(".", 1)[0]
        actual_major = protocol.split(".", 1)[0] if protocol else ""
        if actual_major != expected_major:
            bridge_version = status.get("bridgeVersion", "unknown")
            raise BridgeError(
                "FairyGUI Agent Bridge 协议不兼容："
                f"客户端需要 {PROTOCOL_VERSION}，编辑器报告 {protocol or '未提供'} "
                f"(bridge {bridge_version})。请更新或重新加载编辑器插件。"
            )

        capabilities = {str(item) for item in status.get("capabilities", [])}
        missing = sorted(REQUIRED_CAPABILITIES - capabilities)
        if missing:
            raise BridgeError(f"FairyGUI Agent Bridge 缺少能力：{', '.join(missing)}")

    def ensure_ready(self) -> dict[str, Any]:
        context = self.project_context()
        status = self.read_status()
        if status and status.get("online") is True and status_age(status) <= self.heartbeat_max_age:
            self._validate_status(status)
            return status

        try:
            self.launcher.wake(context.project_file, open_project=True)
        except EditorLaunchError as exc:
            raise BridgeError(str(exc)) from exc
        deadline = time.monotonic() + 7.0
        while time.monotonic() < deadline:
            status = self.read_status()
            if status and status.get("online") is True and status_age(status) <= self.heartbeat_max_age:
                self._validate_status(status)
                return status
            time.sleep(0.1)

        age = status_age(status)
        if status is None:
            raise BridgeError(
                f"未发现 {context.queue_root / 'status.json'}。请打开 {context.project_file}，"
                "并确认 FGUI Agent Bridge 插件已加载。"
            )
        raise BridgeError(
            f"FairyGUI Agent Bridge 心跳仍未恢复（{age:.1f} 秒）。请检查 FairyGUI 编辑器控制台。"
        )

    def call_raw(
        self,
        action: str,
        params: dict[str, Any] | None = None,
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """记录 Bridge 内部计时；调用端分发及模型等待发生在此函数之外。"""
        started = time.perf_counter()
        timing: dict[str, Any] = {"action": action, "timestamp": datetime.now().astimezone().isoformat(), "failed": True}
        try:
            response = self._call_raw(action, params, timeout=timeout, _timing=timing)
            result = response.get("result")
            timing["failed"] = not bool(response.get("ok")) or (isinstance(result, dict) and result.get("status") == "failed")
            return response
        finally:
            timing["roundTripMs"] = round((time.perf_counter() - started) * 1000, 3)
            if not hasattr(self, "_diagnostics"):
                self._diagnostics = deque(maxlen=100)
            self._diagnostics.append(timing)

    def diagnostics(self, limit: int = 20) -> dict[str, Any]:
        """只读取当前 MCP 进程的有界记录，不连接或唤醒 Editor。"""
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("limit 必须为 1..100")
        return {"version": __version__, "records": list(getattr(self, "_diagnostics", []))[-limit:],
                "scope": "current_mcp_process", "hostDispatchIncluded": False, "modelTimeIncluded": False}

    def _call_raw(
        self,
        action: str,
        params: dict[str, Any] | None = None,
        *,
        timeout: float | None = None,
        _timing: dict[str, Any],
    ) -> dict[str, Any]:
        ready_started = time.perf_counter()
        context = self.project_context()
        status = self.ensure_ready()
        _timing["readinessMs"] = round((time.perf_counter() - ready_started) * 1000, 3)
        if action in PERFORMANCE_CAPABILITIES and action not in status.get("capabilities", []):
            raise BridgeError(f"FairyGUI Agent Bridge 缺少能力：{action}，请同步并重新加载 0.10.0 或更高版本插件。")
        if action in EDITING_CAPABILITIES and action not in status.get("capabilities", []):
            raise BridgeError(f"FairyGUI Agent Bridge 缺少能力：{action}，请同步并重新加载 0.9.0 或更高版本插件。")
        if action in GEAR_CAPABILITIES and action not in status.get("capabilities", []):
            raise BridgeError(f"FairyGUI Agent Bridge 缺少能力：{action}，请同步并重新加载 0.8.7 或更高版本插件。")
        if action in CONTROLLER_ACTION_CAPABILITIES and action not in status.get("capabilities", []):
            raise BridgeError(f"FairyGUI Agent Bridge 缺少能力：{action}，请同步并重新加载 0.8.8 或更高版本插件。")
        if action in CONTROLLER_CAPABILITIES and action not in status.get("capabilities", []):
            raise BridgeError(f"FairyGUI Agent Bridge 缺少能力：{action}，请同步并重新加载 0.8.6 或更高版本插件。")
        if action in SPINE_CAPABILITIES and action not in status.get("capabilities", []):
            raise BridgeError(f"FairyGUI Agent Bridge 缺少能力：{action}，请同步并重新加载 0.8.5 或更高版本插件。")
        # 旧插件会忽略未知字段；自动修复不能退化成看似成功的普通绑定/插入。
        payload_params = params or {}
        auto_fix = payload_params.get("fixSpine", True) and (action == "insert_object" or (action == "set_loader3d" and payload_params.get("url")))
        if auto_fix and "fix_spine_anchor" not in status.get("capabilities", []):
            raise BridgeError("FairyGUI Agent Bridge 缺少能力：fix_spine_anchor，请同步并重新加载 0.8.5 或更高版本插件。")
        if action in ANIMATION_CAPABILITIES:
            capabilities = {str(item) for item in status.get("capabilities", [])}
            if action not in capabilities:
                bridge_version = status.get("bridgeVersion", "unknown")
                raise BridgeError(
                    f"FairyGUI Agent Bridge 缺少动画能力：{action} "
                    f"(编辑器 bridge {bridge_version})。请更新并重新加载 0.8.1 或更高版本插件。"
                )

        scope = process_scope(status)
        queue_root = context.queue_root / "instances" / scope if scope else context.queue_root
        request_dir = queue_root / "requests"
        response_dir = queue_root / "responses"
        request_dir.mkdir(parents=True, exist_ok=True)
        response_dir.mkdir(parents=True, exist_ok=True)

        request_id = f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"
        _timing["requestId"] = request_id
        request_path = request_dir / f"{request_id}.json"
        response_path = response_dir / f"{request_id}.json"
        temp_path = request_path.with_suffix(".json.tmp")
        payload = {
            "id": request_id,
            "action": action,
            "params": params or {},
            "protocolVersion": PROTOCOL_VERSION,
            "projectPath": str(context.project_dir),
            "createdAt": datetime.now().astimezone().isoformat(),
            "clientPid": os.getpid(),
        }
        encoded = json.dumps(payload, ensure_ascii=False)
        _timing["requestBytes"] = len(encoded.encode("utf-8"))
        temp_path.write_text(encoded, encoding="utf-8")
        os.replace(temp_path, request_path)
        wait_started = time.perf_counter()

        def read_response() -> dict[str, Any] | None:
            if not response_path.exists():
                return None
            try:
                raw = response_path.read_text(encoding="utf-8")
                _timing["responseBytes"] = len(raw.encode("utf-8"))
                _timing["requestWaitMs"] = round((time.perf_counter() - wait_started) * 1000, 3)
                response = json.loads(raw)
                _timing["editor"] = response.get("timing")
            finally:
                response_path.unlink(missing_ok=True)
            if not isinstance(response, dict):
                raise BridgeError(f"FairyGUI 返回了无效响应：{action}")
            return response

        call_timeout = self.timeout if timeout is None else timeout
        deadline = time.monotonic() + call_timeout
        # 请求已绑定目标实例。慢响应、超时及宽限期都不能再次创建编辑器进程。
        while time.monotonic() < deadline:
            response = read_response()
            if response is not None:
                return response
            time.sleep(0.05)

        grace_deadline = time.monotonic() + self.timeout_grace
        while time.monotonic() < grace_deadline:
            response = read_response()
            if response is not None:
                return response
            time.sleep(0.05)

        request_path.unlink(missing_ok=True)
        _timing["requestWaitMs"] = round((time.perf_counter() - wait_started) * 1000, 3)
        _timing["timeout"] = True
        raise TimeoutError(
            f"等待 FairyGUI 响应超时：{action} ({call_timeout:.1f}s)。"
            "请求可能已被编辑器认领并继续执行，重试前请先检查状态，避免写操作重复执行。"
        )

    def call(
        self,
        action: str,
        params: dict[str, Any] | None = None,
        *,
        timeout: float | None = None,
    ) -> Any:
        response = self.call_raw(action, params, timeout=timeout)
        if not response.get("ok"):
            error = response.get("error")
            message = error.get("message") if isinstance(error, dict) else str(error or "未知错误")
            raise BridgeCommandError(action, str(message), error.get("code") if isinstance(error, dict) else None, error.get("details") if isinstance(error, dict) else None)
        return response.get("result")
