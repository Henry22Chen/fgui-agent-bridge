"""Spine 参数、截图安全边界与真实 MCP stdio 图像协议回归。"""
import asyncio
import base64
import json
import os
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from fairygui_agent import mcp_server
from fairygui_agent.bridge_client import BridgeClient, BridgeError, REQUIRED_CAPABILITIES
from fairygui_agent.capture import capture_result, validate_png_pixels
from fairygui_agent.cli import build_parser

ROOT = Path(__file__).resolve().parents[1]


def png(width=1, height=1):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b'\0\xff\0\0\xff')) + chunk(b'IEND', b'')


class SpineCaptureTests(unittest.TestCase):
    def test_omission_empty_false_and_zero_are_distinct(self):
        client = Mock()
        with patch.object(mcp_server, '_client', client):
            mcp_server.fgui_set_loader3d(object_id='spine', skin_name='', playing=False, frame=0)
        params = client.call.call_args.args[1]
        self.assertEqual(params['skinName'], '')
        self.assertIs(params['playing'], False)
        self.assertEqual(params['frame'], 0)
        self.assertNotIn('url', params)
        self.assertNotIn('animationName', params)

    def test_capture_failure_only_requests_manual_verification(self):
        client = Mock()
        client.project_context.return_value.queue_root = ROOT
        client.call.side_effect = TimeoutError('capture timeout')
        with patch.object(mcp_server, '_client', client):
            result = mcp_server.fgui_capture_document()
        self.assertEqual(len(result.content), 1)
        self.assertEqual(json.loads(result.content[0].text)['visualVerificationStatus'], 'manual_required')
        self.assertEqual(client.call.call_count, 1)
        self.assertEqual(client.call.call_args.args[0], 'capture_document')

    def test_png_validation_and_image_content(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'captures').mkdir()
            path = root / 'captures/test.png'
            path.write_bytes(png())
            info = dict(path='captures/test.png', width=1, height=1)
            result = capture_result(root, info)
            self.assertEqual(result.content[1].type, 'image')
            self.assertEqual(base64.b64decode(result.content[1].data), png())
            for invalid in ('../test.png', str(path.resolve())):
                with self.assertRaises(ValueError):
                    capture_result(root, {**info, 'path': invalid})
            with self.assertRaises(ValueError):
                capture_result(root, {**info, 'width': 2})
            for corrupt in (b'not PNG', png()[:-1], png(9000, 1), png()[:40] + b'x' + png()[41:]):
                path.write_bytes(corrupt)
                with self.assertRaises(ValueError):
                    capture_result(root, info)

    def test_capability_is_checked_per_action(self):
        client = BridgeClient.__new__(BridgeClient)
        client.project_context = lambda: SimpleNamespace(queue_root=ROOT)
        client.ensure_ready = lambda: {'capabilities': sorted(REQUIRED_CAPABILITIES)}
        with self.assertRaisesRegex(BridgeError, '缺少能力'):
            client.call_raw('set_loader3d')

    def test_cli_commands(self):
        parser = build_parser()
        self.assertEqual(parser.parse_args(['get-loader3d', '--id', 'n1']).target_id, 'n1')
        self.assertTrue(parser.parse_args(['set-loader3d', '--id', 'n1', '{"playing":false}', '--save']).save)
        self.assertEqual(parser.parse_args(['capture-document', '--scale', '0.5']).scale, 0.5)
        self.assertEqual(parser.parse_args(['fix-spine-anchor', 'ui://spine']).url, 'ui://spine')
        self.assertTrue(parser.parse_args(['insert', 'ui://spine', '--no-fix-spine']).no_fix_spine)

    def test_invalid_idat_with_valid_crc_is_rejected(self):
        def build(payload):
            prefix = png()[:33]
            return prefix + struct.pack('>I', len(payload)) + b'IDAT' + payload + struct.pack('>I', zlib.crc32(b'IDAT' + payload)) + png()[-12:]
        for payload in (b'not-zlib', zlib.compress(b'\0\xff') , zlib.compress(b'\x05\0\0\0\0'),
                        zlib.compress(b'\0' * 1000000), zlib.compress(b'\0\0\0\0\0') + b'trailing', zlib.compress(b'\0\0\0\0\0')[:-1]):
            with self.subTest(payload_length=len(payload)), self.assertRaises(ValueError):
                validate_png_pixels(build(payload), (1, 1))
        for filtering in range(5):
            validate_png_pixels(build(zlib.compress(bytes([filtering, 1, 2, 3, 4]))), (1, 1))

    def test_corrupt_image_degrades_to_manual_without_undo(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'captures').mkdir()
            (root / 'captures/test.png').write_bytes(png(2, 1))  # IHDR 与实际扫描行长度不符，但 CRC 完全正确。
            client = Mock()
            client.project_context.return_value.queue_root = root
            client.call.return_value = dict(path='captures/test.png', width=2, height=1)
            with patch.object(mcp_server, '_client', client):
                result = mcp_server.fgui_capture_document()
            self.assertEqual([part.type for part in result.content], ['text'])
            self.assertEqual(json.loads(result.content[0].text)['visualVerificationStatus'], 'manual_required')
            self.assertEqual(client.call.call_count, 1)

    def test_spine_fixer_mapping_and_auto_fix_capability(self):
        client = Mock()
        with patch.object(mcp_server, '_client', client):
            mcp_server.fgui_fix_spine_anchor(url='ui://spine')
            self.assertEqual(client.call.call_args.args, ('fix_spine_anchor', {'url': 'ui://spine'}))
            mcp_server.fgui_insert_object('ui://spine', fix_spine=False)
            self.assertFalse(client.call.call_args.args[1]['fixSpine'])
        legacy = BridgeClient.__new__(BridgeClient)
        legacy.project_context = lambda: SimpleNamespace(queue_root=ROOT)
        legacy.ensure_ready = lambda: {'capabilities': sorted(REQUIRED_CAPABILITIES | {'set_loader3d'})}
        for action, params in [('insert_object', {'url': 'ui://spine'}), ('set_loader3d', {'url': 'ui://spine'})]:
            with self.assertRaisesRegex(BridgeError, 'fix_spine_anchor'):
                legacy.call_raw(action, params)

    def test_compiled_host_boundaries(self):
        result = subprocess.run(['node', str(ROOT / 'tests/spine_host_harness.cjs')], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_spine_fixer_compiled_host(self):
        result = subprocess.run(['node', str(ROOT / 'tests/spine_fix_harness.cjs')], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_stdio_protocol_returns_image_block(self):
        # 使用真正 ClientSession/stdio 握手，防止 FastMCP 将返回值序列化成路径文本。
        async def run(root):
            script = """from pathlib import Path
from types import SimpleNamespace
from fairygui_agent import mcp_server as m
class Client:
 def project_context(self): return SimpleNamespace(queue_root=Path(__import__('os').environ['CAPTURE_TEST_ROOT']))
 def call(self,*args,**kwargs): return dict(path='captures/test.png',width=1,height=1)
m._client=Client()
m.mcp.run(transport='stdio')
"""
            parameters = StdioServerParameters(command=sys.executable, args=['-c', script], env={**os.environ, 'CAPTURE_TEST_ROOT': str(root)})
            async with stdio_client(parameters) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    result = await session.call_tool('fgui_capture_document', {})
                    self.assertFalse(result.isError)
                    self.assertEqual([block.type for block in result.content], ['text', 'image'])
                    self.assertEqual(base64.b64decode(result.content[1].data), png())
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'captures').mkdir()
            (root / 'captures/test.png').write_bytes(png())
            asyncio.run(run(root))
