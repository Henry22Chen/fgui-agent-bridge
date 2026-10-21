// Compiled-plugin contract checks; native persistence and rendering are verified separately.
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const prelude = fs.readFileSync(path.join(__dirname, 'editor_settings_host_harness.cjs'), 'utf8').split('const tests = [], test =')[0];
vm.runInNewContext(prelude + `
const array = values => ({ values, get Length(){return this.values.length;}, GetValue(i){return this.values[i];}, SetValue(v,i){this.values[i]=v;} });
let first, peer, updateCount, corruptDefinition, rejectValue;
function widgetSetup(kind='progress') {
    setup();updateCount=0;corruptDefinition=false;rejectValue=false;
    const extension=kind==='progress'?'ProgressBar':kind==='slider'?'Slider':'ComboBox';
    const make=()=>({min:0,max:100,_value:30,get value(){return this._value;},set value(v){if(!rejectValue)this._value=v;},titleType:'percent',reverse:false,wholeNumbers:false,changeOnClick:true,
      sound:'',volume:100,dropdown:'ui://drop',visibleItemCount:10,direction:'auto',selectionController:'',title:'First',icon:'',clearOnPublish:false,items:array([array(['First','a','']),array(['Second','b','ui://image'])]),
      set selectedIndex(i){const row=this.items.GetValue(i);this.title=row.GetValue(0);this.icon=row.GetValue(2);},
      Update(){updateCount++;if(corruptDefinition)this.reverse=!this.reverse;},
      Write_editMode(){return new Xml(extension,kind==='combo'?{dropdown:this.dropdown}:{titleType:this.titleType,reverse:this.reverse,...kind==='slider'?{wholeNumbers:this.wholeNumbers,changeOnClick:this.changeOnClick}:{}});}});
    root.extentionId=extension;root.extention=make();first=objects[4];peer={...first,id:'peer',name:'peer'};objects.push(peer);
    for(const o of [first,peer]){o.extentionId=extension;o.extention=make();o.Write=()=>new Xml('component',{id:o.id,payload:JSON.stringify(ctx.widgetSettings({b:o.extention,kind,definition:false}))});}
    root.Write_editMode=()=>new Xml('component',{},[root.extention.Write_editMode(),new Xml('displayList',{},objects.map(o=>o.Write()))]);
    const resolve=ctx.resolveObject;ctx.resolveObject=(_d,target)=>!target||target.path==='root'?root:resolve(_d,target);
    vm.runInContext('puerts.$typeof=()=>({MakeArrayType:()=>({})})',ctx);
    ctx.CS.System.Array={CreateInstance:(_type,count)=>array(Array(count))};ctx.CS.System.String={};ctx.toCsStringArray=v=>array(v);
    ctx.CS.FairyEditor.FPackageItemType.SOUND='sound';
    ctx.resolveItem=p=>({GetURL:()=>p.url,file:'drop.xml',type:p.url==='ui://sound'?'sound':p.url==='ui://image'?'image':'component'});
    const read=ctx.CS.System.IO.File.ReadAllText;ctx.CS.System.IO.File.ReadAllText=p=>p==='drop.xml'?new Xml('component',{},[new Xml('displayList',{},[new Xml('list',{name:'list'})])]).ToXMLString():read(p);
    ctx.resolveController=(_d,name)=>{if(name!=='Selection')throw Error('missing controller');return {selectedIndex:1};};
    disk=root.Write_editMode().ToXMLString();
}
const tests=[],test=(name,fn)=>tests.push([name,fn]);
const widgetSet=(kind,settings,target='instance',extra={})=>call('set_'+kind+'_settings',{target:{id:target},settings,...extra});
test('scope matrices separate persistent definition fields from preview values',()=>{
 for(const kind of ['progress','slider','combo']){widgetSetup(kind);const d=call('get_'+kind+'_settings'),i=call('get_'+kind+'_settings',{target:{id:'instance'}});assert.equal(d.scope,'definition');assert.equal(d.preview.instanceValuesPersisted,false);assert.equal(i.scope,'instance');assert.equal(i.sharedImpact,false);assert.equal(i.readOnlySettings.titleType,kind==='combo'?undefined:'percent');assert.equal(d.writableFields.includes('value'),false);assert.equal(i.writableFields.includes('dropdown'),false);}
});
test('progress range sound and zero volume persist without shared or sibling mutation',()=>{
 const before=JSON.stringify(peer.extention);const r=widgetSet('progress',{min:200,max:400,value:350,sound:'ui://sound',volume:0},'instance',{save:true});assert.equal(r.persisted,true);assert.equal(r.after.value,350);assert.equal(JSON.stringify(peer.extention),before);assert.equal(root.extention.value,30);assert.equal(first.extention.reverse,false);assert.equal(updateCount,1);
});
test('range patch validation precedes any native setter including invalid final range',()=>{
 for(const p of [{min:100,max:100},{value:101},{max:20},{min:'0'},{value:true},{min:NaN},{value:42.1},{volume:35.5},{max:Infinity},{value:1000001},{reverse:true},{sound:'ui://image'},{volume:-1},{volume:'0'},{typo:1}])assert.throws(()=>widgetSet('progress',p));assert.equal(first.extention.value,30);assert.equal(doc.isModified,false);
});
test('progress definition only changes shared title and reverse fields',()=>{
 const r=widgetSet('progress',{titleType:'valueAndmax',reverse:true},'root',{save:true});assert.equal(r.persisted,true);assert.equal(root.extention.reverse,true);assert.equal(r.preview.instanceValuesPersisted,false);for(const p of [{min:0},{value:0},{sound:''},{titleType:'bogus'},{reverse:1}])assert.throws(()=>widgetSet('progress',p,'root'));
});
test('slider rejects fractional persistence even with integer interaction mode disabled',()=>{
 widgetSetup('slider');assert.throws(()=>widgetSet('slider',{min:-1.5,max:10.5,value:4.25}));assert.throws(()=>widgetSet('slider',{value:4.2}));first.extention.wholeNumbers=true;widgetSet('slider',{min:-2,max:10,value:4},'instance',{save:true});for(const p of [{wholeNumbers:false},{changeOnClick:true},{titleType:'max'}])assert.throws(()=>widgetSet('slider',p));
});
test('slider shared interaction flags persist on the definition',()=>{
 widgetSetup('slider');const r=widgetSet('slider',{titleType:'max',reverse:true,wholeNumbers:true,changeOnClick:false},'root',{save:true});assert.equal(r.after.changeOnClick,false);assert.equal(r.after.wholeNumbers,true);
});
test('combo named rows map exact native title value icon columns and support empty final array',()=>{
 widgetSetup('combo');const r=widgetSet('combo',{items:[{title:'Second',value:'b',icon:'ui://image'},{title:'First',value:''}],title:'Custom',icon:'',visibleItemCount:1,direction:'up',sound:'ui://sound',volume:0,clearOnPublish:true},'instance',{save:true});assert.equal(r.after.items[0].value,'b');assert.equal(first.extention.items.GetValue(0).GetValue(2),'ui://image');assert.equal(r.after.title,'Custom');widgetSet('combo',{items:[],title:'',icon:''},'instance',{save:true});assert.equal(first.extention.items.Length,0);assert.equal(peer.extention.items.Length,2);
});
test('combo selection binding derives display and rejects conflicting display and empty bound list',()=>{
 widgetSetup('combo');let r=widgetSet('combo',{selectionController:'Selection'},'instance',{save:true});assert.equal(r.after.title,'Second');assert.equal(r.after.icon,'ui://image');assert.equal(r.writableFields.includes('title'),false);for(const p of [{title:'Custom'},{icon:''},{items:[]}])assert.throws(()=>widgetSet('combo',p));r=widgetSet('combo',{selectionController:'',items:[],title:'Empty'});assert.equal(r.after.title,'Empty');
});
test('combo validates rows resource types counts direction and controller before any write',()=>{
 widgetSetup('combo');for(const p of [{items:null},{items:[{title:'Missing value'}]},{items:[{title:'A',value:1}]},{items:[{title:'A',value:'a',typo:1}]},{items:[{title:'A',value:'a',icon:'ui://sound'}]},{visibleItemCount:0},{visibleItemCount:1.5},{visibleItemCount:'2'},{direction:'left'},{selectionController:'Missing'},{selectedIndex:1},{dropdown:''},{title:null}])assert.throws(()=>widgetSet('combo',p));assert.equal(doc.isModified,false);
});
test('dropdown definition validates component template and explicit clear',()=>{
 widgetSetup('combo');assert.equal(widgetSet('combo',{dropdown:'ui://valid'},'root',{save:true}).persisted,true);widgetSet('combo',{dropdown:''},'root');assert.equal(root.extention.dropdown,'');assert.throws(()=>widgetSet('combo',{dropdown:'ui://image'},'root'));assert.throws(()=>widgetSet('combo',{title:'x'},'root'));
 ctx.CS.System.IO.File.ReadAllText=()=>new Xml('component',{},[]).ToXMLString();assert.throws(()=>widgetSet('combo',{dropdown:'ui://invalid'},'root'));
 ctx.CS.System.IO.File.ReadAllText=()=>new Xml('component',{},[new Xml('displayList',{},[new Xml('text',{name:'list'}),new Xml('list',{name:'list'})])]).ToXMLString();assert.throws(()=>widgetSet('combo',{dropdown:'ui://ambiguous'},'root'));
});
test('unknown params wrong extension nested target and publication are rejected',()=>{
 assert.throws(()=>call('get_progress_settings',{typo:1}));assert.throws(()=>widgetSet('progress',{value:10},'nested'));assert.throws(()=>widgetSet('slider',{value:10}));vm.runInContext('publishInProgress=true',ctx);for(const kind of ['progress','slider','combo'])for(const verb of ['get','set'])assert.throws(()=>call(verb+'_'+kind+'_settings',{}),/发布/);
});
test('no-op retains history but native rejection reports dirty actual state',()=>{
 vm.runInContext('agentUndoStack.push({sentinel:true})',ctx);assert.equal(widgetSet('progress',{value:30}).changed,false);assert.equal(vm.runInContext('agentUndoStack.length',ctx),1);rejectValue=true;assert.throws(()=>widgetSet('progress',{value:40}),e=>e.code==='editor_rejected'&&e.details.mutationMayHaveOccurred&&!e.details.rollbackAttempted);assert.equal(doc.isModified,true);
});
test('unexpected definition mutation is detected on instance write',()=>{
 corruptDefinition=true;assert.throws(()=>widgetSet('progress',{value:40}),e=>e.code==='editor_rejected');assert.equal(doc.isModified,true);
});
test('save failures report actual settings without persistence or rollback claims',()=>{
 for(const mode of ['throw','dirty','stale']){widgetSetup();saveMode=mode;assert.throws(()=>widgetSet('progress',{value:60},'instance',{save:true}),e=>e.code==='persistence_failed'&&!e.details.persisted&&!e.details.rollbackAttempted);assert.equal(first.extention.value,60);}
});
test('batch instance edits save once and root definition is excluded',()=>{
 const receipts=new Map();ctx.CS.System.IO.Path.GetDirectoryName=()=>'';ctx.batchReceiptPath=()=> 'receipt';ctx.ensureDirectory=()=>{};ctx.writeJsonAtomic=(p,v)=>receipts.set(p,JSON.stringify(v));ctx.CS.System.IO.File.Exists=p=>p==='root.xml'||receipts.has(p);ctx.CS.System.IO.File.ReadAllText=p=>p==='root.xml'?disk:receipts.get(p);
 const batch={operationKey:'widgets',documentUrl:'ui://root',expectedRevision:ctx.documentRevision(doc),operations:[{action:'set_progress_settings',params:{target:{id:'instance'},settings:{value:40}}},{action:'set_progress_settings',params:{target:{id:'peer'},settings:{value:60}}}],save:true};assert.equal(call('apply_batch',batch).status,'succeeded');assert.equal(doc.savedVersion,1);assert.throws(()=>call('apply_batch',{...batch,operationKey:'root',operations:[{action:'set_progress_settings',params:{target:{path:'root'},settings:{reverse:true}}}]}));
});
for(const [name,fn]of tests){widgetSetup();fn();console.log('PASS '+name);}console.log(tests.length+' widget host cases passed');
`,{require,console,__dirname});
