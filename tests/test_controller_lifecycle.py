"""控制器生命周期工具/CLI、兼容门禁、批量和编译后宿主契约。"""
import subprocess
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from fairygui_agent import mcp_server as m
from fairygui_agent.bridge_client import BridgeClient, BridgeError, BridgeCommandError, CONTROLLER_LIFECYCLE_CAPABILITIES
from fairygui_agent.cli import build_parser
from fairygui_agent.performance import validate_batch

ROOT = Path(__file__).resolve().parents[1]


class ControllerLifecycleTests(unittest.TestCase):
    def test_mcp_maps_full_orders_policy_and_replacement(self):
        fake = Mock()
        with patch.object(m, '_client', fake):
            m.fgui_get_controller_references('State', '0')
            fake.call.assert_called_with('get_controller_references', {'controllerName':'State','pageId':'0'})
            m.fgui_remove_controller_page('State','0','local','1',True)
            fake.call.assert_called_with('remove_controller_page', {'controllerName':'State','pageId':'0','referencePolicy':'local','replacementPageId':'1','save':True})
            m.fgui_rename_controller('State','New')
            self.assertEqual(fake.call.call_args.args[1]['referencePolicy'],'reject')
            m.fgui_reorder_controller_actions('State',[1,0])
            self.assertEqual(fake.call.call_args.args[1]['orderedIndices'],[1,0])
            m.fgui_reorder_controller_pages('State',['1','0'])
            self.assertEqual(fake.call.call_args.args[1]['orderedPageIds'],['1','0'])

    def test_mcp_rejections_preserve_structured_impact(self):
        impact = {'references':[{'documentUrl':'external','modified':True}]}
        with patch.object(m,'_client') as fake:
            fake.call.side_effect = BridgeCommandError('remove_controller','外部引用','external_references',{'impact':impact})
            result = m.fgui_remove_controller('State')
            self.assertTrue(result.isError)
            self.assertEqual(result.structuredContent['details']['impact'],impact)

    def test_capability_gate_covers_direct_and_nested_new_fields(self):
        client = BridgeClient.__new__(BridgeClient)
        client.project_context = lambda: SimpleNamespace(queue_root=ROOT)
        client.ensure_ready = lambda: {'capabilities':[]}
        operations = [*({'action':a,'params':{}} for a in CONTROLLER_LIFECYCLE_CAPABILITIES),
                      {'action':'set_controller_properties','params':{'settings':{'homePage':'0'}}},
                      {'action':'upsert_controller_action','params':{'action':{'targetMode':'follow_name'}}}]
        for op in operations:
            with self.subTest(op=op):
                with self.assertRaisesRegex(BridgeError,'0.20.0'):
                    client.call_raw(op['action'],op['params'])
                with self.assertRaisesRegex(BridgeError,'0.20.0'):
                    client.call_raw('apply_batch',{'operations':[op]})

    def test_cli_and_batch_scope(self):
        parser=build_parser()
        for args in [['get-controller-references','State','--page-id','0'],['rename-controller','State','New','--reference-policy','local'],
                     ['remove-controller','State'],['remove-controller-page','State','--page-id','0','--replacement-page-id','1'],
                     ['reorder-controller-pages','State','["1","0"]'],['reorder-controller-actions','State','[1,0]']]:
            self.assertEqual(parser.parse_args(args).command,args[0])
        validate_batch([{'action':'remove_controller_page','params':{'controllerName':'State','pageId':'1','referencePolicy':'local'}}],'lifecycle')
        with self.assertRaises(ValueError):
            validate_batch([{'action':'remove_controller','params':{'controllerName':'State','force':True}}],'unsafe')

    def test_compiled_host(self):
        result=subprocess.run(['node',str(ROOT/'tests/controller_lifecycle_host_harness.cjs')],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)


if __name__ == '__main__':
    unittest.main()
