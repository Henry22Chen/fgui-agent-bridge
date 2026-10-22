"""通过真实 MCP 验证高级 Gear；只写专用隔离夹具，日志、截图和发布产物不入库。"""
import argparse
import asyncio
import json
import math
import os
from pathlib import Path
import shutil
import sys
import uuid
import xml.etree.ElementTree as ET

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from live_list_tree_validation import published_root


async def run(project: Path, editor: str, output: Path, read_only: bool, reset: bool):
    repo=Path(__file__).resolve().parents[1]
    if project.is_relative_to(repo) or output.is_relative_to(repo) or ET.parse(project).getroot().get('id')!='fgui-gear-lifecycle-regression-0001':
        raise ValueError('仅允许仓库外高级 Gear 专用工程')
    report={'cases':[],'readOnly':read_only,'evidence':'native-editor-mcp'}
    def record(name,value=True):
        report['cases'].append({'name':name,'result':value})
        output.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
        print('PASS '+name,flush=True)
    server=StdioServerParameters(command=sys.executable,args=['-B','-m','fairygui_agent.mcp_server','--project',str(project),'--editor',editor],
        env={**os.environ,'PYTHONUTF8':'1','PYTHONPATH':str(repo/'src')})
    async with stdio_client(server) as (read,write):
        async with ClientSession(read,write) as session:
            init=await session.initialize()
            report.update(serverVersion=init.serverInfo.version,toolCount=len((await session.list_tools()).tools))
            assert report['serverVersion']=='0.21.0' and report['toolCount']==123
            async def call(tool,**params):
                result=await session.call_tool('fgui_'+tool,params)
                assert not result.isError,(tool,result.content)
                value=result.structuredContent
                if params.get('save'):assert value['saved'] and value['persisted'],value
                return value
            async def gears(id='label'):return await call('get_gears',object_id=id)
            async def gear(kind,id='label'):return next(g for g in (await gears(id))['gears'] if g['type']==kind)
            async def display(id='label'):return (await gears(id))['currentDisplay']
            async def page(id):return await call('set_controller_page',controller_name='State',page_id=id)
            async def put(kind,default,values,**extra):
                return await call('set_gear',gear_type=kind,controller_name='State',default_value=default,
                    page_values=[{'pageId':id,'value':v} for id,v in values.items()],object_id=extra.pop('object_id','label'),**extra)
            async def reject(tool,**params):
                before=await call('get_child_order');disk=(project.parent/'assets/Probe/Root.xml').read_bytes()
                result=await session.call_tool('fgui_'+tool,params)
                assert result.isError,(tool,result)
                after=await call('get_child_order')
                assert before['revision']==after['revision'] and disk==(project.parent/'assets/Probe/Root.xml').read_bytes(), (params,before,after)
                record('write-before rejection: '+tool+':'+str(params))
            await call('status');await call('ping');await call('get_project');await call('list_packages')
            await call('open_document',package_name='Probe',item_name='Root')
            if reset and not read_only:
                # 仅重置固定 ID 的隔离夹具，使用已有外部编辑交接保护打开文档；不是被测 API 的替代实现。
                await call('save_document')
                ticket=await call('begin_external_edit',document_url='ui://geartestroot')
                target=Path(ticket['file']).resolve()
                assert target==project.parent/'assets/Probe/Root.xml'
                target.write_bytes((repo/'tests/fixtures/gear-lifecycle/assets/Probe/Root.xml').read_bytes())
                await call('finish_external_edit',document_url='ui://geartestroot',token=ticket['token'])
            if read_only:
                xy=await gear('xy')
                assert xy['tween']=={'enabled':True,'duration':1.5,'delay':0.5,'ease':'Linear'} and not xy['positionsInPercent']
                assert {p['pageId'] for p in xy['pageValues']}=={'a','b'}
                assert (await gear('font_size'))['defaultValue']==18 and (await gear('look'))['bound']
                assert (await gear('animation','clip'))['defaultValue']=={'frame':0,'playing':False}
                assert (await gear('display2'))['condition']=='or'
                await page('b');await asyncio.sleep(2.1);state=await display()
                assert state['fontSize']==34 and math.isclose(state['alpha'],0.4,abs_tol=1e-6) and state['x']==300
                assert not (await display('clip'))['playing'] and (await display('clip'))['frame']==1
                record('fresh Editor reload preserves all advanced types, defaults, tween and native state')
            else:
                value=await gears()
                assert len(value['gears'])==10 and next(g for g in value['gears'] if g['type']=='font_size')['supported']
                record('structured read exposes ten types and current effective display')
                look0={'alpha':1,'rotation':0,'grayed':False,'touchable':True}
                look1={'alpha':0.4,'rotation':35,'grayed':True,'touchable':False}
                look_default={'alpha':0.8,'rotation':10,'grayed':False,'touchable':True}
                await put('look',look_default,{'a':look0,'b':look1},save=True)
                await page('b');state=await display()
                assert math.isclose(state['alpha'],0.4,abs_tol=1e-6) and state['rotation']==35 and state['grayed'] and not state['touchable']
                await page('c');assert math.isclose((await display())['alpha'],0.8,abs_tol=1e-6)
                record('look applies alpha/rotation/grayed/touchable and unlisted-page default')
                await put('font_size',18,{'a':20,'b':34},save=True)
                await page('b');assert (await display())['fontSize']==34
                await page('c');assert (await display())['fontSize']==18
                record('font-size native page and fallback behavior')
                clip=await call('create_movieclip',package_name='Probe',movieclip_name='GearClip-'+uuid.uuid4().hex[:8],
                    frame_paths=[str(project.parent/'Frame0.png'),str(project.parent/'Frame1.png')],fps=6)
                items=await call('list_items',package_name='Probe',item_type='movieclip')
                resource=next(i for i in items['items'] if i['url']==clip['movieClip']['item']['url'])
                movie=await call('insert_object',url=resource['url'],name='movie',x=260,y=180,fix_spine=False)
                await put('animation',{'frame':0,'playing':False},{'a':{'frame':0,'playing':True},'b':{'frame':1,'playing':False}},object_id='clip',save=True)
                await put('animation',{'frame':0,'playing':False},{'a':{'frame':0,'playing':True},'b':{'frame':1,'playing':False}},object_id=movie['id'],save=True)
                await page('b');assert (await display('clip'))['frame']==1 and not (await display('clip'))['playing']
                movie_state=(await call('get_gears',object_name='movie'))['currentDisplay']
                assert movie_state['frame']==1 and not movie_state['playing']
                await page('a');assert (await display('clip'))['playing']
                record('real MovieClip loader honors animation frame and playing Gear',clip)
                await call('set_gear',gear_type='display',controller_name='Visible',visible_page_ids=['v1'],object_id='label')
                await call('set_controller_page',controller_name='Visible',page_id='v0')
                await page('a')
                await call('set_gear',gear_type='display2',controller_name='State',visible_page_ids=['a'],condition='and',object_id='label',save=True)
                assert not (await display())['effectiveVisible']
                await call('set_gear',gear_type='display2',controller_name='State',visible_page_ids=['a'],condition='or',object_id='label',save=True)
                assert (await display())['effectiveVisible']
                await page('b');assert not (await display())['effectiveVisible']
                await call('set_controller_page',controller_name='Visible',page_id='v1')
                assert (await display())['effectiveVisible']
                record('Display2 and/or uses actual Gear visibility independently of visible flag')
                rounded=await put('xy',{'x':1,'y':2,'percentX':1/3,'percentY':0.123456789},{},positions_in_percent=True,
                    tween={'duration':1.23456789,'delay':0.123456789},save=True)
                assert math.isclose(rounded['after']['defaultValue']['percentX'],1/3,abs_tol=0.001)
                assert math.isclose(rounded['after']['tween']['duration'],1.23456789,abs_tol=0.0001)
                await put('xy',{'x':0,'y':0},{},positions_in_percent=False,tween={'enabled':False,'duration':0.3,'delay':0},save=True)
                record('native fractional precision is accepted and actual serialized values are returned')
                xy_default={'x':100,'y':75,'percentX':0.25,'percentY':0.25}
                xy_pages={'a':{'x':40,'y':60,'percentX':0.1,'percentY':0.2},'b':{'x':200,'y':150,'percentX':0.5,'percentY':0.5}}
                await put('xy',xy_default,xy_pages,positions_in_percent=True,save=True)
                await page('b');assert (await display())['x']==200
                await call('set_properties',object_path='root',properties={'width':800,'height':600,'useSourceSize':False},save=True)
                await page('a');state=await display();assert state['x']==80 and state['y']==120
                await page('b');state=await display();assert state['x']==400 and state['y']==300
                await page('c');state=await display();assert state['x']==200 and state['y']==150
                record('percentage pages and fallback re-evaluate against changed parent size')
                await call('save_document');await call('discard_document');await call('open_document',package_name='Probe',item_name='Root')
                assert (await gear('xy'))['positionsInPercent'] and (await gear('xy'))['pageValues'][0]['value']['percentX']==0.1
                record('percentage flag and exact fractional coordinates survive reload')
                absolute={'a':{'x':40,'y':60},'b':{'x':300,'y':60}}
                await put('xy',{'x':0,'y':0},absolute,positions_in_percent=False,tween={'enabled':True,'duration':1.5,'delay':0.5,'ease':'Linear'},save=True)
                saved=await gear('xy')
                await put('xy',{'x':0,'y':0},absolute,save=True)
                assert (await gear('xy'))['tween']==saved['tween']
                await put('xy',{'x':0,'y':0},absolute,tween={'enabled':False},save=True)
                assert (await gear('xy'))['tween']=={'enabled':False,'duration':1.5,'delay':0.5,'ease':'Linear'}
                await put('xy',{'x':0,'y':0},absolute,tween={'enabled':True},save=True)
                record('tween patch and old setter retain omitted duration/delay/ease; disable preserves them')
                # 原生播放帧和缓动位置都进入快照；先停在静态页并等待缓动结束，避免自然变化污染拒绝测试。
                await page('b');await asyncio.sleep(2.1)
                for params in [
                    {'gear_type':'look','default_value':{**look0,'alpha':1.1},'page_values':[]},
                    {'gear_type':'font_size','default_value':1.5,'page_values':[]},
                    {'gear_type':'animation','default_value':{'frame':0,'playing':True,'timeScale':1},'page_values':[]},
                    {'gear_type':'xy','default_value':{'x':0,'y':0},'page_values':[],'positions_in_percent':True},
                    {'gear_type':'xy','default_value':{'x':0,'y':0},'page_values':[],'tween':{'duration':0}},
                    {'gear_type':'xy','default_value':{'x':0,'y':0},'page_values':[],'tween':{'ease':'bogus'}},
                    {'gear_type':'text','default_value':'x','page_values':[],'tween':{'enabled':True}},
                    {'gear_type':'display2','visible_page_ids':['missing'],'condition':'or'},
                ]:await reject('set_gear',controller_name='State',object_id='label',**params)
                await page('b');current=await display();other=await gear('look')
                removed=await call('remove_gear',gear_type='font_size',object_id='label',save=True)
                assert removed['bindingCleared'] and removed['configurationRemoved'] and not removed['currentDisplayRestoredToDefault']
                assert (await display())['fontSize']==current['fontSize'] and (await gear('look'))['xml']==other['xml']
                await page('a');assert (await display())['fontSize']==current['fontSize']
                assert not (await call('remove_gear',gear_type='font_size',object_id='label'))['changed']
                record('removal stops future changes, keeps current ordinary value, preserves other Gear and is idempotent')
                await put('font_size',18,{'a':20,'b':34})
                await call('create_controller',name='DeleteState',page_names=['First','Second'])
                ids=next(c['pages'] for c in (await call('get_controllers'))['controllers'] if c['name']=='DeleteState')
                await call('set_gear',gear_type='look',controller_name='DeleteState',default_value=look0,page_values=[{'pageId':ids[1]['id'],'value':look1}],object_id='clip')
                refs=await call('get_controller_references',controller_name='DeleteState',page_id=ids[1]['id'])
                assert refs['complete'] and any(r['kind']=='gear' and r['gear']=='gearLook' for r in refs['references'])
                await reject('remove_controller_page',controller_name='DeleteState',page_id=ids[1]['id'])
                await call('remove_controller_page',controller_name='DeleteState',page_id=ids[1]['id'],reference_policy='local',save=True)
                assert not (await gear('look','clip'))['bound']
                await call('remove_controller',controller_name='DeleteState',save=True)
                record('v0.20 page reference scan and local cleanup cover advanced Gear')
                await call('set_properties',object_path='root',properties={'width':400,'height':300,'useSourceSize':False})
                revision=(await call('get_child_order'))['revision']
                batch=await call('apply_batch',document_url='ui://geartestroot',expected_revision=revision,operation_key='gear-lifecycle-batch',save=True,operations=[
                    {'action':'set_gear','params':{'target':{'id':'label'},'gearType':'font_size','controllerName':'State','defaultValue':18,'pageValues':[{'pageId':'a','value':20},{'pageId':'b','value':34}]}},
                    {'action':'remove_gear','params':{'target':{'id':'label'},'gearType':'text'}},
                    {'action':'set_gear','params':{'target':{'id':'label'},'gearType':'xy','controllerName':'State','defaultValue':{'x':0,'y':0},'pageValues':[{'pageId':id,'value':v} for id,v in absolute.items()],
                        'positionsInPercent':False,'tween':{'enabled':True,'duration':1.5,'delay':0.5,'ease':'Linear'}}}])
                assert batch['status']=='succeeded' and batch['completed']==3
                record('advanced settings and removal participate in saved revision-bound batch',batch)
                await page('a');await call('save_document')
                capture=await session.call_tool('fgui_capture_states',{'document_url':'ui://geartestroot','states':[
                    {'label':'First','controllers':{'State':'a','Visible':'v1'}}, {'label':'Second','controllers':{'State':'b','Visible':'v1'}},
                    {'label':'Default','controllers':{'State':'c','Visible':'v1'}}]})
                assert not capture.isError
                capture_info=next(json.loads(c.text) for c in capture.content if c.type=='text')
                (output.parent/'capture-metadata.json').write_text(json.dumps(capture_info,ensure_ascii=False,indent=2),encoding='utf8')
                for index,image in enumerate((project.parent/'.agent/captures').glob('*.png')):
                    shutil.copy2(image,output.parent/('capture-'+str(index)+'.png'))
                record('native three-state capture generated for visual review',capture_info)
                await call('get_publish_settings',package_name='Probe')
                published=await call('publish',scope='packages',package_names=['Probe'],timeout_seconds=30)
                assert published['success']
                root=published_root(project.parent/'published/Probe.bytes');label=root.find("./displayList/text[@id='label']")
                assert label.find('gearLook') is not None and label.find('gearFontSize') is not None and label.find('gearDisplay2') is not None
                assert label.find('gearXY').get('duration')=='1.5' and root.find("./displayList/loader[@id='clip']/gearAni") is not None
                record('native publication preserves advanced Gear mappings and tween configuration')
            report['passed']=True
            output.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--project',type=Path,required=True);parser.add_argument('--editor',required=True)
    parser.add_argument('--report',type=Path,required=True);parser.add_argument('--read-only',action='store_true')
    parser.add_argument('--reset',action='store_true')
    args=parser.parse_args();asyncio.run(run(args.project.resolve(),args.editor,args.report.resolve(),args.read_only,args.reset))
