"""外观编辑的 MCP/CLI 映射、旧插件拒绝和编译插件宿主契约。"""
import asyncio
from contextlib import redirect_stdout
import io
from pathlib import Path
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from fairygui_agent import cli, mcp_server as m
from fairygui_agent.bridge_client import BridgeClient, BridgeError, VISUAL_CAPABILITIES
from fairygui_agent.performance import validate_batch


class VisualSettingsTests(unittest.TestCase):
    def test_new_tools_and_plugin_dispatch_are_consistent(self):
        source = (Path(__file__).resolve().parents[1] / 'plugin/main.ts').read_text(encoding='utf-8')
        for action in VISUAL_CAPABILITIES:
            self.assertIn('case "' + action + '"', source)
            self.assertIsNotNone(m.mcp._tool_manager.get_tool('fgui_' + action))

    def test_registered_mcp_calls_keep_transparency_zero_and_false(self):
        cases = [
            ('set_graph_settings', {'fillColor': '#12345600', 'lineSize': 0, 'cornerRadius': [0, 0, 0, 0]}),
            ('set_image_display', {'fillMethod': 'radial360', 'fillAmount': 0, 'fillClockwise': False}),
            ('set_filter_settings', {'type': 'color', 'brightness': 0}),
        ]
        for action, settings in cases:
            with patch.object(m._client, 'call', return_value={'changed': True}) as call:
                tool = m.mcp._tool_manager.get_tool('fgui_' + action)
                result = asyncio.run(tool.run({'object_id': 'n1', 'settings': settings, 'save': True}, convert_result=True))
                self.assertIn('changed', str(result))
                call.assert_called_once_with(action, {'target': {'id': 'n1'}, 'settings': settings, 'save': True})
        with patch.object(m._client, 'call') as call:
            m.fgui_get_filter_settings(object_path='root/title')
            call.assert_called_once_with('get_filter_settings', {'target': {'path': 'root/title'}})

    def test_cli_maps_every_new_get_and_set(self):
        for kind in ['graph-settings', 'image-display', 'filter-settings']:
            for verb in ['get', 'set']:
                args = [f'{verb}-{kind}', '--id', 'n1']
                expected = {'target': {'id': 'n1'}}
                if verb == 'set':
                    args += ['{"value":0}', '--save']
                    expected.update(settings={'value': 0}, save=True)
                client = Mock(); client.call_raw.return_value = {'ok': True}
                with patch('sys.argv', ['fgui-agent', *args]), patch.object(cli, 'BridgeClient', return_value=client), redirect_stdout(io.StringIO()):
                    self.assertEqual(cli.main(), 0)
                client.call_raw.assert_called_once_with(f'{verb}_{kind.replace("-", "_")}', expected, timeout=10.0)

    def test_legacy_plugin_rejects_all_visual_actions_before_queue_including_batch(self):
        client = BridgeClient.__new__(BridgeClient)
        client.project_context = lambda: SimpleNamespace(queue_root=Path(__file__).parent)
        client.ensure_ready = lambda: {'capabilities': ['apply_batch']}
        for action in VISUAL_CAPABILITIES:
            with self.assertRaisesRegex(BridgeError, '0.14.0'):
                client.call_raw(action)
            with self.assertRaisesRegex(BridgeError, '0.14.0'):
                client.call_raw('apply_batch', {'operations': [{'action': action, 'params': {}}]})

    def test_batch_accepts_visual_setters_but_not_getters_or_per_step_save(self):
        operations = [{'action': a, 'params': {'target': {'id': 'n1'}, 'settings': {'type': 'none'}}} for a in VISUAL_CAPABILITIES if a.startswith('set_')]
        validate_batch(operations, 'visual')
        for op in operations:
            with self.assertRaises(ValueError):
                validate_batch([{**op, 'params': {**op['params'], 'save': True}}], 'visual-save')
        with self.assertRaises(ValueError):
            validate_batch([{'action': 'get_image_display', 'params': {'target': {'id': 'n1'}}}], 'visual-read')

    def test_compiled_plugin_visual_host_contract(self):
        result = subprocess.run(['node', str(Path(__file__).with_name('visual_host_harness.cjs'))], capture_output=True, text=True, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
