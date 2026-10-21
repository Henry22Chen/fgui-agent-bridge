// Compiled plugin contracts; live native Editor save/reload and screenshots are verified separately.
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const prelude = fs.readFileSync(path.join(__dirname, 'editor_settings_host_harness.cjs'), 'utf8').split('const tests = [], test =')[0];
vm.runInNewContext(prelude + `
let nativeFailure;
function containerSetup(){
    setup(); nativeFailure=false;
    ctx.CS.FairyEditor.FScrollPane={PAGE_MODE:8,MASK_DISABLED:512};
    const configure=obj=>{
        Object.assign(obj,{margin:{left:0,right:0,top:0,bottom:0},scrollBarMargin:{left:0,right:0,top:0,bottom:0},
          minWidth:0,maxWidth:0,minHeight:0,maxHeight:0,hitTestSource:null,width:600,height:440,viewWidth:600,viewHeight:440,
          overflow:'visible',scroll:'vertical',scrollBarDisplay:'default',scrollBarFlags:0,pageController:'',clipSoftnessX:0,clipSoftnessY:0,
          hzScrollBarRes:null,vtScrollBarRes:null,headerRes:null,footerRes:null,scrollPane:{OnFlagsChanged(){}},
          UpdateOverflow(){if(nativeFailure)throw Error('native overflow failed');}});
        for(const [property,field]of [['marginStr','margin'],['scrollBarMarginStr','scrollBarMargin']])Object.defineProperty(obj,property,{set(v){const [top,bottom,left,right]=v.split(',').map(Number);obj[field]={left,right,top,bottom};}});
    };
    configure(root);configure(objects[2]);objects[3].type='rect';
    const resource=(url,type='component',extension='')=>({type,file:'root.xml',GetURL:()=>url,GetAsset:()=>({extension,xml:new Xml('component',{},[new Xml('displayList',{},[new Xml('graph',{name:'grip'}),new Xml('graph',{name:'bar'})])])})});
    ctx.CS.FairyEditor.App.project.GetItemByURL=url=>({
      'ui://root':resource(url),'ui://child':resource(url),'ui://bar':resource(url,'component','ScrollBar'),
      'ui://image':resource(url,'image'),'ui://broken':{...resource(url),GetAsset:()=>({extension:'ScrollBar',xml:new Xml('component')})}
    })[url];
    root.Write_editMode=()=>new Xml('component',{payload:JSON.stringify({container:ctx.containerSettings(root),scroll:ctx.scrollSettings(root),list:ctx.scrollSettings(objects[2]),mask:root.mask?.id||'',reversedMask:root.reversedMask})},[new Xml('displayList',{},objects.map(o=>o.Write()))]);
    disk=root.Write_editMode().ToXMLString();
}
const container=(settings,extra={})=>call('set_container_settings',{settings,...extra});
const scroll=(settings,extra={})=>call('set_scroll_settings',{target:{id:'root'},settings,...extra});
const tests=[],test=(name,fn)=>tests.push([name,fn]);
test('container defaults are read without dirtying',()=>{const r=call('get_container_settings');assert.equal(r.settings.maxWidth,0);assert.equal(r.settings.margin.left,0);assert.equal(doc.isModified,false);});
test('named signed margin and dimensions use native order and preserve omitted sides',()=>{
    let r=container({margin:{left:3,right:4,top:1,bottom:2},minWidth:100,maxWidth:900,minHeight:80,maxHeight:700},{save:true});assert.equal(r.persisted,true);
    r=container({margin:{left:-5},maxWidth:0},{save:true});assert.equal(r.after.margin.top,1);assert.equal(r.after.margin.left,-5);assert.equal(r.after.maxWidth,0);
});
test('malformed margin and limits reject before mutation',()=>{
    for(const settings of [{minWidth:2,maxWidth:1},{minHeight:2,maxHeight:1},{minWidth:'1'},{maxWidth:-1},{minHeight:true},{maxHeight:0.5},
      {margin:null},{margin:{}},{margin:[]},{margin:{x:1}},{margin:{left:1.5}},{margin:{top:Infinity}},{typo:1},{}])assert.throws(()=>container(settings));
    assert.equal(doc.isModified,false);assert.equal(root.minWidth,0);
});
test('hit source is independent of mask opaque and touchable and explicitly clears',()=>{
    root.mask=objects[3];root.opaque=false;objects[3].touchable=false;
    const r=container({hitTestSourceId:'mask'},{save:true});assert.equal(r.after.hitTestSourceId,'mask');assert.equal(root.mask,objects[3]);assert.equal(root.opaque,false);assert.equal(objects[3].touchable,false);
    container({hitTestSourceId:''},{save:true});assert.equal(root.hitTestSource,null);
});
test('hit source scope type and unknown root params reject',()=>{
    for(const id of ['root','nested','group','input'])assert.throws(()=>container({hitTestSourceId:id}));
    objects[3].type='empty';assert.throws(()=>container({hitTestSourceId:'mask'}));
    assert.throws(()=>container({minWidth:1},{target:{id:'root'}}));assert.throws(()=>call('get_container_settings',{target:{id:'root'}}));assert.equal(doc.isModified,false);
});
test('scroll resources margin softness and page flags persist independently',()=>{
    scroll({scrollBarFlags:256});
    const r=scroll({overflow:'scroll',scroll:'both',pageMode:true,hzScrollBarRes:'ui://bar',vtScrollBarRes:'ui://bar',headerRes:'ui://child',footerRes:'ui://child',scrollBarMargin:{left:3,top:7},clipSoftness:{x:8,y:10}},{save:true});
    assert.equal(r.persisted,true);assert.equal(r.after.scrollBarFlags,264);assert.equal(r.after.pageMode,true);assert.equal(r.after.scrollBarMargin.top,7);
    const next=scroll({vtScrollBarRes:'',headerRes:'',clipSoftness:{x:0}},{save:true});assert.equal(next.after.hzScrollBarRes,'ui://bar');assert.equal(next.after.clipSoftness.y,10);assert.equal(next.after.scrollBarFlags,264);
});
test('resource types extension mandatory parts self and mode conflicts reject before write',()=>{
    for(const settings of [{vtScrollBarRes:'ui://bar'},{overflow:'scroll',vtScrollBarRes:'ui://child'},{overflow:'scroll',vtScrollBarRes:'ui://broken'},
      {overflow:'scroll',headerRes:'ui://image'},{overflow:'scroll',footerRes:'ui://root'},{overflow:'scroll',headerRes:'missing'},
      {overflow:'scroll',scroll:'vertical',hzScrollBarRes:'ui://bar'},{scrollBarMargin:{top:1}},{clipSoftness:{x:1}},
      {overflow:'scroll',scrollBarFlags:512,clipSoftness:{y:2}}])assert.throws(()=>scroll(settings));
    assert.equal(root.overflow,'visible');assert.equal(root.vtScrollBarRes,null);assert.equal(doc.isModified,false);
});
test('scroll strict typed patches and page conflicts reject',()=>{
    for(const settings of [{scrollBarFlags:'1'},{scrollBarFlags:true},{clipSoftness:{x:0.5}},{clipSoftness:{y:-1}},{clipSoftness:{z:1}},
      {scrollBarMargin:{left:0.5}},{hzScrollBarRes:null},{overflow:'bad'},{scrollBarFlags:8,pageMode:false},{typo:1}])assert.throws(()=>scroll(settings));assert.equal(doc.isModified,false);
});
test('hidden clipping accepts softness without enabling scrolling',()=>{const r=scroll({overflow:'hidden',clipSoftness:{x:8}},{save:true});assert.equal(r.after.overflow,'hidden');assert.equal(r.after.clipSoftness.x,8);});
test('inactive flags and invalid parent controller scopes are explicit',()=>{
    assert.equal(scroll({overflow:'hidden'}).inactiveScrollFields.includes('scrollBarFlags'),true);
    assert.throws(()=>scroll({pageControllerName:'Pages'}));
    assert.throws(()=>scroll({pageControllerName:'Pages'},{target:{id:'list'}}));assert.equal(objects[2].pageController,'');
});
test('native List settings do not mutate preset items or root definition',()=>{const obj=objects[2],items=obj.items;const r=scroll({overflow:'scroll',vtScrollBarRes:'ui://bar',headerRes:'ui://child'},{target:{id:'list'},save:true});assert.equal(r.persisted,true);assert.equal(obj.items,items);assert.equal(root.overflow,'visible');});
test('nested instances cannot be used as scrolling definitions',()=>{for(const id of ['instance','nested','mask'])assert.throws(()=>scroll({overflow:'scroll'},{target:{id}}));assert.equal(doc.isModified,false);});
test('no-op retains existing Agent history',()=>{vm.runInContext('agentUndoStack.push({sentinel:true})',ctx);assert.equal(container({maxWidth:0}).changed,false);assert.equal(scroll({clipSoftness:{x:0}}).changed,false);assert.equal(vm.runInContext('agentUndoStack.length',ctx),1);});
test('native rejection reports real partial mutation and dirty status',()=>{nativeFailure=true;assert.throws(()=>container({margin:{top:5}}),e=>e.code==='editor_rejected'&&e.details.after.margin.top===5&&e.details.mutationMayHaveOccurred&&!e.details.rollbackAttempted);assert.equal(doc.isModified,true);});
test('save errors never claim persistence or rollback',()=>{for(const mode of ['throw','dirty','stale']){containerSetup();saveMode=mode;assert.throws(()=>scroll({overflow:'hidden',clipSoftness:{x:8}},{save:true}),e=>e.code==='persistence_failed'&&!e.details.persisted&&!e.details.rollbackAttempted);}});
test('batch hit source alias resolves and forward references reject',()=>{
    assert.equal(ctx.batchParams({settings:{hitTestSourceId:'$hit'}},{hit:'mask'}).settings.hitTestSourceId,'mask');
    assert.throws(()=>ctx.validateBatch({operations:[{action:'set_container_settings',params:{settings:{hitTestSourceId:'$later'}}}]},doc));
});
test('new actions blocked while publishing',()=>{vm.runInContext('publishInProgress=true',ctx);for(const action of ['get_container_settings','set_container_settings'])assert.throws(()=>call(action),/发布/);});
for(const [name,fn]of tests){containerSetup();fn();console.log('PASS '+name);}console.log(tests.length+' container host cases passed');
`,{require,console,__dirname});
