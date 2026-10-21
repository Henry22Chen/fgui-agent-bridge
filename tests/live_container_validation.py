"""容器/滚动扩展真实 MCP 回归；只能写入仓库外的专用隔离工程，报告与截图不得入库。"""
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
    if project.is_relative_to(root) or report_path.is_relative_to(root): raise ValueError('测试工程和报告必须位于仓库外')
    if project.name != 'Capabilities.fairy' or ET.parse(project).getroot().get('id') != 'fgui-container-regression-0001': raise ValueError('仅允许容器回归专用工程')
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
            assert init.serverInfo.version == '0.17.0' and len(listing.tools) == 110
            async def call(tool, **kwargs):
                if tool in ('get_scroll_settings', 'set_scroll_settings') and not any(k in kwargs for k in ('object_id', 'object_path', 'object_name')): kwargs['object_path'] = 'root'
                result = await session.call_tool('fgui_' + tool, kwargs); assert not result.isError, (tool, result.content)
                value = result.structuredContent
                if kwargs.get('save'): assert value['saved'] and value['persisted'], value
                return value
            async def case(name, tool, **kwargs):
                value = await call(tool, **kwargs); record(name, value); return value
            async def reload():
                await call('discard_document'); await call('open_document', package_name='Probe', item_name='Root')
            async def reject(name, tool, **kwargs):
                if tool == 'set_scroll_settings' and not any(k in kwargs for k in ('object_id', 'object_path', 'object_name')): kwargs['object_path'] = 'root'
                before = await call('get_child_order'); disk = (assets / 'Root.xml').read_bytes()
                snapshot = await call('get_container_settings'); scroll = await call('get_scroll_settings')
                result = await session.call_tool('fgui_' + tool, kwargs); assert result.isError, result
                after = await call('get_child_order')
                # 组件资源异步载入可推进进程内 revision；以实际对象顺序、设置、dirty 与磁盘字节判定无写入。
                assert {k: v for k, v in before.items() if k != 'revision'} == {k: v for k, v in after.items() if k != 'revision'}, (name, before, after)
                assert disk == (assets / 'Root.xml').read_bytes(), name
                assert snapshot == await call('get_container_settings') and scroll == await call('get_scroll_settings'), name
                record(name, str(result.content))
            async def capture(label):
                # Editor 根定义画布不展示自身运行视口；通过宿主实例检查保存配置的实际边距、滚动条和裁剪。
                await call('open_document', package_name='Probe', item_name='Host')
                result = await session.call_tool('fgui_capture_document', {'expected_document_url': 'ui://contnr00host'})
                metadata = next(json.loads(c.text) for c in result.content if c.type == 'text')
                assert metadata['visualVerificationStatus'] == 'pending_review', metadata
                dest = report_path.parent / ('container-' + label + '.png')
                shutil.copy2(project.parent / '.agent' / metadata['path'], dest); record('capture ' + label, {**metadata, 'localFile': str(dest)})
                await call('open_document', package_name='Probe', item_name='Root')
            await call('status'); await call('ping'); await call('get_project'); await call('list_packages')
            status = await call('status'); assert status['versionMatch'] and status['pluginVersion'] == '0.17.0'
            assert {'get_container_settings', 'set_container_settings', 'scroll_settings_extended'} <= set(status['status']['capabilities'])
            record('MCP handshake and extended field capabilities', {'version': init.serverInfo.version, 'tools': len(listing.tools)})
            await call('open_document', package_name='Probe', item_name='Root')
            hashes = {n: hashlib.sha256((assets / n).read_bytes()).hexdigest() for n in ['Child.xml', 'Host.xml', 'Bar.xml', 'HorizontalBar.xml', 'Pattern.png', 'package.xml']}
            baseline = await case('read container defaults without modifications', 'get_container_settings')
            assert baseline['settings'] == {'margin': {'left': 0, 'right': 0, 'top': 0, 'bottom': 0}, 'hitTestSourceId': '', 'minWidth': 0, 'maxWidth': 0, 'minHeight': 0, 'maxHeight': 0}
            await reject('invalid width limits rejected before write', 'set_container_settings', settings={'minWidth': 800, 'maxWidth': 700})
            await reject('fractional margin rejected before write', 'set_container_settings', settings={'margin': {'left': 0.5}})
            await reject('typed numeric string rejected', 'set_container_settings', settings={'minWidth': '1'})
            await reject('unknown nested margin rejected', 'set_container_settings', settings={'margin': {'typo': 1}})
            await reject('nested hit source rejected', 'set_container_settings', settings={'hitTestSourceId': 'caption'})
            await reject('root or missing hit source rejected', 'set_container_settings', settings={'hitTestSourceId': 'root'})
            await reject('unsupported hit source type rejected', 'set_container_settings', settings={'hitTestSourceId': 'label'})
            configured = await case('named margin and size constraints saved', 'set_container_settings', settings={'margin': {'left': 23, 'right': 31, 'top': 17, 'bottom': 29}, 'minWidth': 100, 'maxWidth': 900, 'minHeight': 80, 'maxHeight': 700}, save=True)
            await reload(); assert (await call('get_container_settings'))['settings'] == configured['after']
            node = ET.parse(assets / 'Root.xml').getroot()
            assert node.get('margin') == '17,29,23,31' and node.get('restrictSize') == '100,900,80,700', node.attrib
            await case('partial signed margin preserves other sides', 'set_container_settings', settings={'margin': {'left': -4}}, save=True)
            await reload(); assert (await call('get_container_settings'))['settings']['margin'] == {'left': -4, 'right': 31, 'top': 17, 'bottom': 29}
            await call('set_container_settings', settings={'margin': {'left': 23}}, save=True)
            await call('set_mask_settings', settings={'maskId': 'mask'}, save=True)
            await case('hit source independent of mask and opaque', 'set_container_settings', settings={'hitTestSourceId': 'hit'}, save=True)
            await reload(); assert (await call('get_mask_settings'))['settings']['maskId'] == 'mask'
            node = ET.parse(assets / 'Root.xml').getroot(); assert node.get('hitTest') == 'hit' and node.get('mask') == 'mask' and node.get('opaque') is None
            assert all(n.get('touchable') is None for n in node.find('displayList'))
            await case('shape hit source supported', 'set_container_settings', settings={'hitTestSourceId': 'background'}, save=True)
            await reload(); assert (await call('get_container_settings'))['settings']['hitTestSourceId'] == 'background'
            await case('clear hit source explicitly', 'set_container_settings', settings={'hitTestSourceId': ''}, save=True)
            await call('set_mask_settings', settings={'maskId': ''}, save=True)
            # 设计态会显示隐藏对象作为编辑参考；移除本轮遮罩测试节点，避免白色图形覆盖后续视觉夹具。
            await call('remove_object', object_id='mask'); await call('save_document')
            await reject('scroll resource requires explicit scroll mode', 'set_scroll_settings', settings={'vtScrollBarRes': 'ui://contnr00bar'})
            await reject('soft edge requires clipping', 'set_scroll_settings', settings={'clipSoftness': {'x': 12}})
            await reject('wrong scrollbar extension rejected', 'set_scroll_settings', settings={'overflow': 'scroll', 'vtScrollBarRes': 'ui://contnr00child'})
            await reject('image header rejected', 'set_scroll_settings', settings={'overflow': 'scroll', 'headerRes': 'ui://contnr00panel'})
            await reject('self footer rejected', 'set_scroll_settings', settings={'overflow': 'scroll', 'footerRes': 'ui://contnr00root'})
            await reject('scrollbar direction mismatch rejected', 'set_scroll_settings', settings={'overflow': 'scroll', 'scroll': 'vertical', 'hzScrollBarRes': 'ui://contnr00hbar'})
            await reject('nested scrolling definition rejected', 'set_scroll_settings', object_id='instance', settings={'overflow': 'scroll'})
            await reject('root cannot bind its own page controller', 'set_scroll_settings', settings={'pageControllerName': 'Pages'})
            await reject('page controller requires active List scrolling', 'set_scroll_settings', object_id='list', settings={'pageControllerName': 'Pages'})
            await call('set_scroll_settings', settings={'scrollBarFlags': 256})
            scroll = await case('both scrollbars margins header footer and flags saved', 'set_scroll_settings', settings={'overflow': 'scroll', 'scroll': 'both', 'scrollBarDisplay': 'visible', 'pageMode': True, 'hzScrollBarRes': 'ui://contnr00hbar', 'vtScrollBarRes': 'ui://contnr00bar', 'scrollBarMargin': {'left': 5, 'right': 7, 'top': 9, 'bottom': 11}, 'headerRes': 'ui://contnr00child', 'footerRes': 'ui://contnr00child'}, save=True)
            await reload(); assert (await call('get_scroll_settings'))['settings'] == scroll['after']
            node = ET.parse(assets / 'Root.xml').getroot(); assert node.get('scrollBarRes') == 'ui://contnr00bar,ui://contnr00hbar' and node.get('ptrRes') == 'ui://contnr00child,ui://contnr00child', node.attrib
            await capture('scrollbars')
            soft = await case('soft edges preserve page flags resources and margins', 'set_scroll_settings', settings={'clipSoftness': {'x': 18, 'y': 22}}, save=True)
            await reload(); assert (await call('get_scroll_settings'))['settings'] == soft['after']
            assert soft['after']['scrollBarFlags'] == 264 and soft['after']['pageMode'] and soft['after']['pageControllerName'] == ''
            await capture('soft-scrollbars')
            await reject('fractional softness rejected', 'set_scroll_settings', settings={'clipSoftness': {'x': 0.5}})
            await reject('disabled mask conflicts with soft edges', 'set_scroll_settings', settings={'scrollBarFlags': 512, 'clipSoftness': {'x': 10}})
            await case('replace and explicitly clear only one scrollbar', 'set_scroll_settings', settings={'vtScrollBarRes': '', 'scrollBarMargin': {'right': 0}}, save=True)
            await reload(); kept = (await call('get_scroll_settings'))['settings']; assert kept['vtScrollBarRes'] == '' and kept['hzScrollBarRes'] == 'ui://contnr00hbar' and kept['headerRes'] == 'ui://contnr00child' and kept['scrollBarFlags'] == 264
            await case('clear pull resources and zero softness', 'set_scroll_settings', settings={'headerRes': '', 'footerRes': '', 'clipSoftness': {'x': 0, 'y': 0}}, save=True)
            await reload(); kept = (await call('get_scroll_settings'))['settings']; assert kept['headerRes'] == kept['footerRes'] == '' and kept['clipSoftness'] == {'x': 0, 'y': 0}
            items = await call('get_list_item_resources', object_id='list')
            await call('set_scroll_settings', object_id='list', settings={'overflow': 'scroll', 'pageMode': True, 'pageControllerName': 'Pages'}, save=True)
            list_scroll = await case('native List accepts extended settings and preserves page controller', 'set_scroll_settings', object_id='list', settings={'scroll': 'vertical', 'scrollBarDisplay': 'visible', 'vtScrollBarRes': 'ui://contnr00bar', 'scrollBarMargin': {'top': 3}, 'clipSoftness': {'y': 8}, 'headerRes': 'ui://contnr00child'}, save=True)
            await reload(); assert (await call('get_scroll_settings', object_id='list'))['settings'] == list_scroll['after']
            assert (await call('get_list_item_resources', object_id='list'))['settings'] == items['settings']
            hidden = await case('hidden container clipping has no implicit scrolling', 'set_scroll_settings', settings={'overflow': 'hidden', 'clipSoftness': {'x': 12, 'y': 16}}, save=True)
            assert hidden['inactiveScrollFields'] == ['scrollBarDisplay', 'scrollBarFlags', 'pageMode']
            await reload(); assert (await call('get_scroll_settings'))['settings']['overflow'] == 'hidden'
            await capture('hidden-soft')
            order = await call('get_child_order'); key = 'container-' + uuid.uuid4().hex[:12]
            batch = await case('batch container settings and scroll extension', 'apply_batch', document_url='ui://contnr00root', expected_revision=order['revision'], operation_key=key,
                               operations=[{'action': 'create_object', 'ref': 'hitSource', 'params': {'objectType': 'graph', 'name': 'BatchHitSource', 'x': 10, 'y': 10, 'width': 50, 'height': 50}},
                                           {'action': 'set_graph_settings', 'params': {'target': {'id': '$hitSource'}, 'settings': {'type': 'rect', 'fillColor': '#FFFFFF'}}},
                                           {'action': 'set_container_settings', 'params': {'settings': {'margin': {'top': 25}, 'maxWidth': 0, 'maxHeight': 0, 'hitTestSourceId': '$hitSource'}}},
                                           {'action': 'set_scroll_settings', 'params': {'target': {'path': 'root'}, 'settings': {'clipSoftness': {'y': 0}}}}], save=True)
            assert batch['status'] == 'succeeded' and batch['completed'] == 4
            await reload(); final = (await call('get_container_settings'))['settings']; assert final['maxWidth'] == 0 and final['hitTestSourceId'] == batch['aliases']['hitSource']
            for n, digest in hashes.items(): assert hashlib.sha256((assets / n).read_bytes()).hexdigest() == digest, n
            record('shared resource definitions and package remain unchanged', hashes)
            settings = await call('get_publish_settings', package_name='Probe'); assert Path(settings['global']['effectivePath']).resolve() == project.parent / 'published'
            published = await call('publish', scope='packages', package_names=['Probe'], timeout_seconds=30); assert published['success'], published
            data = (project.parent / 'published/Probe.bytes').read_text(encoding='utf-8'); assert 'clipSoftness=' in data and 'scrollBarRes=' in data and 'margin=' in data
            record('native publication retains container and scroll fields', published)
            print(f'{len(report["cases"])} native container checks passed; screenshots require actual review', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, required=True); parser.add_argument('--editor', required=True); parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args(); asyncio.run(run(args.project.resolve(), args.editor, args.report.resolve()))
