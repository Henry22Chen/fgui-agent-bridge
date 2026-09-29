"""Controller Action MCP/CLI and compiled host regression coverage."""
import subprocess
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from fairygui_agent import mcp_server as m
from fairygui_agent.bridge_client import BridgeClient, BridgeError, CONTROLLER_ACTION_CAPABILITIES
from fairygui_agent.cli import build_parser

ROOT = Path(__file__).resolve().parents[1]


class ControllerActionTests(unittest.TestCase):
    def test_mcp_mapping_preserves_zero_index_and_false_values(self):
        client = Mock()
        config = {'type': 'play_transition', 'transitionName': 'Pulse', 'delay': 0, 'stopOnExit': False}
        with patch.object(m, '_client', client):
            m.fgui_get_controller_actions('Main')
            client.call.assert_called_with('get_controller_actions', {'controllerName': 'Main'})
            m.fgui_upsert_controller_action('Main', config)
            self.assertNotIn('actionIndex', client.call.call_args.args[1])
            m.fgui_upsert_controller_action('Main', config, action_index=0, save=True)
            client.call.assert_called_with('upsert_controller_action', {'controllerName': 'Main', 'action': config, 'actionIndex': 0, 'save': True})
            m.fgui_remove_controller_action('Main', 0)
            client.call.assert_called_with('remove_controller_action', {'controllerName': 'Main', 'actionIndex': 0, 'save': False})

    def test_capability_negotiation(self):
        plugin = (ROOT / 'plugin/main.ts').read_text(encoding='utf8')
        client = BridgeClient.__new__(BridgeClient)
        client.project_context = lambda: SimpleNamespace(queue_root=ROOT)
        client.ensure_ready = lambda: {'capabilities': []}
        for action in CONTROLLER_ACTION_CAPABILITIES:
            self.assertIn(f'case "{action}"', plugin)
            self.assertTrue(hasattr(m, f'fgui_{action}'))
            with self.assertRaisesRegex(BridgeError, '0.8.8'):
                client.call_raw(action)

    def test_cli(self):
        parser = build_parser()
        self.assertEqual(parser.parse_args(['get-controller-actions', 'Main']).controller_name, 'Main')
        append = parser.parse_args(['upsert-controller-action', 'Main', '{}'])
        self.assertIsNone(append.action_index)
        update = parser.parse_args(['upsert-controller-action', 'Main', '{}', '--action-index', '0', '--save'])
        self.assertEqual(update.action_index, 0)
        self.assertTrue(update.save)
        self.assertEqual(parser.parse_args(['remove-controller-action', 'Main', '0']).action_index, 0)

    def test_compiled_host(self):
        result = subprocess.run(['node', str(ROOT / 'tests/controller_actions_host_harness.cjs')], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
