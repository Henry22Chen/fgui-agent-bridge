"""隔离夹具中的跨类型批量转发验证，禁止业务工程。"""
import argparse
import asyncio
import json
import os
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def run(project: Path, editor: str, output: Path):
    if project.name != 'Capabilities.fairy' or ET.parse(project).getroot().get('id') != 'fgui-capability-regression-0001':
        raise ValueError('只允许专用隔离夹具')
    params = StdioServerParameters(command=sys.executable, args=['-m', 'fairygui_agent.mcp_server', '--project', str(project), '--editor', editor], env=dict(os.environ))
    async with stdio_client(params) as (reader, writer):
        async with ClientSession(reader, writer) as session:
            await session.initialize()
            async def call(name, **kwargs):
                result = await session.call_tool(name, kwargs)
                if result.isError:
                    raise AssertionError(str(result.content))
                return result.structuredContent or json.loads(next(c.text for c in result.content if c.type == 'text'))
            assert (await call('fgui_status'))['online']
            await call('fgui_open_document', package_name='Probe', item_name='Root')
            url = 'ui://captest0root'
            rev = (await call('fgui_get_objects', document_url=url, targets=[]))['revision']
            operations = [
                {'action': 'create_object', 'ref': 'member', 'params': {'objectType': 'loader', 'name': 'batch_member', 'x': 300, 'y': 80, 'width': 10, 'height': 10}},
                {'action': 'create_object', 'ref': 'group', 'params': {'objectType': 'group', 'name': 'batch_group', 'groupMemberIds': ['$member']}},
                {'action': 'set_group', 'params': {'target': {'id': '$member'}, 'groupId': ''}},
                {'action': 'set_group', 'params': {'target': {'id': '$member'}, 'groupId': '$group'}},
                {'action': 'add_relation', 'params': {'target': {'id': '$member'}, 'relationType': 'Center_Center', 'relationTargetId': 'parent'}},
                {'action': 'remove_relation', 'params': {'target': {'id': '$member'}, 'relationType': 'Center_Center', 'relationTargetId': 'parent'}},
                {'action': 'set_loader', 'params': {'target': {'id': '$member'}, 'settings': {'fill': 'scale', 'align': 'center', 'autoSize': False}}},
                {'action': 'set_button_binding', 'params': {'target': {'id': 'tab1'}, 'settings': {'controllerName': 'State', 'pageId': '1', 'selected': False}}},
                {'action': 'set_list_settings', 'params': {'target': {'id': 'list1'}, 'settings': {'layout': 'pagination', 'repeatX': 2, 'repeatY': 1, 'columnGap': 4}}},
                {'action': 'set_scroll_settings', 'params': {'target': {'id': 'list1'}, 'settings': {'overflow': 'scroll', 'scroll': 'horizontal', 'pageMode': True, 'pageControllerName': 'State'}}},
                {'action': 'set_text_style', 'params': {'target': {'id': 'text1'}, 'style': {'fontSize': 24, 'color': '#112233', 'stroke': True, 'strokeSize': 1}}},
                {'action': 'create_controller', 'params': {'name': 'BatchAux', 'pages': ['a', 'b']}},
                {'action': 'set_controller_page', 'params': {'controllerName': 'BatchAux', 'pageName': 'b'}},
                {'action': 'insert_object', 'ref': 'instance', 'params': {'url': 'ui://captest0child', 'name': 'batch_child', 'x': 200, 'y': 160}},
                {'action': 'set_properties', 'params': {'target': {'id': '$instance'}, 'properties': {'useSourceSize': False, 'width': 80, 'height': 50}}},
                {'action': 'remove_object', 'params': {'target': {'id': '$instance'}}},
            ]
            result = await call('fgui_apply_batch', document_url=url, expected_revision=rev, operation_key='batch-surfaces', operations=operations, save=True)
            assert result['status'] == 'succeeded' and result['completed'] == len(operations) and result['persisted']
            group = await call('fgui_get_group', object_id=result['aliases']['member'])
            assert group['groupId'] == result['aliases']['group']
            assert (await call('fgui_get_list_settings', object_id='list1'))['settings']['layout'] == 'pagination'
            assert (await call('fgui_get_scroll_settings', object_id='list1'))['settings']['pageControllerName'] == 'State'
            assert (await call('fgui_get_button_binding', object_id='tab1'))['binding']['pageId'] == '1'
            value = {'operations': len(operations), 'passed': True, 'result': result}
            output.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
            print('PASS: 16 native operations across aliases/groups/relations/Loader/Button/List/Scroll/Text/Controller/insert/remove')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--project', required=True, type=Path)
    parser.add_argument('--editor', required=True)
    parser.add_argument('--report', required=True, type=Path)
    args = parser.parse_args()
    asyncio.run(run(args.project.resolve(), args.editor, args.report.resolve()))
