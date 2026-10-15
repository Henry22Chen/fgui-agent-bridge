"""批量协议、SDK 错误语义、计时及有界联系图回归。"""
import asyncio
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

from PIL import Image, ImageDraw

from fairygui_agent import cli, mcp_server as m
from fairygui_agent.bridge_client import PERFORMANCE_CAPABILITIES, BridgeClient, BridgeError
from fairygui_agent.performance import batch_tool_result, capture_states_result, validate_batch
from test_bridge_client import _make_client


class PerformanceTests(unittest.TestCase):
    def test_batch_rejects_privileged_actions_and_per_step_save(self):
        for action in ('publish', 'import_image', 'save_all', 'call', 'open_document', '__proto__'):
            with self.subTest(action=action), self.assertRaises(ValueError):
                validate_batch([{'action': action, 'params': {}}], 'plan')
        with self.assertRaises(ValueError):
            validate_batch([{'action': 'set_properties', 'params': {'target': {'id': 'x'}, 'properties': {'x': 1}, 'save': True}}], 'plan')
        for key in ('../escape', '', 'x' * 97):
            with self.assertRaises(ValueError):
                validate_batch([{'action': 'create_object', 'params': {'objectType': 'text'}}], key)
        validate_batch([{'action': 'create_controller', 'params': {'name': 'State', 'pages': ['a', 'b']}}], 'controller')
        with self.assertRaises(ValueError):
            validate_batch([{'action': 'create_controller', 'params': {'name': 'State', 'pageNames': ['a', 'b']}}], 'controller')

    def test_mcp_one_call_compact_contract_and_failed_result(self):
        operations = [{'action': 'set_properties', 'params': {'target': {'id': 'x'}, 'properties': {'x': 0, 'visible': False}}}]
        fake = Mock()
        fake.call.return_value = {'status': 'succeeded', 'completed': 1}
        with patch.object(m, '_client', fake):
            result = m.fgui_apply_batch('ui://packageitem', 'rev1', 'plan', operations)
        self.assertFalse(result.isError)
        fake.call.assert_called_once_with('apply_batch', {'documentUrl': 'ui://packageitem', 'expectedRevision': 'rev1', 'operationKey': 'plan',
                                                       'operations': operations, 'dryRun': False, 'save': False, 'verbose': False}, timeout=60)
        self.assertTrue(batch_tool_result({'status': 'failed', 'completed': 1, 'saved': False}).isError)
        self.assertTrue(batch_tool_result({'status': 'running'}).isError)

    def test_sdk_get_objects_schema(self):
        expected = {'documentUrl': 'ui://packageitem', 'revision': 'r1', 'objects': [{'id': 'x', 'x': 0}]}
        with patch.object(m._client, 'call', return_value=expected):
            result = asyncio.run(m.mcp._tool_manager.get_tool('fgui_get_objects').run({'document_url': 'ui://packageitem', 'targets': [{'id': 'x'}]}, convert_result=True))
        self.assertIn('r1', str(result))

    def test_timeout_records_bounded_diagnostics_without_wake(self):
        with tempfile.TemporaryDirectory() as temp:
            client = _make_client(Path(temp))
            with self.assertRaises(TimeoutError):
                client.call('ping')
            records = client.diagnostics()['records']
            self.assertEqual(len(records), 1)
            self.assertTrue(records[0]['failed'])
            self.assertTrue(records[0]['timeout'])
            self.assertGreater(records[0]['requestBytes'], 0)
            self.assertGreater(records[0]['requestWaitMs'], 0)
            client.launcher.wake.assert_not_called()
            client._diagnostics.extend({} for _ in range(150))
            self.assertEqual(len(client.diagnostics(100)['records']), 100)
            with self.assertRaises(ValueError):
                client.diagnostics(101)

    def test_legacy_plugin_fails_before_queue(self):
        with tempfile.TemporaryDirectory() as temp:
            client = _make_client(Path(temp))
            for action in PERFORMANCE_CAPABILITIES:
                with self.subTest(action=action), self.assertRaisesRegex(BridgeError, '0.10.0'):
                    client.call_raw(action)
            self.assertEqual(list((Path(temp) / '.agent/requests').glob('*.json')), [])

    def test_contact_sheet_is_one_image_and_preserves_full_labels(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'captures').mkdir()
            for name, color in [('a', 'red'), ('b', 'green')]:
                Image.new('RGBA', (20, 30), color).save(root / 'captures' / f'{name}.png')
            captures = [{'label': label, 'path': f'captures/{name}.png', 'width': 20, 'height': 30} for name, label in [('a', '未选中'), ('b', '选中')]]
            result = capture_states_result(root, {'captures': captures, 'restored': True}, 2, 128)
            self.assertEqual(sum(c.type == 'image' for c in result.content), 1)
            metadata = json.loads(result.content[0].text)
            self.assertEqual(metadata['labels'][0]['label'], '未选中')
            self.assertEqual(metadata['contactSheet']['width'], 40)
            captures[0]['path'] = '../outside.png'
            with self.assertRaises(ValueError):
                capture_states_result(root, {'captures': captures}, 2, 128)

    def test_missing_contact_sheet_preserves_failed_restore_metadata(self):
        fake = Mock()
        fake.call.return_value = {'captures': [], 'restored': False, 'restoreErrors': [{'controller': 'State', 'error': 'native error'}]}
        with patch.object(m, '_client', fake), patch.object(m, 'capture_states_result', side_effect=ValueError('missing PNG')):
            result = m.fgui_capture_states('ui://packageitem', [{'label': 'state', 'controllers': {}}])
        metadata = json.loads(result.content[0].text)
        self.assertFalse(metadata['restored'])
        self.assertEqual(metadata['restoreErrors'][0]['controller'], 'State')
        self.assertNotIn('mutationPerformed', metadata)

    def test_design_asset_alpha_bounds_exclude_transparent_padding(self):
        from scripts.inspect_design_assets import inspect_png
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp) / 'button.png'
            picture = Image.new('RGBA', (100, 50), (0, 0, 0, 0))
            ImageDraw.Draw(picture).rectangle((10, 5, 79, 39), fill='red')
            picture.save(file)
            result = inspect_png(file)
        self.assertEqual(result['visibleBounds'], [10, 5, 80, 40])
        self.assertEqual(result['transparentInsets'], [10, 5, 20, 10])

    def test_cli_plan_boolean_does_not_turn_string_false_into_save(self):
        with tempfile.TemporaryDirectory() as temp:
            plan = Path(temp) / 'plan.json'
            plan.write_text(json.dumps({'documentUrl': 'ui://packageitem', 'expectedRevision': 'r', 'operationKey': 'p',
                                        'operations': [{'action': 'create_object', 'params': {'objectType': 'text'}}], 'save': 'false'}), encoding='utf-8')
            with patch('sys.argv', ['fgui-agent', 'apply-batch', str(plan)]), patch.object(cli, 'BridgeClient') as fake, redirect_stdout(io.StringIO()):
                self.assertEqual(cli.main(), 1)
            fake.return_value.call_raw.assert_not_called()
            value = json.loads(plan.read_text(encoding='utf-8'))
            value['save'] = False
            plan.write_text(json.dumps(value), encoding='utf-8')
            response = {'ok': True, 'result': {'status': 'succeeded'}}
            with patch('sys.argv', ['fgui-agent', 'apply-batch', str(plan)]), patch.object(cli, 'BridgeClient') as fake, redirect_stdout(io.StringIO()):
                fake.return_value.call_raw.return_value = response
                self.assertEqual(cli.main(), 0)
            fake.return_value.call_raw.assert_called_once_with('apply_batch', {**value, 'dryRun': False, 'verbose': False}, timeout=60)

    def test_compiled_batch_and_reload_boundaries(self):
        result = subprocess.run(['node', str(Path(__file__).with_name('performance_host_harness.cjs'))], capture_output=True, text=True, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
