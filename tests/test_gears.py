"""Gear 的 MCP 参数、能力协商、CLI 与编译后插件回归。"""
import subprocess
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from fairygui_agent import mcp_server as m
from fairygui_agent.bridge_client import BridgeClient, BridgeError, GEAR_CAPABILITIES
from fairygui_agent.cli import build_parser

ROOT = Path(__file__).resolve().parents[1]


class GearTests(unittest.TestCase):
    def test_mapping_preserves_empty_values_and_zero(self):
        client = Mock()
        with patch.object(m, '_client', client):
            m.fgui_get_gears(object_id='n1')
            client.call.assert_called_with('get_gears', {'target': {'id': 'n1'}})
            m.fgui_set_gear('text', 'State', default_value='', page_values=[{'pageId': '0', 'value': ''}], object_id='n1')
            params = client.call.call_args.args[1]
            self.assertEqual(params['defaultValue'], '')
            self.assertEqual(params['pageValues'][0]['pageId'], '0')
            self.assertNotIn('visiblePageIds', params)
            m.fgui_set_gear('display', 'State', visible_page_ids=[], object_id='n1')
            params = client.call.call_args.args[1]
            self.assertEqual(params['visiblePageIds'], [])
            self.assertNotIn('defaultValue', params)

    def test_capabilities(self):
        client = BridgeClient.__new__(BridgeClient)
        client.project_context = lambda: SimpleNamespace(queue_root=ROOT)
        client.ensure_ready = lambda: {'capabilities': []}
        plugin = (ROOT / 'plugin/main.ts').read_text(encoding='utf8')
        for action in GEAR_CAPABILITIES:
            self.assertTrue(hasattr(m, f'fgui_{action}'))
            self.assertIn(f'case "{action}"', plugin)
            with self.assertRaisesRegex(BridgeError, '0.8.7'):
                client.call_raw(action)

    def test_cli(self):
        parser = build_parser()
        self.assertEqual(parser.parse_args(['get-gears', '--id', 'n1']).command, 'get-gears')
        args = parser.parse_args(['set-gear', 'display', 'State', '{"visiblePageIds":["1"]}', '--id', 'n1', '--save'])
        self.assertTrue(args.save)
        self.assertEqual(args.gear_type, 'display')

    def test_compiled_host(self):
        result = subprocess.run(['node', str(ROOT / 'tests/gear_host_harness.cjs')], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
