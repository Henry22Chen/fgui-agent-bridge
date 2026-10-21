"""真实 MCP 按钮回归；仅接受仓库外的专用夹具，报告与截图不入库。"""
import argparse
import asyncio
import base64
import hashlib
import json
import os
from pathlib import Path
import sys
import uuid
import xml.etree.ElementTree as ET

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def run(project: Path, editor: str, report_path: Path):
    root = Path(__file__).resolve().parents[1]
    if project.is_relative_to(root) or report_path.is_relative_to(root):
        raise ValueError('测试工程与报告必须位于仓库外')
    if project.name != 'Capabilities.fairy' or ET.parse(project).getroot().get('id') != 'fgui-button-regression-0001':
        raise ValueError('仅允许按钮专用夹具')
    assets = project.parent / 'assets/Probe'
    report = {'evidence': 'live-editor-mcp', 'cases': [], 'visualReview': 'pending'}
    def record(name, result):
        report['cases'].append({'name': name, 'result': result})
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print('PASS ' + name, flush=True)
    env = {**os.environ, 'PYTHONUTF8': '1', 'PYTHONPATH': str(root / 'src')}
    server = StdioServerParameters(command=sys.executable, args=['-B', '-m', 'fairygui_agent.mcp_server', '--project', str(project), '--editor', editor], env=env)
    async with stdio_client(server) as (read, write):
        async with ClientSession(read, write) as session:
            init = await session.initialize(); tools = await session.list_tools()
            assert init.serverInfo.version == '0.15.0' and len(tools.tools) == 105
            async def call(tool, **kwargs):
                result = await session.call_tool('fgui_' + tool, kwargs)
                assert not result.isError, (tool, result.content)
                value = result.structuredContent
                if kwargs.get('save'): assert value['saved'] and value['persisted'], value
                return value
            async def case(name, tool, **kwargs):
                value = await call(tool, **kwargs); record(name, value); return value
            async def reload(name):
                await call('discard_document'); await call('open_document', package_name='Probe', item_name=name)
            async def reject(name, tool, **kwargs):
                before = await call('get_active_document'); url = before['url']
                snapshot = await call('get_objects', document_url=url, targets=[])
                result = await session.call_tool('fgui_' + tool, kwargs); assert result.isError, result
                after = await call('get_objects', document_url=url, targets=[])
                assert snapshot['revision'] == after['revision'], name
                record(name, str(result.content))
            async def capture(label, url, states=None):
                result = await session.call_tool('fgui_capture_states', {'document_url': url, 'states': states or [
                    {'label': state, 'controllers': {'button': chr(97 + i)}} for i, state in enumerate(['up', 'down', 'over', 'selectedOver', 'disabled', 'selectedDisabled'])], 'scale': 1})
                metadata = next(json.loads(c.text) for c in result.content if c.type == 'text')
                assert metadata['restored'] and metadata['visualVerificationStatus'] == 'pending_review', metadata
                picture = next(c for c in result.content if c.type == 'image')
                destination = report_path.parent / ('buttons-' + label + '.png')
                destination.write_bytes(base64.b64decode(picture.data))
                record('capture ' + label, {**metadata, 'localFile': str(destination)})
            await call('status'); await call('ping'); await call('get_project'); await call('list_packages')
            status = await call('status'); assert status['versionMatch'] and status['pluginVersion'] == '0.15.0', status
            record('installed MCP and loaded plugin', {'version': init.serverInfo.version, 'tools': len(tools.tools)})
            await call('open_document', package_name='Probe', item_name='Standard')
            initial = await call('get_button_settings'); assert initial['scope'] == 'definition' and 'mode' in initial['writableFields']
            structure = ET.parse(assets / 'Standard.xml').getroot()
            children = {n.get('id'): (n.tag, n.get('xy'), n.get('size'), [(g.tag, dict(g.attrib)) for g in n if g.tag.startswith('gear') or g.tag == 'relation']) for n in structure.find('displayList')}
            for mode in ['common', 'check', 'radio']:
                await case('definition mode ' + mode, 'set_button_settings', settings={'mode': mode}, save=True)
                await reload('Standard'); assert (await call('get_button_settings'))['settings']['mode'] == mode
            await case('definition style sound zero volume tint zero', 'set_button_settings', settings={
                'titleColor': '#FFEE44', 'titleFontSize': 24, 'sound': 'ui://button00click', 'volume': 0, 'downEffect': 'tint', 'downEffectValue': 0}, save=True)
            await reload('Standard'); settings = (await call('get_button_settings'))['settings']
            assert settings['sound'] == 'ui://button00click' and settings['volume'] == 0 and settings['downEffectValue'] == 0 and settings['titleColor'] == '#FFEE44', settings
            await case('definition clear sound and scale effect', 'set_button_settings', settings={'sound': '', 'volume': 75, 'downEffect': 'scale', 'downEffectValue': 0.8}, save=True)
            await reload('Standard'); settings = (await call('get_button_settings'))['settings']; assert settings['sound'] == '' and settings['volume'] == 75
            await reject('definition rejects instance selected content', 'set_button_settings', settings={'selectedTitle': 'bad'})
            for settings in [{'mode': 'Radio'}, {'volume': -1}, {'volume': '0'}, {'titleColor': '#12345600'}, {'downEffect': 'zoom'}, {'downEffectValue': 2}, {'typo': 1}]:
                await reject('invalid definition ' + str(settings), 'set_button_settings', settings=settings)
            await capture('six-states', 'ui://button00standard')
            state_map = await call('get_button_state_resources'); assert all(v['writable'] for v in state_map['states'].values()), state_map
            await case('replace two image states', 'set_button_state_resources', settings={'up': 'ui://button00state5', 'down': 'ui://button00state4'}, save=True)
            await reload('Standard'); settings = (await call('get_button_state_resources'))['settings']; assert settings['up'] == 'ui://button00state5' and settings['over'] == 'ui://button00state2'
            cleared = await case('clear Image state through native Loader conversion', 'set_button_state_resources', settings={'down': ''}, save=True)
            assert cleared['conversions'] == [{'state': 'down', 'targetId': 'bg_down', 'from': 'image', 'to': 'loader'}], cleared
            await reload('Standard'); assert (await call('get_button_state_resources'))['settings']['down'] == ''
            await capture('clear-down', 'ui://button00standard')
            await case('restore cleared Loader state', 'set_button_state_resources', settings={'down': 'ui://button00state1'}, save=True)
            await reload('Standard')
            current = ET.parse(assets / 'Standard.xml').getroot()
            for n in current.find('displayList'):
                old = children[n.get('id')]
                if n.get('id') in {'title', 'icon'}: continue
                assert n.get('xy') == old[1]
                if n.get('id') == 'bg_down': assert n.get('fill') == 'scaleFree', n.attrib
                assert [(g.tag, dict(g.attrib)) for g in n if g.tag.startswith('gear') or g.tag == 'relation'] == old[3], n.attrib
            record('state IDs layout gears and relations preserved', list(children))
            await reject('state resource wrong type', 'set_button_state_resources', settings={'up': 'ui://button00click'})
            await reject('unknown state rejected', 'set_button_state_resources', settings={'hover': ''})
            await call('open_document', package_name='Probe', item_name='IconGear')
            await case('Icon Gear replace and clear', 'set_button_state_resources', settings={'up': '', 'selectedDisabled': 'ui://button00state0'}, save=True)
            await reload('IconGear'); settings = (await call('get_button_state_resources'))['settings']; assert settings['up'] == '' and settings['down'] == 'ui://button00state1' and settings['over'] == 'ui://button00state2' and settings['selectedDisabled'] == 'ui://button00state0', settings
            await capture('icon-gear', 'ui://button00icons')
            await call('open_document', package_name='Probe', item_name='Complex')
            await reject('ambiguous mapping rejected before mutation', 'set_button_state_resources', settings={'down': 'ui://button00state0'})
            generated_name = 'Generated' + uuid.uuid4().hex[:8]
            await call('create_button', package_name='Probe', button_name=generated_name, mode='check', image_urls=['ui://button00state' + str(i) for i in range(6)], width=200, height=100)
            generated = await call('get_button_state_resources')
            assert generated['states']['up']['writable'] and generated['states']['down']['writable'], generated
            await case('Bridge-created standard button mapping and clear', 'set_button_state_resources', settings={'down': ''}, save=True)
            await reload(generated_name); assert (await call('get_button_state_resources'))['settings']['down'] == ''
            await call('open_document', package_name='Probe', item_name='Root')
            source_hash = hashlib.sha256((assets / 'Standard.xml').read_bytes()).hexdigest()
            sibling = await call('get_button_settings', object_id='button2'); binding = await call('get_button_binding', object_id='button1')
            await case('instance text selected content style sound and zero volume', 'set_button_settings', object_id='button1', settings={
                'title': 'Normal', 'selectedTitle': 'Selected', 'icon': 'ui://button00state0', 'selectedIcon': 'ui://button00state1',
                'titleColor': '#FFFFFF', 'titleFontSize': 22, 'sound': 'ui://button00click', 'volume': 0}, save=True)
            await reload('Root'); instance = await call('get_button_settings', object_id='button1')
            assert all(instance['overrides'].values()) and instance['settings']['selectedTitle'] == 'Selected' and instance['settings']['volume'] == 0, instance
            assert (await call('get_button_binding', object_id='button1'))['binding'] == binding['binding']
            assert (await call('get_button_settings', object_id='button2'))['settings'] == sibling['settings']
            await capture('instance-content', 'ui://button00root', [{'label': 'normal', 'controllers': {'Parent': 'p1'}}, {'label': 'selected', 'controllers': {'Parent': 'p0'}}])
            await case('empty instance selected content and explicit silent sound', 'set_button_settings', object_id='button1', settings={'selectedTitle': '', 'selectedIcon': '', 'sound': ''}, save=True)
            await reload('Root'); settings = (await call('get_button_settings', object_id='button1'))['settings']; assert settings['selectedTitle'] == '' and settings['selectedIcon'] == '' and settings['sound'] == '', settings
            await capture('cleared-selected-content', 'ui://button00root', [{'label': 'normal', 'controllers': {'Parent': 'p1'}}, {'label': 'selected-after-clear', 'controllers': {'Parent': 'p0'}}])
            await reject('instance cannot modify definition mode', 'set_button_settings', object_id='button1', settings={'mode': 'common'})
            await reject('nested target rejected', 'set_button_settings', object_path='root/first/title', settings={'title': 'bad'})
            query = await call('get_objects', document_url='ui://button00root', targets=[])
            batch = await call('apply_batch', document_url='ui://button00root', expected_revision=query['revision'], operation_key='button-' + uuid.uuid4().hex[:12], operations=[
                {'action': 'set_button_settings', 'params': {'target': {'id': 'button1'}, 'settings': {'title': 'Batch A'}}},
                {'action': 'set_button_settings', 'params': {'target': {'id': 'button2'}, 'settings': {'title': 'Batch B', 'volume': 0}}}], save=True)
            assert batch['status'] == 'succeeded' and batch['completed'] == 2, batch
            record('two instance batch single save', batch)
            await reload('Root'); assert (await call('get_button_settings', object_id='button2'))['settings']['volume'] == 0
            assert hashlib.sha256((assets / 'Standard.xml').read_bytes()).hexdigest() == source_hash
            record('instance overrides leave shared definition unchanged', source_hash)
            settings = await call('get_publish_settings', package_name='Probe'); assert Path(settings['global']['effectivePath']).resolve() == project.parent / 'published'
            published = await call('publish', scope='packages', package_names=['Probe'], timeout_seconds=30); assert published['success'], published
            data = (project.parent / 'published/Probe.bytes').read_text(encoding='utf-8')
            assert 'selectedDisabled' in data and 'Batch A' in data and 'Batch B' in data and 'volume="0"' in data
            record('native XML publish retains definitions and instance overrides', published)
            print(f'{len(report["cases"])} native button checks passed; screenshots require actual review', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, required=True); parser.add_argument('--editor', required=True); parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args(); asyncio.run(run(args.project.resolve(), args.editor, args.report.resolve()))
