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
    ToXMLString(){return JSON.stringify(this.data);}
}
let ctx,doc,obj,controller,reads,applies,appliedControllers,saveMode,readMode,disk,unsupported;
const node=(name,attrs={},children=[])=>({name,attrs,children});
function setup(){
    reads=0;applies=0;appliedControllers=[];saveMode='normal';readMode='normal';unsupported=-1;disk=node('component');
    controller={name:'State',selectedIndex:0,GetPages:()=>list(['0','1','2'].map((id,index)=>({id,name:'Page'+index})))};
    obj={id:'n1',name:'target',objectType:'text',gears:node('gears'),SupportGear:i=>i!==unsupported,
        WriteGears(){return new XML(JSON.stringify(this.gears));},ReadGears(xml){reads++;this.gears=JSON.parse(xml.ToXMLString());if(readMode==='throw')throw Error('host rejected');if(readMode==='corrupt')this.gears.children[0].attrs.pages='2';if(readMode==='dropOther')this.gears.children=this.gears.children.filter(n=>n.name!=='gearLook');},
        HandleControllerChanged(c){applies++;appliedControllers.push(c.name);}};
    doc={content:{resourceURL:'ui://component',numChildren:1,GetChildAt:()=>obj,controllers:list([controller])},isModified:false,savedVersion:0,
        SetModified(v){this.isModified=v;},RefreshInspectors(){},history:{Undo(){doc.isModified=false;return false;}},
        Save(){if(saveMode==='throw')throw Error('disk full');if(saveMode==='dirty')return;if(saveMode!=='stale')disk=node('component',{},[node('displayList',{},[node('text',{id:obj.id},JSON.parse(JSON.stringify(obj.gears.children)))])]);this.savedVersion++;this.isModified=false;}};
    const app={activeDoc:doc,project:{GetItemByURL:url=>url==='ui://component'?{file:'component.xml'}:url==='ui://image'?{type:'image',GetURL:()=>url}:null}};
    ctx=vm.createContext({exports:{},console,require:()=>({}),CS:{FairyEditor:{App:app,FPackageItemType:{IMAGE:'image'}},FairyGUI:{Utils:{XML}},UnityEngine:{Application:{runInBackground:false}},
        System:{IO:{File:{ReadAllText:()=>JSON.stringify(disk)},Directory:{},Path:{},FileInfo:{},SearchOption:{}}}}});
    vm.runInContext(code,ctx);ctx.getActiveDocument=()=>doc;ctx.resolveObject=()=>obj;ctx.describeDocument=()=>({modified:doc.isModified});
}
const call=(action,params={})=>ctx.handleCommand({action,params});
const set=(type,extra={})=>call('set_gear',{target:{id:'n1'},gearType:type,controllerName:'State',...extra});
const textConfig={defaultValue:'fallback',pageValues:[{pageId:'1',value:'Active'},{pageId:'0',value:'Idle'}]};
const tests=[];function test(name,fn){tests.push([name,fn]);}
test('reading does not create or mutate Gear',()=>{const r=call('get_gears',{target:{id:'n1'}});assert.equal(r.gears.length,6);assert.ok(r.gears.every(g=>!g.bound));assert.equal(reads,0);assert.equal(doc.isModified,false);});
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
let failed=0;for(const [name,run] of tests){try{setup();run();console.log('PASS',name);}catch(e){failed++;console.error('FAIL',name,e);}}if(failed)process.exitCode=1;
