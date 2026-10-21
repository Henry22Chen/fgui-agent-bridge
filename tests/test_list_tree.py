"""列表与树扩展的 MCP 类型保留、旧插件拒绝、CLI/批量契约及编译插件宿主回归。"""
import asyncio
from contextlib import redirect_stdout
import io
from pathlib import Path
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from fairygui_agent import cli, mcp_server as m
from fairygui_agent.bridge_client import LIST_ADVANCED_FIELDS, BridgeClient, BridgeError
from fairygui_agent.performance import validate_batch


class ListTreeTests(unittest.TestCase):
    def test_mcp_advanced_fields_and_tree_levels_use_existing_tools(self):
        with patch.object(m._client, 'call', return_value={}) as call:
            m.fgui_set_list_settings({'treeViewEnabled': True, 'selectionController': '', 'indent': 0}, object_id='list')
            call.assert_called_with('set_list_settings', {'target': {'id': 'list'}, 'settings': {'treeViewEnabled': True, 'selectionController': '', 'indent': 0}, 'save': False})
            m.fgui_set_list_item_resources({'items': [{'sourceIndex': 0, 'level': 0}, {'sourceIndex': 1, 'level': 1}]}, object_id='list', save=True)
            self.assertEqual(call.call_args.args[1]['settings']['items'][1]['level'], 1)
            self.assertTrue(call.call_args.args[1]['save'])

    def test_registered_mcp_retains_invalid_types_for_native_preflight(self):
        for action, settings in [('set_list_settings', {'indent': '1', 'clickToExpand': False}), ('set_list_item_resources', {'items': [{'level': '0'}, {'level': True}]})]:
            with patch.object(m._client, 'call', return_value={}) as call:
                asyncio.run(m.mcp._tool_manager.get_tool('fgui_' + action).run({'settings': settings, 'object_id': 'list'}, convert_result=True))
                self.assertEqual(call.call_args.args[1]['settings'], settings)

    def test_old_plugins_reject_each_advanced_field_and_levels_before_queue_including_batch(self):
        client = BridgeClient.__new__(BridgeClient)
        client.project_context = lambda: SimpleNamespace(queue_root=Path(__file__).parent)
        client.ensure_ready = lambda: {'capabilities': ['apply_batch', 'set_list_settings', 'set_list_item_resources']}
        operations = [{'action': 'set_list_settings', 'params': {'settings': {key: False}}} for key in LIST_ADVANCED_FIELDS]
        operations += [{'action': 'set_list_item_resources', 'params': {'settings': {'items': [{'level': 0}]}}}]
        for op in operations:
            for action, params in [(op['action'], op['params']), ('apply_batch', {'operations': [op]})]:
                with self.assertRaisesRegex(BridgeError, '0.18.0'): client.call_raw(action, params)

    def test_cli_maps_advanced_settings_and_level_without_new_commands(self):
        cases = [(['set-list-settings', '{"treeViewEnabled":true,"indent":24}', '--id', 'list', '--save'], 'set_list_settings', {'treeViewEnabled': True, 'indent': 24}),
                 (['set-list-item-resources', '{"items":[{"sourceIndex":0,"level":0}]}', '--id', 'list', '--save'], 'set_list_item_resources', {'items': [{'sourceIndex': 0, 'level': 0}]})]
        for args, action, settings in cases:
            client = Mock(); client.call_raw.return_value = {'ok': True}
            with patch('sys.argv', ['fgui-agent', *args]), patch.object(cli, 'BridgeClient', return_value=client), redirect_stdout(io.StringIO()):
                self.assertEqual(cli.main(), 0)
            client.call_raw.assert_called_once_with(action, {'target': {'id': 'list'}, 'settings': settings, 'save': True}, timeout=10.0)

    def test_batch_preserves_existing_actions_aliases_and_whole_plan_save(self):
        ops = [{'action': 'create_object', 'ref': 'tree', 'params': {'objectType': 'list'}},
               {'action': 'set_list_settings', 'params': {'target': {'id': '$tree'}, 'settings': {'treeViewEnabled': True}}},
               {'action': 'set_list_item_resources', 'params': {'target': {'id': '$tree'}, 'settings': {'items': [{'level': 0}]}}}]
        validate_batch(ops, 'tree')
        with self.assertRaises(ValueError): validate_batch([{**ops[2], 'params': {**ops[2]['params'], 'save': True}}], 'bad-tree')

    def test_compiled_list_tree_contracts(self):
        result = subprocess.run(['node', str(Path(__file__).with_name('list_tree_host_harness.cjs'))], capture_output=True, text=True, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
