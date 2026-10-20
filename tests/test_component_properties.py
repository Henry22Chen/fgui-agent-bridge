"""组件属性接口的宿主语义、批量边界和实际 MCP/CLI 映射回归。"""
from contextlib import redirect_stdout
import io
from pathlib import Path
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from fairygui_agent import cli, mcp_server as m
from fairygui_agent.bridge_client import BridgeClient, BridgeError, COMPONENT_PROPERTY_CAPABILITIES
from fairygui_agent.performance import validate_batch


class ComponentPropertyTests(unittest.TestCase):
    def test_legacy_capability_gate_including_nested_batch(self):
        client = BridgeClient.__new__(BridgeClient)
        client.project_context = lambda: SimpleNamespace(queue_root=Path(__file__).parent)
        client.ensure_ready = lambda: {'capabilities': ['apply_batch']}
        for action in COMPONENT_PROPERTY_CAPABILITIES:
            self.assertTrue(hasattr(m, 'fgui_' + action))
            with self.assertRaisesRegex(BridgeError, '0.11.0'):
                client.call_raw(action)
        with self.assertRaisesRegex(BridgeError, '0.11.0'):
            client.call_raw('apply_batch', {'operations': [{'action': 'set_controller_properties'}]})

    def test_mapping_retains_empty_zero_false_and_omitted_label(self):
        fake = Mock()
        with patch.object(m, '_client', fake):
            m.fgui_set_component_instance_controller('State', page_index=0, object_id='x')
            fake.call.assert_called_with('set_component_instance_controller', {'target': {'id': 'x'}, 'controllerName': 'State', 'pageIndex': 0, 'save': False})
            m.fgui_set_component_instance_property('label', 0, '', object_id='x', save=True)
            self.assertEqual(fake.call.call_args.args[1]['value'], '')
            m.fgui_upsert_component_property('label', 0)
            self.assertNotIn('label', fake.call.call_args.args[1])
            m.fgui_set_controller_properties('State', {'exported': False, 'alias': ''})
            self.assertEqual(fake.call.call_args.args[1]['settings'], {'exported': False, 'alias': ''})
            with self.assertRaises(ValueError):
                m.fgui_set_component_instance_controller('State', object_id='x')

    def test_batch_accepts_new_writers_and_ref_target(self):
        operations = [
            {'action': 'set_controller_properties', 'params': {'controllerName': 'State', 'settings': {'exported': True}}},
            {'action': 'upsert_component_property', 'params': {'childPath': 'label', 'propertyId': 0}},
            {'action': 'remove_component_property', 'params': {'childPath': 'label', 'propertyId': 0}},
            {'action': 'insert_object', 'ref': 'instance', 'params': {'url': 'ui://test'}},
            {'action': 'set_component_instance_controller', 'params': {'target': {'id': '$instance'}, 'controllerName': 'State', 'pageIndex': 0}},
            {'action': 'set_component_instance_property', 'params': {'target': {'id': '$instance'}, 'childPath': 'label', 'propertyId': 0, 'value': ''}},
        ]
        validate_batch(operations, 'component-properties')
        with self.assertRaises(ValueError):
            validate_batch([{'action': 'set_controller_properties', 'params': {'controllerName': 'State', 'save': True}}], 'bad')

    def test_cli_uses_raw_text_and_new_settings(self):
        cases = [
            (['set-component-instance-property', 'label', '0', 'true', '--id', 'x'], 'set_component_instance_property', {'target': {'id': 'x'}, 'childPath': 'label', 'propertyId': 0, 'value': 'true', 'save': False}),
            (['set-component-instance-controller', 'State', '--page-index', '0', '--id', 'x'], 'set_component_instance_controller', {'target': {'id': 'x'}, 'controllerName': 'State', 'pageIndex': 0, 'save': False}),
            (['set-controller-properties', 'State', '{"exported":false,"alias":""}'], 'set_controller_properties', {'controllerName': 'State', 'settings': {'exported': False, 'alias': ''}, 'save': False}),
            (['upsert-component-property', 'label', '0', '--label', '文案'], 'upsert_component_property', {'childPath': 'label', 'propertyId': 0, 'label': '文案', 'save': False}),
        ]
        for args, action, params in cases:
            fake = Mock()
            fake.call_raw.return_value = {'ok': True}
            with patch('sys.argv', ['fgui-agent', *args]), patch.object(cli, 'BridgeClient', return_value=fake), redirect_stdout(io.StringIO()):
                self.assertEqual(cli.main(), 0)
            fake.call_raw.assert_called_once_with(action, params, timeout=10.0)

    def test_compiled_native_property_semantics(self):
        result = subprocess.run(['node', str(Path(__file__).with_name('component_properties_host_harness.cjs'))], capture_output=True, text=True, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
