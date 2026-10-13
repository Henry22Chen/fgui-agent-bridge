"""按平台唤醒或打开 FairyGUI Editor。"""

from __future__ import annotations

import os
import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

EDITOR_ENV = "FAIRYGUI_EDITOR_PATH"
LEGACY_EDITOR_ENV = "FAIRYGUI_EDITOR_APP"


class EditorLaunchError(RuntimeError):
    """实例身份不明或目标存在歧义，必须停止自动启动。"""


def process_scope(status: dict[str, Any]) -> str | None:
    """进程启动时间使用 UTC yyyyMMddHHmmssfffffff 字符串，不能转浮点数。"""
    pid, started = status.get("editorProcessId"), status.get("editorProcessStartedAt")
    if type(pid) is int and pid > 0 and isinstance(started, str) and len(started) == 21 and started.isascii() and started.isdecimal():
        return f"{pid}-{started}"
    return None


class EditorLauncher:
    """封装编辑器路径解析与平台差异。"""

    def __init__(self, editor_path: str | None = None) -> None:
        configured = editor_path or os.environ.get(EDITOR_ENV) or os.environ.get(LEGACY_EDITOR_ENV)
        self.editor_path = Path(configured).expanduser() if configured else self._find_default_editor()
        self._processes = None

    def _windows_processes(self):
        if self._processes is None:
            from .windows_editor import WindowsEditorProcesses
            self._processes = WindowsEditorProcesses()
        return self._processes

    @staticmethod
    def _read_json(path: Path) -> dict[str, Any] | None:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else None
        except (OSError, ValueError):
            return None

    def read_project_status(self, project_file: Path) -> dict[str, Any] | None:
        """Windows 只信任目标目录的实例记录，并核对实际 exe、PID 和启动时间。"""
        root = project_file.parent / ".agent"
        if sys.platform != "win32":
            return self._read_json(root / "status.json")
        if not self.editor_path:
            raise EditorLaunchError("Windows 必须配置 FAIRYGUI_EDITOR_PATH 才能校验编辑器身份。")
        matches = []
        for path in (root / "instances").glob("*/status.json"):
            status = self._read_json(path)
            if not status or status.get("online") is not True or process_scope(status) != path.parent.name:
                continue
            project = status.get("project")
            base_path = project.get("basePath") if isinstance(project, dict) else None
            if not isinstance(base_path, str) or Path(base_path).resolve() != project_file.parent.resolve():
                continue
            process = self._windows_processes().inspect(status["editorProcessId"])
            if process and process.executable and process.executable.resolve() == self.editor_path.resolve() and process.started_at == status["editorProcessStartedAt"]:
                matches.append(status)
        if len(matches) > 1:
            pids = ", ".join(str(value["editorProcessId"]) for value in matches)
            raise EditorLaunchError(f"目标工程存在多个已确认实例（PID {pids}）；请保留一个，Bridge 不会任意选择或再开窗口。")
        if matches:
            return matches[0]
        # 旧插件记录只用于显示版本与排障；没有实例身份时绝不能据此发送指令。
        legacy = self._read_json(root / "status.json")
        if legacy:
            return {**legacy, "online": False}
        return None

    def _wake_windows(self, project_file: Path, *, allow_launch: bool) -> bool:
        processes = self._windows_processes()
        status = self.read_project_status(project_file)
        if status and status.get("online") is True and process_scope(status):
            processes.activate(status["editorProcessId"])
            return True
        if not allow_launch:
            return False
        with processes.launch_guard(project_file) as acquired:
            if not acquired:
                return False
            # 持锁后重新检查，防止两个 MCP 会话同时看见“没有实例”。
            status = self.read_project_status(project_file)
            if status and status.get("online") is True and process_scope(status):
                processes.activate(status["editorProcessId"])
                return True
            if processes.list_editors(self.editor_path):
                raise EditorLaunchError(f"已有 FairyGUI 进程，但无法确认它当前打开的是 {project_file}。请手动打开目标工程并重新加载新版插件；不会按标题或启动参数复用，也不会重复启动。")
            launch_file = project_file.parent / ".agent" / "launch.json"
            previous = self._read_json(launch_file)
            if previous and time.time() - float(previous.get("timestamp", 0)) < 30:
                return False
            launch_file.parent.mkdir(parents=True, exist_ok=True)
            launch_file.write_text(json.dumps({"timestamp": time.time()}), encoding="utf-8")
            subprocess.Popen([str(self.editor_path), str(project_file)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return True

    @staticmethod
    def _find_default_editor() -> Path | None:
        if sys.platform == "darwin":
            candidates = [
                Path("/Applications/FairyGUI-Editor.app"),
                Path.home() / "Applications" / "FairyGUI-Editor.app",
                Path.home() / "Downloads" / "FairyGUI-Editor.app",
            ]
            return next((path for path in candidates if path.exists()), None)
        return None

    def wake(self, project_file: Path, *, open_project: bool = False) -> bool:
        """激活已确认的目标实例；open_project 才允许在无人运行时启动一次。"""

        try:
            if sys.platform == "darwin":
                command = ["open"]
                if self.editor_path and self.editor_path.exists():
                    command.extend(["-a", str(self.editor_path)])
                    if open_project:
                        command.append(str(project_file))
                elif open_project:
                    command.append(str(project_file))
                else:
                    command.extend(["-a", "FairyGUI-Editor"])
                subprocess.run(
                    command,
                    check=False,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                return True

            if sys.platform == "win32":
                if self.editor_path and self.editor_path.is_file():
                    return self._wake_windows(project_file.resolve(), allow_launch=open_project)
                raise EditorLaunchError("FairyGUI Editor 路径无效，请检查 FAIRYGUI_EDITOR_PATH；不使用无法校验身份的文件关联启动。")
        except OSError:
            return False

        return False
