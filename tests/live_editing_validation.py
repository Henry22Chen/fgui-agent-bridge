"""在隔离工程执行真实 MCP 编辑回归；仅接受显式指定的测试工程路径。"""
import argparse
import asyncio
import json
import os
from pathlib import Path
import sys
import xml.etree.ElementTree as ET
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def run(project: Path, editor: str, report_file: Path, read_only: bool = False):
    if project.name != 'Capabilities.fairy' or ET.parse(project).getroot().get('id') != 'fgui-capability-regression-0001':
        raise ValueError('仅允许在专用隔离测试夹具运行，禁止对业务工程执行此脚本。')
    report = {'project': str(project), 'evidence': 'live-editor-mcp', 'cases': []}
    env = {**os.environ, 'PYTHONUTF8': '1', 'PYTHONPATH': str(Path(__file__).resolve().parents[1] / 'src')}
    server = StdioServerParameters(command=sys.executable, args=['-m', 'fairygui_agent.mcp_server', '--project', str(project), '--editor', editor], env=env)
    async with stdio_client(server) as (read, write):
        async with ClientSession(read, write) as session:
            init = await session.initialize()
            report['serverVersion'] = init.serverInfo.version
            report['toolCount'] = len((await session.list_tools()).tools)

            async def call(tool_name, **kwargs):
                result = await session.call_tool(tool_name, kwargs)
                if result.isError: raise AssertionError(str(result.content))
                return result.structuredContent

            async def case(label, tool_name, **kwargs):
                try:
                    result = await call(tool_name, **kwargs)
                    if kwargs.get('save'): assert result.get('saved') and result.get('persisted'), result
                    report['cases'].append({'name': label, 'passed': True, 'result': result})
                    print('PASS:', label, flush=True)
                    return result
                except Exception as error:
                    report['cases'].append({'name': label, 'passed': False, 'error': str(error)})
                    print('FAIL:', label, str(error)[:500], flush=True)
                finally:
                    report_file.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')

            status = await call('fgui_status')
            report['editorPid'] = status['status']['editorProcessId']
            assert status['online'] and status['versionMatch']
            await call('fgui_open_document', package_name='Probe', item_name='Root')
            if read_only:
                checks = [
                    ('reopen image scaling','fgui_get_image_settings',{'url':'ui://captest0panel'}, lambda r:r['settings']['scaleMode']=='9grid' and r['settings']['gridTile']==5),
                    ('reopen button binding','fgui_get_button_binding',{'object_id':'tab1'},lambda r:r['binding']['controllerName']=='State' and r['binding']['pageId']=='1'),
                    ('reopen list layout','fgui_get_list_settings',{'object_id':'list1'},lambda r:r['settings']['layout']=='pagination' and r['settings']['repeatX']==4 and r['settings']['repeatY']==2),
                    ('reopen pagination controller','fgui_get_scroll_settings',{'object_id':'list1'},lambda r:r['settings']['pageMode'] and r['settings']['pageControllerName']=='State'),
                    ('reopen loader fitting','fgui_get_loader',{'object_id':'loader1'},lambda r:r['settings']['fill']=='scale' and r['settings']['vAlign']=='middle'),
                    ('reopen group membership','fgui_get_group',{'object_id':'loader1'},lambda r:bool(r['groupId'])),
                    ('reopen remaining relation','fgui_get_relations',{'object_id':'loader1'},lambda r:[d['relationType'] for item in r['relations'] for d in item['definitions']]==['Bottom_Bottom']),
                    ('reopen default text style','fgui_get_text_style',{'object_id':'text1'},lambda r:r['style']['color']=='#000000' and r['style']['lineGap']==0 and not r['style']['ubbEnabled']),
                    ('reopen all created native nodes','fgui_get_tree',{'max_depth':2},lambda r: all('created_'+kind in str(r) for kind in ('text','richtext','inputtext','loader','list','group','graph'))),
                ]
                for label, tool_name, kwargs, validate in checks:
                    result = await case(label,tool_name,**kwargs)
                    assert result and validate(result), (label,result)
                report['externalReloadVerified']=True
                report['passed']=len(report['cases']); report['total']=len(checks)
                report_file.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
                print(f'{len(checks)} reopen checks passed')
                return
            await case('list_items returns a structured package/items object', 'fgui_list_items', package_name='Probe')
            await case('component instance omitted size resolves source dimensions', 'fgui_verify_document', object_id='child1', expected={'width':64,'height':40})
            await case('read image scaling', 'fgui_get_image_settings', url='ui://captest0panel')
            await case('save nine-slice independent of JSON key order', 'fgui_set_image_settings', url='ui://captest0panel', settings={'scaleMode':'9grid','scale9Grid':{'width':48,'height':48,'y':8,'x':8},'gridTile':0}, save=True)
            await case('save tile scaling', 'fgui_set_image_settings', url='ui://captest0panel', settings={'scaleMode':'tile'}, save=True)
            await case('save normal scaling', 'fgui_set_image_settings', url='ui://captest0panel', settings={'scaleMode':'none'}, save=True)
            await case('save nine-slice nonzero tile flags', 'fgui_set_image_settings', url='ui://captest0panel', settings={'scaleMode':'9grid','gridTile':5}, save=True)
            await case('button parent controller binding', 'fgui_set_button_binding', object_id='tab1', settings={'controllerName':'State','pageId':'1','selected':True}, save=True)
            await case('read button binding', 'fgui_get_button_binding', object_id='tab1')
            await case('list 4 columns and 2 rows', 'fgui_set_list_settings', object_id='list1', settings={'layout':'pagination','repeatX':4,'repeatY':2,'lineGap':3,'columnGap':7}, save=True)
            await case('scroll pagination and controller', 'fgui_set_scroll_settings', object_id='list1', settings={'overflow':'scroll','scroll':'horizontal','pageMode':True,'pageControllerName':'State'}, save=True)
            await case('loader aspect fit and alignment', 'fgui_set_loader', object_id='loader1', settings={'fill':'scale','align':'center','vAlign':'middle','autoSize':False,'shrinkOnly':True}, save=True)
            await case('text effects and geometry', 'fgui_set_text_style', object_id='text1', style={'autoSize':'none','stroke':True,'strokeColor':'#204080','strokeSize':2,'shadow':True,'shadowColor':'#000000','shadowX':2,'shadowY':3,'bold':True,'ubbEnabled':True,'text':'[color=#FF0000]42[/color]','width':220,'height':42,'x':15,'y':245}, save=True)
            await case('verify text effects', 'fgui_verify_document', object_id='text1', expected={'stroke':True,'strokeColor':'#204080','strokeSize':2,'shadow':True,'shadowX':2,'shadowY':3,'width':220,'x':15})
            await case('Gear color and stroke configuration', 'fgui_set_gear', object_id='text1', gear_type='color', controller_name='State', default_value={'color':'#000000','strokeColor':'#204080'}, page_values=[{'pageId':'1','value':{'color':'#FFFFFF','strokeColor':'#408020'}}], save=True)
            await case('batch pivot size and coordinates', 'fgui_set_properties', object_id='loader1', properties={'pivotX':0.5,'pivotY':0.5,'anchor':True,'width':80,'height':90,'x':90,'y':100}, save=True)
            for kind in ('text','richtext','inputtext','loader','list','group','graph'):
                options = {'group_member_ids':['loader1']} if kind == 'group' else {}
                result = await case('create native '+kind, 'fgui_create_object', object_type=kind, name='created_'+kind, width=120, height=30, save=True, **options)
                if kind == 'group' and result:
                    group_id = result['after']['id']
                    await case('assign group', 'fgui_set_group', object_id='text1', group_id=group_id, save=True)
            await case('add center relation', 'fgui_add_relation', object_id='loader1', relation_type='Center_Center', save=True)
            await case('add bottom relation', 'fgui_add_relation', object_id='loader1', relation_type='Bottom_Bottom', save=True)
            await case('read relations', 'fgui_get_relations', object_id='loader1')
            await case('remove one relation while retaining the other', 'fgui_remove_relation', object_id='loader1', relation_type='Center_Center', save=True)
            await case('text default color and zero spacing', 'fgui_set_text_style', object_id='text1', style={'color':'#000000','align':'left','vAlign':'top','lineGap':0,'letterSpacing':0,'bold':False,'ubbEnabled':False,'stroke':False,'shadow':False}, save=True)

            async def rejects(label, tool_name, **kwargs):
                before = await call('fgui_get_tree', max_depth=12)
                response = await session.call_tool(tool_name, kwargs)
                after = await call('fgui_get_tree', max_depth=12)
                passed = bool(response.isError) and before == after
                report['cases'].append({'name':label,'passed':passed,'expectedRejection':True,'unchangedTree':before==after})
                print('PASS:' if passed else 'FAIL:', label, flush=True)

            await rejects('invalid image grid rejected before write', 'fgui_set_image_settings', url='ui://captest0panel', settings={'scale9Grid':{'x':0,'y':0,'width':999,'height':9}}, save=True)
            await rejects('unknown batch key rejected before partial write', 'fgui_set_properties', object_id='loader1', properties={'width':999,'typo':True})
            await rejects('inapplicable native property rejected before write', 'fgui_set_properties', object_id='loader1', properties={'width':999,'font':'fake-font'})
            await rejects('auto-size conflict rejected before partial write', 'fgui_set_properties', object_id='text1', properties={'autoSize':'both','width':999})
            await rejects('invalid controller page rejected', 'fgui_set_button_binding', object_id='tab1', settings={'pageId':'missing'})
            await rejects('invalid list layout rejected', 'fgui_set_list_settings', object_id='list1', settings={'layout':'grid','repeatX':7})
            await rejects('conflicting page flag rejected', 'fgui_set_scroll_settings', object_id='list1', settings={'pageMode':False,'scrollBarFlags':8})
            await rejects('invalid loader fill rejected', 'fgui_set_loader', object_id='loader1', settings={'fill':'invalid'})
            await rejects('group cycle rejected', 'fgui_set_group', object_name='created_group', group_id=group_id)
            await rejects('self relation rejected', 'fgui_add_relation', object_id='loader1', relation_type='Width', relation_target_id='loader1')
            await rejects('unknown text style rejected before partial write', 'fgui_set_text_style', object_id='text1', style={'fontSize':45,'typo':True})
            await rejects('empty group save rejected before creation', 'fgui_create_object', object_type='group', name='invalid_group', save=True)
            latest = await call('fgui_status')
            assert latest['status']['editorProcessId'] == report['editorPid']
            report['sameEditorInstance'] = True
    report['passed'] = sum(c['passed'] for c in report['cases'])
    report['total'] = len(report['cases'])
    report_file.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f"{report['passed']}/{report['total']} live cases passed")
    if report['passed'] != report['total']: raise SystemExit(1)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--project', required=True, type=Path)
    parser.add_argument('--editor', required=True)
    parser.add_argument('--report', required=True, type=Path)
    parser.add_argument('--read-only', action='store_true')
    args = parser.parse_args()
    asyncio.run(run(args.project.resolve(), args.editor, args.report, args.read_only))
