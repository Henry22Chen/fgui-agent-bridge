"""对象复制/层级的 MCP、CLI、能力协商、批量边界和编译插件宿主契约。"""
import asyncio
from contextlib import redirect_stdout
import io
from pathlib import Path
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from fairygui_agent import cli, mcp_server as m
from fairygui_agent.bridge_client import STRUCTURE_CAPABILITIES, BridgeClient, BridgeError
from fairygui_agent.performance import validate_batch


class ObjectStructureTests(unittest.TestCase):
    def test_mcp_maps_names_offsets_and_multi_object_aliases(self):
        with patch.object(m._client, 'call', return_value={}) as call:
            m.fgui_get_child_order(); call.assert_called_with('get_child_order')
            m.fgui_reorder_objects(['a', 'b'], save=True); call.assert_called_with('reorder_objects', {'orderedIds': ['a', 'b'], 'save': True})
            m.fgui_duplicate_objects([{'id': 'a'}], offset={'x': 0, 'y': -10}, names={'a': 'new'}, refs={'a': 'copy'}, external_references='preserve', save=True)
            call.assert_called_with('duplicate_objects', {'targets': [{'id': 'a'}], 'offset': {'x': 0, 'y': -10}, 'names': {'a': 'new'},
                                                        'refs': {'a': 'copy'}, 'namingPolicy': 'auto_rename', 'externalReferences': 'preserve', 'save': True})

    def test_registered_mcp_preserves_invalid_numeric_input_for_native_preflight(self):
        with patch.object(m._client, 'call', return_value={'changed': True}) as call:
            tool = m.mcp._tool_manager.get_tool('fgui_duplicate_objects')
            asyncio.run(tool.run({'targets': [{'id': 'a'}], 'offset': {'x': '1', 'y': False}}, convert_result=True))
            self.assertEqual(call.call_args.args[1]['offset'], {'x': '1', 'y': False})
        for action in STRUCTURE_CAPABILITIES: self.assertIsNotNone(m.mcp._tool_manager.get_tool('fgui_' + action))

    def test_cli_maps_all_structure_actions(self):
        cases = [(['get-child-order'], 'get_child_order', {}),
                 (['reorder-objects', '["a","b"]', '--save'], 'reorder_objects', {'orderedIds': ['a', 'b'], 'save': True}),
                 (['duplicate-objects', '[{"id":"a"}]', '--offset-x', '10', '--naming-policy', 'error', '--external-references', 'preserve', '--refs', '{"a":"copy"}'],
                  'duplicate_objects', {'targets': [{'id': 'a'}], 'offset': {'x': 10, 'y': 0}, 'namingPolicy': 'error', 'externalReferences': 'preserve', 'refs': {'a': 'copy'}, 'save': False})]
        for args, action, params in cases:
            client = Mock(); client.call_raw.return_value = {'ok': True}
            with patch('sys.argv', ['fgui-agent', *args]), patch.object(cli, 'BridgeClient', return_value=client), redirect_stdout(io.StringIO()):
                self.assertEqual(cli.main(), 0)
            client.call_raw.assert_called_once_with(action, params, timeout=10.0)

    def test_legacy_plugin_rejects_direct_and_batch_before_queue(self):
        client = BridgeClient.__new__(BridgeClient)
        client.project_context = lambda: SimpleNamespace(queue_root=Path(__file__).parent)
        client.ensure_ready = lambda: {'capabilities': ['apply_batch']}
        for action in STRUCTURE_CAPABILITIES:
            with self.assertRaisesRegex(BridgeError, '0.16.0'): client.call_raw(action)
            with self.assertRaisesRegex(BridgeError, '0.16.0'): client.call_raw('apply_batch', {'operations': [{'action': action, 'params': {}}]})

    def test_batch_uses_explicit_multi_clone_refs_and_rejects_conflicts(self):
        duplicate = {'action': 'duplicate_objects', 'params': {'targets': [{'id': 'a'}], 'refs': {'a': 'copy'}}}
        validate_batch([duplicate, {'action': 'reorder_objects', 'params': {'orderedIds': ['a', '$copy']}}], 'structure')
        for operations in [[{**duplicate, 'ref': 'one'}], [duplicate, duplicate],
                           [{'action': 'duplicate_objects', 'params': {'targets': [{'id': 'a'}], 'refs': {'a': 'same', 'b': 'same'}}}],
                           [{'action': 'get_child_order', 'params': {}}],
                           [{'action': 'reorder_objects', 'params': {'orderedIds': ['a'], 'save': True}}]]:
            with self.assertRaises(ValueError): validate_batch(operations, 'bad-structure')

    def test_compiled_structure_host_contracts(self):
        result = subprocess.run(['node', str(Path(__file__).with_name('structure_host_harness.cjs'))], capture_output=True, text=True, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
