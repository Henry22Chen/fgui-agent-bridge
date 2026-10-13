"""Windows 编辑器进程身份查询与定向激活，不依赖标题或启动命令行。"""

from __future__ import annotations

import ctypes
from ctypes import wintypes
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
from pathlib import Path


@dataclass(frozen=True)
class EditorProcess:
    pid: int
    executable: Path | None
    started_at: str | None


class _ProcessEntry(ctypes.Structure):
    _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
               ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
               ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", wintypes.LONG), ("dwFlags", wintypes.DWORD),
               ("szExeFile", wintypes.WCHAR * 260)]


class WindowsEditorProcesses:
    """仅查询进程、恢复指定 PID 的窗口及协调首次启动，不关闭任何编辑器。"""

    def __init__(self) -> None:
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.user = ctypes.WinDLL("user32", use_last_error=True)
        signatures = {
            "OpenProcess": ([wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE),
            "CloseHandle": ([wintypes.HANDLE], wintypes.BOOL),
            "GetExitCodeProcess": ([wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL),
            "QueryFullProcessImageNameW": ([wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL),
            "GetProcessTimes": ([wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4, wintypes.BOOL),
            "CreateToolhelp32Snapshot": ([wintypes.DWORD, wintypes.DWORD], wintypes.HANDLE),
            "Process32FirstW": ([wintypes.HANDLE, ctypes.POINTER(_ProcessEntry)], wintypes.BOOL),
            "Process32NextW": ([wintypes.HANDLE, ctypes.POINTER(_ProcessEntry)], wintypes.BOOL),
            "CreateMutexW": ([ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR], wintypes.HANDLE),
            "WaitForSingleObject": ([wintypes.HANDLE, wintypes.DWORD], wintypes.DWORD),
            "ReleaseMutex": ([wintypes.HANDLE], wintypes.BOOL),
        }
        for name, (arguments, result) in signatures.items():
            function = getattr(self.kernel, name)
            function.argtypes, function.restype = arguments, result
        self.callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        self.user.EnumWindows.argtypes = [self.callback_type, wintypes.LPARAM]
        self.user.EnumWindows.restype = wintypes.BOOL
        self.user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        self.user.IsWindowVisible.argtypes = [wintypes.HWND]
        self.user.ShowWindowAsync.argtypes = [wintypes.HWND, ctypes.c_int]
        self.user.SetForegroundWindow.argtypes = [wintypes.HWND]

    def inspect(self, pid: int) -> EditorProcess | None:
        """返回活动进程的真实 exe 与 UTC 启动时间，防止 PID 被回收后误认。"""
        handle = self.kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return None
        try:
            exit_code = wintypes.DWORD()
            if not self.kernel.GetExitCodeProcess(handle, ctypes.byref(exit_code)) or exit_code.value != 259:
                return None
            executable = ctypes.create_unicode_buffer(32768)
            size = wintypes.DWORD(len(executable))
            times = [wintypes.FILETIME() for _ in range(4)]
            if not self.kernel.QueryFullProcessImageNameW(handle, 0, executable, ctypes.byref(size)):
                return None
            if not self.kernel.GetProcessTimes(handle, *(ctypes.byref(value) for value in times)):
                return None
            ticks = (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime
            seconds, fraction = divmod(ticks, 10_000_000)
            started_at = datetime.fromtimestamp(seconds - 11_644_473_600, timezone.utc).strftime("%Y%m%d%H%M%S") + f"{fraction:07d}"
            return EditorProcess(pid, Path(executable.value), started_at)
        finally:
            self.kernel.CloseHandle(handle)

    def list_editors(self, executable: Path) -> list[EditorProcess]:
        """无法读取身份的同名进程也保留，避免因权限不足而误判为无人运行。"""
        snapshot = self.kernel.CreateToolhelp32Snapshot(2, 0)
        if snapshot == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            entry = _ProcessEntry()
            entry.dwSize = ctypes.sizeof(entry)
            has_entry = self.kernel.Process32FirstW(snapshot, ctypes.byref(entry))
            result = []
            while has_entry:
                if entry.szExeFile.casefold() == executable.name.casefold():
                    result.append(self.inspect(entry.th32ProcessID) or EditorProcess(entry.th32ProcessID, None, None))
                has_entry = self.kernel.Process32NextW(snapshot, ctypes.byref(entry))
            return result
        finally:
            self.kernel.CloseHandle(snapshot)

    def activate(self, pid: int) -> bool:
        """只恢复指定进程的窗口；系统拒绝前台切换时也不启动替代实例。"""
        windows = []

        @self.callback_type
        def visit(window, _):
            owner = wintypes.DWORD()
            self.user.GetWindowThreadProcessId(window, ctypes.byref(owner))
            if owner.value == pid and self.user.IsWindowVisible(window):
                windows.append(window)
            return True

        self.user.EnumWindows(visit, 0)
        if not windows:
            return False
        self.user.ShowWindowAsync(windows[0], 9)
        return bool(self.user.SetForegroundWindow(windows[0]))

    @contextmanager
    def launch_guard(self, project_file: Path):
        """同一工程的不同 MCP 进程只能串行检查并启动编辑器。"""
        key = hashlib.sha256(str(project_file.resolve()).casefold().encode("utf-8")).hexdigest()
        mutex = self.kernel.CreateMutexW(None, False, "Local\\FGUIAgentBridge-" + key)
        if not mutex:
            raise ctypes.WinError(ctypes.get_last_error())
        acquired = False
        try:
            wait_result = self.kernel.WaitForSingleObject(mutex, 0)
            acquired = wait_result in (0, 0x80)
            if wait_result == 0xFFFFFFFF:
                raise ctypes.WinError(ctypes.get_last_error())
            yield acquired
        finally:
            if acquired:
                self.kernel.ReleaseMutex(mutex)
            self.kernel.CloseHandle(mutex)
