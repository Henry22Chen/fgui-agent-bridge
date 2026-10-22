"""高级 Gear 的工具映射、能力协商、CLI 和批量边界；原生效果由独立 live 脚本验证。"""
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from fairygui_agent import mcp_server as m
from fairygui_agent.bridge_client import BridgeClient, BridgeError
from fairygui_agent.cli import build_parser
from fairygui_agent.performance import validate_batch

ROOT=Path(__file__).resolve().parents[1]


class GearLifecycleTests(unittest.TestCase):
    def test_mcp_retains_false_ratios_and_tween_patch(self):
        with patch.object(m,'_client',Mock()) as client:
            m.fgui_set_gear('xy','State',default_value={'x':0,'y':0},page_values=[],object_id='n1',positions_in_percent=False,tween={'enabled':False,'delay':0})
            params=client.call.call_args.args[1]
            self.assertIs(params['positionsInPercent'],False)
            self.assertEqual(params['tween'],{'enabled':False,'delay':0})
            m.fgui_set_gear('display2','State',visible_page_ids=[],condition='and',object_id='n1')
            self.assertEqual(client.call.call_args.args[1]['condition'],'and')
            m.fgui_remove_gear('look',object_id='n1',save=True)
            client.call.assert_called_with('remove_gear',{'target':{'id':'n1'},'gearType':'look','save':True})

    def test_advanced_capabilities_block_before_direct_and_batch_queue(self):
        client=BridgeClient.__new__(BridgeClient)
        client.project_context=lambda:SimpleNamespace(queue_root=ROOT)
        client.ensure_ready=lambda:{'capabilities':['set_gear','get_gears','apply_batch']}
        operations=[{'action':'remove_gear','params':{}}, *({'action':'set_gear','params':{'gearType':kind}} for kind in ['look','animation','font_size','display2']),
                    *({'action':'set_gear','params':{key:value}} for key,value in [('positionsInPercent',False),('tween',{'enabled':False}),('condition','and')])]
        for op in operations:
            with self.subTest(op=op):
                with self.assertRaisesRegex(BridgeError,'0.21.0'): client.call_raw(op['action'],op['params'])
                with self.assertRaisesRegex(BridgeError,'0.21.0'): client.call_raw('apply_batch',{'operations':[op]})

    def test_cli_and_batch_whitelist(self):
        parser=build_parser()
        self.assertEqual(parser.parse_args(['remove-gear','look','--id','n1','--save']).gear_type,'look')
        self.assertEqual(parser.parse_args(['set-gear','font_size','State','{"defaultValue":18,"pageValues":[]}','--id','n1']).gear_type,'font_size')
        validate_batch([{'action':'set_gear','params':{'target':{'id':'n1'},'gearType':'xy','positionsInPercent':True,'tween':{'enabled':False}}},
                        {'action':'remove_gear','params':{'target':{'id':'n1'},'gearType':'xy'}}],'gear-lifecycle')
        with self.assertRaises(ValueError):validate_batch([{'action':'remove_gear','params':{'target':{'id':'n1'},'gearType':'xy','restore':'source'}}],'bad-gear')


if __name__=='__main__':
    unittest.main()
