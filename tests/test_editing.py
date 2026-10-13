"""原生编辑接口的能力协商、MCP 输出契约及几何/布局拒绝回归。"""
import asyncio
from contextlib import redirect_stdout
import io
from pathlib import Path
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from fairygui_agent import cli, mcp_server as m
from fairygui_agent.bridge_client import BridgeClient, BridgeError, EDITING_CAPABILITIES


class EditingTests(unittest.TestCase):
    def test_new_actions_fail_before_queue_on_legacy_plugin(self):
        client = BridgeClient.__new__(BridgeClient)
        client.project_context = lambda: SimpleNamespace(queue_root=Path(__file__).parent)
        client.ensure_ready = lambda: {'capabilities': []}
        for action in EDITING_CAPABILITIES:
            with self.subTest(action=action), self.assertRaisesRegex(BridgeError, '0.9.0'):
                client.call_raw(action)

    def test_list_items_sdk_output_contract(self):
        expected = {'package': {'name':'Probe'}, 'items': [{'id':'panel'}]}
        with patch.object(m._client, 'call', return_value=expected):
            result = asyncio.run(m.mcp._tool_manager.get_tool('fgui_list_items').run({'package_name':'Probe'}, convert_result=True))
        self.assertIn('Probe', str(result))
        self.assertIn('panel', str(result))

    def test_empty_binding_and_zero_values_survive_mcp(self):
        fake = Mock()
        with patch.object(m, '_client', fake):
            m.fgui_set_button_binding({'controllerName':'','selected':False}, object_id='tab')
            fake.call.assert_called_with('set_button_binding', {'target':{'id':'tab'},'settings':{'controllerName':'','selected':False},'save':False})
            m.fgui_set_group('', object_id='icon')
            self.assertEqual(fake.call.call_args.args[1]['groupId'], '')
            m.fgui_create_object('group', group_member_ids=['icon'], insert_index=0)
            self.assertEqual(fake.call.call_args.args[1]['insertIndex'], 0)
            self.assertEqual(fake.call.call_args.args[1]['groupMemberIds'], ['icon'])

    def test_target_ambiguity_rejected_without_call(self):
        with patch.object(m, '_client') as fake:
            with self.assertRaises(ValueError):
                m.fgui_set_loader({'fill':'scale'}, object_id='x', object_name='x')
            fake.call.assert_not_called()

    def test_cli_batch_mapping_preserves_false_and_zero(self):
        fake = Mock()
        fake.call_raw.return_value = {'ok':True}
        with patch('sys.argv', ['fgui-agent','set-properties','{"x":0,"visible":false}', '--id','icon']), patch.object(cli,'BridgeClient',return_value=fake), redirect_stdout(io.StringIO()):
            self.assertEqual(cli.main(), 0)
        fake.call_raw.assert_called_once_with('set_properties', {'target':{'id':'icon'},'properties':{'x':0,'visible':False},'save':False}, timeout=10.0)

    def test_compiled_layout_preflight_and_geometry(self):
        harness = Path(__file__).with_name('editing_host_harness.cjs')
        result = subprocess.run(['node', str(harness)], capture_output=True, text=True, encoding='utf-8')
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)


if __name__ == '__main__':
    unittest.main()
