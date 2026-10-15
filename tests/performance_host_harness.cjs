// Run the compiled production helpers; native serialization/rendering is verified separately in Editor.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const files=new Map(), children=[], controllers={State:{selectedIndex:0,pages:['idle','active']},Other:{selectedIndex:0,pages:['off','on']}};
const io={Exists:p=>files.has(p),ReadAllText:p=>files.get(p),WriteAllText:(p,s)=>files.set(p,s),Delete:p=>files.delete(p),Move:(a,b)=>{files.set(b,files.get(a));files.delete(a);}};
const ctx=vm.createContext({exports:{},require:()=>({}),CS:{FairyEditor:{App:{project:{opened:true,basePath:'/fixture'}},FObjectType:{MOVIECLIP:'movieclip'},FPackageItemType:{IMAGE:'image',COMPONENT:'component'}},UnityEngine:{Application:{runInBackground:false},Vector2:function(x,y){this.x=x;this.y=y;}},System:{IO:{File:io,Directory:{Exists:()=>true,CreateDirectory(){}},Path:{Combine:(...p)=>path.posix.join(...p),GetDirectoryName:path.posix.dirname,GetFullPath:p=>p,DirectorySeparatorChar:'/'},FileInfo:{},SearchOption:{}}},FairyGUI:{Utils:{XML:function(value){JSON.parse(value);this.name='component';this.GetNode=()=>null;}}}}});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../plugin/main.js'),'utf8').split('App.add_onUpdate(onUpdate);')[0],ctx);
vm.runInContext('instanceStatusFile="/fixture/.agent/instances/123-epoch/status.json";',ctx);
let nextId=0;
function newObject(type,name){const object={id:`native${nextId++}`,name,objectType:type,x:0,y:0,width:100,height:30,pivotX:0,pivotY:0,anchor:false,autoSize:type.includes('text')?'none':false,useSourceSize:false,groupId:'',
 SetSize(w,h){this.width=w;this.height=h;},SetXY(x,y){this.x=x;this.y=y;},SetPivot(x,y,a){this.pivotX=x;this.pivotY=y;this.anchor=a;}};children.push(object);return object;}
const root={resourceURL:'ui://captest0root',id:'root',name:'root',objectType:'component',get numChildren(){return children.length;},GetChildAt:i=>children[i],Write_editMode:()=>({ToXMLString:()=>JSON.stringify({objects:children.map(o=>({...o})),controllers:Object.fromEntries(Object.entries(controllers).map(([k,v])=>[k,v.selectedIndex]))})})};
const doc={content:root,docURL:root.resourceURL,packageItem:{file:'/fixture/Root.xml'},isModified:false,savedVersion:1,SetModified(v){this.isModified=v;},RefreshInspectors(){},InsertObject(type,pos){return newObject(type,'');},DiscardChanges(){this.isModified=false;this.reloads=(this.reloads||0)+1;}};
ctx.getActiveDocument=()=>doc;
ctx.resolveObject=(_doc,target)=>{if(target.path==='root')return root;const found=children.find(o=>target.id===o.id||target.name===o.name);if(!found)throw Error('missing object');return found;};
ctx.resolveController=(_doc,name)=>{if(!controllers[name])throw Error('missing controller');return controllers[name];};
ctx.resolveControllerPage=(controller,locator)=>{const index=controller.pages.indexOf(locator.pageId);if(index<0)throw Error('missing page');return {index};};
newObject('loader','original');
function batch(key,operations,extra={}){return ctx.applyBatch({documentUrl:root.resourceURL,expectedRevision:ctx.documentRevision(doc),operationKey:key,operations,...extra},{id:key});}
const property=(target,properties)=>({action:'set_properties',params:{target,properties}});
assert.throws(()=>ctx.getObjects({documentUrl:'ui://other',targets:[]}),/目标不符/);
assert.throws(()=>ctx.getObjects({documentUrl:root.resourceURL,targets:[],fields:['unsafe']}),/字段/);
const revision=ctx.getObjects({documentUrl:root.resourceURL,targets:[{name:'original'}]}).revision;
children[0].x=7;
assert.throws(()=>ctx.applyBatch({documentUrl:root.resourceURL,expectedRevision:revision,operationKey:'stale',operations:[property({name:'original'},{x:9})]},{id:'stale'}),/文档已变化/);
assert.equal(children[0].x,7);
assert.throws(()=>batch('bad-late',[property({name:'original'},{x:99}),{action:'save_all',params:{}}]),/允许/);
assert.equal(children[0].x,7);
assert.throws(()=>batch('bad-ref',[property({id:'$future'},{x:9})]),/ref/);
assert.throws(()=>batch('bad-save',[{action:'set_properties',params:{target:{name:'original'},properties:{x:9},save:true}}]),/禁止/);
const operations=[{action:'create_object',ref:'fresh',params:{objectType:'loader',name:'created',x:2,y:4}},property({id:'$fresh'},{x:30,y:40,width:80,height:90})];
const dry=batch('first',operations,{dryRun:true});assert.equal(dry.status,'preflight');assert.equal(children.length,1);
const expectedRevision=ctx.documentRevision(doc);
const request={documentUrl:root.resourceURL,expectedRevision,operationKey:'first',operations};
const applied=ctx.applyBatch(request,{id:'first'});assert.equal(applied.status,'succeeded',JSON.stringify(applied));assert.equal(applied.completed,2);assert.equal(applied.aliases.fresh,'native1');assert.equal(children[1].x,30);assert.equal(applied.results,undefined);
const replay=ctx.applyBatch(request,{id:'retry'});assert.equal(replay.replayed,true);assert.equal(children.length,2);
assert.throws(()=>ctx.applyBatch({...request,save:true},{id:'reuse'}),/其他参数/);
const receipt=ctx.getBatchResult({operationKey:'first',documentUrl:root.resourceURL,verbose:true});assert.equal(receipt.results.length,2);
const receiptPath='/fixture/.agent/instances/123-epoch/batch-results/first.json';
const interrupted=JSON.parse(files.get(receiptPath));interrupted.status='running';interrupted.mutationMayHaveOccurred=true;files.set(receiptPath,JSON.stringify(interrupted));
const pending=ctx.applyBatch(request,{id:'pending'});assert.equal(pending.status,'running');assert.equal(pending.replayed,true);assert.equal(children.length,2);assert.equal(pending.mutationMayHaveOccurred,true);
assert.throws(()=>ctx.getBatchResult({operationKey:'../escape',documentUrl:root.resourceURL}),/operationKey/);
const partial=batch('partial',[property({name:'original'},{x:15}),property({name:'original'},{autoSize:true,width:99})]);
assert.equal(partial.status,'failed');assert.equal(partial.completed,1);assert.equal(partial.saved,false);assert.equal(children[0].x,15);
assert.equal(ctx.getBatchResult({operationKey:'unknown',documentUrl:root.resourceURL}).retrySafe,false);
// State preflight happens before changing any controller; every state starts from the original baseline.
let statesSeen=[];
ctx.captureDocument=()=>{statesSeen.push([controllers.State.selectedIndex,controllers.Other.selectedIndex]);return {path:'captures/x.png',width:2,height:2};};
assert.throws(()=>ctx.captureStates({documentUrl:root.resourceURL,states:[{label:'bad',controllers:{State:'missing'}}]},'bad'),/missing page/);
const captured=ctx.captureStates({documentUrl:root.resourceURL,states:[{label:'active',controllers:{State:'active'}},{label:'other',controllers:{Other:'on'}}]},'capture');
assert.deepEqual(statesSeen,[[1,0],[0,1]]);assert.equal(captured.restored,true);assert.equal(controllers.State.selectedIndex,0);assert.equal(controllers.Other.selectedIndex,0);
ctx.captureDocument=()=>{throw Error('render failure');};
const failed=ctx.captureStates({documentUrl:root.resourceURL,states:[{label:'active',controllers:{State:'active'}}]},'failed');assert.equal(failed.restored,true);assert.match(failed.error,/render failure/);
// External reload requires the exact same native doc and an unchanged complete snapshot.
assert.throws(()=>ctx.beginExternalEdit({documentUrl:root.resourceURL},'dirty'),/必须已保存/);
doc.isModified=false;files.set(doc.packageItem.file,JSON.stringify({disk:'new'}));
const ticket=ctx.beginExternalEdit({documentUrl:root.resourceURL},'ticket');children[0].x=55;
assert.throws(()=>ctx.finishExternalEdit({documentUrl:root.resourceURL,token:ticket.token}),/文档已变化/);assert.equal(doc.reloads,undefined);
children[0].x=15;
const finished=ctx.finishExternalEdit({documentUrl:root.resourceURL,token:ticket.token});assert.equal(finished.reloaded,true);assert.equal(doc.reloads,1);
assert.throws(()=>ctx.finishExternalEdit({documentUrl:root.resourceURL,token:ticket.token}),/令牌/);
console.log('PASS: revision guards, one-request native IDs/aliases, preflight, partial receipts, replay, state restoration, external reload guard');
