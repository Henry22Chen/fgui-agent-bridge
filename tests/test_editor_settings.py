"""新增 Editor 设置的协议映射、版本协商和编译宿主回归。"""
from contextlib import redirect_stdout
import io
from pathlib import Path
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from fairygui_agent import cli, mcp_server as m
from fairygui_agent.bridge_client import BridgeClient, BridgeError, EDITOR_SETTING_CAPABILITIES
from fairygui_agent.performance import validate_batch


class EditorSettingsTests(unittest.TestCase):
    def test_all_new_tools_registered_and_dispatchable(self):
        source = (Path(__file__).resolve().parents[1] / 'plugin/main.ts').read_text(encoding='utf-8')
        for action in EDITOR_SETTING_CAPABILITIES:
            self.assertIsNotNone(m.mcp._tool_manager.get_tool('fgui_' + action))
            self.assertIn('case "' + action + '"', source)

    def test_mcp_settings_and_empty_values_are_forwarded(self):
        for kind, settings in [('group', {'advanced': False}), ('input', {'promptText': ''})]:
            with patch.object(m._client, 'call') as call:
                getattr(m, 'fgui_set_' + kind + '_settings')(settings, object_id='n1', save=True)
                call.assert_called_once_with('set_' + kind + '_settings', {'target': {'id': 'n1'}, 'settings': settings, 'save': True})
        with patch.object(m._client, 'call') as call:
            m.fgui_set_mask_settings({'maskId': ''})
            call.assert_called_once_with('set_mask_settings', {'settings': {'maskId': ''}, 'save': False})
        with patch.object(m._client, 'call') as call:
            m.fgui_replace_object_resource('ui://new', object_id='instance', expected_type='component', preserve_size=False)
            self.assertFalse(call.call_args.args[1]['preserveSize'])
            self.assertEqual(call.call_args.args[1]['expectedType'], 'component')

    def test_cli_maps_root_settings_without_target_and_native_resource_replacement(self):
        cases = [
            (['set-group-settings', '{"advanced":true}', '--id', 'g', '--save'], 'set_group_settings', {'target': {'id': 'g'}, 'settings': {'advanced': True}, 'save': True}),
            (['set-input-settings', '{"promptText":""}', '--id', 'i'], 'set_input_settings', {'target': {'id': 'i'}, 'settings': {'promptText': ''}, 'save': False}),
            (['get-mask-settings'], 'get_mask_settings', {}),
            (['set-mask-settings', '{"maskId":""}', '--save'], 'set_mask_settings', {'settings': {'maskId': ''}, 'save': True}),
            (['replace-object-resource', 'ui://new', '--id', 'i', '--expected-type', 'component', '--no-preserve-size'], 'replace_object_resource',
             {'target': {'id': 'i'}, 'resourceURL': 'ui://new', 'expectedType': 'component', 'preserveSize': False, 'verify': True, 'save': False}),
        ]
        for args, action, expected in cases:
            client = Mock(); client.call_raw.return_value = {'ok': True}
            with patch('sys.argv', ['fgui-agent', *args]), patch.object(cli, 'BridgeClient', return_value=client), redirect_stdout(io.StringIO()):
                self.assertEqual(cli.main(), 0)
            client.call_raw.assert_called_once_with(action, expected, timeout=10.0)

    def test_old_plugin_rejects_new_actions_and_new_fields_before_queue(self):
        client = BridgeClient.__new__(BridgeClient)
        client.project_context = lambda: SimpleNamespace(queue_root=Path(__file__).parent)
        client.ensure_ready = lambda: {'capabilities': ['apply_batch', 'set_list_settings', 'replace_object_resource']}
        operations = [{'action': a, 'params': {}} for a in EDITOR_SETTING_CAPABILITIES]
        operations += [
            {'action': 'set_list_settings', 'params': {'settings': {'clearOnPublish': False}}},
            {'action': 'replace_object_resource', 'params': {'expectedType': 'component'}},
            {'action': 'replace_object_resource', 'params': {}},
        ]
        for op in operations:
            for action, params in [(op['action'], op['params']), ('apply_batch', {'operations': [op]})]:
                with self.assertRaisesRegex(BridgeError, '0.13.0'):
                    client.call_raw(action, params)

    def test_batch_allows_new_writes_but_never_individual_saves(self):
        operations = [
            {'action': 'set_group_settings', 'params': {'target': {'id': 'g'}, 'settings': {'advanced': True}}},
            {'action': 'set_input_settings', 'params': {'target': {'id': 'i'}, 'settings': {'promptText': ''}}},
            {'action': 'set_mask_settings', 'params': {'settings': {'maskId': 'mask'}}},
            {'action': 'replace_object_resource', 'params': {'target': {'id': 'i'}, 'resourceURL': 'ui://new', 'expectedType': 'component'}},
        ]
        validate_batch(operations, 'editor-settings')
        for op in operations:
            with self.assertRaises(ValueError):
                validate_batch([{**op, 'params': {**op['params'], 'save': True}}], 'editor-settings-save')

    def test_compiled_plugin_native_host_contract(self):
        result = subprocess.run(['node', str(Path(__file__).with_name('editor_settings_host_harness.cjs'))], capture_output=True, text=True, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
