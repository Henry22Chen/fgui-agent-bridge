"""真实 MCP 控件回归；仅写仓库外专用工程，报告、截图与发布产物不入库。"""
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

from live_list_tree_validation import published_root


async def run(project: Path, editor: str, report_path: Path):
    root = Path(__file__).resolve().parents[1]
    if project.is_relative_to(root) or report_path.is_relative_to(root):
        raise ValueError('测试工程与报告必须位于仓库外')
    if project.name != 'Capabilities.fairy' or ET.parse(project).getroot().get('id') != 'fgui-widget-regression-0001':
        raise ValueError('仅允许控件回归专用工程')
    assets = project.parent / 'assets/Probe'
    report = {'evidence': 'live-editor-mcp', 'cases': [], 'visualReview': 'pending'}
    def record(name, value):
        report['cases'].append({'name': name, 'result': value})
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print('PASS ' + name, flush=True)
    env = {**os.environ, 'PYTHONUTF8': '1', 'PYTHONPATH': str(root / 'src')}
    server = StdioServerParameters(command=sys.executable, args=['-B', '-m', 'fairygui_agent.mcp_server', '--project', str(project), '--editor', editor], env=env)
    async with stdio_client(server) as (read, write):
        async with ClientSession(read, write) as session:
            init = await session.initialize(); tools = await session.list_tools()
            assert init.serverInfo.version == '0.19.0' and len(tools.tools) == 116
            async def call(tool, **params):
                result = await session.call_tool('fgui_' + tool, params)
                assert not result.isError, (tool, result.content)
                value = result.structuredContent
                if params.get('save'): assert value['saved'] and value['persisted'], value
                return value
            async def case(name, tool, **params):
                value = await call(tool, **params); record(name, value); return value
            async def reload(name='Root'):
                await call('discard_document'); await call('open_document', package_name='Probe', item_name=name)
            async def snapshot():
                return {id: await call('get_' + kind + '_settings', object_id=id) for kind in ['progress', 'slider', 'combo'] for id in [kind + '1', kind + '2']}
            async def reject(name, tool, **params):
                before = await snapshot(); disk = (assets / 'Root.xml').read_bytes(); order = await call('get_child_order')
                result = await session.call_tool('fgui_' + tool, params); assert result.isError, result
                assert before == await snapshot() and disk == (assets / 'Root.xml').read_bytes(), name
                after = await call('get_child_order'); assert order['order'] == after['order'] and order['modified'] == after['modified'], name
                record(name, str(result.content))
            async def capture(label):
                result = await session.call_tool('fgui_capture_document', {'expected_document_url': 'ui://widget00root'})
                metadata = next(json.loads(c.text) for c in result.content if c.type == 'text')
                assert metadata['visualVerificationStatus'] == 'pending_review'
                dest = report_path.parent / ('widgets-' + label + '.png')
                shutil.copy2(project.parent / '.agent' / metadata['path'], dest)
                record('capture ' + label, {**metadata, 'localFile': str(dest)})
            async def publish():
                config = await call('get_publish_settings', package_name='Probe')
                assert Path(config['global']['effectivePath']).resolve() == project.parent / 'published'
                result = await call('publish', scope='packages', package_names=['Probe'], timeout_seconds=30)
                assert result['success'], result
                return result, published_root(project.parent / 'published/Probe.bytes')
            await call('status'); await call('ping'); await call('get_project'); await call('list_packages')
            status = await call('status'); assert status['versionMatch'] and status['pluginVersion'] == '0.19.0'
            assert {verb + '_' + kind + '_settings' for verb in ['get', 'set'] for kind in ['progress', 'slider', 'combo']} <= set(status['status']['capabilities'])
            record('MCP handshake and six widget capabilities', {'version': init.serverInfo.version, 'tools': len(tools.tools)})
            for name, kind, settings in [('Progress', 'progress', {'titleType': 'valueAndmax', 'reverse': True}), ('Slider', 'slider', {'titleType': 'value', 'reverse': True, 'wholeNumbers': True, 'changeOnClick': False}), ('Combo', 'combo', {'dropdown': ''})]:
                await call('open_document', package_name='Probe', item_name=name)
                defaults = await call('get_' + kind + '_settings')
                assert defaults['scope'] == 'definition' and not defaults['preview']['instanceValuesPersisted']
                result = await case(kind + ' definition persistent fields', 'set_' + kind + '_settings', settings=settings, save=True)
                await reload(name)
                assert (await call('get_' + kind + '_settings'))['settings'] == result['after']
                if kind == 'combo':
                    await case('combo dropdown restored through native definition', 'set_combo_settings', settings={'dropdown': 'ui://widget00drop'}, save=True)
                    await reload(name); assert (await call('get_combo_settings'))['settings']['dropdown'] == 'ui://widget00drop'
                bad = await session.call_tool('fgui_set_' + kind + '_settings', {'settings': {'value': 10} if kind != 'combo' else {'items': []}})
                assert bad.isError
                record(kind + ' definition rejects instance-only values', str(bad.content))
            await call('open_document', package_name='Probe', item_name='Root')
            initial = await snapshot(); await capture('initial')
            for kind in ['progress', 'slider', 'combo']:
                assert initial[kind + '1']['scope'] == 'instance' and not initial[kind + '1']['sharedImpact']
            hashes = {name: hashlib.sha256((assets / name).read_bytes()).hexdigest() for name in ['Progress.xml', 'Slider.xml', 'Combo.xml', 'Dropdown.xml', 'Cell.xml', 'Child.xml', 'Icon.png', 'Click.wav', 'package.xml']}
            for label, tool, params in [
                ('range reversed', 'set_progress_settings', {'object_id': 'progress1', 'settings': {'min': 200, 'max': 100}}),
                ('range equal', 'set_progress_settings', {'object_id': 'progress1', 'settings': {'min': 100, 'max': 100}}),
                ('value outside final range', 'set_progress_settings', {'object_id': 'progress1', 'settings': {'max': 20}}),
                ('fractional progress value', 'set_progress_settings', {'object_id': 'progress1', 'settings': {'value': 42.1}}),
                ('fractional widget volume', 'set_progress_settings', {'object_id': 'progress1', 'settings': {'volume': 35.5}}),
                ('numeric string', 'set_progress_settings', {'object_id': 'progress1', 'settings': {'value': '1'}}),
                ('instance shared setting', 'set_progress_settings', {'object_id': 'progress1', 'settings': {'reverse': False}}),
                ('sound type mismatch', 'set_progress_settings', {'object_id': 'progress1', 'settings': {'sound': 'ui://widget00icon'}}),
                ('fractional integer slider', 'set_slider_settings', {'object_id': 'slider1', 'settings': {'value': 1.5}}),
                ('nested instance', 'set_slider_settings', {'object_path': 'root/nested/nestedSlider', 'settings': {'value': 10}}),
                ('wrong extension', 'set_slider_settings', {'object_id': 'progress1', 'settings': {'value': 10}}),
                ('unknown setting', 'set_combo_settings', {'object_id': 'combo1', 'settings': {'typo': 1}}),
                ('missing row value', 'set_combo_settings', {'object_id': 'combo1', 'settings': {'items': [{'title': 'Missing'}]}}),
                ('row image type mismatch', 'set_combo_settings', {'object_id': 'combo1', 'settings': {'items': [{'title': 'A', 'value': 'a', 'icon': 'ui://widget00click'}]}}),
                ('invalid visible count', 'set_combo_settings', {'object_id': 'combo1', 'settings': {'visibleItemCount': 0}}),
                ('unknown selection controller', 'set_combo_settings', {'object_id': 'combo1', 'settings': {'selectionController': 'Missing'}}),
                ('preview index unsupported', 'set_combo_settings', {'object_id': 'combo1', 'settings': {'selectedIndex': 1}}),
                ('instance dropdown unsupported', 'set_combo_settings', {'object_id': 'combo1', 'settings': {'dropdown': ''}}),
            ]:
                await reject('reject ' + label, tool, **params)
            p = await case('progress range and sound overrides', 'set_progress_settings', object_id='progress1', settings={'min': -10, 'max': 200, 'value': 42, 'sound': 'ui://widget00click', 'volume': 35}, save=True)
            await reload(); assert (await call('get_progress_settings', object_id='progress1'))['settings'] == p['after']
            assert (await call('get_progress_settings', object_id='progress2')) == initial['progress2']
            await case('progress explicit sound clear and zero volume', 'set_progress_settings', object_id='progress1', settings={'sound': '', 'volume': 0}, save=True)
            await reload(); current = (await call('get_progress_settings', object_id='progress1'))['settings']; assert current['sound'] == '' and current['volume'] == 0
            slider = await case('slider disjoint complete range and integer value', 'set_slider_settings', object_id='slider1', settings={'min': 200, 'max': 400, 'value': 350}, save=True)
            await reload(); assert (await call('get_slider_settings', object_id='slider1'))['settings'] == slider['after']
            assert (await call('get_slider_settings', object_id='slider2')) == initial['slider2']
            items = [{'title': 'Alpha', 'value': 'a', 'icon': 'ui://widget00icon'}, {'title': 'Beta', 'value': 'b', 'icon': ''}, {'title': 'Gamma', 'value': '', 'icon': 'ui://widget00icon'}]
            combo = await case('combo named rows and persistent custom display', 'set_combo_settings', object_id='combo1', settings={'items': items, 'title': 'Custom display', 'icon': '', 'visibleItemCount': 2, 'direction': 'up', 'sound': 'ui://widget00click', 'volume': 0}, save=True)
            await reload(); assert (await call('get_combo_settings', object_id='combo1'))['settings'] == combo['after']
            assert (await call('get_combo_settings', object_id='combo2')) == initial['combo2']
            await case('combo delete and reorder final rows', 'set_combo_settings', object_id='combo1', settings={'items': [items[2], items[0]]}, save=True)
            await reload(); assert (await call('get_combo_settings', object_id='combo1'))['settings']['items'] == [items[2], items[0]]
            await case('combo empty options and explicit empty display', 'set_combo_settings', object_id='combo1', settings={'items': [], 'title': '', 'icon': ''}, save=True)
            await reload(); assert (await call('get_combo_settings', object_id='combo1'))['settings']['items'] == []
            await call('set_combo_settings', object_id='combo1', settings={'items': items}, save=True)
            bound = await case('combo controller derives display', 'set_combo_settings', object_id='combo1', settings={'selectionController': 'Selection'}, save=True)
            await reload(); assert (await call('get_combo_settings', object_id='combo1'))['settings'] == bound['after'] and bound['after']['title'] == 'Alpha'
            await reject('reject conflicting bound title', 'set_combo_settings', object_id='combo1', settings={'title': 'Conflict'})
            await reject('reject empty bound options', 'set_combo_settings', object_id='combo1', settings={'items': []})
            reordered = await case('bound reorder follows controller index', 'set_combo_settings', object_id='combo1', settings={'items': [items[1], items[0], items[2]]}, save=True)
            await reload(); assert (await call('get_combo_settings', object_id='combo1'))['settings'] == reordered['after'] and reordered['after']['title'] == 'Beta'
            await case('controller clear permits custom default display', 'set_combo_settings', object_id='combo1', settings={'selectionController': '', 'title': 'Persistent title', 'icon': 'ui://widget00icon'}, save=True)
            await reload()
            await call('set_property', object_id='combo1', property_name='text', value='Generic text')
            await call('save_document'); await reload()
            assert (await call('get_combo_settings', object_id='combo1'))['settings']['title'] == 'Generic text'
            record('existing generic text setter remains compatible', True)
            await capture('configured')
            published, node = await publish(); exported = node.find("./displayList/component[@id='combo1']/ComboBox")
            assert exported is not None and len(exported.findall('item')) == 3
            assert exported.findall('item')[0].get('value') == 'b'
            record('native publication preserves named combo rows', published)
            await call('set_combo_settings', object_id='combo1', settings={'clearOnPublish': True}, save=True)
            await reload(); published, node = await publish(); exported = node.find("./displayList/component[@id='combo1']/ComboBox")
            assert exported is not None and not exported.findall('item')
            assert len((await call('get_combo_settings', object_id='combo1'))['settings']['items']) == 3
            record('combo publication clearing preserves source options', published)
            await call('set_combo_settings', object_id='combo1', settings={'clearOnPublish': False}, save=True)
            published, node = await publish(); assert len(node.find("./displayList/component[@id='combo1']/ComboBox").findall('item')) == 3
            record('combo publication restores options after flag cleared', published)
            order = await call('get_child_order')
            batch = await case('batch writes three instance types in one save', 'apply_batch', document_url='ui://widget00root', expected_revision=order['revision'], operation_key='widgets-' + uuid.uuid4().hex[:12], save=True, operations=[
                {'action': 'set_progress_settings', 'params': {'target': {'id': 'progress1'}, 'settings': {'value': 120}}},
                {'action': 'set_slider_settings', 'params': {'target': {'id': 'slider1'}, 'settings': {'value': 250}}},
                {'action': 'set_combo_settings', 'params': {'target': {'id': 'combo1'}, 'settings': {'direction': 'down'}}}])
            assert batch['completed'] == 3 and batch['status'] == 'succeeded'
            await reload(); assert (await call('get_progress_settings', object_id='progress1'))['settings']['value'] == 120
            assert (await call('get_slider_settings', object_id='slider1'))['settings']['value'] == 250
            await capture('batch')
            for name, digest in hashes.items(): assert hashlib.sha256((assets / name).read_bytes()).hexdigest() == digest, name
            record('instance edits preserve all shared resources', hashes)
            await call('open_document', package_name='Probe', item_name='Slider')
            await call('set_slider_settings', settings={'wholeNumbers': False}, save=True)
            await reload('Slider'); assert not (await call('get_slider_settings'))['settings']['wholeNumbers']
            await call('open_document', package_name='Probe', item_name='Root')
            await reject('reject fractional persistence even with wholeNumbers disabled', 'set_slider_settings', object_id='slider1', settings={'min': -1.5, 'max': 10.5, 'value': 4.2}, save=True)
            await reload(); assert (await call('get_slider_settings', object_id='slider1'))['settings'] == {'min': 200, 'max': 400, 'value': 250}
            print(f'{len(report["cases"])} native widget checks passed; screenshots require actual review', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, required=True); parser.add_argument('--editor', required=True); parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args(); asyncio.run(run(args.project.resolve(), args.editor, args.report.resolve()))
