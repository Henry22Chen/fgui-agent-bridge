"""目标工程身份与防多开回归测试；不会启动真实 FairyGUI。"""

from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from fairygui_agent.editor_launcher import EditorLaunchError, EditorLauncher
from fairygui_agent.windows_editor import EditorProcess, WindowsEditorProcesses


START = "202610130100001234567"


class FakeProcesses:
    def __init__(self):
        self.processes = {}
        self.activations = []
        self.mutex = threading.Lock()

    def inspect(self, pid):
        return self.processes.get(pid)

    def list_editors(self, executable):
        return list(self.processes.values())

    def activate(self, pid):
        self.activations.append(pid)
        return True

    @contextmanager
    def launch_guard(self, project_file):
        acquired = self.mutex.acquire(blocking=False)
        try:
            yield acquired
        finally:
            if acquired:
                self.mutex.release()


class TestEditorLauncher(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.project = self.root / "TextDemo.fairy"
        self.project.write_text("<project/>", encoding="utf-8")
        self.executable = self.root / "FairyGUI-Editor.exe"
        self.executable.touch()
        self.launcher = EditorLauncher(str(self.executable))
        self.processes = FakeProcesses()
        self.launcher._processes = self.processes
        self.platform = patch("fairygui_agent.editor_launcher.sys.platform", "win32")
        self.platform.start()
        self.spawn = patch("fairygui_agent.editor_launcher.subprocess.Popen")
        self.popen = self.spawn.start()

    def tearDown(self):
        self.spawn.stop()
        self.platform.stop()
        self.temp.cleanup()

    def instance(self, pid=42, started=START, base_path=None, online=True):
        status = {"editorProcessId": pid, "editorProcessStartedAt": started, "online": online,
                  "project": {"basePath": str(base_path or self.root)}, "timestamp": "2000-01-01T00:00:00Z"}
        status_file = self.root / ".agent/instances" / f"{pid}-{started}" / "status.json"
        status_file.parent.mkdir(parents=True, exist_ok=True)
        status_file.write_text(json.dumps(status), encoding="utf-8")
        self.processes.processes[pid] = EditorProcess(pid, self.executable, started)
        return status_file

    def test_verified_target_is_activated_without_launch(self):
        self.instance()
        self.assertTrue(self.launcher.wake(self.project, open_project=True))
        self.assertEqual(self.processes.activations, [42])
        self.popen.assert_not_called()

    def test_other_project_is_never_reused_or_reopened(self):
        self.instance(base_path=self.root / "different-clone")
        with self.assertRaisesRegex(EditorLaunchError, "无法确认"):
            self.launcher.wake(self.project, open_project=True)
        self.assertEqual(self.processes.activations, [])
        self.popen.assert_not_called()

    def test_closed_or_switched_project_record_is_not_reused(self):
        self.instance(online=False)
        with self.assertRaises(EditorLaunchError):
            self.launcher.wake(self.project, open_project=True)
        self.assertEqual(self.processes.activations, [])
        self.popen.assert_not_called()

    def test_recycled_pid_is_not_reused(self):
        self.instance()
        self.processes.processes[42] = EditorProcess(42, self.executable, "202610140100001234567")
        self.assertFalse(self.launcher.wake(self.project))
        self.assertEqual(self.processes.activations, [])
        self.popen.assert_not_called()

    def test_wrong_executable_is_not_reused(self):
        self.instance()
        self.processes.processes[42] = EditorProcess(42, self.root / "other.exe", START)
        self.assertFalse(self.launcher.wake(self.project))
        self.assertEqual(self.processes.activations, [])

    def test_dead_instance_is_not_reused(self):
        self.instance()
        self.processes.processes.clear()
        self.assertIsNone(self.launcher.read_project_status(self.project))
        self.assertFalse(self.launcher.wake(self.project))
        self.popen.assert_not_called()

    def test_multiple_target_instances_fail_without_activation(self):
        self.instance(42)
        self.instance(43)
        with self.assertRaisesRegex(EditorLaunchError, "多个已确认实例"):
            self.launcher.wake(self.project, open_project=True)
        self.assertEqual(self.processes.activations, [])
        self.popen.assert_not_called()

    def test_unknown_existing_editor_blocks_new_launch(self):
        self.processes.processes[99] = EditorProcess(99, None, None)
        with self.assertRaisesRegex(EditorLaunchError, "不会.*重复启动"):
            self.launcher.wake(self.project, open_project=True)
        self.popen.assert_not_called()

    def test_old_status_without_identity_is_offline(self):
        (self.root / ".agent").mkdir()
        (self.root / ".agent/status.json").write_text(json.dumps({"online": True, "project": {"basePath": str(self.root)}}), encoding="utf-8")
        self.assertFalse(self.launcher.read_project_status(self.project)["online"])

    def test_two_sessions_start_only_once_with_target_argument(self):
        second = EditorLauncher(str(self.executable))
        second._processes = self.processes
        self.assertTrue(self.launcher.wake(self.project, open_project=True))
        # 进程尚未被枚举到时，另一会话仍被工程级启动记录挡住。
        self.assertFalse(second.wake(self.project, open_project=True))
        self.popen.assert_called_once_with([str(self.executable), str(self.project.resolve())], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def test_concurrent_launch_guard_does_not_spawn(self):
        with self.processes.launch_guard(self.project):
            self.assertFalse(self.launcher.wake(self.project, open_project=True))
        self.popen.assert_not_called()

    def test_activation_never_starts_a_blank_window(self):
        self.assertFalse(self.launcher.wake(self.project))
        self.popen.assert_not_called()


class TestNativeProcessIdentity(unittest.TestCase):
    @unittest.skipUnless(sys.platform == "win32" and shutil.which("powershell.exe"), "Windows PowerShell")
    def test_il2cpp_probe_matches_native_process_times(self):
        probe = Path(__file__).resolve().parents[1] / "plugin/windows-process-identity.ps1"
        with tempfile.TemporaryDirectory(prefix="fgui identity ") as folder:
            output = Path(folder) / "process identity.json"
            subprocess.run([shutil.which("powershell.exe"), "-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", str(probe), "-EditorProcessId", str(os.getpid()), "-OutputPath", str(output)], capture_output=True, text=True, timeout=15, check=True)
            identity = json.loads(output.read_text(encoding="utf-8"))
        expected = WindowsEditorProcesses().inspect(os.getpid())
        self.assertEqual(identity, {"pid": expected.pid, "startedAt": expected.started_at})

    @unittest.skipUnless(sys.platform == "win32", "Windows API")
    def test_current_process_identity_and_snapshot(self):
        processes = WindowsEditorProcesses()
        identity = processes.inspect(os.getpid())
        self.assertEqual(identity.pid, os.getpid())
        self.assertEqual(identity.executable.resolve(), Path(getattr(sys, "_base_executable", sys.executable)).resolve())
        self.assertEqual(len(identity.started_at), 21)
        self.assertIn(os.getpid(), [value.pid for value in processes.list_editors(Path(sys.executable))])

    @unittest.skipUnless(sys.platform == "win32", "Windows API")
    def test_native_guard_excludes_another_thread(self):
        processes = WindowsEditorProcesses()
        results = []
        def contend():
            with WindowsEditorProcesses().launch_guard(Path(__file__)) as acquired:
                results.append(acquired)
        with processes.launch_guard(Path(__file__)) as acquired:
            self.assertTrue(acquired)
            thread = threading.Thread(target=contend)
            thread.start()
            thread.join(timeout=5)
        self.assertEqual(results, [False])

    @unittest.skipUnless(shutil.which("node"), "Node.js")
    def test_plugin_instance_lifecycle_and_queue_isolation(self):
        harness = Path(__file__).with_name("editor_instance_host_harness.cjs")
        result = subprocess.run([shutil.which("node"), str(harness)], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
