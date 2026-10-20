"""真实 MCP 组件属性验证；只接受有专用 ID 的隔离夹具，不自动启动 Editor。"""
import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def run(project: Path, editor: str, output: Path, read_only: bool):
    if project.name != 'Capabilities.fairy' or ET.parse(project).getroot().get('id') != 'fgui-component-properties-regression-0001':
        raise ValueError('只允许专用组件属性回归夹具')
    report = {'evidence': 'live-windows-editor-mcp', 'cases': [], 'readOnly': read_only}
    def checked(name, condition):
        if not condition:
            raise AssertionError(name)
        report['cases'].append({'name': name, 'passed': True})
    root_url = 'ui://proptestroot'
    child_file = project.parent / 'assets/Probe/Child.xml'
    child_hash = hashlib.sha256(child_file.read_bytes()).hexdigest()
    params = StdioServerParameters(command=sys.executable, args=['-m', 'fairygui_agent.mcp_server', '--project', str(project), '--editor', editor], env=dict(os.environ))
    async with stdio_client(params) as (reader, writer):
        async with ClientSession(reader, writer) as session:
            init = await session.initialize()
            checked('0.11.0 handshake and 87 tools', init.serverInfo.version == '0.11.0' and len((await session.list_tools()).tools) == 87)
            async def raw(name, **kwargs):
                return await session.call_tool(name, kwargs)
            async def call(name, **kwargs):
                result = await raw(name, **kwargs)
                if result.isError:
                    raise AssertionError((name, result.content))
                return result.structuredContent or json.loads(next(c.text for c in result.content if c.type == 'text'))
            checked('existing explicit test Editor online', (await call('fgui_status'))['online'])
            await call('fgui_open_document', package_name='Probe', item_name='Root')
            async def instance(object_id='child1'):
                return await call('fgui_get_component_instance', object_id=object_id)
            async def revision():
                return (await call('fgui_get_objects', document_url=root_url, targets=[]))['revision']
            def prop(value, target='label', property_id=0):
                return next(p for p in value['properties'] if p['target'] == target and p['propertyId'] == property_id)
            if read_only:
                child = await instance()
                other = await instance('child2')
                batch = await call('fgui_get_component_instance', object_name='batch_child')
                checked('reopen controller override persists', next(c for c in child['controllers'] if c['name'] == 'State')['overridePageId'] == '1')
                checked('reopen text/icon/deep/empty overrides persist', prop(child)['value'] == 'Final' and prop(child, 'icon', 1)['value'] == 'ui://proptestpanel' and prop(child, 'inner.caption')['value'] == '')
                checked('reopen sibling still inherits original values', not prop(other)['overridden'] and prop(other)['effectiveValue'] == 'Base')
                checked('reopen batch alias target persists', prop(batch)['value'] == 'Batch')
                controllers = (await call('fgui_get_controllers'))['controllers']
                checked('reopen controller export and alias persist', controllers[0]['exported'] and controllers[0]['alias'] == '根状态')
                checked('reopen definition label persists', (await call('fgui_get_component_properties'))['properties'][0]['label'] == '标题')
                checked('reopen read-only document remains clean', not (await call('fgui_get_active_document'))['modified'])
            else:
                original = await instance()
                checked('read exported/private controls and inherited values', original['controllers'][0]['exported'] and not original['controllers'][1]['exported'] and not prop(original)['overridden'])
                result = await call('fgui_set_component_instance_controller', object_id='child1', controller_name='State', page_index=1)
                checked('native controller override and effective selection agree', result['after']['controllers'][0]['overridePageId'] == '1' and result['after']['controllers'][0]['selectedPageId'] == '1' and not result['saved'])
                await call('fgui_set_component_instance_property', object_id='child1', child_path='label', property_id=0, value='实例文案')
                await call('fgui_set_component_instance_property', object_id='child1', child_path='inner.caption', property_id=0, value='')
                await call('fgui_set_component_instance_property', object_id='child1', child_path='icon', property_id=1, value='ui://proptestpanel', save=True)
                now, other = await instance(), await instance('child2')
                checked('text/icon/deep/empty override values are effective', prop(now)['effectiveValue'] == '实例文案' and prop(now, 'inner.caption')['effectiveValue'] == '' and prop(now, 'icon', 1)['overridden'])
                checked('shared component file and sibling remain unchanged', hashlib.sha256(child_file.read_bytes()).hexdigest() == child_hash and prop(other)['effectiveValue'] == 'Base' and not other['controllers'][0]['overridden'])
                before = await revision()
                invalid = [
                    ('fgui_set_component_instance_controller', {'object_id': 'child1', 'controller_name': 'Private', 'page_index': 1}),
                    ('fgui_set_component_instance_controller', {'object_id': 'child1', 'controller_name': 'State', 'page_id': 'missing'}),
                    ('fgui_set_component_instance_property', {'object_id': 'child1', 'child_path': 'missing', 'property_id': 0, 'value': 'x'}),
                    ('fgui_set_component_instance_property', {'object_id': 'child1', 'child_path': 'label', 'property_id': 0, 'value': None}),
                    ('fgui_get_component_instance', {'object_id': 'label1'}),
                    ('fgui_upsert_component_property', {'child_path': 'caption', 'property_id': 1}),
                    ('fgui_set_controller_properties', {'controller_name': 'RootState', 'settings': {'homePage': '1'}}),
                ]
                for name, args in invalid:
                    checked('reject without mutation: ' + name + ':' + str(args), bool((await raw(name, **args)).isError) and await revision() == before)
                await call('fgui_upsert_component_property', child_path='caption', property_id=0, label='标题')
                checked('omitted definition label is a no-op', not (await call('fgui_upsert_component_property', child_path='caption', property_id=0))['changed'])
                await call('fgui_remove_component_property', child_path='caption', property_id=0)
                checked('definition removal does not delete target', not (await call('fgui_get_component_properties'))['properties'] and (await call('fgui_get_objects', document_url=root_url, targets=[{'id': 'title1'}]))['objects'][0]['id'] == 'title1')
                operations = [
                    {'action': 'set_controller_properties', 'params': {'controllerName': 'RootState', 'settings': {'exported': True, 'alias': '根状态'}}},
                    {'action': 'upsert_component_property', 'params': {'childPath': 'caption', 'propertyId': 0, 'label': '标题'}},
                    {'action': 'remove_component_property', 'params': {'childPath': 'caption', 'propertyId': 0}},
                    {'action': 'upsert_component_property', 'params': {'childPath': 'caption', 'propertyId': 0, 'label': '标题'}},
                    {'action': 'insert_object', 'ref': 'instance', 'params': {'url': 'ui://proptestchild', 'name': 'batch_child', 'x': 360, 'y': 0}},
                    {'action': 'set_component_instance_controller', 'params': {'target': {'id': '$instance'}, 'controllerName': 'State', 'pageName': 'Active'}},
                    {'action': 'set_component_instance_property', 'params': {'target': {'id': '$instance'}, 'childPath': 'label', 'propertyId': 0, 'value': 'Batch'}},
                ]
                batch = await call('fgui_apply_batch', document_url=root_url, expected_revision=await revision(), operation_key='instance-properties-batch', operations=operations, save=True)
                checked('all five new writers participate in one saved batch with native ID ref', batch['status'] == 'succeeded' and batch['completed'] == len(operations) and batch['persisted'])
                checked('batch controller export and alias readable', (await call('fgui_get_controllers'))['controllers'][0]['alias'] == '根状态')
                # Batch failure must expose the completed mutation and keep the document dirty.
                partial = await raw('fgui_apply_batch', document_url=root_url, expected_revision=await revision(), operation_key='instance-partial', operations=[
                    {'action': 'set_component_instance_property', 'params': {'target': {'id': 'child1'}, 'childPath': 'label', 'propertyId': 0, 'value': 'Partial'}},
                    {'action': 'set_component_instance_controller', 'params': {'target': {'id': 'child1'}, 'controllerName': 'Private', 'pageIndex': 1}},
                ])
                receipt = await call('fgui_get_batch_result', document_url=root_url, operation_key='instance-partial')
                checked('partial batch reports actual changed prefix without save', bool(partial.isError) and receipt['status'] == 'failed' and receipt['completed'] == 1 and not receipt['saved'] and prop(await instance())['value'] == 'Partial')
                await call('fgui_set_component_instance_property', object_id='child1', child_path='label', property_id=0, value='Final', save=True)
                disk = ET.parse(project.parent/'assets/Probe/Root.xml').getroot()
                saved_instance = disk.find("./displayList/component[@id='child1']")
                checked('native parent XML contains override and exposed definition', saved_instance.get('controller') == 'State,1' and saved_instance.find("property[@target='label']").get('value') == 'Final' and disk.find('customProperty').get('label') == '标题')
                checked('all instance edits still leave shared source file untouched', hashlib.sha256(child_file.read_bytes()).hexdigest() == child_hash)
                await call('fgui_open_document', package_name='Probe', item_name='Child')
                await call('fgui_upsert_component_property', child_path='inner.caption', property_id=0, label='内层文字')
                await call('fgui_remove_component_property', child_path='inner.caption', property_id=0)
                await call('fgui_upsert_component_property', child_path='inner.caption', property_id=0, label='内层文字', save=True)
                checked('nested definition native XML survives remove/readd', ET.parse(child_file).getroot().find("customProperty[@target='inner.caption']").get('label') == '内层文字')
                await call('fgui_set_controller_properties', controller_name='State', settings={'exported': False, 'alias': '状态备注'}, save=True)
                checked('disable export retains existing controller pages', not (await call('fgui_get_controllers'))['controllers'][0]['exported'])
                await call('fgui_set_controller_properties', controller_name='State', settings={'exported': True, 'alias': '状态'}, save=True)
                checked('enable export survives native root serialization', ET.parse(child_file).getroot().find('controller').get('exported') == 'true')
            report['serverVersion'] = init.serverInfo.version
            report['toolCount'] = 87
            report['passed'] = True
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'passed': report['passed'], 'cases': len(report['cases']), 'readOnly': read_only}, ensure_ascii=False))


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--project', type=Path, required=True)
    p.add_argument('--editor', required=True)
    p.add_argument('--report', type=Path, required=True)
    p.add_argument('--read-only', action='store_true')
    args = p.parse_args()
    asyncio.run(run(args.project.resolve(), args.editor, args.report, args.read_only))
