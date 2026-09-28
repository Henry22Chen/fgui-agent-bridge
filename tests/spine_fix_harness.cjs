// SpineFixer 数学规则、输入拒绝、资源保存与调用集成；真实文件另做 Editor 实机验证。
const fs=require('fs'),vm=require('vm'),assert=require('assert'),path=require('path');
const code=fs.readFileSync(path.join(__dirname,'../plugin/main.js'),'utf8').split('App.add_onUpdate(onUpdate);')[0];
function header({version='4.2.43',x=-12.25,y=-18.75,width=40.4,height=50.6}={}){
    const bytes=Buffer.alloc(8+1+version.length+16);bytes[8]=version.length+1;bytes.write(version,9);
    [x,y,width,height].forEach((value,index)=>bytes.writeFloatBE(value,9+version.length+index*4));return new Uint8Array(bytes);
}
let ctx,item,asset,bytes,saves,changed,disposed,mode;
function setup(){
    bytes=header();saves=0;changed=0;disposed=0;mode='normal';
    asset={anchorX:0,anchorY:0,pma:true};
    item={id:'s',type:'spine',file:'/pkg/s.skel',width:1,height:1,GetAsset:()=>asset,GetURL:()=> 'ui://pkgs',SetChanged:()=>changed++};
    let disk={};item.owner={basePath:'/pkg',Save(){saves++;if(mode==='save-fail')throw Error('disk full');if(mode!=='stale')disk={width:item.width,height:item.height,anchor:`${asset.anchorX},${asset.anchorY}`,pma:String(asset.pma),id:'s'};}};
    class XML{GetNode(){return {elements:{Count:1,get_Item:()=>({name:'spine',GetAttribute:key=>disk[key]??null})}};}}
    const app={project:{GetItemByURL:()=>item}};
    const File={OpenRead(){let i=0;return {ReadByte:()=>i<bytes.length?bytes[i++]:-1,Dispose:()=>disposed++};},ReadAllText:()=>'<mock package.xml/>'};
    ctx=vm.createContext({exports:{},require:()=>({}),console,CS:{FairyEditor:{App:app,FPackageItemType:{SPINE:'spine'}},FairyGUI:{Utils:{XML}},UnityEngine:{Application:{runInBackground:false}},System:{IO:{File,Directory:{},Path:{Combine:(a,b)=>b.startsWith('/')?b:a+'/'+b,GetFullPath:p=>p,GetExtension:p=>path.extname(p)},FileInfo:{},SearchOption:{}}}}});
    vm.runInContext(code,ctx);return app;
}
const tests=[];function test(name,fn){tests.push([name,fn]);}
test('same rounding and Y flip as SpineFixer, including pma=false',()=>{
    const parsed=ctx.parseSpineBounds(bytes),r=ctx.fixSpineResource(item);
    assert.equal(item.width,40);assert.equal(item.height,51);
    assert.equal(asset.anchorX,Math.trunc(40*(-parsed.x/parsed.width)));
    assert.equal(asset.anchorY,Math.trunc(51*(1+parsed.y/parsed.height)));
    assert.equal(asset.pma,false);assert.equal(r.persisted,true);assert.equal(saves,1);assert.equal(disposed,1);
});
test('repeat is numerically idempotent but persistence is still verified',()=>{
    ctx.fixSpineResource(item);const r=ctx.fixSpineResource(item);assert.equal(r.changed,false);assert.equal(changed,1);assert.equal(saves,2);
});
test('negative anchors truncate toward zero as the native SpineFixer assignment does',()=>{
    bytes=header({x:12.75,y:-80,width:40.4,height:50.6});const r=ctx.fixSpineResource(item);
    assert.equal(asset.anchorX,Math.trunc(r.bounds.calculatedAnchorX));assert.equal(asset.anchorY,Math.trunc(r.bounds.calculatedAnchorY));
    assert.ok(asset.anchorX<0&&asset.anchorY<0);
});
test('unsupported version rejected before resource writes',()=>{
    bytes=header({version:'4.1.24'});assert.throws(()=>ctx.fixSpineResource(item),e=>e.code==='unsupported_spine_version');assert.equal(changed,0);assert.equal(saves,0);
});
test('truncation zero negative nonfinite and excessive bounds rejected',()=>{
    for(const bad of [bytes.subarray(0,12),header({width:0}),header({height:-1}),header({x:Infinity}),header({width:NaN}),header({width:0.1}),header({width:1e12})]){
        bytes=bad;assert.throws(()=>ctx.fixSpineResource(item),e=>e.code==='invalid_spine_bounds');
    }assert.equal(saves,0);assert.equal(changed,0);
});
test('resource type and extension validated',()=>{
    item.type='image';assert.throws(()=>ctx.fixSpineResource(item),e=>e.code==='unsupported_resource_type');
    item.type='spine';item.file='/pkg/s.json';assert.throws(()=>ctx.fixSpineResource(item),e=>e.code==='unsupported_spine_format');assert.equal(saves,0);
});
test('save failure never claims persistence and retry does save again',()=>{
    mode='save-fail';assert.throws(()=>ctx.fixSpineResource(item),e=>e.code==='persistence_failed'&&e.details.diskState==='unknown');
    mode='normal';assert.equal(ctx.fixSpineResource(item).persisted,true);assert.equal(saves,2);
});
test('stale package.xml rejected',()=>{mode='stale';assert.throws(()=>ctx.fixSpineResource(item),e=>e.code==='persistence_failed');});
test('insert fixes before creating node and supports explicit opt-out',()=>{
    let inserted=0;const obj={SetProperty(){}};
    ctx.getActiveDocument=()=>({InsertObject(){assert.ok(saves>0);inserted++;return obj;},SetModified(){},SelectObject(){}});
    ctx.resolveItem=()=>item;ctx.describeObject=()=>({type:'loader3D'});ctx.CS.UnityEngine.Vector2=class{};
    let r=ctx.handleCommand({action:'insert_object',params:{url:'ui://pkgs'}});assert.equal(r.resourceFix.persisted,true);assert.equal(inserted,1);
    saves=0;ctx.getActiveDocument=()=>({InsertObject(){inserted++;return obj;},SetModified(){},SelectObject(){}});
    r=ctx.handleCommand({action:'insert_object',params:{url:'ui://pkgs',fixSpine:false}});assert.equal(r.resourceFix,null);assert.equal(saves,0);
});
test('invalid bounds stop insertion before a node is created',()=>{
    let inserted=false;bytes=header({width:0});ctx.getActiveDocument=()=>({InsertObject(){inserted=true;}});ctx.resolveItem=()=>item;
    assert.throws(()=>ctx.handleCommand({action:'insert_object',params:{url:'ui://pkgs'}}),e=>e.code==='invalid_spine_bounds');assert.equal(inserted,false);
});
let failed=0;for(const [name,run] of tests){try{setup();run();console.log('PASS',name);}catch(error){failed++;console.error('FAIL',name,error);}}if(failed)process.exitCode=1;
