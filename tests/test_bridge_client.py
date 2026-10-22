"""BridgeClient 队列超时语义测试（临时目录模拟插件响应，无需编辑器）。"""

from __future__ import annotations

import json
import tempfile
import threading
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

from fairygui_agent import PROTOCOL_VERSION, __version__
from fairygui_agent.bridge_client import REQUIRED_CAPABILITIES, BridgeClient, BridgeError
from fairygui_agent.project_locator import ProjectLocator


def _write_fresh_status(queue_root: Path) -> None:
    status = {
        "online": True,
        "bridgeVersion": __version__,
        "protocolVersion": PROTOCOL_VERSION,
        "project": {"basePath": str(queue_root.parent)},
        "capabilities": sorted(REQUIRED_CAPABILITIES),
        "timestamp": datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z"),
    }
    (queue_root / "status.json").write_text(json.dumps(status), encoding="utf-8")


def _make_client(root: Path) -> BridgeClient:
    project_file = root / "FairyGUI.fairy"
    project_file.write_text("{}", encoding="utf-8")
    queue_root = root / ".agent"
    (queue_root / "requests").mkdir(parents=True)
    (queue_root / "responses").mkdir(parents=True)
    _write_fresh_status(queue_root)
    launcher = MagicMock()
    launcher.read_project_status.side_effect = lambda _: json.loads((queue_root / "status.json").read_text(encoding="utf-8"))
    return BridgeClient(
        ProjectLocator(str(project_file)),
        launcher,
        timeout=0.1,
        heartbeat_max_age=15.0,
        timeout_grace=0.3,
    )


class TestBridgeClientTimeout(unittest.TestCase):
    def test_transient_response_read_and_cleanup_locks_never_replay_write(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root=Path(temp_dir)
            client=_make_client(root)
            read_text=Path.read_text
            replace=__import__('os').replace
            unlink=Path.unlink
            calls={'writes':0,'reads':0,'cleanup':0}

            def publish(source, destination):
                replace(source,destination)
                path=Path(destination)
                if path.parent.name=='requests':
                    calls['writes']+=1
                    request=json.loads(read_text(path,encoding='utf8'))
                    (root/'.agent/responses'/path.name).write_text(json.dumps({'id':request['id'],'ok':True,'result':{'done':True}}),encoding='utf8')

            def locked_read(path, *args, **kwargs):
                if path.parent.name=='responses':
                    calls['reads']+=1
                    if calls['reads']==1:
                        raise PermissionError('temporary native writer lock')
                return read_text(path,*args,**kwargs)

            def locked_cleanup(path, *args, **kwargs):
                if path.parent.name=='responses':
                    calls['cleanup']+=1
                    raise PermissionError('temporary cleanup lock')
                return unlink(path,*args,**kwargs)

            with patch('fairygui_agent.bridge_client.os.replace',side_effect=publish), patch.object(Path,'read_text',locked_read), patch.object(Path,'unlink',locked_cleanup):
                self.assertEqual(client.call('set_property',{'value':1}),{'done':True})
            self.assertEqual(calls,{'writes':1,'reads':2,'cleanup':1})
            client.launcher.wake.assert_not_called()

    def test_timeout_cleans_unclaimed_request_and_warns(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            client = _make_client(root)
            with self.assertRaisesRegex(TimeoutError, "重复执行"):
                client.call("ping")
            self.assertEqual(list((root / ".agent" / "requests").glob("*.json")), [])
            client.launcher.wake.assert_not_called()

    def test_late_response_within_grace_is_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            client = _make_client(root)

            def late_plugin() -> None:
                requests_dir = root / ".agent" / "requests"
                files: list[Path] = []
                deadline = time.monotonic() + 2.0
                while time.monotonic() < deadline:
                    files = list(requests_dir.glob("*.json"))
                    if files:
                        break
                    time.sleep(0.01)
                if not files:
                    return
                time.sleep(0.2)  # 主循环 0.1s 已超时，宽限期内送达的响应仍有效
                request = json.loads(files[0].read_text(encoding="utf-8"))
                response = {
                    "id": request["id"],
                    "ok": True,
                    "action": request["action"],
                    "result": {"late": True},
                }
                (root / ".agent" / "responses" / f"{request['id']}.json").write_text(
                    json.dumps(response), encoding="utf-8"
                )

            thread = threading.Thread(target=late_plugin)
            thread.start()
            try:
                result = client.call("ping")
            finally:
                thread.join()
            self.assertEqual(result, {"late": True})
            client.launcher.wake.assert_not_called()

    def test_other_project_status_is_rejected_before_queue_write(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            client = _make_client(root)
            status_file = root / ".agent/status.json"
            status = json.loads(status_file.read_text(encoding="utf-8"))
            status["project"]["basePath"] = str(root / "other-project")
            status_file.write_text(json.dumps(status), encoding="utf-8")
            with self.assertRaisesRegex(BridgeError, "工程路径"):
                client.call("get_tree")
            client.launcher.wake.assert_not_called()
            self.assertEqual(list((root / ".agent/requests").glob("*.json")), [])

    def test_request_is_bound_to_selected_process_queue(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            client = _make_client(root)
            status_file = root / ".agent/status.json"
            status = json.loads(status_file.read_text(encoding="utf-8"))
            status.update(editorProcessId=42, editorProcessStartedAt="202610130100001234567")
            status_file.write_text(json.dumps(status), encoding="utf-8")
            with self.assertRaises(TimeoutError):
                client.call("get_tree")
            self.assertTrue((root / ".agent/instances/42-202610130100001234567/responses").is_dir())
            self.assertEqual(list((root / ".agent/requests").glob("*.json")), [])
            client.launcher.wake.assert_not_called()


if __name__ == "__main__":
    unittest.main()
