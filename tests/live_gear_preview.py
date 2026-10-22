"""对正式接口保存后的配置执行原生预览采样；测试钩子只安装到仓库外固定 ID 夹具，验收后恢复正式插件。"""
import argparse
import json
from pathlib import Path
import time
import xml.etree.ElementTree as ET

from fairygui_agent import mcp_server as m


def run(project: Path, editor: str, output: Path, install: bool):
    repo=Path(__file__).resolve().parents[1]
    if project.is_relative_to(repo) or output.is_relative_to(repo) or ET.parse(project).getroot().get('id')!='fgui-gear-lifecycle-regression-0001':
        raise ValueError('仅允许仓库外 Gear 专用测试工程')
    if install:
        code=(repo/'plugin/main.js').read_text(encoding='utf8')
        marker='case "get_gears":'
        assert code.count(marker)==1
        probe=(repo/'tests/gear_preview_probe.js').read_text(encoding='utf8')
        code=probe+'\n'+code.replace(marker,'case "__gear_preview_probe": return gearPreviewProbe(params);\n        '+marker)
        (project.parent/'plugins/agent-bridge/main.js').write_text(code,encoding='utf8')
        print('Test-only preview hook installed; restart only the owned dedicated Editor before sampling.')
        return
    m.configure_runtime(project=str(project),editor=editor)
    client=m._client
    deadline=time.monotonic()+20
    while not client.describe_status()['online'] and time.monotonic()<deadline:
        time.sleep(0.2)
    assert client.describe_status()['online'], '专用 Editor 尚未完成插件启动；测试不额外拉起实例'
    for action in ['ping','get_project','list_packages']:client.call(action)
    client.call('open_document',{'packageName':'Probe','itemName':'Root'})
    records=[]
    def sample(operation,**params):
        result=client.call('__gear_preview_probe',{'operation':operation,**params})
        records.append(result)
        return result
    try:
        initial=sample('start')
        assert initial['pageId']=='a' and initial['x']==40 and initial['duration']==1.5 and initial['delay']==0.5 and initial['ease']=='Linear'
        started=sample('select',pageId='b')
        assert started['x']==40 and started['tweenActive']
        for _ in range(12):
            time.sleep(0.16);sample('read')
        assert any(r.get('x')==40 and 150 <= r['timestamp']-started['timestamp'] < 500 for r in records)
        assert any(40<r.get('x',0)<300 for r in records) and records[-1]['x']==300 and not records[-1]['tweenActive']
        sample('select',pageId='a')
        for _ in range(6):
            time.sleep(0.17);sample('read')
        # FMovieClip.frame 是配置帧；实际播放游标属于显示对象的 MovieClip。
        frames={r['movie']['renderFrame'] for r in records if r.get('movie') and r['movie']['playing']}
        assert len(frames)>=2,frames
        report={'passed':True,'evidence':'native-editor-runtime-copy','duration':1.5,'delay':0.5,'ease':'Linear','trace':records,'playingFrames':sorted(frames)}
        output.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
        print('PASS native tween delay/interpolation/completion and actual MovieClip playing frames')
    finally:
        (output.parent/'preview-trace.json').write_text(json.dumps(records,ensure_ascii=False,indent=2),encoding='utf8')
        sample('stop')


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--project',type=Path,required=True);parser.add_argument('--editor',required=True)
    parser.add_argument('--report',type=Path,required=True);parser.add_argument('--install',action='store_true')
    args=parser.parse_args();run(args.project.resolve(),args.editor,args.report.resolve(),args.install)
