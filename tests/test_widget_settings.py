"""三种扩展控件的工具映射、旧插件拒绝、CLI、批量及编译插件契约。"""
import asyncio
from contextlib import redirect_stdout
import io
from pathlib import Path
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from fairygui_agent import cli, mcp_server as m
from fairygui_agent.bridge_client import WIDGET_CAPABILITIES, BridgeClient, BridgeError
from fairygui_agent.performance import validate_batch


class WidgetSettingsTests(unittest.TestCase):
    def test_mcp_definition_instance_and_raw_numeric_types(self):
        for kind in ['progress', 'slider', 'combo']:
            with patch.object(m._client, 'call', return_value={}) as call:
                getattr(m, 'fgui_get_' + kind + '_settings')()
                call.assert_called_with('get_' + kind + '_settings', {'target': {'path': 'root'}})
                settings = {'value': '0'} if kind != 'combo' else {'items': [], 'title': ''}
                tool = m.mcp._tool_manager.get_tool('fgui_set_' + kind + '_settings')
                asyncio.run(tool.run({'settings': settings, 'object_id': 'instance', 'save': True}, convert_result=True))
                call.assert_called_with('set_' + kind + '_settings', {'target': {'id': 'instance'}, 'settings': settings, 'save': True})
        with self.assertRaises(ValueError):
            m.fgui_get_progress_settings(object_id='x', object_path='root')

    def test_each_new_action_rejects_old_plugins_before_direct_or_batch_queue(self):
        client = BridgeClient.__new__(BridgeClient)
        client.project_context = lambda: SimpleNamespace(queue_root=Path(__file__).parent)
        client.ensure_ready = lambda: {'capabilities': ['apply_batch']}
        for action in WIDGET_CAPABILITIES:
            for name, params in [(action, {}), ('apply_batch', {'operations': [{'action': action, 'params': {}}]})]:
                with self.assertRaisesRegex(BridgeError, '0.19.0'): client.call_raw(name, params)

    def test_cli_six_commands_preserve_scope_empty_and_zero(self):
        for kind in ['progress', 'slider', 'combo']:
            for verb in ['get', 'set']:
                args = [verb + '-' + kind + '-settings']
                params = {'target': {'path': 'root'}}
                if verb == 'set':
                    args += ['{"volume":0}', '--id', 'instance', '--save']
                    params = {'target': {'id': 'instance'}, 'settings': {'volume': 0}, 'save': True}
                client = Mock(); client.call_raw.return_value = {'ok': True}
                with patch('sys.argv', ['fgui-agent', *args]), patch.object(cli, 'BridgeClient', return_value=client), redirect_stdout(io.StringIO()):
                    self.assertEqual(cli.main(), 0)
                client.call_raw.assert_called_once_with(verb + '_' + kind + '_settings', params, timeout=10.0)

    def test_batch_only_accepts_known_instance_writes_without_step_save(self):
        for kind in ['progress', 'slider', 'combo']:
            params = {'target': {'id': 'instance'}, 'settings': {'value': 0}}
            validate_batch([{'action': 'set_' + kind + '_settings', 'params': params}], 'widgets')
            for action, value in [('get_' + kind + '_settings', params), ('set_' + kind + '_settings', {**params, 'save': True})]:
                with self.assertRaises(ValueError): validate_batch([{'action': action, 'params': value}], 'invalid')

    def test_compiled_widget_host_contracts(self):
        result = subprocess.run(['node', str(Path(__file__).with_name('widget_host_harness.cjs'))], capture_output=True, text=True, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
