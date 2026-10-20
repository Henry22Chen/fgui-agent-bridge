"""五项 Editor 能力的真实 MCP 回归；只接受专用隔离夹具，报告必须输出到仓库之外。"""
import argparse
import asyncio
import json
import os
from pathlib import Path
import sys
import uuid
import xml.etree.ElementTree as ET

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


def published_list_count(data: bytes) -> int:
    """读取原生 XML 发布包的 name|UTF16长度|content 记录，仅用于夹具验证。"""
    data = data.decode('utf-8').encode('utf-16-le')
    offset = 0
    while offset < len(data):
        name_end = data.index(b'|\0', offset)
        length_end = data.index(b'|\0', name_end + 2)
        length = int(data[name_end + 2:length_end].decode('utf-16-le')) * 2
        content = data[length_end + 2:length_end + 2 + length]
        if data[offset:name_end].decode('utf-16-le') == 'root.xml':
            node = ET.fromstring(content.decode('utf-16-le')).find("./displayList/list[@id='list1']")
            assert node is not None
            return len(node.findall('item'))
        offset = length_end + 2 + length
    raise AssertionError('发布产物中缺少 root.xml')


async def run(project: Path, editor: str, report_path: Path):
    root = Path(__file__).resolve().parents[1]
    if project.resolve().is_relative_to(root):
        raise ValueError('必须复制夹具到仓库外，禁止直接写入受版本控制的夹具')
    if project.name != 'Capabilities.fairy' or ET.parse(project).getroot().get('id') != 'fgui-capability-regression-0001':
        raise ValueError('仅允许专用隔离测试工程')
    if report_path.resolve().is_relative_to(root):
        raise ValueError('验证报告必须放在仓库外')
    report = {'evidence': 'live-editor-mcp', 'project': str(project), 'cases': []}
    report_path.parent.mkdir(parents=True, exist_ok=True)
    def record(name, result):
        report['cases'].append({'name': name, 'result': result})
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print('PASS ' + name, flush=True)
    env = {**os.environ, 'PYTHONUTF8': '1', 'PYTHONPATH': str(root / 'src')}
    server = StdioServerParameters(command=sys.executable, args=['-B', '-m', 'fairygui_agent.mcp_server', '--project', str(project), '--editor', editor], env=env)
    async with stdio_client(server) as (read, write):
        async with ClientSession(read, write) as session:
            init = await session.initialize()
            assert init.serverInfo.version == '0.13.0'
            assert len((await session.list_tools()).tools) == 95
            async def call(tool, **kwargs):
                result = await session.call_tool(tool, kwargs)
                assert not result.isError, (tool, result.content)
                value = result.structuredContent
                if kwargs.get('save'): assert value.get('saved') and value.get('persisted'), value
                return value
            async def case(name, tool, **kwargs):
                value = await call(tool, **kwargs); record(name, value); return value
            async def rejects(name, tool, **kwargs):
                result = await session.call_tool(tool, kwargs)
                assert result.isError, (tool, result)
                record(name, str(result.content))
            await call('fgui_status')
            await call('fgui_ping')
            status = await call('fgui_status')
            assert status['online'] and status['versionMatch'], status
            record('MCP and plugin 0.13.0 / 95 tools', status)
            await call('fgui_get_project'); await call('fgui_list_packages')
            await call('fgui_open_document', package_name='Probe', item_name='Root')
            suffix = uuid.uuid4().hex[:6]
            group = await call('fgui_create_object', object_type='group', name='settings_group_' + suffix, group_member_ids=['loader1', 'text1'], save=True)
            group_id = group['after']['id']
            await case('advanced group with horizontal layout', 'fgui_set_group_settings', object_id=group_id,
                       settings={'advanced': True, 'layout': 'hz', 'columnGap': 5, 'excludeInvisibles': True, 'autoSizeDisabled': True,
                                 'hasMainGrid': True, 'mainGridIndex': 0}, save=True)
            await case('group settings read', 'fgui_get_group_settings', object_id=group_id)
            await rejects('invalid main-grid index rejected', 'fgui_set_group_settings', object_id=group_id, settings={'mainGridIndex': 999})
            input_result = await call('fgui_create_object', object_type='inputtext', name='settings_input_' + suffix, save=True)
            input_id = input_result['after']['id']
            await case('input prompt and input constraints', 'fgui_set_input_settings', object_id=input_id,
                       settings={'promptText': '[color=#888888]请输入编号[/color]', 'restrict': '0-9', 'maxLength': 12, 'password': False, 'keyboardType': 2}, save=True)
            await rejects('ordinary text cannot receive prompt', 'fgui_set_input_settings', object_id='text1', settings={'promptText': 'wrong'})
            mask = await call('fgui_create_object', object_type='graph', name='settings_mask_' + suffix, width=200, height=200, save=True)
            mask_id = mask['after']['id']
            await case('root mask reference and inversion', 'fgui_set_mask_settings', settings={'maskId': mask_id, 'reversedMask': True}, save=True)
            await rejects('group is not a mask graphic', 'fgui_set_mask_settings', settings={'maskId': group_id})
            await case('preset items prepared', 'fgui_set_list_item_resources', object_id='list1', settings={'items': [{'title': 'one'}, {'title': 'two'}]}, save=True)
            await case('clear presets on publish', 'fgui_set_list_settings', object_id='list1', settings={'clearOnPublish': True}, save=True)
            items = await call('fgui_get_list_item_resources', object_id='list1')
            assert len(items['settings']['items']) == 2
            record('editor preset items retained', items)
            await call('fgui_replace_object_resource', object_id='child1', resource_url='ui://captest0child', expected_type='component', save=True)
            await call('fgui_set_properties', object_id='child1', properties={'x': 20, 'y': 30, 'width': 80, 'height': 45, 'rotation': 12, 'alpha': 0.75}, save=True)
            await call('fgui_add_relation', object_id='child1', relation_type='Bottom_Bottom', save=True)
            await case('component instance replaced by Button component', 'fgui_replace_object_resource', object_id='child1', resource_url='ui://captest0button', expected_type='component', save=True)
            await rejects('self-reference rejected', 'fgui_replace_object_resource', object_id='child1', resource_url='ui://captest0root', expected_type='component')
            await rejects('image cannot replace component instance', 'fgui_replace_object_resource', object_id='child1', resource_url='ui://captest0panel', expected_type='component')
            # 干净隔离文档可用原生 DiscardChanges 强制重载，确保回读来自磁盘。
            await call('fgui_discard_document')
            # DiscardChanges 会关闭原文档；重新打开后才允许解析对象引用。
            await call('fgui_open_document', package_name='Probe', item_name='Root')
            checks = [
                ('reloaded group', 'fgui_get_group_settings', {'object_id': group_id}, lambda v: v['settings']['advanced'] and v['settings']['layout'] == 'hz' and v['settings']['columnGap'] == 5 and v['settings']['hasMainGrid'] and v['settings']['mainGridIndex'] == 0),
                ('reloaded input', 'fgui_get_input_settings', {'object_id': input_id}, lambda v: v['settings']['promptText'].endswith('[/color]') and v['settings']['maxLength'] == 12 and v['settings']['restrict'] == '0-9' and v['settings']['keyboardType'] == 2),
                ('reloaded mask', 'fgui_get_mask_settings', {}, lambda v: v['settings']['maskId'] == mask_id and v['settings']['reversedMask']),
                ('reloaded list', 'fgui_get_list_settings', {'object_id': 'list1'}, lambda v: v['settings']['clearOnPublish']),
                ('reloaded replacement', 'fgui_get_component_instance', {'object_id': 'child1'}, lambda v: v['resourceURL'] == 'ui://captest0button'),
            ]
            for name, tool, kwargs, check in checks:
                value = await call(tool, **kwargs); assert check(value), value; record(name, value)
            await case('clear mask', 'fgui_set_mask_settings', settings={'maskId': ''}, save=True)
            await case('clear prompt', 'fgui_set_input_settings', object_id=input_id, settings={'promptText': '', 'restrict': '', 'maxLength': 0}, save=True)
            await call('fgui_discard_document')
            await call('fgui_open_document', package_name='Probe', item_name='Root')
            empty_input = await call('fgui_get_input_settings', object_id=input_id)
            assert empty_input['settings']['promptText'] == '' and empty_input['settings']['restrict'] == '', empty_input
            record('empty prompt and restrict survive reload', empty_input)
            query = await call('fgui_get_objects', document_url='ui://captest0root', targets=[])
            batch = await call('fgui_apply_batch', document_url='ui://captest0root', expected_revision=query['revision'], operation_key='settings-' + suffix,
                               operations=[
                                   {'action': 'set_group_settings', 'params': {'target': {'id': group_id}, 'settings': {'advanced': True}}},
                                   {'action': 'set_input_settings', 'params': {'target': {'id': input_id}, 'settings': {'promptText': 'batch'}}},
                                   {'action': 'set_mask_settings', 'params': {'settings': {'maskId': mask_id}}},
                                   {'action': 'replace_object_resource', 'params': {'target': {'id': 'child1'}, 'resourceURL': 'ui://captest0child', 'expectedType': 'component'}},
                               ], save=True)
            assert batch['status'] == 'succeeded' and batch['completed'] == 4, batch
            record('all new writes in native batch with one save', batch)
            publish_settings = await call('fgui_get_publish_settings', package_name='Probe')
            output = project.parent / 'published'
            assert Path(publish_settings['global']['effectivePath']).resolve() == output.resolve(), publish_settings
            assert not publish_settings['global']['binaryFormat']
            for clear, expected in [(True, 0), (False, 2)]:
                await call('fgui_set_list_settings', object_id='list1', settings={'clearOnPublish': clear}, save=True)
                published = await call('fgui_publish', scope='packages', package_names=['Probe'], timeout_seconds=30)
                assert published['success'], published
                actual = published_list_count((output / 'Probe.bytes').read_bytes())
                assert actual == expected, (clear, actual, expected)
                source_items = ET.parse(project.parent / 'assets/Probe/Root.xml').findall("./displayList/list[@id='list1']/item")
                assert len(source_items) == 2
                record('publish list clear=' + str(clear), {'publishedItems': actual, 'sourceItems': len(source_items), 'publish': published})
            record('source XML after native saves', (project.parent / 'assets/Probe/Root.xml').read_text(encoding='utf-8'))
            print(f'{len(report["cases"])} live checks passed', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, required=True)
    parser.add_argument('--editor', required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    asyncio.run(run(args.project.resolve(), args.editor, args.report.resolve()))
