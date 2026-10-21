"""通过真实 MCP 验证外观、重载、批量、截图和发布；仅允许仓库外的专用视觉夹具。"""
import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import uuid
import xml.etree.ElementTree as ET

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


def published_root(data: bytes):
    """读取原生 XML 包的 UTF16 长度记录，避免非 ASCII 标题导致截断。"""
    data = data.decode('utf-8').encode('utf-16-le'); offset = 0
    while offset < len(data):
        name_end = data.index(b'|\0', offset); length_end = data.index(b'|\0', name_end + 2)
        length = int(data[name_end + 2:length_end].decode('utf-16-le')) * 2
        if data[offset:name_end].decode('utf-16-le') == 'root.xml':
            return ET.fromstring(data[length_end + 2:length_end + 2 + length].decode('utf-16-le'))
        offset = length_end + 2 + length
    raise AssertionError('原生发布包中缺少 root.xml')


async def run(project: Path, editor: str, report_path: Path):
    root = Path(__file__).resolve().parents[1]
    if project.is_relative_to(root) or report_path.is_relative_to(root):
        raise ValueError('测试工程和报告必须位于仓库外')
    if project.name != 'Capabilities.fairy' or ET.parse(project).getroot().get('id') != 'fgui-visual-regression-0001':
        raise ValueError('只允许外观专用夹具')
    expected_version = json.loads((root / 'plugin/package.json').read_text(encoding='utf-8'))['version']
    report = {'evidence': 'live-editor-mcp', 'project': str(project), 'cases': [], 'visualReview': 'pending'}
    report_path.parent.mkdir(parents=True, exist_ok=True)
    def record(name, value):
        report['cases'].append({'name': name, 'result': value})
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print('PASS ' + name, flush=True)
    env = {**os.environ, 'PYTHONUTF8': '1', 'PYTHONPATH': str(root / 'src')}
    server = StdioServerParameters(command=sys.executable, args=['-B', '-m', 'fairygui_agent.mcp_server', '--project', str(project), '--editor', editor], env=env)
    async with stdio_client(server) as (read, write):
        async with ClientSession(read, write) as session:
            initialized = await session.initialize(); listing = await session.list_tools()
            assert initialized.serverInfo.version == expected_version and len(listing.tools) >= 101
            async def call(tool, **kwargs):
                result = await session.call_tool(tool, kwargs)
                assert not result.isError, (tool, result.content)
                value = result.structuredContent
                if kwargs.get('save'): assert value.get('saved') and value.get('persisted'), value
                return value
            async def case(name, tool, **kwargs):
                value = await call(tool, **kwargs); record(name, value); return value
            async def reject(name, tool, **kwargs):
                before = await call('fgui_get_objects', document_url='ui://visual00root', targets=[])
                result = await session.call_tool(tool, kwargs); assert result.isError, (name, result)
                after = await call('fgui_get_objects', document_url='ui://visual00root', targets=[])
                assert before['revision'] == after['revision'], (name, before, after)
                record(name, str(result.content))
            async def reload():
                await call('fgui_discard_document')
                await call('fgui_open_document', package_name='Probe', item_name='Root')
            async def capture(label):
                result = await session.call_tool('fgui_capture_document', {'expected_document_url': 'ui://visual00root'})
                metadata = next(json.loads(item.text) for item in result.content if item.type == 'text')
                assert metadata.get('visualVerificationStatus') == 'pending_review', metadata
                source = project.parent / '.agent' / metadata['path']
                destination = report_path.parent / ('visual-' + label + '.png')
                shutil.copy2(source, destination)
                record('capture ' + label, {**metadata, 'localFile': str(destination)})
            await call('fgui_status'); await call('fgui_ping')
            status = await call('fgui_status'); assert status['online'] and status['versionMatch'], status
            record('MCP handshake and loaded plugin', {'server': initialized.serverInfo.version, 'tools': len(listing.tools), 'status': status})
            await call('fgui_get_project'); await call('fgui_list_packages')
            await call('fgui_open_document', package_name='Probe', item_name='Root')
            await call('fgui_set_image_settings', url='ui://visual00pattern', settings={'scaleMode': '9grid', 'scale9Grid': {'x': 8, 'y': 8, 'width': 48, 'height': 48}, 'gridTile': 0}, save=True)
            assets = project.parent / 'assets/Probe'
            hashes = {name: hashlib.sha256((assets / name).read_bytes()).hexdigest() for name in ['Pattern.png', 'package.xml', 'Tile.xml']}
            await case('opaque RGBA transparent border and four corners', 'fgui_set_graph_settings', object_id='shape', settings={
                'type': 'rect', 'fillColor': '#2080D0FF', 'lineColor': '#10203000', 'lineSize': 0, 'cornerRadius': [8, 16, 24, 32]}, save=True)
            await case('local fractional concave polygon', 'fgui_set_graph_settings', object_id='polygon', settings={
                'points': [{'x': -0.1, 'y': 112}, {'x': 80, 'y': 0}, {'x': 160, 'y': 112}, {'x': 80, 'y': 80}], 'fillColor': '#14B8A6', 'lineColor': '#064E3B', 'lineSize': 2}, save=True)
            await case('regular polygon vertex radii', 'fgui_set_graph_settings', object_id='regular', settings={
                'sides': 5, 'startAngle': -90, 'distances': [1, 0.65, 1, 0.65, 1], 'fillColor': '#F59E0B', 'lineSize': 0}, save=True)
            await case('ellipse style', 'fgui_set_graph_settings', object_id='ellipse', settings={'fillColor': '#A855F7', 'lineColor': '#581C87', 'lineSize': 3}, save=True)
            await case('image horizontal flip', 'fgui_set_image_display', object_id='picture', settings={'color': '#FFFFFFFF', 'flip': 'hz', 'fillMethod': 'none'}, save=True)
            await call('fgui_set_properties', object_id='reference', properties={'blendMode': 'add'}, save=True)
            await case('color filter neutral zeros and grayscale', 'fgui_set_filter_settings', object_id='reference', settings={
                'type': 'color', 'brightness': 0, 'contrast': 0, 'saturation': -1, 'hue': 0}, save=True)
            await case('single component instance filter', 'fgui_set_filter_settings', object_id='tile1', settings={'type': 'color', 'saturation': -1}, save=True)
            assert (await call('fgui_get_filter_settings', object_id='tile2'))['settings']['type'] == 'none'
            await capture('flip-filter')
            await reload()
            checks = [
                ('rect reload', 'fgui_get_graph_settings', 'shape', lambda s: s['fillColor'] == '#2080D0' and s['lineSize'] == 0 and s['lineColor'] == '#10203000' and s['cornerRadius'] == [8, 16, 24, 32]),
                ('polygon reload', 'fgui_get_graph_settings', 'polygon', lambda s: len(s['points']) == 4 and abs(s['points'][0]['x'] + 0.1) < 0.000001),
                ('regular reload', 'fgui_get_graph_settings', 'regular', lambda s: s['sides'] == 5 and s['startAngle'] == -90 and abs(s['distances'][1] - 0.65) < 0.000001),
                ('image reload', 'fgui_get_image_display', 'picture', lambda s: s['flip'] == 'hz' and s['fillMethod'] == 'none'),
                ('filter reload', 'fgui_get_filter_settings', 'reference', lambda s: s['saturation'] == -1 and s['brightness'] == 0),
                ('instance filter reload', 'fgui_get_filter_settings', 'tile1', lambda s: s['saturation'] == -1),
            ]
            for name, tool, target, validate in checks:
                value = await call(tool, object_id=target); assert validate(value['settings']), value; record(name, value)
            await call('fgui_set_graph_settings', object_id='shape', settings={'fillColor': '#2080D000'}, save=True)
            await reload(); value = await call('fgui_get_graph_settings', object_id='shape')
            assert value['settings']['fillColor'] == '#2080D000', value
            record('transparent graph fill survives reload', value)
            await call('fgui_set_graph_settings', object_id='shape', settings={'fillColor': '#2080D0'}, save=True)
            await reject('self-intersection rejected before mutation', 'fgui_set_graph_settings', object_id='polygon', settings={
                'points': [{'x': 0, 'y': 0}, {'x': 5, 'y': 5}, {'x': 0, 'y': 5}, {'x': 5, 'y': 0}, {'x': 6, 'y': -1}]})
            await reject('inactive geometry rejected', 'fgui_set_graph_settings', object_id='ellipse', settings={'cornerRadius': [1, 1, 1, 1]})
            await reject('polygon transition needs points', 'fgui_set_graph_settings', object_id='shape', settings={'type': 'polygon'})
            await reject('invalid color rejected', 'fgui_set_graph_settings', object_id='shape', settings={'fillColor': '#FFF'})
            await reject('numeric strings rejected', 'fgui_set_graph_settings', object_id='shape', settings={'lineSize': '2'})
            await reject('filter range rejected', 'fgui_set_filter_settings', object_id='reference', settings={'hue': 1.1})
            await reject('clear with parameters rejected', 'fgui_set_filter_settings', object_id='reference', settings={'type': 'none', 'brightness': 0})
            await reject('nested target rejected', 'fgui_set_image_display', object_id='tileIcon', settings={'flip': 'hz'})
            await reject('wrong object type rejected', 'fgui_set_graph_settings', object_id='picture', settings={'type': 'rect'})
            await case('empty graph type', 'fgui_set_graph_settings', object_id='ellipse', settings={'type': 'empty'}, save=True)
            await reload(); assert (await call('fgui_get_graph_settings', object_id='ellipse'))['settings'] == {'type': 'empty'}
            await call('fgui_set_graph_settings', object_id='ellipse', settings={'type': 'ellipse', 'fillColor': '#A855F7', 'lineColor': '#581C87', 'lineSize': 3}, save=True)
            await case('regular side count preserves radius prefix', 'fgui_set_graph_settings', object_id='regular', settings={'sides': 6}, save=True)
            regular = (await call('fgui_get_graph_settings', object_id='regular'))['settings']; assert regular['distances'][-1] == 1 and regular['startAngle'] == -90, regular
            await call('fgui_set_graph_settings', object_id='regular', settings={'sides': 5}, save=True)
            for method in ['hz', 'vt', 'radial90', 'radial180', 'radial360']:
                settings = {'fillMethod': method, 'fillOrigin': 0, 'fillAmount': 37}
                if method.startswith('radial'): settings['fillClockwise'] = False
                await case('fill method ' + method, 'fgui_set_image_display', object_id='picture', settings=settings, save=True)
            await reject('origin transition rejected', 'fgui_set_image_display', object_id='picture', settings={'fillOrigin': 4})
            await reject('percent overflow rejected', 'fgui_set_image_display', object_id='picture', settings={'fillAmount': 101})
            await call('fgui_set_image_display', object_id='picture', settings={'fillMethod': 'hz', 'fillOrigin': 1, 'fillAmount': 50}, save=True)
            await capture('linear-fill')
            await call('fgui_set_image_display', object_id='picture', settings={'fillMethod': 'radial90', 'fillOrigin': 3, 'fillAmount': 50, 'fillClockwise': False}, save=True)
            await capture('radial-fill')
            await call('fgui_set_image_display', object_id='picture', settings={'fillMethod': 'radial360'}, save=True)
            image = (await call('fgui_get_image_display', object_id='picture'))['settings']; assert image['fillOrigin'] == 3 and image['fillAmount'] == 50 and not image['fillClockwise'], image
            record('fill transition preserves unspecified active parameters', image)
            await case('transparent image and zero percent', 'fgui_set_image_display', object_id='picture', settings={'color': '#12345600', 'fillAmount': 0}, save=True)
            await reload(); image = (await call('fgui_get_image_display', object_id='picture'))['settings']; assert image['fillAmount'] == 0 and image['color'] == '#123456' and image['alpha'] == 0, image
            record('image alpha zero survives reload', image)
            await call('fgui_set_image_display', object_id='picture', settings={'color': '#12345680'}, save=True)
            await reload(); image = (await call('fgui_get_image_display', object_id='picture'))['settings']; assert abs(image['alpha'] - 0.502) < 0.000001, image
            record('partial image alpha survives reload', image)
            await case('clear color filter', 'fgui_set_filter_settings', object_id='reference', settings={'type': 'none'}, save=True)
            await reload(); assert (await call('fgui_get_filter_settings', object_id='reference'))['settings'] == {'type': 'none'}
            query = await call('fgui_get_objects', document_url='ui://visual00root', targets=[])
            batch = await call('fgui_apply_batch', document_url='ui://visual00root', expected_revision=query['revision'], operation_key='visual-' + uuid.uuid4().hex[:12], operations=[
                {'action': 'set_graph_settings', 'params': {'target': {'id': 'shape'}, 'settings': {'lineSize': 0, 'cornerRadius': [8, 16, 24, 32]}}},
                {'action': 'set_image_display', 'params': {'target': {'id': 'picture'}, 'settings': {'color': '#FFFFFFFF', 'fillMethod': 'radial90', 'fillOrigin': 3, 'fillAmount': 50, 'fillClockwise': False}}},
                {'action': 'set_filter_settings', 'params': {'target': {'id': 'label4'}, 'settings': {'type': 'color', 'brightness': 0.15}}},
            ], save=True)
            assert batch['status'] == 'succeeded' and batch['completed'] == 3, batch
            record('native batch three visual setters one save', batch)
            await call('fgui_set_properties', object_id='mask_sample', properties={'visible': True}, save=True)
            await call('fgui_set_mask_settings', settings={'maskId': 'shape'}, save=True)
            await case('masked graph refresh', 'fgui_set_graph_settings', object_id='shape', settings={'cornerRadius': [16, 24, 32, 40]}, save=True)
            assert (await call('fgui_get_mask_settings'))['settings']['maskId'] == 'shape'
            await capture('rounded-mask')
            await call('fgui_set_mask_settings', settings={'maskId': ''}, save=True)
            await call('fgui_set_properties', object_id='mask_sample', properties={'visible': False}, save=True)
            await capture('final')
            await reload()
            assert (await call('fgui_get_filter_settings', object_id='reference'))['settings']['type'] == 'none'
            assert (await call('fgui_get_filter_settings', object_id='tile2'))['settings']['type'] == 'none'
            for name, digest in hashes.items(): assert hashlib.sha256((assets / name).read_bytes()).hexdigest() == digest, name
            record('source pixels nine-slice package and shared component unchanged', hashes)
            image_settings = await call('fgui_get_image_settings', url='ui://visual00pattern'); assert image_settings['settings']['scaleMode'] == '9grid', image_settings
            source_xml = ET.parse(assets / 'Root.xml').getroot()
            image_xml = source_xml.find("./displayList/image[@id='picture']")
            assert image_xml.get('fillAmount') == '50' and image_xml.get('flip') == 'hz', ET.tostring(image_xml)
            assert source_xml.find("./displayList/image[@id='reference']").get('filter') is None
            assert source_xml.find("./displayList/image[@id='reference']").get('blend') == 'add'
            record('filter clear preserves blend mode', 'add')
            publish_settings = await call('fgui_get_publish_settings', package_name='Probe')
            assert Path(publish_settings['global']['effectivePath']).resolve() == (project.parent / 'published').resolve()
            published = await call('fgui_publish', scope='packages', package_names=['Probe'], timeout_seconds=30); assert published['success'], published
            exported = published_root((project.parent / 'published/Probe.bytes').read_bytes())
            for tag, identifier in [('graph', 'shape'), ('graph', 'polygon'), ('graph', 'regular'), ('image', 'picture'), ('image', 'reference'), ('component', 'tile1')]:
                source = source_xml.find(f"./displayList/{tag}[@id='{identifier}']"); target = exported.find(f"./displayList/{tag}[@id='{identifier}']")
                assert source is not None and target is not None
                for attribute in ['type', 'color', 'alpha', 'blend', 'lineColor', 'fillColor', 'lineSize', 'corner', 'points', 'sides', 'startAngle', 'distances', 'flip', 'fillMethod', 'fillOrigin', 'fillAmount', 'fillClockwise', 'filter', 'filterData']:
                    assert source.get(attribute) == target.get(attribute), (identifier, attribute, source.attrib, target.attrib)
            record('native publish retains visual settings and cleared filter', published)
            print(f'{len(report["cases"])} live visual checks passed; screenshots await actual review', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, required=True); parser.add_argument('--editor', required=True); parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    asyncio.run(run(args.project.resolve(), args.editor, args.report.resolve()))
