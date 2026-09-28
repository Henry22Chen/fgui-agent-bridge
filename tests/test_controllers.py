"""Controller 工具、参数、能力协商与编译后宿主回归。"""
import subprocess
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from fairygui_agent import mcp_server as m
from fairygui_agent.bridge_client import BridgeClient, BridgeError, CONTROLLER_CAPABILITIES
from fairygui_agent.cli import build_parser

ROOT = Path(__file__).resolve().parents[1]


class ControllerTests(unittest.TestCase):
    def test_mapping_and_zero_index(self):
        client = Mock()
        with patch.object(m, '_client', client):
            m.fgui_get_controllers()
            client.call.assert_called_with('get_controllers')
            m.fgui_create_controller('State', ['Idle', 'Active'], save=True)
            client.call.assert_called_with('create_controller', {'name': 'State', 'pages': ['Idle', 'Active'], 'save': True})
            m.fgui_add_controller_page('State', 'Third')
            client.call.assert_called_with('add_controller_page', {'controllerName': 'State', 'name': 'Third', 'save': False})
            m.fgui_rename_controller_page('State', 'Enabled', page_id='0')
            self.assertEqual(client.call.call_args.args[1]['pageId'], '0')
            m.fgui_set_controller_page('State', page_index=0)
            self.assertEqual(client.call.call_args.args[1]['pageIndex'], 0)
            self.assertNotIn('pageId', client.call.call_args.args[1])
            for args in ({}, {'page_index': 0, 'page_name': 'Idle'}):
                with self.assertRaises(ValueError):
                    m.fgui_set_controller_page('State', **args)

    def test_capabilities_and_no_deletion_surface(self):
        plugin = (ROOT / 'plugin/main.ts').read_text(encoding='utf8')
        client = BridgeClient.__new__(BridgeClient)
        client.project_context = lambda: SimpleNamespace(queue_root=ROOT)
        client.ensure_ready = lambda: {'capabilities': []}
        for action in CONTROLLER_CAPABILITIES:
            self.assertIn(f'case "{action}"', plugin)
            self.assertTrue(hasattr(m, f'fgui_{action}'))
            with self.assertRaisesRegex(BridgeError, '0.8.6'):
                client.call_raw(action)
        self.assertFalse(hasattr(m, 'fgui_remove_controller_page'))
        self.assertFalse(hasattr(m, 'fgui_remove_controller'))

    def test_cli(self):
        parser = build_parser()
        for args in [['controllers'], ['create-controller', 'State', '--pages', 'Idle', 'Active', '--save'],
                     ['add-controller-page', 'State', 'Third'], ['rename-controller-page', 'State', 'Enabled', '--page-id', '0'],
                     ['set-controller-page', 'State', '--page-index', '0']]:
            self.assertEqual(parser.parse_args(args).command, args[0])

    def test_compiled_host(self):
        result = subprocess.run(['node', str(ROOT / 'tests/controller_host_harness.cjs')], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
