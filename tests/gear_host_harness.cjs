// Execute compiled plugin against a synthetic host; Editor round trips are verified separately.
const fs=require('fs'),vm=require('vm'),assert=require('assert'),path=require('path');
const code=fs.readFileSync(path.join(__dirname,'../plugin/main.js'),'utf8').split('App.add_onUpdate(onUpdate);')[0];
const list=a=>({get Count(){return a.length;},get_Item:i=>a[i]});
class XML {
    constructor(data){this.data=typeof data==='string'?JSON.parse(data):data;}
    static Create(name){return new XML({name,attrs:{},children:[]});}
    get name(){return this.data.name;}
    get text(){return '';}
    get attributes(){const entries=Object.entries(this.data.attrs);let i=-1;return {GetEnumerator:()=>({MoveNext:()=>++i<entries.length,get Current(){return {Key:entries[i][0],Value:entries[i][1]};},Dispose(){}})};}
    get elements(){return list(this.data.children.map(n=>new XML(n)));}
    GetAttribute(k){return this.data.attrs[k]??null;}
    SetAttribute(k,v){this.data.attrs[k]=String(v);}
    GetNode(name){const node=this.data.children.find(n=>n.name===name);return node?new XML(node):null;}
    AppendChild(n){this.data.children.push(n.data);}
    RemoveChild(n){this.data.children.splice(this.data.children.indexOf(n.data),1);}
    ToXMLString(){return JSON.stringify(this.data);}
}
let ctx,doc,obj,controller,reads,applies,appliedControllers,saveMode,readMode,disk,unsupported;
const node=(name,attrs={},children=[])=>({name,attrs,children});
function setup(){
    reads=0;applies=0;appliedControllers=[];saveMode='normal';readMode='normal';unsupported=-1;disk=node('component');
    controller={name:'State',selectedIndex:0,GetPages:()=>list(['0','1','2'].map((id,index)=>({id,name:'Page'+index})))};
    obj={id:'n1',name:'target',objectType:'text',gears:node('gears'),SupportGear:i=>i!==unsupported,
        WriteGears(){return new XML(JSON.stringify(this.gears));},ReadGears(xml){reads++;this.gears=JSON.parse(xml.ToXMLString());if(readMode==='precision')for(const n of this.gears.children){
            const format=value=>value.split('|').map(v=>v.split(',').map((x,i)=>n.name==='gearXY'&&i>=2||n.name==='gearLook'&&i<2?Number(x).toFixed(3):x).join(',')).join('|');
            for(const key of ['default','values'])if(n.attrs[key])n.attrs[key]=format(n.attrs[key]);
            for(const key of ['duration','delay'])if(n.attrs[key])n.attrs[key]=Number(n.attrs[key]).toFixed(4);
        }if(readMode==='throw')throw Error('host rejected');if(readMode==='corrupt')this.gears.children[0].attrs.pages='2';if(readMode==='dropOther')this.gears.children=this.gears.children.filter(n=>n.name!=='gearLook');},
        CheckGearDisplay(){},HandleControllerChanged(c){applies++;appliedControllers.push(c.name);}};
    doc={content:{resourceURL:'ui://component',numChildren:1,GetChildAt:()=>obj,controllers:list([controller])},isModified:false,savedVersion:0,
        SetModified(v){this.isModified=v;},RefreshInspectors(){},history:{Undo(){doc.isModified=false;return false;}},
        Save(){if(saveMode==='throw')throw Error('disk full');if(saveMode==='dirty')return;if(saveMode!=='stale')disk=node('component',{},[node('displayList',{},[node('text',{id:obj.id},JSON.parse(JSON.stringify(obj.gears.children)))])]);this.savedVersion++;this.isModified=false;}};
    doc.content.Write_editMode=()=>new XML(node('component',{},[node('displayList',{},[node('text',{id:obj.id},JSON.parse(JSON.stringify(obj.gears.children)))])]));
    const app={activeDoc:doc,project:{GetItemByURL:url=>url==='ui://component'?{file:'component.xml'}:url==='ui://image'?{type:'image',GetURL:()=>url}:null}};
    ctx=vm.createContext({exports:{},console,require:()=>({}),CS:{FairyEditor:{App:app,FPackageItemType:{IMAGE:'image'}},FairyGUI:{Utils:{XML}},UnityEngine:{Application:{runInBackground:false}},
        System:{IO:{File:{Exists:()=>true,ReadAllText:()=>JSON.stringify(disk)},Directory:{},Path:{},FileInfo:{},SearchOption:{}}}}});
    vm.runInContext(code,ctx);ctx.getActiveDocument=()=>doc;ctx.resolveObject=()=>obj;ctx.describeDocument=()=>({modified:doc.isModified});
}
const call=(action,params={})=>ctx.handleCommand({action,params});
const set=(type,extra={})=>call('set_gear',{target:{id:'n1'},gearType:type,controllerName:'State',...extra});
const textConfig={defaultValue:'fallback',pageValues:[{pageId:'1',value:'Active'},{pageId:'0',value:'Idle'}]};
const tests=[];function test(name,fn){tests.push([name,fn]);}
test('reading does not create or mutate Gear',()=>{const r=call('get_gears',{target:{id:'n1'}});assert.equal(r.gears.length,10);assert.ok(r.gears.every(g=>!g.bound));assert.equal(reads,0);assert.equal(doc.isModified,false);});
test('text roundtrip sorts IDs, keeps defaults, applies without switching controller',()=>{const r=set('text',textConfig);assert.deepEqual(Array.from(r.after.pageValues,p=>p.pageId),['0','1']);assert.equal(r.after.defaultValue,'fallback');assert.equal(applies,1);assert.equal(controller.selectedIndex,0);assert.equal(r.saved,false);});
test('display empty means all visible; nonempty lists are explicit page membership',()=>{let r=set('display',{visiblePageIds:['1']});assert.equal(r.after.allPagesVisible,false);r=set('display',{visiblePageIds:[]});assert.equal(r.after.allPagesVisible,true);});
test('all requested Gear value types can persist',()=>{
    for(const [type,value] of [['xy',{x:-10,y:0}],['size',{width:0,height:100}],['color',{color:'#ABCDEF'}],['icon','ui://image']]){
        const r=set(type,{defaultValue:value,pageValues:[{pageId:'0',value}],save:true});assert.equal(r.persisted,true);assert.equal(doc.isModified,false);
    }
});
test('empty string, newline and XML special characters are values, not omissions',()=>{const r=set('text',{defaultValue:'',pageValues:[{pageId:'0',value:''},{pageId:'1',value:'A<&"\nB'}]});assert.equal(r.after.defaultValue,'');assert.equal(r.after.pageValues[0].value,'');assert.equal(r.after.pageValues[1].value,'A<&"\nB');});
test('missing or duplicate page IDs and wrong controller are rejected before mutation',()=>{
    for(const pageValues of [[{pageId:'bad',value:'x'}],[{pageId:'0',value:'x'},{pageId:'0',value:'y'}],[{pageId:0,value:'x'}]])assert.throws(()=>set('text',{...textConfig,pageValues}),e=>e.code==='invalid_argument');
    assert.throws(()=>set('text',{...textConfig,controllerName:'Missing'}),e=>e.code==='controller_not_found');assert.equal(reads,0);assert.equal(doc.isModified,false);
});
test('invalid values never clear old history',()=>{
    vm.runInContext('agentUndoStack.push({sentinel:true})',ctx);
    for(const [type,defaultValue] of [['text','A|B'],['text','\0'],['icon','http://example.invalid/a.png'],['icon','ui://missing'],['xy',{x:NaN,y:0}],['xy',{x:0.5,y:0}],['xy',{x:0,y:1,extra:2}],['size',{width:-1,height:2}],['size',{width:1.5,height:2}],['color',{color:'#ffffff00'}],['color',{color:123}]])assert.throws(()=>set(type,{defaultValue,pageValues:[]}));
    assert.equal(reads,0);assert.equal(vm.runInContext('agentUndoStack.length',ctx),1);
});
test('type and field combinations validated',()=>{
    for(const [type,params] of [['__proto__',{}],['display',{}],['display',{visiblePageIds:['0'],defaultValue:'x'}],['text',{pageValues:[]}],['text',{...textConfig,visiblePageIds:[]}],['text',{...textConfig,save:'true'}],['text',{defaultValue:'x',pageValues:[{pageId:'0',value:'x',extra:1}]}]])assert.throws(()=>set(type,params));assert.equal(reads,0);
});
test('unsupported and nested objects rejected',()=>{unsupported=6;assert.throws(()=>set('text',textConfig),e=>e.code==='unsupported_gear');unsupported=-1;doc.content.numChildren=0;assert.throws(()=>set('text',textConfig),e=>e.code==='nested_target');assert.equal(reads,0);});
test('replacement retains other Gear and target extras',()=>{
    obj.gears.children=[node('gearLook',{controller:'State',pages:'0',values:'1,0,0,1',tween:'true'}),node('gearText',{controller:'State',pages:'0',values:'old',default:'old',custom:'keep'})];
    const other=JSON.stringify(obj.gears.children[0]);set('text',textConfig);assert.equal(JSON.stringify(obj.gears.children[0]),other);assert.equal(obj.gears.children[1].attrs.custom,'keep');
});
test('full replacement removes omitted page overrides but not controller pages',()=>{set('text',textConfig);const r=set('text',{defaultValue:'new',pageValues:[]});assert.equal(r.after.pageValues.length,0);assert.equal(controller.GetPages().Count,3);});
test('no-op preserves history, changed operation protects dirty from undo',()=>{
    set('text',textConfig);vm.runInContext('agentUndoStack.push({sentinel:true})',ctx);assert.equal(set('text',textConfig).changed,false);assert.equal(vm.runInContext('agentUndoStack.length',ctx),1);
    set('text',{defaultValue:'changed',pageValues:[]});assert.equal(vm.runInContext('agentUndoStack.length',ctx),0);call('undo');assert.equal(doc.isModified,true);
});
test('save errors do not claim persistence or rollback',()=>{for(const mode of ['throw','dirty','stale']){saveMode=mode;assert.throws(()=>set('text',{defaultValue:mode,pageValues:[],save:true}),e=>e.code==='persistence_failed'&&!e.details.persisted&&!e.details.rollbackAttempted);}});
test('native rejection or changed other Gear is reported with dirty retained',()=>{
    for(const mode of ['throw','corrupt','dropOther']){setup();obj.gears.children=[node('gearLook',{controller:'State'})];readMode=mode;assert.throws(()=>set('text',textConfig),e=>e.code==='editor_rejected'&&e.details.mutationMayHaveOccurred);assert.equal(doc.isModified,true);}
});
test('partial failure reports actual new Gear rather than the old unbound snapshot',()=>{
    readMode='throw';assert.throws(()=>set('text',textConfig),e=>e.code==='editor_rejected'&&e.details.before.bound===false&&e.details.after.bound===true);
});
test('percentage XY remains protected',()=>{obj.gears.children=[node('gearXY',{controller:'State',positionsInPercent:'0.1,0.2'})];assert.throws(()=>set('xy',{defaultValue:{x:0,y:0},pageValues:[]}),e=>e.code==='unsupported_gear');assert.equal(reads,0);});
test('rebind validates all IDs against the new controller',()=>{
    set('text',textConfig);const second={name:'Other',selectedIndex:0,GetPages:()=>list([{id:'9',name:'Only'}])};doc.content.controllers=list([controller,second]);
    assert.throws(()=>set('text',{...textConfig,controllerName:'Other'}));const r=set('text',{controllerName:'Other',defaultValue:'fallback',pageValues:[{pageId:'9',value:'only'}]});assert.equal(r.after.controllerName,'Other');
});
test('reconstruction reapplies other controllers without changing their pages',()=>{
    const second={name:'Visibility',selectedIndex:1,GetPages:()=>list([{id:'8',name:'Hidden'},{id:'9',name:'Visible'}])};
    doc.content.controllers=list([controller,second]);obj.gears.children=[node('gearDisplay',{controller:'Visibility',pages:'9'})];
    set('text',textConfig);assert.deepEqual(appliedControllers,['State','Visibility']);assert.equal(second.selectedIndex,1);
});
test('publishing and loading block Gear writes',()=>{vm.runInContext('publishInProgress=true',ctx);assert.throws(()=>set('text',textConfig));vm.runInContext('publishInProgress=false;loader3dBusy=true',ctx);assert.throws(()=>set('text',textConfig),e=>e.code==='document_busy');});

test('advanced value types are typed and persist without affecting legacy Gear',()=>{
    const values={look:{alpha:0,rotation:-12.5,grayed:true,touchable:false},font_size:37,animation:{frame:12,playing:false}};
    for(const [type,value] of Object.entries(values)){
        const r=set(type,{defaultValue:value,pageValues:[{pageId:'1',value}],save:true});
        assert.equal(JSON.stringify(r.after.defaultValue),JSON.stringify(value));assert.equal(r.persisted,true);
    }
});
test('percentage mode preserves fractional ratios and requires complete fallback values',()=>{
    const value={x:40,y:60,percentX:0.125,percentY:-0.2};
    let r=set('xy',{positionsInPercent:true,defaultValue:value,pageValues:[{pageId:'1',value}]});
    assert.equal(r.after.positionsInPercent,true);assert.equal(r.after.defaultValue.percentX,0.125);
    assert.throws(()=>set('xy',{defaultValue:{x:1,y:2},pageValues:[]}),e=>e.code==='invalid_argument');
    r=set('xy',{positionsInPercent:false,defaultValue:{x:1,y:2},pageValues:[]});assert.equal(r.after.positionsInPercent,false);
});
test('Display2 uses named composition and preserves an omitted condition',()=>{
    let r=set('display2',{visiblePageIds:['1'],condition:'or'});assert.equal(r.after.condition,'or');
    r=set('display2',{visiblePageIds:[]});assert.equal(r.after.condition,'or');assert.equal(r.after.allPagesVisible,true);
    assert.throws(()=>set('display',{visiblePageIds:[],condition:'and'}),e=>e.code==='invalid_argument');
});
test('tween patches preserve omitted properties and old calls preserve entire tween',()=>{
    const value={x:1,y:2},config={defaultValue:value,pageValues:[]};
    set('xy',{...config,tween:{enabled:true,duration:0.6,delay:0.2,ease:'Cubic.InOut'}});
    let r=set('xy',{...config,tween:{enabled:false}});assert.equal(r.after.tween.duration,0.6);assert.equal(r.after.tween.ease,'Cubic.InOut');assert.equal(r.after.tween.enabled,false);
    r=set('xy',config);assert.equal(r.after.tween.delay,0.2);
    assert.throws(()=>set('text',{...textConfig,tween:{enabled:true}}),e=>e.code==='unsupported_gear_option');
});
test('invalid advanced inputs do not mutate or invalidate history',()=>{
    const value={x:1,y:2};vm.runInContext('agentUndoStack.push({sentinel:true})',ctx);
    for(const config of [
        {gearType:'look',defaultValue:{alpha:2,rotation:0,grayed:false,touchable:true}},
        {gearType:'look',defaultValue:{alpha:1,rotation:0,grayed:0,touchable:true}},
        {gearType:'font_size',defaultValue:1.5},{gearType:'font_size',defaultValue:0},
        {gearType:'animation',defaultValue:{frame:0,playing:1}},{gearType:'animation',defaultValue:{frame:0,playing:true,timeScale:1}},
        {gearType:'xy',defaultValue:value,positionsInPercent:'true'},
        ...[{duration:0},{duration:0.00001},{duration:Infinity},{delay:-1},{ease:'bogus'},{ease:'Custom'},{enabled:1},{unknown:1}].map(tween=>({gearType:'xy',defaultValue:value,tween}))
    ]) assert.throws(()=>set(config.gearType,{...config,pageValues:[]}));
    assert.equal(reads,0);assert.equal(doc.isModified,false);assert.equal(vm.runInContext('agentUndoStack.length',ctx),1);
});
test('unknown Gear and custom metadata survive both edits and removal',()=>{
    const unknown=node('gearFuture',{controller:'State',raw:'keep'},[node('futureData',{x:'1'})]);obj.gears.children=[unknown];
    set('text',textConfig);assert.equal(JSON.stringify(obj.gears.children[0]),JSON.stringify(unknown));
    const r=call('remove_gear',{target:{id:'n1'},gearType:'text',save:true});
    assert.equal(r.configurationRemoved,true);assert.equal(r.bindingCleared,true);assert.equal(r.currentDisplayRestoredToDefault,false);assert.equal(r.persisted,true);
    assert.equal(JSON.stringify(obj.gears.children[0]),JSON.stringify(unknown));assert.equal(call('get_gears',{target:{id:'n1'}}).otherGears.length,1);
});
test('remove is idempotent, clears whole target config and keeps current display',()=>{
    obj.text='current';set('text',textConfig);const r=call('remove_gear',{target:{id:'n1'},gearType:'text'});
    assert.equal(r.after.bound,false);assert.equal(r.displayAfter.text,'current');assert.equal(obj.gears.children.length,0);
    vm.runInContext('agentUndoStack.push({sentinel:true})',ctx);assert.equal(call('remove_gear',{target:{id:'n1'},gearType:'text'}).changed,false);assert.equal(vm.runInContext('agentUndoStack.length',ctx),1);
    assert.throws(()=>call('remove_gear',{target:{id:'n1'},gearType:'future'}),e=>e.code==='unsupported_gear');
});
test('extended animation names are diagnosed and protected from narrow writes',()=>{
    obj.gears.children=[node('gearAni',{controller:'State',pages:'0',values:'0,p,walk,skin',default:'0,s,,'})];
    const r=call('get_gears',{target:{id:'n1'}}).gears.find(g=>g.type==='animation');assert.equal(r.editable,false);assert.equal(r.pageValues[0].value.animationName,'walk');
    assert.throws(()=>set('animation',{defaultValue:{frame:0,playing:false},pageValues:[]}),e=>e.code==='unsupported_gear');assert.equal(reads,0);
});

test('native floating-point formatting returns actual precision without accepting structural changes',()=>{
    readMode='precision';
    const r=set('xy',{positionsInPercent:true,defaultValue:{x:1,y:2,percentX:1/3,percentY:0.123456789},pageValues:[],tween:{duration:1.23456789,delay:0.123456789},save:true});
    assert.equal(r.after.defaultValue.percentX,0.333);assert.equal(r.after.tween.duration,1.2346);assert.equal(r.persisted,true);
    const look={alpha:0.4,rotation:0,grayed:false,touchable:true};set('look',{defaultValue:look,pageValues:[]});
    const small=set('look',{defaultValue:{...look,alpha:0.4009},pageValues:[]});assert.equal(small.changed,true);assert.equal(small.after.defaultValue.alpha,0.401);
    assert.equal(ctx.gearSemanticsEqual({defaultValue:{x:1}},{defaultValue:{x:1.0001}}),false);
    assert.equal(ctx.gearSemanticsEqual({defaultValue:{alpha:0.4}},{defaultValue:{alpha:0.5}}),false);
});
let failed=0;for(const [name,run] of tests){try{setup();run();console.log('PASS',name);}catch(e){failed++;console.error('FAIL',name,e);}}if(failed)process.exitCode=1;
