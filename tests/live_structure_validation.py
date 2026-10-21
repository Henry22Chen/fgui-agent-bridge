"""对象复制、引用修复、层级与批量的真实 MCP 回归；只允许仓库外的专用工程。"""
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


async def run(project: Path, editor: str, report_path: Path):
    root = Path(__file__).resolve().parents[1]
    if project.is_relative_to(root) or report_path.is_relative_to(root): raise ValueError('测试工程与报告必须位于仓库外')
    if project.name != 'Capabilities.fairy' or ET.parse(project).getroot().get('id') != 'fgui-structure-regression-0001': raise ValueError('仅允许结构回归专用工程')
    assets = project.parent / 'assets/Probe'
    report = {'evidence': 'live-editor-mcp', 'cases': [], 'visualReview': 'pending'}
    def record(name, value):
        report['cases'].append({'name': name, 'result': value})
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8'); print('PASS ' + name, flush=True)
    env = {**os.environ, 'PYTHONUTF8': '1', 'PYTHONPATH': str(root / 'src')}
    server = StdioServerParameters(command=sys.executable, args=['-B', '-m', 'fairygui_agent.mcp_server', '--project', str(project), '--editor', editor], env=env)
    async with stdio_client(server) as (read, write):
        async with ClientSession(read, write) as session:
            init = await session.initialize(); listing = await session.list_tools()
            assert init.serverInfo.version == '0.16.0' and len(listing.tools) == 108
            async def call(tool, **kwargs):
                result = await session.call_tool('fgui_' + tool, kwargs); assert not result.isError, (tool, result.content)
                value = result.structuredContent
                if kwargs.get('save'): assert value['saved'] and value['persisted'], value
                return value
            async def case(name, tool, **kwargs):
                value = await call(tool, **kwargs); record(name, value); return value
            async def reload():
                await call('discard_document'); await call('open_document', package_name='Probe', item_name='Root')
            async def reject(name, tool, **kwargs):
                before = await call('get_child_order'); disk = (assets / 'Root.xml').read_bytes()
                result = await session.call_tool('fgui_' + tool, kwargs); assert result.isError, result
                after = await call('get_child_order')
                assert before['revision'] == after['revision'] and before['order'] == after['order'] and disk == (assets / 'Root.xml').read_bytes(), name
                record(name, str(result.content))
            async def capture(label):
                result = await session.call_tool('fgui_capture_document', {'expected_document_url': 'ui://struct00root'})
                metadata = next(json.loads(c.text) for c in result.content if c.type == 'text')
                assert metadata['visualVerificationStatus'] == 'pending_review', metadata
                dest = report_path.parent / ('structure-' + label + '.png')
                shutil.copy2(project.parent / '.agent' / metadata['path'], dest); record('capture ' + label, {**metadata, 'localFile': str(dest)})
            await call('status'); await call('ping'); await call('get_project'); await call('list_packages')
            status = await call('status'); assert status['versionMatch'] and status['pluginVersion'] == '0.16.0'
            record('MCP handshake and loaded plugin', {'version': init.serverInfo.version, 'tools': len(listing.tools)})
            await call('open_document', package_name='Probe', item_name='Root')
            hashes = {n: hashlib.sha256((assets / n).read_bytes()).hexdigest() for n in ['Child.xml', 'Pattern.png', 'package.xml']}
            await call('set_component_instance_property', object_id='instance1', child_path='caption', property_id=0, value='Override', save=True)
            await call('set_component_instance_controller', object_id='instance1', controller_name='Appearance', page_id='b', save=True)
            await call('upsert_transition', transition={'name': 'ExistingMove', 'items': [{'targetId': 'over1', 'type': 'XY', 'frame': 0, 'value': {'x': 500, 'y': 300}}]})
            await call('upsert_component_property', child_path='label', property_id=0, label='OriginalLabel', save=True)
            # 根级引用必须保留原目标；对比真实持久化定义，而不是只检查克隆自身。
            def root_definitions():
                return [ET.tostring(n, encoding='unicode') for n in ET.parse(assets / 'Root.xml').getroot() if n.tag != 'displayList']
            definitions = root_definitions()
            initial = await case('read complete child order', 'get_child_order')
            assert len(initial['order']) == 11 and initial['childrenRenderOrder'] == 'ascent', initial
            await capture('initial')
            await reject('external Relation rejected by default', 'duplicate_objects', targets=[{'id': 'linked'}])
            await reject('external group rejected by default', 'duplicate_objects', targets=[{'id': 'label1'}])
            await reject('root copy rejected', 'duplicate_objects', targets=[{'path': 'root'}])
            await reject('nested copy rejected', 'duplicate_objects', targets=[{'path': 'root/instance/caption'}])
            await reject('duplicate source rejected', 'duplicate_objects', targets=[{'id': 'picture'}, {'name': 'picture'}])
            await reject('name conflict rejected before allocation', 'duplicate_objects', targets=[{'id': 'picture'}], names={'picture': 'panel'}, naming_policy='error')
            await reject('bad offset rejected before allocation', 'duplicate_objects', targets=[{'id': 'picture'}], offset={'x': '1'})
            await reject('fractional GearXY offset rejected', 'duplicate_objects', targets=[{'id': 'grp1'}], offset={'x': 0.5})
            await reject('bad alias source rejected before allocation', 'duplicate_objects', targets=[{'id': 'picture'}], refs={'linked': 'missing'})
            image = await case('image clone preserves resource flip geometry', 'duplicate_objects', targets=[{'id': 'picture'}], offset={'x': -80, 'y': 80}, names={'picture': 'pictureTwin'}, refs={'picture': 'pic'}, save=True)
            image_id = image['idMap']['picture']; assert image['aliases']['pic'] == image_id and not image['clipboardTouched']
            await reload()
            xml = ET.parse(assets / 'Root.xml').getroot(); img = xml.find(f"./displayList/image[@id='{image_id}']")
            assert img.get('flip') == 'hz' and img.get('xy') == '630,110' and img.get('src') == 'panel', img.attrib
            await call('set_mask_settings', settings={'maskId': 'rectA'}, save=True)
            group = await case('group closure internal references and offset', 'duplicate_objects', targets=[{'id': 'grp1'}], offset={'x': 240, 'y': 0}, save=True)
            assert group['expandedSourceIds'] == ['rectA', 'label1', 'grp1'] and len(set(group['idMap'].values())) == 3, group
            await reload(); mapping = group['idMap']
            assert (await call('get_mask_settings'))['settings']['maskId'] == 'rectA'
            label = (await call('get_objects', document_url='ui://struct00root', targets=[{'id': mapping['label1']}], fields=['x', 'y', 'groupId']))['objects'][0]
            assert label['x'] == 280 and label['y'] == 40 and label['groupId'] == mapping['grp1'], label
            relations = (await call('get_relations', object_id=mapping['label1']))['relations']; assert relations[0]['targetId'] == mapping['rectA'], relations
            gears = (await call('get_gears', object_id=mapping['label1']))['gears']; xy = next(g for g in gears if g['type'] == 'xy')
            assert xy['defaultValue'] == {'x': 280, 'y': 40} and xy['pageValues'][0]['value'] == {'x': 300, 'y': 55}, xy
            await call('set_controller_page', controller_name='State', page_id='s1')
            active = (await call('get_objects', document_url='ui://struct00root', targets=[{'id': mapping['label1']}], fields=['x', 'y', 'text']))['objects'][0]
            assert active['x'] == 300 and active['y'] == 55 and active['text'] == 'Second', active
            await call('set_controller_page', controller_name='State', page_id='s0', save=True)
            record('cloned Gear states and root mask reference survive reload', {'label': label, 'active': active})
            await call('set_mask_settings', settings={'maskId': ''}, save=True)
            instance = await case('component instance overrides cloned', 'duplicate_objects', targets=[{'id': 'instance1'}], offset={'x': 350}, save=True)
            instance_id = instance['idMap']['instance1']; await reload()
            copied = await call('get_component_instance', object_id=instance_id)
            assert 'Override' in json.dumps(copied) and '"selectedPageId": "b"' in json.dumps(copied), copied
            original_items = (await call('get_list_item_resources', object_id='list1'))['settings']
            cloned_list = await case('native List preset items cloned', 'duplicate_objects', targets=[{'id': 'list1'}], offset={'x': 180}, save=True)
            await reload()
            assert (await call('get_list_item_resources', object_id=cloned_list['idMap']['list1']))['settings'] == original_items
            kept = await case('external Relation explicitly preserved', 'duplicate_objects', targets=[{'id': 'linked'}], offset={'x': 200}, external_references='preserve', save=True)
            assert kept['externalReferences'] == [{'sourceId': 'linked', 'kind': 'relation', 'targetId': 'external'}], kept
            await reload(); kept_relations = (await call('get_relations', object_id=kept['idMap']['linked']))['relations']; assert kept_relations[0]['targetId'] == 'external'
            current = await call('get_child_order'); order = current['order']
            await reject('incomplete order rejected', 'reorder_objects', ordered_ids=order[:-1])
            await reject('duplicate order ID rejected', 'reorder_objects', ordered_ids=order[:-1] + [order[0]])
            await reject('foreign order ID rejected', 'reorder_objects', ordered_ids=order[:-1] + ['foreign'])
            front = [i for i in order if i != 'over1'] + ['over1']
            await case('move blue to front with complete order', 'reorder_objects', ordered_ids=front, save=True)
            await reload(); assert (await call('get_child_order'))['order'] == front
            assert [n.get('id') for n in ET.parse(assets / 'Root.xml').getroot().find('displayList')] == front
            await capture('blue-front')
            back = ['over1'] + [i for i in order if i != 'over1']
            await case('move blue to back with complete order', 'reorder_objects', ordered_ids=back, save=True)
            await reload(); assert (await call('get_child_order'))['order'] == back
            await capture('blue-back')
            query = await call('get_child_order'); operation_key = 'structure-' + uuid.uuid4().hex[:12]
            operations = [
                {'action': 'duplicate_objects', 'params': {'targets': [{'id': 'picture'}], 'offset': {'x': -200, 'y': 400}, 'refs': {'picture': 'batchPic'}}},
                {'action': 'set_properties', 'params': {'target': {'id': '$batchPic'}, 'properties': {'name': 'BatchPicture'}}},
                {'action': 'reorder_objects', 'params': {'orderedIds': query['order'] + ['$batchPic']}},
            ]
            args = {'document_url': 'ui://struct00root', 'expected_revision': query['revision'], 'operation_key': operation_key, 'operations': operations, 'save': True}
            batch = await call('apply_batch', **args); assert batch['status'] == 'succeeded' and batch['completed'] == 3, batch
            replay = await call('apply_batch', **args); assert replay['replayed'] and replay['aliases'] == batch['aliases']
            await reload(); assert (await call('get_child_order'))['order'] == query['order'] + [batch['aliases']['batchPic']]
            record('batch clone alias reorder and receipt replay', {'batch': batch, 'replayed': replay['replayed']})
            assert root_definitions() == definitions, root_definitions()
            record('root controllers Transition and property mappings retain original targets', definitions)
            for n, digest in hashes.items(): assert hashlib.sha256((assets / n).read_bytes()).hexdigest() == digest, n
            record('shared definitions pixels and package unchanged', hashes)
            settings = await call('get_publish_settings', package_name='Probe'); assert Path(settings['global']['effectivePath']).resolve() == project.parent / 'published'
            published = await call('publish', scope='packages', package_names=['Probe'], timeout_seconds=30); assert published['success'], published
            data = (project.parent / 'published/Probe.bytes').read_text(encoding='utf-8')
            assert 'BatchPicture' in data and instance_id in data and mapping['label1'] in data
            record('native publication includes clones and final order', published)
            print(f'{len(report["cases"])} native structure checks passed; screenshots require actual review', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, required=True); parser.add_argument('--editor', required=True); parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args(); asyncio.run(run(args.project.resolve(), args.editor, args.report.resolve()))
