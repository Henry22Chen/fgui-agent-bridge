// 模拟宿主验证失败边界；真实资源与 XML 语义另有 Editor 6.1.4 实机报告。
const fs = require('fs'), vm = require('vm'), assert = require('assert'), path = require('path');
const code = fs.readFileSync(path.join(__dirname, '../plugin/main.js'), 'utf8').split('App.add_onUpdate(onUpdate);')[0];
let ctx, doc, obj, app, release, failSave, ignoreSkin;
function setup() {
    release = null; failSave = false; ignoreSkin = false;
    obj = {id:'n1',name:'spine',objectType:'loader3D',url:'ui://spine',animationName:'idle',skinName:'',playing:true,loop:true,frame:0};
    doc = {content:{numChildren:1,GetChildAt:()=>obj,resourceURL:'ui://doc',width:100,height:100},savedVersion:1,isModified:false,
        SetModified(value){this.isModified=value;},RefreshInspectors(){},Save(){if(failSave)throw Error('disk full');this.savedVersion++;this.isModified=false;}};
    doc.history={CanUndo:()=>false,CanRedo:()=>false,GetPendingList:()=>({Count:0}),Undo(){doc.isModified=false;return true;},Redo(){doc.isModified=false;return true;}};
    obj.GetProperty=function(key){return this[key];};obj.SetProperty=function(key,value){this[key]=value;};
    const list = a => ({Count:a.length,get_Item:i=>a[i]});
    const asset = {Load:()=>Promise.resolve(),animations:list(['idle','run']),skins:list(['default'])};
    app = {activeDoc:doc,project:{GetItemByURL:url=>url==='ui://spine'?{type:'spine',GetAsset:()=>asset}:url==='ui://image'?{type:'image'}:null}};
    ctx = vm.createContext({exports:{},console,require:()=>({$promise:p=>p}),CS:{FairyEditor:{App:app,FPackageItemType:{SPINE:'spine'}},UnityEngine:{Application:{runInBackground:false}},System:{IO:{File:{},Directory:{},Path:{},FileInfo:{},SearchOption:{}}}}});
    ctx.CS.FairyGUI={UpdateContext:class {Begin(){} End(){}},Stage:{inst:{ForceUpdate(){}}}};
    vm.runInContext(code,ctx);
    ctx.getActiveDocument=()=>doc;
    ctx.resolveObject=()=>obj;
    ctx.verifyObject=(_,o,e)=>{
        const values={...o,resourceURL:o.url};
        for(const k of Object.keys(e)) if(values[k]!==e[k])throw Error('editor rejected');
        return {editorReadback:true,xmlReadback:false};
    };
    ctx.describeDocument=()=>({});
    return asset;
}
const set = extra=>ctx.setLoader3d({target:{id:'n1'},fixSpine:false,...extra});
const tests=[];
function test(name,run){tests.push([name,run]);}
test('invalid animation does not mutate',async()=>{await assert.rejects(set({animationName:'missing'}),e=>e.code==='invalid_animation');assert.equal(obj.animationName,'idle');assert.equal(doc.isModified,false);});
test('invalid skin does not mutate',async()=>{await assert.rejects(set({skinName:'missing'}),e=>e.code==='invalid_skin');});
test('wrong resource type and missing resource',async()=>{await assert.rejects(set({url:'ui://image'}),e=>e.code==='unsupported_resource_type');await assert.rejects(set({url:'ui://missing'}),e=>e.code==='resource_not_found');});
test('wrong target and nested write rejected',async()=>{obj.objectType='image';await assert.rejects(set({playing:false}),e=>e.code==='wrong_object_type');obj.objectType='loader3D';doc.content.numChildren=0;await assert.rejects(set({playing:false}),e=>e.code==='nested_target');});
test('empty clears and omitted fields survive',async()=>{const r=await set({url:'',skinName:'',playing:false,frame:0});assert.equal(obj.url,'');assert.equal(obj.animationName,'idle');assert.equal(r.saved,false);assert.equal(r.persisted,false);});
test('new Editor object null names normalize to empty XML values',async()=>{obj.skinName=null;const r=await set({playing:false});assert.equal(r.before.skinName,'');assert.equal(r.after.skinName,'');});
test('invalid numeric and bool fields rejected',async()=>{await assert.rejects(set({frame:-1}),e=>e.code==='invalid_argument');await assert.rejects(set({playing:'false'}),e=>e.code==='invalid_argument');});
test('concurrent mutation and document switch are rejected',async asset=>{
    asset.Load=()=>new Promise(resolve=>{release=resolve;});
    const pending=set({playing:false});
    assert.throws(()=>ctx.handleCommand({action:'save_document'}),e=>e.code==='document_busy');
    app.activeDoc={}; release();
    await assert.rejects(pending,e=>e.code==='asset_not_ready');assert.equal(obj.playing,true);
});
test('manual property changes are preserved',async asset=>{
    asset.Load=()=>new Promise(resolve=>{release=resolve;});const pending=set({playing:false});obj.skinName='manual';release();
    await assert.rejects(pending,e=>e.code==='asset_not_ready');assert.equal(obj.skinName,'manual');assert.equal(obj.playing,true);
});
test('unload cancels and late load cannot mutate',async asset=>{
    asset.Load=()=>new Promise(resolve=>{release=resolve;});const pending=set({playing:false,skipNameValidation:true});ctx.invalidateSpineWaits();
    await assert.rejects(pending,e=>e.code==='asset_not_ready');release();await Promise.resolve();assert.equal(obj.playing,true);
});
test('server deadline cancels even when name validation is skipped',async asset=>{
    asset.Load=()=>new Promise(resolve=>{release=resolve;});const pending=set({playing:false,skipNameValidation:true});
    vm.runInContext('Date.now = () => 9999999999999; for (const wait of spineWaits.slice()) wait.check();',ctx);
    await assert.rejects(pending,e=>e.code==='asset_not_ready');release();await Promise.resolve();assert.equal(obj.playing,true);
});
test('enumeration can be explicitly skipped but load failure cannot',async asset=>{
    asset.animations=null;const r=await set({playing:false,skipNameValidation:true});assert.equal(r.validationStatus,'unverified');
    asset.Load=()=>Promise.reject(Error('load error'));await assert.rejects(set({playing:true,skipNameValidation:true}),e=>e.code==='asset_not_ready');assert.equal(obj.playing,false);
});
test('setter rejection restores prior values',async()=>{
    Object.defineProperty(obj,'skinName',{get:()=>'',set:()=>{}});
    await assert.rejects(set({skinName:'default',playing:false}),e=>e.code==='editor_rejected'&&e.details.rollbackSucceeded);
    assert.equal(obj.playing,true);
});
test('rollback preserves unrelated dirty state changed during asset loading',async asset=>{
    asset.Load=()=>new Promise(resolve=>{release=resolve;});
    Object.defineProperty(obj,'skinName',{get:()=>'',set:()=>{}});
    const pending=set({skinName:'default',playing:false});doc.isModified=true;release();
    await assert.rejects(pending,e=>e.code==='editor_rejected'&&e.details.rollbackSucceeded);
    assert.equal(obj.playing,true);assert.equal(doc.isModified,true);
});
test('explicit binding fixes independently of component save, playback-only changes do not',async()=>{
    let fixes=0;ctx.fixSpineResource=()=>{fixes++;return {saved:true,persisted:true};};
    let r=await set({url:'ui://spine',fixSpine:true});
    assert.equal(r.saved,false);assert.equal(r.resourceFix.persisted,true);assert.equal(fixes,1);
    r=await set({playing:false,fixSpine:true});assert.equal(r.resourceFix,null);assert.equal(fixes,1);
});
test('binding failure reports already persisted resource fix',async()=>{
    ctx.fixSpineResource=()=>({saved:true,persisted:true});
    Object.defineProperty(obj,'skinName',{get:()=>'',set:()=>{}});
    await assert.rejects(set({url:'ui://spine',skinName:'default',fixSpine:true}),
        e=>e.code==='editor_rejected'&&e.details.resourceFix.persisted&&e.details.rollbackSucceeded);
});
test('save failure preserves mutation and reports uncertain disk',async()=>{
    failSave=true;await assert.rejects(set({playing:false,save:true}),e=>e.code==='persistence_failed'&&e.details.diskState==='unknown'&&!e.details.rollbackAttempted);assert.equal(obj.playing,false);
});
test('capture failure never reverts successful modification',async()=>{
    await set({playing:false});const r=ctx.captureDocument({},'test');assert.equal(r.visualVerificationStatus,'manual_required');assert.equal(obj.playing,false);
});
test('oversize capture never allocates texture',async()=>{
    let allocations=0;doc.content.displayObject={GetScreenShot(){allocations++;}};
    const r=ctx.captureDocument({scale:100},'test');assert.equal(r.visualVerificationStatus,'manual_required');assert.equal(allocations,0);
});
test('encoding failure releases temporary texture',async()=>{
    let destroyed=0;const texture={width:100,height:100};doc.content.displayObject={Update(){},GetScreenShot:()=>texture};
    ctx.CS.UnityEngine.ImageConversion={EncodeToPNG(){throw Error('encode error');}};
    ctx.CS.UnityEngine.Object={Destroy(value){assert.equal(value,texture);destroyed++;}};
    const r=ctx.captureDocument({},'test');assert.equal(r.visualVerificationStatus,'manual_required');assert.equal(destroyed,1);
});
test('Loader3D invalidates old Agent undo and keeps dirty during native fallback',async()=>{
    obj.x=0;
    ctx.handleCommand({action:'set_property',params:{target:{id:'n1'},property:'x',value:1}});
    await set({playing:false});
    assert.equal(ctx.handleCommand({action:'get_history'}).agentUndoCount,0);
    const result=ctx.handleCommand({action:'undo'});
    assert.equal(result.mode,'native');assert.equal(obj.playing,false);assert.equal(doc.isModified,true);
    ctx.handleCommand({action:'redo'});assert.equal(doc.isModified,true);
});
test('validation failure and no-op preserve existing history',async()=>{
    obj.x=0;ctx.handleCommand({action:'set_property',params:{target:{id:'n1'},property:'x',value:1}});
    await assert.rejects(set({animationName:'missing'}));
    await set({playing:true});assert.equal(ctx.handleCommand({action:'get_history'}).agentUndoCount,1);
});
test('failed save still invalidates old history',async()=>{
    obj.x=0;ctx.handleCommand({action:'set_property',params:{target:{id:'n1'},property:'x',value:1}});
    failSave=true;await assert.rejects(set({playing:false,save:true}));
    assert.equal(ctx.handleCommand({action:'get_history'}).agentUndoCount,0);
    ctx.handleCommand({action:'undo'});assert.equal(doc.isModified,true);
});
test('successful save retires native dirty protection',async()=>{
    await set({playing:false});doc.Save();doc.isModified=true;
    ctx.handleCommand({action:'undo'});assert.equal(doc.isModified,false);
});
test('async success and rejection both reply to the original project',async()=>{
    for(const reject of [false,true]){
        const writes=[];let settle;ctx.handleCommand=()=>new Promise((resolve,fail)=>{settle=reject?fail:resolve;});
        ctx.CS.System.IO.Path.GetFileName=p=>p.split('/').pop();ctx.CS.System.IO.Path.GetFileNameWithoutExtension=p=>p.split('/').pop().replace('.json','');
        ctx.CS.System.IO.Path.Combine=(...p)=>p.join('/');ctx.CS.System.IO.File.Exists=()=>false;
        ctx.CS.System.IO.File.Move=()=>{};ctx.CS.System.IO.File.ReadAllText=()=>JSON.stringify({id:'r',action:'get_loader3d'});
        ctx.isStaleFile=()=>false;ctx.writeJsonAtomic=(path,response)=>writes.push({path,response});ctx.appendLog=()=>{};app.consoleView={LogError(){}};
        vm.runInContext("responseFolder='A/responses';processingFolder='A/processing';",ctx);
        ctx.processRequestFile('A/requests/r.json');vm.runInContext("responseFolder='B/responses';",ctx);
        settle(reject?Error('closed'):{});await Promise.resolve();await Promise.resolve();await Promise.resolve();
        assert.equal(writes.length,1);assert.equal(writes[0].path,'A/responses/r.json');assert.equal(writes[0].response.ok,!reject);
    }
});
(async()=>{let failed=0;for(const [name,run] of tests){try{const asset=setup();await run(asset);console.log('PASS',name);}catch(e){failed++;console.error('FAIL',name,e);}}if(failed)process.exitCode=1;})();
