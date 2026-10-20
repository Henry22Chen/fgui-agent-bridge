"""列表项编辑的 MCP/CLI、能力协商、批量和编译插件回归。"""
import asyncio
from contextlib import redirect_stdout
import io
from pathlib import Path
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from fairygui_agent import cli, mcp_server as m
from fairygui_agent.bridge_client import BridgeClient, BridgeError, LIST_ITEM_CAPABILITIES
from fairygui_agent.performance import validate_batch


class ListItemTests(unittest.TestCase):
    def test_capabilities_match_plugin_dispatch_and_registered_mcp_tools(self):
        plugin = (Path(__file__).resolve().parents[1] / 'plugin/main.ts').read_text(encoding='utf-8')
        for action in LIST_ITEM_CAPABILITIES:
            self.assertIn('"' + action + '"', plugin)
            self.assertIn('case "' + action + '"', plugin)
            self.assertIsNotNone(m.mcp._tool_manager.get_tool('fgui_' + action))

    def test_legacy_plugin_rejected_before_queue_including_batch(self):
        client = BridgeClient.__new__(BridgeClient)
        client.project_context = lambda: SimpleNamespace(queue_root=Path(__file__).parent)
        client.ensure_ready = lambda: {'capabilities': ['apply_batch']}
        for action in LIST_ITEM_CAPABILITIES:
            with self.assertRaisesRegex(BridgeError, '0.12.0'):
                client.call_raw(action)
        with self.assertRaisesRegex(BridgeError, '0.12.0'):
            client.call_raw('apply_batch', {'operations': [{'action': 'set_list_item_resources'}]})

    def test_mcp_registered_tools_preserve_empty_values_and_zero_indices(self):
        settings = {'defaultItem': '', 'items': [{'sourceIndex': 0, 'title': '', 'properties': []}]}
        with patch.object(m._client, 'call', return_value={'changed': True}) as call:
            result = asyncio.run(m.mcp._tool_manager.get_tool('fgui_set_list_item_resources').run({'settings': settings, 'object_id': 'list1', 'save': False}, convert_result=True))
            self.assertIn('changed', str(result))
            call.assert_called_once_with('set_list_item_resources', {'target': {'id': 'list1'}, 'settings': settings, 'save': False})
        with patch.object(m, '_client') as client:
            m.fgui_get_list_item_resources(object_path='root/list')
            client.call.assert_called_once_with('get_list_item_resources', {'target': {'path': 'root/list'}})
            with self.assertRaises(ValueError):
                m.fgui_get_list_item_resources(object_id='x', object_name='x')

    def test_cli_get_and_set_forward_settings(self):
        cases = [
            (['get-list-item-resources', '--id', 'list1'], 'get_list_item_resources', {'target': {'id': 'list1'}}),
            (['set-list-item-resources', '{"defaultItem":"","items":[]}', '--id', 'list1', '--save'], 'set_list_item_resources', {'target': {'id': 'list1'}, 'settings': {'defaultItem': '', 'items': []}, 'save': True}),
        ]
        for args, action, expected in cases:
            client = Mock()
            client.call_raw.return_value = {'ok': True}
            with patch('sys.argv', ['fgui-agent', *args]), patch.object(cli, 'BridgeClient', return_value=client), redirect_stdout(io.StringIO()):
                self.assertEqual(cli.main(), 0)
            client.call_raw.assert_called_once_with(action, expected, timeout=10.0)

    def test_batch_accepts_list_alias_and_rejects_per_operation_save(self):
        operations = [
            {'action': 'create_object', 'ref': 'items', 'params': {'objectType': 'list'}},
            {'action': 'set_list_item_resources', 'params': {'target': {'id': '$items'}, 'settings': {'defaultItem': 'ui://item', 'items': [{}, {}]}}},
        ]
        validate_batch(operations, 'list-items')
        operations[1]['params']['save'] = True
        with self.assertRaises(ValueError):
            validate_batch(operations, 'bad-list-items')

    def test_compiled_plugin_list_item_semantics(self):
        result = subprocess.run(['node', str(Path(__file__).with_name('list_items_host_harness.cjs'))], capture_output=True, text=True, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
