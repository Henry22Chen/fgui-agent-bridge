// The host keeps property overrides separate from effective values, matching Editor serialization.
const fs=require('fs'),vm=require('vm'),assert=require('assert'),path=require('path');
const code=fs.readFileSync(path.join(__dirname,'../plugin/main.js'),'utf8').split('App.add_onUpdate(onUpdate);')[0];
const list=a=>({get Count(){return a.length;},get_Item:i=>a[i],Add:p=>a.push(p),Remove:p=>{const i=a.indexOf(p);if(i>=0)a.splice(i,1);}});
class Node{
 constructor(name,attrs={},nodes=[]){this.name=name;this.attrs=attrs;this.nodes=nodes;this.text='';this.elements=list(nodes);this.attributes={GetEnumerator(){let i=-1;const e=Object.entries(attrs);return{MoveNext(){return ++i<e.length;},get Current(){return{Key:e[i][0],Value:e[i][1]};},Dispose(){}};}};}
 GetAttribute(k){return this.attrs[k]??null;} GetNode(name){return this.nodes.find(n=>n.name===name)||null;}
 ToXMLString(){return JSON.stringify({name:this.name,attrs:this.attrs,nodes:this.nodes.map(n=>JSON.parse(n.ToXMLString()))});}
}
function parse(s){const n=typeof s==='string'?JSON.parse(s):s;return new Node(n.name,n.attrs,(n.nodes||[]).map(parse));}
class Property{constructor(){this.target='';this.propertyId=0;this.label='';this.value=null;}}
class Controller{
 constructor(name='State',exported=true){this.name=name;this.exported=exported;this.alias='状态';this.pages=[{id:'0',name:'Idle'},{id:'1',name:'Active'}];this.selectedIndex=0;this.homePage='';this.homePageType='default';}
 GetPages(){return list(this.pages);} get selectedPageId(){return this.pages[this.selectedIndex]?.id;}
 set selectedPageId(v){this.selectedIndex=this.pages.findIndex(p=>p.id===v);if(redirect)this.selectedIndex=0;}
 Write(){return new Node('controller',{name:this.name,exported:String(this.exported),alias:this.alias,pages:'0,Idle,1,Active',selected:String(this.selectedIndex)});}
}
class ObjectNode{
 constructor(name,id,type='text'){this.name=name;this.id=id;this.objectType=type;this.text='Base';this.icon='ui://image';}
 GetProp(i){return i===0&&this.objectType==='text'?this.text:i===1&&this.objectType==='loader'?this.icon:null;}
 Write(){return new Node(this.objectType,{name:this.name,id:this.id,text:this.text,icon:this.icon});}
}
class Component extends ObjectNode{
 constructor(name,id){super(name,id,'component');this.resourceURL='ui://child';this.a=[];this.cs=[];this.ps=[];this.controllers=list(this.cs);this.customProperties=list(this.ps);}
 get numChildren(){return this.a.length;} GetChildAt(i){return this.a[i];} GetChild(name){return this.a.find(p=>p.name===name);}
 GetController(name){return this.cs.find(c=>c.name===name);}
 GetCustomProperty(target,id){return this.ps.find(p=>p.target===target&&p.propertyId===id);}
 ApplyCustomProperty(p){if(p.value==null)return;if(p.propertyId===-1){this.GetController(p.target).selectedPageId=p.value;return;}let obj=this;for(const n of p.target.split('.'))obj=obj.GetChild(n);if(p.propertyId===0)obj.text=p.value;else obj.icon=p.value;}
 Write(){const a={name:this.name,id:this.id},overrides=this.ps.filter(p=>p.value!==null);const c=overrides.filter(p=>p.propertyId===-1);if(c.length)a.controller=c.flatMap(p=>[p.target,p.value]).join(',');return new Node('component',a,overrides.filter(p=>p.propertyId>=0).map(p=>new Node('property',{target:p.target,propertyId:String(p.propertyId),value:p.value})));}
 Write_editMode(){return new Node('component',{size:'400,300'},[...this.cs.map(c=>c.Write()),new Node('displayList',{},this.a.map(c=>c.Write())),...this.ps.filter(p=>p.propertyId>=0).map(p=>new Node('customProperty',{target:p.target,propertyId:String(p.propertyId),label:p.label}))]);}
}
let ctx,root,child,other,doc,disk,saveMode,redirect;
function instance(name,id){const c=new Component(name,id);c.a.push(new ObjectNode('label',id+'label'),new ObjectNode('icon',id+'icon','loader'));c.cs.push(new Controller());for(const [t,i] of [['State',-1],['label',0],['icon',1]]){const p=new Property();p.target=t;p.propertyId=i;c.ps.push(p);}return c;}
function setup(){
 saveMode='normal';redirect=false;root=new Component('root','');root.resourceURL='ui://root';root.cs.push(new Controller('RootState',false));child=instance('child','child1');other=instance('other','child2');root.a.push(child,other,new ObjectNode('title','title1'));disk=root.Write_editMode().ToXMLString();
 doc={content:root,isModified:false,savedVersion:0,SetModified(v){this.isModified=v;},RefreshInspectors(){},Save(){if(saveMode==='throw')throw Error('disk full');if(saveMode==='dirty')return;if(saveMode!=='stale')disk=root.Write_editMode().ToXMLString();this.isModified=false;this.savedVersion++;}};
 const app={activeDoc:doc,project:{GetItemByURL:()=>({file:'root.xml'})}};
 ctx=vm.createContext({exports:{},console,require:()=>({}),CS:{FairyEditor:{App:app,ComProperty:Property},FairyGUI:{Utils:{XML:class{constructor(s){return parse(s);}}}},UnityEngine:{Application:{runInBackground:false}},System:{IO:{File:{Exists:()=>true,ReadAllText:()=>disk},Directory:{},Path:{},FileInfo:{},SearchOption:{}}}}});
 vm.runInContext(code,ctx);
}
const call=(action,p={})=>ctx.handleCommand({action,params:p});
const target={id:'child1'},setText=(value,more={})=>call('set_component_instance_property',{target,childPath:'label',propertyId:0,value,...more});
const tests=[];const test=(n,f)=>tests.push([n,f]);
test('read separates effective values from absent overrides without dirtying',()=>{const r=call('get_component_instance',{target});assert.equal(r.controllers[0].exported,true);assert.equal(r.controllers[0].overridden,false);assert.equal(r.properties[0].effectiveValue,'Base');assert.equal(doc.isModified,false);});
test('controller writes override and effective page on only the selected instance',()=>{const r=call('set_component_instance_controller',{target,controllerName:'State',pageIndex:1,save:true});assert.equal(r.persisted,true);assert.equal(child.ps[0].value,'1');assert.match(child.Write().ToXMLString(),/State,1/);assert.equal(other.cs[0].selectedIndex,0);assert.equal(other.ps[0].value,null);assert.equal(root.cs[0].exported,false);});
test('text empty string and icon writes remain distinct from null',()=>{setText('');assert.equal(child.GetChild('label').text,'');assert.equal(child.ps[1].value,'');call('set_component_instance_property',{target,childPath:'icon',propertyId:1,value:'ui://other'});assert.equal(child.GetChild('icon').icon,'ui://other');assert.equal(other.GetChild('icon').icon,'ui://image');assert.throws(()=>setText(null),e=>e.code==='invalid_argument');});
test('scope and unsupported inputs reject before clearing history',()=>{vm.runInContext('agentUndoStack.push({sentinel:true})',ctx);for(const p of [{target:{path:'root'}},{target:{id:'title1'}},{target:{id:'child1label'}}])assert.throws(()=>call('get_component_instance',p));for(const p of [{childPath:'missing'},{propertyId:8},{propertyId:true},{childPath:'label.x'}])assert.throws(()=>setText('x',p));assert.equal(doc.isModified,false);assert.equal(vm.runInContext('agentUndoStack.length',ctx),1);});
test('private controllers and unexposed nested properties cannot bypass authoring',()=>{child.cs[0].exported=false;assert.throws(()=>call('set_component_instance_controller',{target,controllerName:'State',pageId:'1'}),e=>e.code==='controller_not_exposed');child.ps.splice(1,1);assert.throws(()=>setText('x'),e=>e.code==='property_not_exposed');assert.equal(doc.isModified,false);});
test('page selectors preserve zero and fail on duplicate/mixed names',()=>{for(const p of [{},{pageId:'0',pageIndex:0},{pageIndex:true},{pageIndex:-1},{pageName:'Missing'}])assert.throws(()=>call('set_component_instance_controller',{target,controllerName:'State',...p}));call('set_component_instance_controller',{target,controllerName:'State',pageIndex:0});assert.equal(child.ps[0].value,'0');});
test('definition upsert supports deep paths and preserves other definitions',()=>{call('upsert_component_property',{childPath:'child.label',propertyId:0,label:'文案',save:true});call('upsert_component_property',{childPath:'title',propertyId:0});assert.equal(root.ps.length,2);assert.equal(root.ps[0].label,'文案');assert.equal(child.GetChild('label').text,'Base');const r=call('get_component_properties');assert.equal(r.properties[0].target,'child.label');assert.match(disk,/customProperty/);});
test('definition no-op preserves label/history and removal preserves internal children',()=>{call('upsert_component_property',{childPath:'title',propertyId:0,label:'标题'});vm.runInContext('agentUndoStack.push({sentinel:true})',ctx);assert.equal(call('upsert_component_property',{childPath:'title',propertyId:0}).changed,false);assert.equal(vm.runInContext('agentUndoStack.length',ctx),1);call('remove_component_property',{childPath:'title',propertyId:0});assert.equal(root.a.length,3);assert.equal(root.ps.length,0);assert.equal(call('remove_component_property',{childPath:'title',propertyId:0}).changed,false);});
test('duplicate names, unsupported targets and duplicate metadata reject cleanly',()=>{root.a.push(new ObjectNode('title','duplicate'));assert.throws(()=>call('upsert_component_property',{childPath:'title',propertyId:0}),e=>e.code==='ambiguous_target');assert.throws(()=>call('upsert_component_property',{childPath:'child',propertyId:1}),e=>e.code==='unsupported_property');child.ps.push(child.ps[1]);assert.throws(()=>setText('x'),e=>e.code==='ambiguous_property');assert.equal(doc.isModified,false);});
test('controller export/alias round-trip preserves pages and selection',()=>{const c=root.cs[0],before=JSON.stringify(c.pages);const r=call('set_controller_properties',{controllerName:'RootState',settings:{exported:true,alias:'根状态'},save:true});assert.equal(r.persisted,true);assert.equal(c.exported,true);assert.equal(JSON.stringify(c.pages),before);assert.equal(c.selectedIndex,0);assert.equal(call('get_controllers').controllers[0].alias,'根状态');for(const settings of [{},{exported:'true'},{homePage:'1'}])assert.throws(()=>call('set_controller_properties',{controllerName:'RootState',settings}));});
test('native redirect failure keeps mutation dirty and never reports rollback',()=>{redirect=true;assert.throws(()=>call('set_component_instance_controller',{target,controllerName:'State',pageId:'1'}),e=>e.code==='editor_rejected'&&e.details.mutationMayHaveOccurred&&!e.details.rollbackAttempted);assert.equal(doc.isModified,true);});
test('save errors distinguish saved from verified and retain actual modifications',()=>{for(const mode of ['throw','dirty','stale']){saveMode=mode;assert.throws(()=>setText(mode,{save:true}),e=>e.code==='persistence_failed'&&!e.details.persisted&&!e.details.rollbackAttempted&&e.details.saved===(mode==='stale'));assert.equal(child.GetChild('label').text,mode);}});
test('publishing blocks all new writers',()=>{vm.runInContext('publishInProgress=true',ctx);for(const [action,p] of [['set_component_instance_property',{target,childPath:'label',propertyId:0,value:'x'}],['set_controller_properties',{controllerName:'RootState',settings:{exported:true}}],['upsert_component_property',{childPath:'title',propertyId:0}],['remove_component_property',{childPath:'title',propertyId:0}]])assert.throws(()=>call(action,p),/发布/);assert.equal(doc.isModified,false);});
for(const [name,fn]of tests){setup();try{fn();console.log('PASS '+name);}catch(e){console.error('FAIL '+name);throw e;}}
console.log(`${tests.length} component property host cases passed`);
