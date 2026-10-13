// 执行实际编译插件的独立队列逻辑；不启动 FairyGUI，不模拟业务 UI 状态。
const fs = require('node:fs');
const path = require('node:path').posix;
const vm = require('node:vm');
const assert = require('node:assert/strict');
const files = new Map();
const start = '202610130100001234567';
const app = {
  project: {opened:true, basePath:'/target-a', id:'same-id', name:'TextDemo', type:'Unity',allPackages:{Count:0}},
  activeDoc:null,
  consoleView:{Log(){},LogError(){}}
};
const ioFile = {
  Exists:p=>files.has(p),
  WriteAllText:(p,v)=>files.set(p,v),
  ReadAllText:p=>{if(!files.has(p))throw Error('missing '+p);return files.get(p);},
  AppendAllText:(p,v)=>files.set(p,(files.get(p)||'')+v),
  Delete:p=>files.delete(p),
  Move:(a,b)=>{if(!files.has(a))throw Error('missing '+a);files.set(b,files.get(a));files.delete(a);}
};
const ctx = vm.createContext({exports:{},require:()=>({}),console,CS:{
  FairyEditor:{App:app}, UnityEngine:{Application:{runInBackground:false}},
  System:{Diagnostics:{Process:{GetCurrentProcess:()=>({Id:42,StartTime:{ToUniversalTime:()=>({ToString:()=>start})},Dispose(){}})}},
    IO:{File:ioFile,FileInfo:{},SearchOption:{},
      Directory:{Exists:()=>true,CreateDirectory(){},GetFiles:dir=>{const values=[...files.keys()].filter(p=>path.dirname(p)===dir&&p.endsWith('.json'));return {Length:values.length,GetValue:i=>values[i]};}},
      Path:{Combine:(...args)=>path.join(...args),GetFullPath:path.resolve,DirectorySeparatorChar:'/',GetFileName:path.basename,GetFileNameWithoutExtension:p=>path.basename(p,'.json')}}}
}});
const code = fs.readFileSync(require('node:path').join(__dirname,'../plugin/main.js'),'utf8').split('App.add_onUpdate(onUpdate);')[0];
vm.runInContext(code,ctx);
vm.runInContext('initializeBridge()',ctx);
const statusA = '/target-a/.agent/instances/42-'+start+'/status.json';
assert.equal(JSON.parse(files.get(statusA)).editorProcessId,42);
assert.equal(JSON.parse(files.get(statusA)).editorProcessStartedAt,start);
assert.equal(JSON.parse(files.get(statusA)).protocolVersion,'2.0');
assert.throws(()=>ctx.handleCommand({action:'ping',protocolVersion:'1.0'}),/协议版本不兼容/);
assert.throws(()=>ctx.handleCommand({action:'ping',protocolVersion:'2.0',projectPath:'/other-project'}),/目标工程/);
const originalHandleCommand = ctx.handleCommand;
ctx.handleCommand = request=>({processed:request.id});
const ownRequest = '/target-a/.agent/instances/42-'+start+'/requests/own.json';
const otherRequest = '/target-a/.agent/instances/43-'+start+'/requests/other.json';
const legacyRequest = '/target-a/.agent/requests/legacy.json';
for(const [p,id] of [[ownRequest,'own'],[otherRequest,'other'],[legacyRequest,'legacy']])files.set(p,JSON.stringify({id,action:'ping',protocolVersion:'2.0'}));
vm.runInContext('pollRequests()',ctx);
assert.equal(files.has(ownRequest),false);
assert.equal(files.has(otherRequest),true);
assert.equal(files.has(legacyRequest),true);
assert.equal(JSON.parse(files.get('/target-a/.agent/instances/42-'+start+'/responses/own.json')).ok,true);
vm.runInContext('onProjectClosed()',ctx);
assert.equal(JSON.parse(files.get(statusA)).online,false);
app.project.basePath='/target-b';
vm.runInContext('onProjectOpened()',ctx);
assert.equal(JSON.parse(files.get(statusA)).online,false);
assert.equal(JSON.parse(files.get('/target-b/.agent/instances/42-'+start+'/status.json')).project.basePath,'/target-b');
console.log('PASS: process identity, protocol rejection, queue isolation, close and project switch');

// 与真实 IL2CPP 宿主一样只支持 PID，不支持 StartTime；char 由 Puerts 映射为数字。
let probes = 0;
ctx.CS.System.Diagnostics.Process.GetCurrentProcess = ()=>({Id:42,get StartTime(){throw Error('IL2CPP does not support process times');},Dispose(){}});
ctx.CS.System.Array = {CreateInstance:(_type,length)=>{const values=Array(length);values.SetValue=(v,i)=>values[i]=v;return values;}};
ctx.CS.System.String = {};
vm.runInContext('puerts.$typeof = value => value',ctx);
ctx.CS.System.IO.Path.DirectorySeparatorChar = 92;
ctx.CS.FairyEditor.ProcessUtil = {Start:(exe,args,cwd,wait)=>{
  probes++;
  assert.equal(exe,'powershell.exe');
  assert.equal(args[args.indexOf('-WindowStyle')+1],'Hidden');
  assert.equal(args[args.indexOf('-File')+1],'/target-c/plugins/agent-bridge/windows-process-identity.ps1');
  assert.equal(args[args.indexOf('-EditorProcessId')+1],'42');
  assert.equal(cwd,'/target-c');
  assert.equal(wait,true);
  files.set(args[args.indexOf('-OutputPath')+1],JSON.stringify({pid:42,startedAt:start}));
  return '';
}};
app.project.basePath = '/target-c';
vm.runInContext('initialized = false; editorIdentity = null; initializeBridge(); initializeBridge()',ctx);
assert.equal(probes,1);
assert.equal(JSON.parse(files.get('/target-c/.agent/instances/42-'+start+'/status.json')).editorProcessId,42);
assert.doesNotThrow(()=>originalHandleCommand({action:'ping',protocolVersion:'2.0',projectPath:'/TARGET-C'}));
ctx.CS.FairyEditor.ProcessUtil.Start = (_exe,args)=>files.set(args[args.indexOf('-OutputPath')+1],JSON.stringify({pid:0,startedAt:start}));
app.project.basePath = '/target-d';
vm.runInContext('editorIdentity = null; initializeBridge()',ctx);
const failed = JSON.parse(files.get('/target-d/.agent/status.json'));
assert.equal(failed.editorProcessId,null);
assert.match(failed.editorIdentityError,/无效 PID/);
assert.equal([...files.keys()].some(p=>p.includes('/process-probe-')),false);
console.log('PASS: IL2CPP fallback uses one hidden probe and rejects invalid identity');
