"""通过真实 MCP 验证列表/树保存、重载、批量和原生发布；仅写仓库外专用工程，报告/截图不得入库。"""
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


def published_root(path: Path):
    """读取原生 XML 发布包的 UTF16 长度记录，返回真实 root.xml；不模拟发布器。"""
    data = path.read_text(encoding='utf-8').encode('utf-16-le'); offset = 0
    while offset < len(data):
        name_end = data.index(b'|\0', offset); length_end = data.index(b'|\0', name_end + 2)
        length = int(data[name_end + 2:length_end].decode('utf-16-le')) * 2
        content = data[length_end + 2:length_end + 2 + length]
        if data[offset:name_end].decode('utf-16-le') == 'root.xml': return ET.fromstring(content.decode('utf-16-le'))
        offset = length_end + 2 + length
    raise AssertionError('原生发布包缺少 root.xml')


async def run(project: Path, editor: str, report_path: Path):
    root = Path(__file__).resolve().parents[1]
    if project.is_relative_to(root) or report_path.is_relative_to(root): raise ValueError('测试工程和报告必须位于仓库外')
    if project.name != 'Capabilities.fairy' or ET.parse(project).getroot().get('id') != 'fgui-list-tree-regression-0001': raise ValueError('仅允许列表/树回归专用工程')
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
            assert init.serverInfo.version == '0.18.0' and len(listing.tools) == 110
            async def call(tool, **kwargs):
                result = await session.call_tool('fgui_' + tool, kwargs); assert not result.isError, (tool, result.content)
                value = result.structuredContent
                if kwargs.get('save'): assert value['saved'] and value['persisted'], value
                return value
            async def case(name, tool, **kwargs):
                value = await call(tool, **kwargs); record(name, value); return value
            async def reload():
                await call('discard_document'); await call('open_document', package_name='Probe', item_name='Root')
            async def snapshot():
                return {id: {'settings': (await call('get_list_settings', object_id=id))['settings'], 'items': (await call('get_list_item_resources', object_id=id))['settings']} for id in ('plain', 'tree')}
            async def reject(name, tool, **kwargs):
                before = await snapshot(); order = await call('get_child_order'); disk = (assets / 'Root.xml').read_bytes()
                result = await session.call_tool('fgui_' + tool, kwargs); assert result.isError, result
                assert before == await snapshot() and disk == (assets / 'Root.xml').read_bytes(), name
                after = await call('get_child_order'); assert order['order'] == after['order'] and order['modified'] == after['modified'], name
                record(name, str(result.content))
            async def capture(label):
                result = await session.call_tool('fgui_capture_document', {'expected_document_url': 'ui://treepr00root'})
                metadata = next(json.loads(c.text) for c in result.content if c.type == 'text'); assert metadata['visualVerificationStatus'] == 'pending_review'
                dest = report_path.parent / ('list-tree-' + label + '.png'); shutil.copy2(project.parent / '.agent' / metadata['path'], dest)
                record('capture ' + label, {**metadata, 'localFile': str(dest)})
            async def tree_items():
                return await call('get_list_item_resources', object_id='tree')
            async def publish():
                config = await call('get_publish_settings', package_name='Probe'); assert Path(config['global']['effectivePath']).resolve() == project.parent / 'published'
                result = await call('publish', scope='packages', package_names=['Probe'], timeout_seconds=30); assert result['success'], result
                node = published_root(project.parent / 'published/Probe.bytes').find("./displayList/list[@id='tree']"); assert node is not None
                return result, node
            await call('status'); await call('ping'); await call('get_project'); await call('list_packages')
            status = await call('status'); assert status['versionMatch'] and status['pluginVersion'] == '0.18.0'
            assert {'list_settings_advanced', 'list_item_levels'} <= set(status['status']['capabilities'])
            record('MCP handshake and extended list capabilities', {'version': init.serverInfo.version, 'tools': len(listing.tools)})
            await call('open_document', package_name='Probe', item_name='Root')
            hashes = {n: hashlib.sha256((assets / n).read_bytes()).hexdigest() for n in ['Cell.xml', 'Nested.xml', 'Icon.png', 'package.xml']}
            baseline = await case('advanced defaults and hierarchy read', 'get_list_settings', object_id='plain')
            assert baseline['settings']['selectionController'] == '' and baseline['settings']['indent'] == 15 and not baseline['settings']['treeViewEnabled']
            initial = await tree_items(); assert [n['parentIndex'] for n in initial['tree']['nodes']] == [None, 0, 0, None]
            assert initial['tree']['nativeDefaultFolderExpanded'] and not initial['tree']['expandedStateFieldAvailable']
            await capture('initial')
            await reject('unknown selection controller rejected', 'set_list_settings', object_id='plain', settings={'selectionController': 'Missing'})
            await reject('fractional indent rejected', 'set_list_settings', object_id='tree', settings={'indent': 0.5})
            await reject('numeric string indent rejected', 'set_list_settings', object_id='tree', settings={'indent': '24'})
            await reject('invalid click mode rejected', 'set_list_settings', object_id='tree', settings={'clickToExpand': 3})
            await reject('tree-only fields require tree mode', 'set_list_settings', object_id='plain', settings={'indent': 24})
            await reject('nested list definition rejected', 'set_list_settings', object_path='root/nested/innerList', settings={'treeViewEnabled': True})
            await reject('root is not a List', 'set_list_settings', object_path='root', settings={'treeViewEnabled': True})
            presets = (await call('get_list_item_resources', object_id='plain'))['settings']
            await call('set_scroll_settings', object_id='plain', settings={'pageMode': True, 'pageControllerName': 'Pages'}, save=True)
            advanced = await case('selection binding and advanced booleans persist', 'set_list_settings', object_id='plain', settings={'selectionController': 'Selection', 'foldInvisibleItems': True, 'scrollItemToViewOnClick': False}, save=True)
            await reload(); assert (await call('get_list_settings', object_id='plain'))['settings'] == advanced['after']
            assert (await call('get_list_item_resources', object_id='plain'))['settings'] == presets
            paging = (await call('get_scroll_settings', object_id='plain'))['settings']; assert paging['pageControllerName'] == 'Pages' and paging['pageMode']
            record('selection and page controllers remain independent', paging)
            await case('clear selection binding explicitly', 'set_list_settings', object_id='plain', settings={'selectionController': ''}, save=True)
            await reload(); assert (await call('get_list_settings', object_id='plain'))['settings']['selectionController'] == ''
            assert (await call('get_scroll_settings', object_id='plain'))['settings']['pageControllerName'] == 'Pages'
            tree_settings = await case('tree settings preserve preset hierarchy', 'set_list_settings', object_id='tree', settings={'selectionController': 'Selection', 'indent': 26, 'clickToExpand': 2, 'foldInvisibleItems': True, 'scrollItemToViewOnClick': False}, save=True)
            await reload(); assert (await call('get_list_settings', object_id='tree'))['settings'] == tree_settings['after']
            await reject('nonzero levels block leaving tree mode', 'set_list_settings', object_id='tree', settings={'treeViewEnabled': False})
            for label, items in [('first level must be zero', [{'sourceIndex': 0, 'level': 1}]), ('level jump rejected', [{'sourceIndex': 0, 'level': 0}, {'sourceIndex': 1, 'level': 2}]),
                                 ('negative level rejected', [{'sourceIndex': 0, 'level': -1}]), ('level byte overflow rejected', [{'sourceIndex': 0, 'level': 256}]),
                                 ('fractional level rejected', [{'sourceIndex': 0, 'level': 0.5}]), ('boolean level rejected', [{'sourceIndex': 0, 'level': True}]),
                                 ('string level rejected', [{'sourceIndex': 0, 'level': '0'}]), ('invalid source index rejected', [{'sourceIndex': 99, 'level': 0}]),
                                 ('folder flag is read only', [{'sourceIndex': 0, 'isFolder': True}]), ('expanded is not a persistent item field', [{'sourceIndex': 0, 'expanded': False}])]:
                await reject(label, 'set_list_item_resources', object_id='tree', settings={'items': items})
            await reject('ordinary list cannot store nonzero levels', 'set_list_item_resources', object_id='plain', settings={'items': [{'sourceIndex': 0, 'level': 0}, {'sourceIndex': 1, 'level': 1}]})
            properties = [{'target': 'Style', 'propertyId': -1, 'value': 'b'}, {'target': 'title', 'propertyId': 0, 'value': 'Source override'}]
            await call('set_list_item_resources', object_id='tree', settings={'items': [{'sourceIndex': 0}, {'sourceIndex': 1, 'properties': properties}, {'sourceIndex': 2}, {'sourceIndex': 3}]}, save=True)
            added = await case('multilevel insertion and independent sourceIndex copy', 'set_list_item_resources', object_id='tree', settings={'items': [
                {'sourceIndex': 0, 'level': 0, 'title': 'Root A'}, {'sourceIndex': 1, 'level': 1}, {'level': 2, 'title': 'Grandchild'},
                {'sourceIndex': 2, 'level': 1}, {'sourceIndex': 3, 'level': 0, 'title': 'Root B'}, {'sourceIndex': 1, 'level': 1, 'title': 'Copied child'}]}, save=True)
            assert [n['parentIndex'] for n in added['tree']['nodes']] == [None, 0, 1, 0, None, 4]
            await reload(); current = await tree_items(); assert [i['level'] for i in current['settings']['items']] == [0, 1, 2, 1, 0, 1]
            assert current['settings']['items'][1]['properties'] == current['settings']['items'][5]['properties'] == properties
            await capture('multilevel')
            reordered = await case('delete and reorder subtrees while retaining overrides', 'set_list_item_resources', object_id='tree', settings={'items': [
                {'sourceIndex': 4}, {'sourceIndex': 5}, {'sourceIndex': 0}, {'sourceIndex': 1}, {'sourceIndex': 2}]}, save=True)
            await reload(); current = await tree_items(); assert [n['parentIndex'] for n in current['tree']['nodes']] == [None, 0, None, 2, 3]
            assert current['settings']['items'][1]['properties'] == current['settings']['items'][3]['properties'] == properties
            await capture('reordered')
            published, node = await publish(); assert [int(n.get('level', '0')) for n in node.findall('item')] == [0, 1, 0, 1, 2]
            record('native publication preserves tree preorder and levels', published)
            await case('clearOnPublish enabled without deleting source items', 'set_list_settings', object_id='tree', settings={'clearOnPublish': True}, save=True)
            await reload(); assert len((await tree_items())['settings']['items']) == 5
            published, node = await publish(); assert not node.findall('item'); assert len(ET.parse(assets / 'Root.xml').getroot().find("./displayList/list[@id='tree']").findall('item')) == 5
            record('publication clears only exported tree examples', published)
            await call('set_list_settings', object_id='tree', settings={'clearOnPublish': False}, save=True)
            await reload(); published, node = await publish(); assert len(node.findall('item')) == 5
            record('publication restores examples when clear flag disabled', published)
            flattened = await case('explicit flatten before normal list conversion', 'set_list_item_resources', object_id='tree', settings={'items': [{'sourceIndex': i, 'level': 0} for i in range(5)]}, save=True)
            converted = await case('leave tree mode without silent data loss', 'set_list_settings', object_id='tree', settings={'treeViewEnabled': False}, save=True)
            assert converted['inactiveTreeFields'] == ['indent', 'clickToExpand']
            await reload(); current = await tree_items(); assert all(i['level'] == 0 for i in current['settings']['items']) and current['settings']['items'][1]['properties'] == properties
            assert (await call('get_list_settings', object_id='tree'))['settings']['indent'] == 15
            await call('set_list_settings', object_id='tree', settings={'treeViewEnabled': True, 'indent': 20}, save=True)
            query = await call('get_child_order')
            batch = await case('batch creates tree and assigns level through alias', 'apply_batch', document_url='ui://treepr00root', expected_revision=query['revision'], operation_key='tree-' + uuid.uuid4().hex[:12], save=True,
                               operations=[{'action': 'create_object', 'ref': 'newTree', 'params': {'objectType': 'list', 'name': 'BatchTree', 'x': 20, 'y': 470, 'width': 300, 'height': 44}},
                                           {'action': 'set_list_settings', 'params': {'target': {'id': '$newTree'}, 'settings': {'treeViewEnabled': True, 'indent': 22, 'clickToExpand': 1}}},
                                           {'action': 'set_list_item_resources', 'params': {'target': {'id': '$newTree'}, 'settings': {'defaultItem': 'ui://treepr00cell', 'items': [{'level': 0, 'title': 'Batch folder'}, {'level': 1, 'title': 'Batch child'}]}}}])
            assert batch['status'] == 'succeeded' and batch['completed'] == 3
            await reload(); assert (await call('get_list_item_resources', object_id=batch['aliases']['newTree']))['tree']['nodes'][1]['parentIndex'] == 0
            for n, digest in hashes.items(): assert hashlib.sha256((assets / n).read_bytes()).hexdigest() == digest, n
            record('shared cell definitions images and package remain unchanged', hashes)
            print(f'{len(report["cases"])} native list/tree checks passed; screenshots require actual review', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, required=True); parser.add_argument('--editor', required=True); parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args(); asyncio.run(run(args.project.resolve(), args.editor, args.report.resolve()))
