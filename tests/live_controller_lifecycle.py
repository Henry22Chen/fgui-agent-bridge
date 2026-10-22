"""控制器生命周期真实 MCP 回归；仅写专用隔离工程，报告/发布产物不入库。"""
import argparse
import asyncio
import json
import os
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from live_list_tree_validation import published_root


async def run(project: Path, editor: str, output: Path, read_only: bool):
    repo = Path(__file__).resolve().parents[1]
    if project.is_relative_to(repo) or output.is_relative_to(repo) or ET.parse(project).getroot().get('id') != 'fgui-controller-lifecycle-regression-0001':
        raise ValueError('仅允许仓库外控制器专用测试工程')
    report = {'cases': [], 'readOnly': read_only, 'evidence': 'native-editor-mcp'}
    def record(name, value=True):
        report['cases'].append({'name': name, 'result': value})
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
        print('PASS ' + name, flush=True)
    server = StdioServerParameters(command=sys.executable, args=['-B', '-m', 'fairygui_agent.mcp_server', '--project', str(project), '--editor', editor],
                                   env={**os.environ, 'PYTHONUTF8': '1', 'PYTHONPATH': str(repo/'src')})
    async with stdio_client(server) as (read, write):
        async with ClientSession(read, write) as session:
            init = await session.initialize()
            report['serverVersion'] = init.serverInfo.version
            report['toolCount'] = len((await session.list_tools()).tools)
            assert report['serverVersion'] == '0.20.0' and report['toolCount'] == 122
            async def call(tool, **params):
                r = await session.call_tool('fgui_' + tool, params)
                assert not r.isError, (tool, r.content)
                value = r.structuredContent
                if params.get('save'): assert value['saved'] and value['persisted'], value
                return value
            async def reject(tool, code, **params):
                before = await call('get_child_order')
                disk = (project.parent/'assets/Probe/Root.xml').read_bytes()
                result = await session.call_tool('fgui_' + tool, params)
                assert result.isError and code in str(result.content), (tool, code, result)
                after = await call('get_child_order')
                assert before['revision'] == after['revision'] and disk == (project.parent/'assets/Probe/Root.xml').read_bytes(), {'before':before,'after':after,'diskUnchanged':disk == (project.parent/'assets/Probe/Root.xml').read_bytes()}
                record('write-before rejection: ' + tool + ':' + code)
            async def controllers():
                return {c['name']: c for c in (await call('get_controllers'))['controllers']}
            await call('status'); await call('ping'); await call('get_project'); await call('list_packages')
            await call('open_document', package_name='Probe', item_name='Root')
            if read_only:
                state = (await controllers())['Renamed']
                assert [p['id'] for p in state['pages']] == ['b', 'a'] and state['homePageType'] == 'specific' and state['homePage'] == 'b' and state['autoRadioGroupDepth']
                actions = (await call('get_controller_actions', controller_name='Renamed'))['actions']
                assert [a['targetMode'] for a in actions] == ['follow_name', 'follow_index']
                assert 'Temporary' not in await controllers()
                record('fresh Editor reopen preserves stable IDs, home rules, action order and deletion')
            else:
                impact = await call('get_controller_references', controller_name='State')
                assert impact['complete'] and any(r['kind'] == 'gear' for r in impact['references'])
                record('read-only full project scan', impact)
                await reject('rename_controller', 'controller_referenced', controller_name='State', name='Renamed')
                external = await call('get_controller_references', controller_name='Exported')
                assert any(r['kind'] == 'instance_override' and not r['local'] for r in external['references'])
                assert any(r['kind'] == 'instance_override' and '/item[' in r['path'] for r in external['references'])
                record('external exported override impact', external)
                await call('open_document', package_name='Probe', item_name='External')
                preset = await call('get_list_item_resources', object_id='presets')
                assert preset['settings']['items'][0]['properties'] == [{'target':'Exported','propertyId':-1,'value':'e1'}]
                record('native preset controllers XML reads as real property overrides')
                await call('create_controller', name='Caller', page_names=['Only'])
                await call('upsert_controller_action', controller_name='Caller', action={'type':'change_page','objectId':'instance','controllerName':'State','targetPageId':'b'})
                await call('open_document', package_name='Probe', item_name='Root')
                dirty = await call('get_controller_references', controller_name='State')
                assert any(r['kind'] == 'action' and not r['local'] and r['modified'] and r['source'] == 'editor' for r in dirty['references'])
                await reject('rename_controller', 'external_references', controller_name='State', name='Unsafe', reference_policy='local')
                record('unsaved external document overrides disk reference scan', dirty)
                await call('open_document', package_name='Probe', item_name='External')
                await call('remove_controller_action', controller_name='Caller', action_index=0)
                await call('open_document', package_name='Probe', item_name='Root')
                await reject('rename_controller', 'external_references', controller_name='Exported', name='Unsafe', reference_policy='local')
                await reject('remove_controller', 'external_references', controller_name='Exported', reference_policy='local')
                await call('upsert_controller_action', controller_name='Target', action={'type':'change_page','controllerName':'State','targetPageId':'b'})
                await call('rename_controller', controller_name='State', name='Renamed', reference_policy='local', save=True)
                assert any(g.get('controllerName') == 'Renamed' for g in (await call('get_gears', object_id='label'))['gears'])
                assert (await call('get_controller_actions', controller_name='Target'))['actions'][0]['controllerName'] == 'Renamed'
                await call('remove_controller_action', controller_name='Target', action_index=0, save=True)
                record('rename migrates native local Gear and incoming action with stable pages')
                await call('set_button_binding', object_id='button', settings={'controllerName':'Bindings','pageId':'bind0'})
                await call('set_list_settings', object_id='list', settings={'selectionController':'Bindings'})
                await call('set_scroll_settings', object_id='list', settings={'overflow':'scroll','pageMode':True,'pageControllerName':'Bindings'})
                await call('set_combo_settings', object_id='combo', settings={'selectionController':'Bindings'}, save=True)
                bindings = await call('get_controller_references', controller_name='Bindings')
                assert {'button_binding','selectionController','pageController'} <= {r['kind'] for r in bindings['references']}, bindings
                await call('rename_controller', controller_name='Bindings', name='BindingNew', reference_policy='local', save=True)
                assert (await call('get_button_binding', object_id='button'))['binding']['controllerName'] == 'BindingNew'
                assert (await call('get_list_settings', object_id='list'))['settings']['selectionController'] == 'BindingNew'
                assert (await call('get_scroll_settings', object_id='list'))['settings']['pageControllerName'] == 'BindingNew'
                assert (await call('get_combo_settings', object_id='combo'))['settings']['selectionController'] == 'BindingNew'
                await call('remove_controller', controller_name='BindingNew', reference_policy='local', save=True)
                assert not (await call('get_button_binding', object_id='button'))['binding']['controllerName']
                assert not (await call('get_list_settings', object_id='list'))['settings']['selectionController']
                assert not (await call('get_scroll_settings', object_id='list'))['settings']['pageControllerName']
                assert not (await call('get_combo_settings', object_id='combo'))['settings']['selectionController']
                record('Button/List/Scroll/Combo references migrate and explicitly unbind')
                await call('set_controller_properties', controller_name='Renamed', settings={'homePageType': 'specific', 'homePage': 'b', 'autoRadioGroupDepth': True}, save=True)
                assert (await controllers())['Renamed']['selectedPageId'] == 'a'
                record('specific home differs from preview selected page')
                for mode in ['branch', 'variable', 'default']:
                    await call('set_controller_properties', controller_name='Target', settings={'homePageType': mode, **({'homePage': 'testVariant'} if mode == 'variable' else {})}, save=True)
                    await call('discard_document'); await call('open_document', package_name='Probe', item_name='Root')
                    restored = (await controllers())['Target']
                    assert restored['homePageType'] == mode and restored['homePage'] == ('testVariant' if mode == 'variable' else '')
                    record('native home mode saves and reloads: ' + mode)
                await reject('set_controller_properties', 'invalid_home_page', controller_name='Target', settings={'homePageType':'page'})
                await call('reorder_controller_pages', controller_name='Renamed', ordered_page_ids=['c','b','a'], save=True)
                assert (await controllers())['Renamed']['selectedPageId'] == 'a'
                record('native SwapPage preserves IDs and selected identity')
                await reject('reorder_controller_pages', 'invalid_order', controller_name='Renamed', ordered_page_ids=['a','a','b'])
                await reject('remove_controller_page', 'default_page', controller_name='Renamed', page_id='b')
                await reject('remove_controller_page', 'controller_referenced', controller_name='Renamed', page_id='b', replacement_page_id='a')
                await call('remove_controller_page', controller_name='Renamed', page_id='c', save=True)
                assert [p['id'] for p in (await controllers())['Renamed']['pages']] == ['b','a']
                record('delete unreferenced page preserves all remaining page IDs')
                for mode in ['follow_index', 'follow_name']:
                    await call('upsert_controller_action', controller_name='Renamed', action={'type':'change_page','controllerName':'Target','targetMode':mode}, save=True)
                await call('reorder_controller_actions', controller_name='Renamed', ordered_indices=[1,0], save=True)
                await call('create_controller', name='HomeCleanup', page_names=['First','Second'])
                home_pages = (await controllers())['HomeCleanup']['pages']
                await call('remove_controller_page', controller_name='HomeCleanup', page_id=home_pages[0]['id'], replacement_page_id=home_pages[1]['id'], save=True)
                home_after = (await controllers())['HomeCleanup']
                assert home_after['homePageType'] == 'specific' and home_after['homePage'] == home_pages[1]['id'] and home_after['selectedPageId'] == home_pages[1]['id']
                await call('remove_controller', controller_name='HomeCleanup', save=True)
                record('explicit replacement removes first/current page without recreating remaining ID')
                await reject('upsert_controller_action', 'controller_cycle', controller_name='Target', action={'type':'change_page','controllerName':'Renamed','targetMode':'follow_index'})
                await call('set_controller_page', controller_name='Renamed', page_id='b')
                await call('set_controller_page', controller_name='Renamed', page_id='a')
                assert (await controllers())['Target']['selectedIndex'] == 1
                record('follow_name executes before follow_index in configured native order')
                await call('reorder_controller_actions', controller_name='Renamed', ordered_indices=[1,0])
                await call('set_controller_page', controller_name='Renamed', page_id='b')
                assert (await controllers())['Target']['selectedPage'] == 'Active'
                record('reverse action order changes actual native final page by follow_name')
                await call('reorder_controller_actions', controller_name='Renamed', ordered_indices=[1,0], save=True)
                await call('create_controller', name='Temporary', page_names=['Only'])
                only = (await controllers())['Temporary']['pages'][0]['id']
                await reject('remove_controller_page', 'last_page', controller_name='Temporary', page_id=only)
                operations = [
                    {'action':'rename_controller','params':{'controllerName':'Temporary','name':'BatchTemporary'}},
                    {'action':'rename_controller_page','params':{'controllerName':'BatchTemporary','pageId':only,'name':'Kept'}},
                    {'action':'reorder_controller_pages','params':{'controllerName':'BatchTemporary','orderedPageIds':[only]}},
                    {'action':'reorder_controller_actions','params':{'controllerName':'BatchTemporary','orderedIndices':[]}},
                    {'action':'remove_controller','params':{'controllerName':'BatchTemporary'}},
                ]
                revision = (await call('get_child_order'))['revision']
                batch = await call('apply_batch', document_url='ui://ctrltestroot', expected_revision=revision, operation_key='controller-lifecycle-batch', operations=operations, save=True)
                assert batch['status'] == 'succeeded' and batch['completed'] == len(operations)
                record('last page rejected; lifecycle batch renames/reorders/deletes and saves', batch)
                await call('create_controller', name='Cleanup', page_names=['One','Two'])
                pages = (await controllers())['Cleanup']['pages']
                await call('set_gear', gear_type='text', controller_name='Cleanup', object_id='label', default_value='base', page_values=[{'pageId': pages[1]['id'], 'value': 'two'}])
                await call('remove_controller_page', controller_name='Cleanup', page_id=pages[1]['id'], reference_policy='local', save=True)
                assert not any(g.get('controllerName') == 'Cleanup' for g in (await call('get_gears', object_id='label'))['gears'])
                await call('remove_controller', controller_name='Cleanup', save=True)
                record('explicit local cleanup removes entire referenced Gear')
                await call('set_controller_page', controller_name='Renamed', page_id='a', save=True)
                await call('get_publish_settings', package_name='Probe')
                publish = await call('publish', scope='packages', package_names=['Probe'], timeout_seconds=30)
                assert publish['success']
                root = published_root(project.parent/'published/Probe.bytes')
                state = root.find("controller[@name='Renamed']")
                assert state is not None and state.get('homePageType') == 'specific' and state.get('homePage') == 'b' and state.get('selected') == '1'
                record('native publication contains configured default home', ET.tostring(state,encoding='unicode'))
                await call('discard_document'); await call('open_document', package_name='Probe', item_name='Root')
                assert (await controllers())['Renamed']['homePage'] == 'b'
                record('save/discard/reopen retains home independently of preview')
            report['passed'] = True
            output.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--project', type=Path, required=True)
    parser.add_argument('--editor', required=True)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--read-only', action='store_true')
    args = parser.parse_args()
    asyncio.run(run(args.project.resolve(), args.editor, args.report.resolve(), args.read_only))
