// Execute the compiled plugin against a minimal host; native Gear/serialization is also tested in Editor.
const fs=require('fs'),vm=require('vm'),assert=require('assert'),path=require('path');
const code=fs.readFileSync(path.join(__dirname,'../plugin/main.js'),'utf8').split('App.add_onUpdate(onUpdate);')[0];
const list=a=>({get Count(){return a.length;},get_Item:i=>a[i]});
let ctx,doc,controllers,disk,saveMode,selectionMode,nextId,applied;
class Node {
    constructor(attrs={},name='controller',children=[]){this.attrs=attrs;this.name=name;this.elements=list(children);}
    GetAttribute(key){return this.attrs[key]??null;}
}
class Controller {
    constructor(){this.name='';this.pages=[];this._selected=-1;this.homePage='';this.homePageType='';}
    GetPages(){return list(this.pages);}
    AddPage(name){const p={id:String(nextId++),name};this.pages.push(p);return p;}
    get selectedIndex(){return this._selected;}
    set selectedIndex(value){applied++;if(selectionMode==='throw')throw Error('linked action failed');this._selected=selectionMode==='redirect'?0:value;}
    Write(){return new Node({name:this.name,pages:this.pages.flatMap(p=>[p.id,p.name]).join(','),selected:String(this._selected),homePage:this.homePage,homePageType:this.homePageType});}
}
function setup(){
    controllers=[];disk=[];saveMode='normal';selectionMode='normal';nextId=0;applied=0;
    doc={content:{controllers:list(controllers),resourceURL:'ui://test',AddController(c){controllers.push(c);c.parent=this;}},
        isModified:false,savedVersion:0,SetModified(v){this.isModified=v;},RefreshInspectors(){},
        history:{Undo(){doc.isModified=false;return false;},Redo(){doc.isModified=false;return false;}},
        Save(){if(saveMode==='throw')throw Error('disk full');if(saveMode==='dirty')return;if(saveMode!=='stale')disk=controllers.map(c=>c.Write());this.savedVersion++;this.isModified=false;}};
    const app={activeDoc:doc,project:{GetItemByURL:()=>({file:'component.xml'})}};
    class XML {constructor(){return new Node({},'component',disk);}}
    ctx=vm.createContext({exports:{},console,require:()=>({}),CS:{FairyEditor:{App:app,FController:Controller},FairyGUI:{Utils:{XML}},
        UnityEngine:{Application:{runInBackground:false}},System:{IO:{File:{ReadAllText:()=>'<fixture/>'},Directory:{},Path:{},FileInfo:{},SearchOption:{}}}}});
    vm.runInContext(code,ctx);ctx.getActiveDocument=()=>doc;ctx.describeDocument=()=>({modified:doc.isModified});
}
const call=(action,params={})=>ctx.handleCommand({action,params});
const create=(params={})=>call('create_controller',{name:'State',pages:['Idle','Active'],...params});
const edit=(action,params)=>call(action,{controllerName:'State',...params});
const tests=[];function test(name,fn){tests.push([name,fn]);}
test('read is root-owned and does not mutate',()=>{assert.equal(call('get_controllers').controllers.length,0);assert.equal(doc.isModified,false);});
test('create empty and populated controllers without saving',()=>{const a=create();assert.equal(a.saved,false);assert.equal(a.after.pages.length,2);assert.equal(a.after.selectedIndex,0);assert.equal(doc.isModified,true);const b=create({name:'Empty',pages:[]});assert.equal(b.after.selectedPageId,null);const c=call('add_controller_page',{controllerName:'Empty',name:'First'});assert.equal(c.after.selectedIndex,0);});
test('invalid creation is rejected before clearing existing history',()=>{
    vm.runInContext('agentUndoStack.push({sentinel:true})',ctx);
    for(const params of [{name:''},{name:'a,b'},{pages:['a','a']},{pages:['a,b']},{pages:[null]},{pages:'a'},{save:'true'}])assert.throws(()=>create(params));
    assert.equal(controllers.length,0);assert.equal(doc.isModified,false);assert.equal(vm.runInContext('agentUndoStack.length',ctx),1);
});
test('controller names must be unique and duplicate existing names are ambiguous',()=>{create();assert.throws(()=>create(),e=>e.code==='controller_exists');controllers.push(controllers[0]);assert.throws(()=>edit('add_controller_page',{name:'New'}),e=>e.code==='ambiguous_controller');});
test('append keeps page IDs, selection and references stable',()=>{
    create();const c=controllers[0],old=JSON.stringify(c.pages),gear={pages:c.pages.map(p=>p.id)};
    const r=edit('add_controller_page',{name:'Third'});assert.equal(JSON.stringify(c.pages.slice(0,2)),old);assert.equal(r.after.selectedIndex,0);assert.deepEqual(gear.pages,c.pages.slice(0,2).map(p=>p.id));
});
test('rename keeps selected ID and reference IDs; same name is a no-op',()=>{
    create();const id=controllers[0].pages[1].id;
    edit('set_controller_page',{pageId:id});edit('rename_controller_page',{pageId:id,name:'Enabled'});
    assert.equal(controllers[0].pages[1].id,id);assert.equal(controllers[0].selectedIndex,1);
    vm.runInContext('agentUndoStack.push({sentinel:true})',ctx);
    assert.equal(edit('rename_controller_page',{pageId:id,name:'Enabled'}).changed,false);assert.equal(vm.runInContext('agentUndoStack.length',ctx),1);
});
test('page selectors accept zero and string IDs, reject missing mixed bool negative out-of-range',()=>{
    create();edit('set_controller_page',{pageIndex:1});assert.equal(edit('set_controller_page',{pageIndex:0}).after.selectedIndex,0);
    for(const params of [{},{pageId:'0',pageName:'Idle'},{pageIndex:true},{pageIndex:-1},{pageIndex:2},{pageId:0},{pageName:'Missing'}])assert.throws(()=>edit('set_controller_page',params));
});
test('duplicate page names cannot be created; legacy duplicate names require IDs',()=>{
    create();assert.throws(()=>edit('add_controller_page',{name:'Idle'}),e=>e.code==='duplicate_page');assert.throws(()=>edit('rename_controller_page',{pageIndex:1,name:'Idle'}),e=>e.code==='duplicate_page');
    controllers[0].pages[1].name='Idle';assert.throws(()=>edit('set_controller_page',{pageName:'Idle'}),e=>e.code==='ambiguous_page');edit('set_controller_page',{pageId:controllers[0].pages[1].id});
});
test('selection invokes native setter and never rewrites homePage',()=>{
    create();const c=controllers[0];c.homePage='branch';c.homePageType='branch';const before=applied;
    edit('set_controller_page',{pageName:'Active'});assert.equal(applied,before+1);assert.equal(c.homePage,'branch');assert.equal(c.homePageType,'branch');
});
test('changed controller clears old history and native undo keeps dirty',()=>{
    create();vm.runInContext('agentUndoStack.push({sentinel:true})',ctx);edit('add_controller_page',{name:'New'});
    assert.equal(vm.runInContext('agentUndoStack.length',ctx),0);call('undo');assert.equal(doc.isModified,true);
});
test('save checks XML and retires dirty protection; no-op save clears stale history',()=>{
    create({save:true});assert.equal(doc.isModified,false);
    vm.runInContext('agentUndoStack.push({sentinel:true})',ctx);
    const r=edit('set_controller_page',{pageIndex:0,save:true});assert.equal(r.persisted,true);assert.equal(r.changed,false);assert.equal(vm.runInContext('agentUndoStack.length',ctx),0);
    doc.isModified=true;call('undo');assert.equal(doc.isModified,false);
});
test('save failures never claim persistence or rollback',()=>{
    create();for(const mode of ['throw','dirty','stale']){saveMode=mode;assert.throws(()=>edit('add_controller_page',{name:mode,save:true}),e=>e.code==='persistence_failed'&&!e.details.persisted&&!e.details.rollbackAttempted);}
    assert.equal(controllers[0].pages.length,5);
});
test('linked action failure or redirect reports mutation, preserves dirty, no pretend rollback',()=>{
    create();for(const mode of ['throw','redirect']){selectionMode=mode;assert.throws(()=>edit('set_controller_page',{pageIndex:1}),e=>e.code==='editor_rejected'&&e.details.mutationMayHaveOccurred&&!e.details.rollbackAttempted);assert.equal(doc.isModified,true);}
});
test('publish and async loader block editing, deletion remains unavailable',()=>{
    vm.runInContext('publishInProgress=true',ctx);assert.throws(()=>create());vm.runInContext('publishInProgress=false;loader3dBusy=true',ctx);assert.throws(()=>create(),e=>e.code==='document_busy');
    vm.runInContext('loader3dBusy=false',ctx);assert.throws(()=>call('remove_controller_page'),/未知 action/);assert.throws(()=>call('remove_controller'),/未知 action/);
});
let failed=0;for(const [name,run] of tests){try{setup();run();console.log('PASS',name);}catch(e){failed++;console.error('FAIL',name,e);}}if(failed)process.exitCode=1;
