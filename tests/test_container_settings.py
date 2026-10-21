"""容器/滚动字段的 MCP、CLI、能力协商、批量边界与编译宿主契约。"""
import asyncio
from contextlib import redirect_stdout
import io
from pathlib import Path
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from fairygui_agent import cli, mcp_server as m
from fairygui_agent.bridge_client import CONTAINER_CAPABILITIES, SCROLL_EXTENDED_FIELDS, BridgeClient, BridgeError
from fairygui_agent.performance import validate_batch


class ContainerSettingsTests(unittest.TestCase):
    def test_mcp_container_and_scroll_patches_preserve_explicit_empty_values(self):
        with patch.object(m._client, 'call', return_value={}) as call:
            m.fgui_get_container_settings(); call.assert_called_with('get_container_settings')
            m.fgui_set_container_settings({'margin': {'top': 0}, 'hitTestSourceId': ''}, save=True)
            call.assert_called_with('set_container_settings', {'settings': {'margin': {'top': 0}, 'hitTestSourceId': ''}, 'save': True})
            m.fgui_set_scroll_settings({'vtScrollBarRes': '', 'clipSoftness': {'x': 0}}, object_path='root')
            call.assert_called_with('set_scroll_settings', {'target': {'path': 'root'}, 'settings': {'vtScrollBarRes': '', 'clipSoftness': {'x': 0}}, 'save': False})

    def test_registered_mcp_preserves_nested_types_for_native_preflight(self):
        for action, args in [('set_container_settings', {'settings': {'margin': {'top': '1'}, 'minWidth': False}}),
                             ('set_scroll_settings', {'object_path': 'root', 'settings': {'clipSoftness': {'x': '1'}}})]:
            with patch.object(m._client, 'call', return_value={}) as call:
                asyncio.run(m.mcp._tool_manager.get_tool('fgui_' + action).run(args, convert_result=True))
                self.assertEqual(call.call_args.args[1]['settings'], args['settings'])

    def test_cli_container_requires_no_target_and_scroll_keeps_target(self):
        cases = [(['get-container-settings'], 'get_container_settings', {}),
                 (['set-container-settings', '{"margin":{"top":5}}', '--save'], 'set_container_settings', {'settings': {'margin': {'top': 5}}, 'save': True}),
                 (['set-scroll-settings', '{"vtScrollBarRes":""}', '--path', 'root'], 'set_scroll_settings', {'target': {'path': 'root'}, 'settings': {'vtScrollBarRes': ''}, 'save': False})]
        for args, action, expected in cases:
            client = Mock(); client.call_raw.return_value = {'ok': True}
            with patch('sys.argv', ['fgui-agent', *args]), patch.object(cli, 'BridgeClient', return_value=client), redirect_stdout(io.StringIO()):
                self.assertEqual(cli.main(), 0)
            client.call_raw.assert_called_once_with(action, expected, timeout=10.0)

    def test_old_plugin_rejects_new_actions_and_each_extended_field_even_in_batch(self):
        client = BridgeClient.__new__(BridgeClient)
        client.project_context = lambda: SimpleNamespace(queue_root=Path(__file__).parent)
        client.ensure_ready = lambda: {'capabilities': ['apply_batch', 'set_scroll_settings']}
        ops = [{'action': action, 'params': {}} for action in CONTAINER_CAPABILITIES]
        ops += [{'action': 'set_scroll_settings', 'params': {'settings': {key: ''}}} for key in SCROLL_EXTENDED_FIELDS]
        for op in ops:
            for action, params in [(op['action'], op['params']), ('apply_batch', {'operations': [op]})]:
                with self.assertRaisesRegex(BridgeError, '0.17.0'): client.call_raw(action, params)

    def test_batch_allows_root_container_patch_but_not_target_or_step_save(self):
        op = {'action': 'set_container_settings', 'params': {'settings': {'hitTestSourceId': '$image'}}}
        validate_batch([op], 'container')
        for extra in [{'target': {'path': 'root'}}, {'save': True}]:
            with self.assertRaises(ValueError): validate_batch([{**op, 'params': {**op['params'], **extra}}], 'bad-container')

    def test_compiled_container_host_contracts(self):
        result = subprocess.run(['node', str(Path(__file__).with_name('container_host_harness.cjs'))], capture_output=True, text=True, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
