"""真实 Editor 性能/边界验证；只允许专用 Capabilities.fairy 夹具。"""
import argparse
import asyncio
import base64
import json
import os
from pathlib import Path
import sys
import time
import xml.etree.ElementTree as ET

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def run(project: Path, report_path: Path, editor: str, read_only: bool = False):
    if project.name != 'Capabilities.fairy' or ET.parse(project).getroot().get('id') != 'fgui-capability-regression-0001':
        raise ValueError('只允许专用隔离夹具，禁止对业务工程运行')
    report = {'evidence': 'live-windows-editor-mcp', 'cases': [], 'metrics': {}}
    report_path.parent.mkdir(parents=True, exist_ok=True)
    server = StdioServerParameters(command=sys.executable, args=['-m', 'fairygui_agent.mcp_server', '--project', str(project), '--editor', editor],
                                   env={**os.environ, 'PYTHONUTF8': '1', 'PYTHONPATH': str(Path(__file__).resolve().parents[1] / 'src')})
    try:
        async with stdio_client(server) as (reader, writer):
            async with ClientSession(reader, writer) as session:
                init = await session.initialize()
                report['serverVersion'] = init.serverInfo.version
                report['toolCount'] = len((await session.list_tools()).tools)
                assert report['serverVersion'] == '0.10.0' and report['toolCount'] == 80

                async def call(name, **kwargs):
                    result = await session.call_tool(name, kwargs)
                    if result.isError:
                        raise AssertionError(str(result.content))
                    return result.structuredContent or json.loads(next(c.text for c in result.content if c.type == 'text'))

                async def expect_error(label, name, **kwargs):
                    result = await session.call_tool(name, kwargs)
                    assert result.isError, label
                    report['cases'].append({'name': label, 'passed': True})
                    print('PASS:', label, flush=True)
                    return result

                def passed(label, **details):
                    report['cases'].append({'name': label, 'passed': True, **details})
                    print('PASS:', label, flush=True)

                status = await call('fgui_status')
                assert status['online'] and status['versionMatch'], 'Editor 必须由测试准备步骤独立打开，不自动 ping'
                assert Path(status['project']['projectFile']).resolve() == project.resolve()
                report['editorPid'] = status['status']['editorProcessId']
                await call('fgui_open_document', package_name='Probe', item_name='Root')
                url = 'ui://captest0root'

                async def revision():
                    return (await call('fgui_get_objects', document_url=url, targets=[]))['revision']

                # A just-opened fixture may finish native text/resource layout on the next Editor frame.
                # The production guard correctly rejects that change; benchmark only after it settles.
                previous = await revision()
                for _ in range(20):
                    current = await revision()
                    if current == previous:
                        break
                    previous = current
                else:
                    raise AssertionError('原生文档布局未稳定，不能开始性能对照')

                async def batch(key, operations, save=False, **kwargs):
                    return await call('fgui_apply_batch', document_url=url, expected_revision=await revision(), operation_key=key,
                                      operations=operations, save=save, **kwargs)

                if read_only:
                    objects = (await call('fgui_get_objects', document_url=url, targets=[{'name': f'perf_label{i}'} for i in range(20)]))['objects']
                    assert len(set(o['id'] for o in objects)) == 20
                    for i, obj in enumerate(objects):
                        assert (obj['x'], obj['y'], obj['width'], obj['height']) == (10 + i * 3, 10 + (i % 10) * 24, 120, 25)
                    passed('reopen native IDs and 20 object geometries persist')
                    obj = (await call('fgui_get_objects', document_url=url, targets=[{'id': 'loader1'}]))['objects'][0]
                    assert obj['x'] == 77 and obj['y'] == 88
                    passed('reopen external XML geometry persists')
                    receipt = await call('fgui_get_batch_result', document_url=url, operation_key='layout-labels')
                    assert receipt['status'] == 'unknown' and not receipt['retrySafe']
                    passed('new Editor instance does not replay old receipts')
                    assert not (await call('fgui_get_active_document'))['modified']
                    passed('read-only reopen validation leaves document clean')
                    return

                query = await call('fgui_get_objects', document_url=url, targets=[{'id': 'loader1'}, {'id': 'text1'}], fields=['x', 'width'])
                assert len(query['objects']) == 2 and 'children' not in query['objects'][0]
                passed('native full snapshot revision and targeted read')
                await expect_error('wrong document rejected', 'fgui_get_objects', document_url='ui://captest0other', targets=[])
                await expect_error('unknown query field rejected', 'fgui_get_objects', document_url=url, targets=[], fields=['unsafe'])
                operations = [{'action': 'create_object', 'ref': f'label{i}', 'params': {'objectType': 'text', 'name': f'perf_label{i}', 'width': 100, 'height': 24}} for i in range(20)]
                original_revision = await revision()
                dry = await call('fgui_apply_batch', document_url=url, expected_revision=original_revision, operation_key='create-labels', operations=operations, dry_run=True)
                assert dry['status'] == 'preflight' and not dry['mutationPerformed']
                passed('dry-run creates no nodes')
                created = await call('fgui_apply_batch', document_url=url, expected_revision=original_revision, operation_key='create-labels', operations=operations)
                assert created['status'] == 'succeeded' and len(set(created['aliases'].values())) == 20
                replay = await call('fgui_apply_batch', document_url=url, expected_revision=original_revision, operation_key='create-labels', operations=operations)
                assert replay['replayed'] and replay['aliases'] == created['aliases']
                passed('20 native IDs and replay without duplicate creation')
                await expect_error('operation key reuse rejected', 'fgui_apply_batch', document_url=url, expected_revision=original_revision, operation_key='create-labels', operations=operations, save=True)
                aliases = created['aliases']
                targets = [{'id': aliases[f'label{i}']} for i in range(20)]
                patches = [{'x': 10 + i * 3, 'y': 10 + (i % 10) * 24, 'width': 120, 'height': 25} for i in range(20)]
                before = len((await call('fgui_diagnostics', limit=100))['records'])
                start = time.perf_counter()
                for target, properties in zip(targets, patches):
                    for name, value in properties.items():
                        await call('fgui_set_property', object_id=target['id'], property_name=name, value=value)
                scalar_seconds = time.perf_counter() - start
                scalar_records = (await call('fgui_diagnostics', limit=100))['records']
                assert sum(r['action'] == 'set_property' for r in scalar_records[-80:]) == 80
                reset = [{'action': 'set_properties', 'params': {'target': target, 'properties': {'x': 0, 'y': 0, 'width': 100, 'height': 24}}} for target in targets]
                await batch('reset-labels', reset)
                layout = [{'action': 'set_properties', 'params': {'target': target, 'properties': properties}} for target, properties in zip(targets, patches)]
                rev = await revision()
                start = time.perf_counter()
                compact = await call('fgui_apply_batch', document_url=url, expected_revision=rev, operation_key='layout-labels', operations=layout)
                batch_seconds = time.perf_counter() - start
                last = (await call('fgui_diagnostics', limit=1))['records'][0]
                assert last['action'] == 'apply_batch' and last['editor']['executionMs'] >= 0 and not last['failed']
                full = await call('fgui_get_batch_result', document_url=url, operation_key='layout-labels', verbose=True)
                compact_bytes, full_bytes = len(json.dumps(compact)), len(json.dumps(full))
                assert compact['completed'] == 20 and compact_bytes < full_bytes * .3
                actual = await call('fgui_get_objects', document_url=url, targets=targets)
                for obj, patch in zip(actual['objects'], patches):
                    assert all(obj[k] == v for k, v in patch.items())
                report['metrics'] = {'scalarRequests': 80, 'batchRequests': 1, 'scalarSeconds': scalar_seconds, 'batchSeconds': batch_seconds,
                                     'compactBytes': compact_bytes, 'verboseBytes': full_bytes, 'batchTiming': last}
                passed('80 scalar requests versus one batch with same final geometry')
                passed('compact receipt below 30 percent of verbose')
                old_revision = await revision()
                await call('fgui_set_property', object_id='loader1', property_name='x', value=3)
                await expect_error('stale plan rejected', 'fgui_apply_batch', document_url=url, expected_revision=old_revision, operation_key='stale-plan', operations=layout)
                partial_ops = [{'action': 'set_properties', 'params': {'target': {'id': 'loader1'}, 'properties': {'x': 22}}},
                               {'action': 'set_properties', 'params': {'target': {'id': 'text1'}, 'properties': {'autoSize': 'both', 'width': 10}}}]
                await expect_error('partial failure is MCP error', 'fgui_apply_batch', document_url=url, expected_revision=await revision(), operation_key='partial', operations=partial_ops)
                partial = await call('fgui_get_batch_result', document_url=url, operation_key='partial')
                assert partial['status'] == 'failed' and partial['completed'] == 1 and not partial['saved']
                assert (await call('fgui_get_objects', document_url=url, targets=[{'id': 'loader1'}]))['objects'][0]['x'] == 22
                passed('partial receipt retains completed write without saving')
                await expect_error('dirty external handoff rejected', 'fgui_begin_external_edit', document_url=url)
                saved = await batch('save-fixture', [
                    {'action': 'set_properties', 'params': {'target': {'id': 'loader1'}, 'properties': {'x': 22}}},
                    {'action': 'set_gear', 'params': {'target': {'id': 'text1'}, 'gearType': 'text', 'controllerName': 'State',
                                                    'defaultValue': 'Idle', 'pageValues': [{'pageId': '1', 'value': 'Active'}]}}
                ], save=True)
                assert saved['saved'] and saved['persisted']
                passed('one component save verified by native XML snapshot')
                controllers_before = await call('fgui_get_controllers')
                capture = await session.call_tool('fgui_capture_states', {'document_url': url, 'states': [{'label': 'idle', 'controllers': {'State': '0'}}, {'label': 'active', 'controllers': {'State': '1'}}]})
                assert not capture.isError
                metadata = json.loads(next(c.text for c in capture.content if c.type == 'text'))
                assert metadata['restored'] and len(metadata['captures']) == 2
                assert sum(c.type == 'image' for c in capture.content) == 1
                image = next(c for c in capture.content if c.type == 'image')
                (report_path.parent / 'performance-states.png').write_bytes(base64.b64decode(image.data))
                assert (await call('fgui_get_controllers'))['controllers'] == controllers_before['controllers']
                passed('two states one image and complete snapshot restored')
                await expect_error('invalid capture page rejected before changing state', 'fgui_capture_states', document_url=url, states=[{'label': 'bad', 'controllers': {'State': 'missing'}}])
                ticket = await call('fgui_begin_external_edit', document_url=url)
                component_path = Path(ticket['file']).resolve()
                assert component_path.is_relative_to(project.parent.resolve()) and component_path.name == 'Root.xml'
                tree = ET.parse(component_path)
                loader = next(n for n in tree.getroot().find('displayList') if n.get('id') == 'loader1')
                loader.set('xy', '77,88')
                tree.write(component_path, encoding='utf-8', xml_declaration=True)
                finished = await call('fgui_finish_external_edit', document_url=url, token=ticket['token'])
                assert finished['reloaded'] and not finished['saved']
                obj = (await call('fgui_get_objects', document_url=url, targets=[{'id': 'loader1'}]))['objects'][0]
                assert obj['x'] == 77 and obj['y'] == 88
                passed('external XML reload refreshes actual native geometry')
                await expect_error('external ticket cannot be reused', 'fgui_finish_external_edit', document_url=url, token=ticket['token'])
                ticket = await call('fgui_begin_external_edit', document_url=url)
                await call('fgui_set_property', object_id='loader1', property_name='x', value=99)
                await expect_error('foreign native edit prevents discard', 'fgui_finish_external_edit', document_url=url, token=ticket['token'], allow_unchanged_dirty=True)
                assert (await call('fgui_get_objects', document_url=url, targets=[{'id': 'loader1'}]))['objects'][0]['x'] == 99
                await call('fgui_set_property', object_id='loader1', property_name='x', value=77)
                assert (await call('fgui_finish_external_edit', document_url=url, token=ticket['token'], allow_unchanged_dirty=True))['reloaded']
                passed('explicit dirty reload allowed only after complete snapshot restored')
                ticket = await call('fgui_begin_external_edit', document_url=url)
                original = component_path.read_bytes()
                tree = ET.parse(component_path)
                nodes = tree.getroot().find('displayList')
                nodes[1].set('id', nodes[0].get('id'))
                tree.write(component_path, encoding='utf-8', xml_declaration=True)
                try:
                    await expect_error('duplicate external object IDs rejected before reload', 'fgui_finish_external_edit', document_url=url, token=ticket['token'])
                finally:
                    component_path.write_bytes(original)
                assert (await call('fgui_finish_external_edit', document_url=url, token=ticket['token']))['reloaded']
                unknown = await call('fgui_get_batch_result', document_url=url, operation_key='does-not-exist')
                assert unknown['status'] == 'unknown' and not unknown['retrySafe']
                passed('unknown receipt never claims safe retry')
                assert (await call('fgui_status'))['status']['editorProcessId'] == report['editorPid']
                passed('same target Editor process throughout validation')
    finally:
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--project', required=True, type=Path)
    parser.add_argument('--report', required=True, type=Path)
    parser.add_argument('--editor', required=True)
    parser.add_argument('--read-only', action='store_true')
    args = parser.parse_args()
    asyncio.run(run(args.project.resolve(), args.report.resolve(), args.editor, args.read_only))
