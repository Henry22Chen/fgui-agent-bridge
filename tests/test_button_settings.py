"""按钮工具签名、CLI、版本协商、批量边界及编译插件契约。"""
import asyncio
from contextlib import redirect_stdout
import io
from pathlib import Path
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from fairygui_agent import cli, mcp_server as m
from fairygui_agent.bridge_client import BUTTON_CAPABILITIES, BridgeClient, BridgeError
from fairygui_agent.performance import validate_batch


class ButtonSettingsTests(unittest.TestCase):
    def test_mcp_scope_and_zero_empty_values(self):
        with patch.object(m._client, 'call', return_value={}) as call:
            m.fgui_get_button_settings(); call.assert_called_with('get_button_settings', {'target': {'path': 'root'}})
            m.fgui_set_button_settings({'selectedTitle': '', 'volume': 0}, object_id='n1', save=True)
            call.assert_called_with('set_button_settings', {'target': {'id': 'n1'}, 'settings': {'selectedTitle': '', 'volume': 0}, 'save': True})
            m.fgui_set_button_state_resources({'down': ''})
            call.assert_called_with('set_button_state_resources', {'settings': {'down': ''}, 'save': False})
            with self.assertRaises(ValueError): m.fgui_get_button_settings(object_id='n1', object_path='root')

    def test_registered_mcp_settings_tool(self):
        with patch.object(m._client, 'call', return_value={'changed': True}) as call:
            tool = m.mcp._tool_manager.get_tool('fgui_set_button_settings')
            asyncio.run(tool.run({'settings': {'sound': '', 'volume': 0}, 'save': False}, convert_result=True))
            call.assert_called_once_with('set_button_settings', {'target': {'path': 'root'}, 'settings': {'sound': '', 'volume': 0}, 'save': False})
        for action in BUTTON_CAPABILITIES:
            self.assertIsNotNone(m.mcp._tool_manager.get_tool('fgui_' + action))

    def test_cli_definition_instance_and_state_commands(self):
        cases = [
            (['get-button-settings'], 'get_button_settings', {'target': {'path': 'root'}}),
            (['set-button-settings', '{"volume":0}', '--save'], 'set_button_settings', {'target': {'path': 'root'}, 'settings': {'volume': 0}, 'save': True}),
            (['set-button-settings', '--id', 'n1', '{"selectedTitle":""}'], 'set_button_settings', {'target': {'id': 'n1'}, 'settings': {'selectedTitle': ''}, 'save': False}),
            (['get-button-state-resources'], 'get_button_state_resources', {}),
            (['set-button-state-resources', '{"down":""}', '--save'], 'set_button_state_resources', {'settings': {'down': ''}, 'save': True}),
        ]
        for args, action, params in cases:
            client = Mock(); client.call_raw.return_value = {'ok': True}
            with patch('sys.argv', ['fgui-agent', *args]), patch.object(cli, 'BridgeClient', return_value=client), redirect_stdout(io.StringIO()):
                self.assertEqual(cli.main(), 0)
            client.call_raw.assert_called_once_with(action, params, timeout=10.0)

    def test_old_plugin_rejects_direct_and_nested_actions_before_queue(self):
        client = BridgeClient.__new__(BridgeClient)
        client.project_context = lambda: SimpleNamespace(queue_root=Path(__file__).parent)
        client.ensure_ready = lambda: {'capabilities': ['apply_batch']}
        for action in BUTTON_CAPABILITIES:
            with self.assertRaisesRegex(BridgeError, '0.15.0'): client.call_raw(action)
            with self.assertRaisesRegex(BridgeError, '0.15.0'): client.call_raw('apply_batch', {'operations': [{'action': action, 'params': {}}]})

    def test_batch_only_accepts_settings_action_without_step_save(self):
        validate_batch([{'action': 'set_button_settings', 'params': {'target': {'id': 'n1'}, 'settings': {'volume': 0}}}], 'buttons')
        for action, params in [('set_button_state_resources', {'settings': {'down': ''}}), ('get_button_settings', {'target': {'id': 'n1'}}),
                               ('set_button_settings', {'target': {'id': 'n1'}, 'settings': {'volume': 0}, 'save': True})]:
            with self.assertRaises(ValueError): validate_batch([{'action': action, 'params': params}], 'invalid-buttons')

    def test_compiled_button_host_contracts(self):
        result = subprocess.run(['node', str(Path(__file__).with_name('button_host_harness.cjs'))], capture_output=True, text=True, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
