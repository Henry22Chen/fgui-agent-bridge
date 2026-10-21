// Reuse the established mocked host, then exercise compiled button actions. Live native checks are separate.
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const prelude = fs.readFileSync(path.join(__dirname, 'visual_host_harness.cjs'), 'utf8').split('const tests = [], test =')[0];
vm.runInNewContext(prelude + `
class Button {
    constructor() { Object.assign(this, {mode:'Check', title:'', selectedTitle:'', icon:'', selectedIcon:'', titleColor:new Color(1,1,1,1),
        titleFontSize:18, titleColorSet:false, titleFontSizeSet:false, soundSet:false, sound:null, volume:100, baseSound:'', baseVolume:75,
        downEffect:'none', downEffectValue:0.8, selected:false, controller:'Parent', page:'p0'}); }
    GetTextField() { return {}; }
}
function buttonSetup() {
    setup(); const resolve=ctx.resolveObject; ctx.resolveObject=(doc,target)=>!target || target.path==='root' ? root : resolve(doc,target); root.extentionId='Button'; root.extention=new Button(); graph.objectType='component'; graph.extentionId='Button'; graph.extention=new Button();
    const pages=['up','down','over','selectedOver','disabled','selectedDisabled'].map((name,i)=>({id:String(i),name}));
    root.controllers = new List([{name:'button', GetPages:()=>new List(pages), selectedIndex:0}]);
    image.WriteGears = () => new Xml('gears', {}, [new Xml('gearDisplay',{controller:'button',pages:'0'})]);
    doc.SetSelection = obj => doc.selection=obj;
    doc.ReplaceSelection = url => { const obj=doc.selection; if (url==='loader') { obj.objectType='loader'; obj.url=obj.resourceURL; obj.touchable=true; } else obj.resourceURL=url; };
    image.SetSize = (w,h) => {image.width=w;image.height=h;};
    ctx.resolveItem = p => ({ type: p.url==='ui://sound' ? 3 : p.url.startsWith('ui://image') ? 0 : 9, GetURL:()=>p.url });
    ctx.CS.FairyEditor.FPackageItemType={IMAGE:0,SOUND:3};
}
const tests=[], test=(name,fn)=>tests.push([name,fn]);
const settings=(value,target='graph1',extra={})=>call('set_button_settings',{target:{id:target},settings:value,...extra});
const states=(value,extra={})=>call('set_button_state_resources',{settings:value,...extra});
test('scope matrix exposes definition and instance fields',()=>{
    const d=call('get_button_settings',{}), i=call('get_button_settings',{target:{id:'graph1'}});
    assert.equal(d.scope,'definition'); assert.equal(i.scope,'instance'); assert.equal(i.settings.volume,75);
    assert.equal(i.writableFields.includes('mode'),false); assert.equal(d.writableFields.includes('selectedTitle'),false);
});
test('definition mode sound zero and feedback use definition fields',()=>{
    const r=settings({mode:'radio',sound:'ui://sound',volume:0,downEffect:'tint',downEffectValue:0},'root',{save:true});
    assert.equal(r.persisted,true); assert.equal(root.extention.mode,'Radio'); assert.equal(root.extention.baseVolume,0); assert.equal(root.extention.soundSet,false);
});
test('instance overrides set native persistence flags and preserve inherited sound volume',()=>{
    const r=settings({title:'Normal',selectedTitle:'Selected',icon:'ui://image0',selectedIcon:'',titleColor:'#ABCDEF',titleFontSize:22,sound:'ui://sound'},'graph1');
    assert.equal(r.after.volume,75); assert.equal(graph.extention.soundSet,true); assert.equal(graph.extention.titleColorSet,true); assert.equal(graph.extention.titleFontSizeSet,true);
    assert.equal(root.extention.title,''); assert.equal(graph.extention.controller,'Parent'); assert.equal(graph.extention.page,'p0');
});
test('explicit empty content silent sound and zero volume are valid',()=>{
    settings({selectedTitle:'Selected',selectedIcon:'ui://image0'});
    const r=settings({selectedTitle:'',selectedIcon:'',sound:'',volume:0},'graph1',{save:true});
    assert.equal(r.persisted,true); assert.equal(r.after.selectedTitle,''); assert.equal(r.after.sound,''); assert.equal(r.after.volume,0);
});
test('same effective style creates explicit override but ordinary no-op retains history',()=>{
    vm.runInContext('agentUndoStack.push({sentinel:true})',ctx);
    assert.equal(settings({title:''}).changed,false); assert.equal(vm.runInContext('agentUndoStack.length',ctx),1);
    assert.equal(settings({titleColor:'#FFFFFF'}).changed,true); assert.equal(graph.extention.titleColorSet,true);
});
test('scope and malformed settings reject before mutation',()=>{
    for(const patch of [{mode:'common'},{downEffect:'scale'},{volume:-1},{volume:'0'},{icon:null},{sound:'file.wav'},{titleFontSize:0},{titleColor:'#FFFFFF00'},{title:false},{typo:1}]) assert.throws(()=>settings(patch));
    for(const patch of [{selectedTitle:'x'},{mode:'Radio'},{downEffectValue:0.5}]) assert.throws(()=>settings(patch,'root'));
    assert.throws(()=>settings({title:'x'},'nested')); assert.throws(()=>settings({title:'x'},'image1'));
    assert.equal(doc.isModified,false); assert.equal(graph.extention.soundSet,false);
});
test('missing title text refuses style before mutation',()=>{
    graph.extention.GetTextField=()=>null; assert.throws(()=>settings({titleColor:'#123456'})); assert.equal(doc.isModified,false);
});
test('display mapping uses stable page and object IDs without names',()=>{
    const r=call('get_button_state_resources'); assert.equal(r.states.up.pageId,'0'); assert.equal(r.states.up.targetId,'image1');
    assert.equal(r.states.down.writable,false); assert.equal(r.settings.up,'ui://pattern');
});
test('ambiguous mappings return diagnostics without mutation',()=>{
    text.objectType='image'; text.WriteGears=image.WriteGears;
    assert.throws(()=>states({up:'ui://image0'}), e=>e.code==='unsupported_mapping'&&e.details.candidates.length===2);
    assert.equal(doc.isModified,false);
});
test('missing carriers and invalid URLs refuse whole patch before any writes',()=>{
    assert.throws(()=>call('set_button_state_resources',{target:{id:'graph1'},settings:{up:''}}));
    assert.throws(()=>states({up:'ui://image0',down:'ui://image1'}),e=>e.code==='unsupported_mapping');
    assert.throws(()=>states({up:'ui://sound'})); assert.throws(()=>states({hover:''})); assert.equal(image.resourceURL,'ui://pattern'); assert.equal(doc.isModified,false);
});
test('empty Image uses native conversion and retains IDs layout gears and relations',()=>{
    const r=states({up:''},{save:true}); assert.equal(r.persisted,true); assert.equal(r.settings.up,''); assert.equal(r.conversions[0].targetId,'image1');
    assert.equal(image.objectType,'loader'); assert.equal(image.width,160); assert.equal(image.url,''); assert.equal(image.fill,'scaleFree');
    assert.equal(states({up:'ui://image0'}).settings.up,'ui://image0');
});
test('conversion refuses advanced Image styling before writes',()=>{
    image.Write=()=>new Xml('image',{id:'image1',flip:'hz'}); assert.throws(()=>states({up:''}),e=>e.code==='unsupported_mapping'); assert.equal(doc.isModified,false);
});
test('Icon Gear resolves omitted default from native serialized base URL',()=>{
    image.objectType='loader';image.url='ui://current'; image.Write=()=>new Xml('loader',{id:'image1',url:'ui://image0'});
    image.WriteGears=()=>new Xml('gears',{},[new Xml('gearIcon',{controller:'button',pages:'1',values:'ui://image1'})]);
    const r=call('get_button_state_resources'); assert.equal(r.settings.up,'ui://image0');assert.equal(r.settings.down,'ui://image1');
});
test('failed saves report actual mutation and do not claim rollback',()=>{
    for(const mode of ['throw','dirty','stale']) { buttonSetup(); saveMode=mode;
        assert.throws(()=>settings({title:'changed'},'graph1',{save:true}),e=>e.code==='persistence_failed'&&e.details.mutationMayHaveOccurred&&!e.details.persisted&&!e.details.rollbackAttempted);
    }
});
test('batch permits instance settings and rejects shared definition and resource action',()=>{
    const batch={operationKey:'button-batch',documentUrl:'ui://root',expectedRevision:ctx.documentRevision(doc),operations:[{action:'set_button_settings',params:{target:{id:'graph1'},settings:{title:'Batch'}}}],save:true};
    const r=call('apply_batch',batch);assert.equal(r.status,'succeeded',JSON.stringify(r));assert.equal(doc.savedVersion,1);
    assert.throws(()=>call('apply_batch',{...batch,operationKey:'root',operations:[{action:'set_button_settings',params:{target:{path:'root'},settings:{mode:'common'}}}]}));
    assert.throws(()=>call('apply_batch',{...batch,operationKey:'resource',operations:[{action:'set_button_state_resources',params:{settings:{up:''}}}]}));
});
test('publishing blocks all button surfaces',()=>{
    vm.runInContext('publishInProgress=true',ctx);for(const action of ['get_button_settings','set_button_settings','get_button_state_resources','set_button_state_resources']) assert.throws(()=>call(action),/发布/);
});
for(const [name,fn] of tests){buttonSetup();fn();console.log('PASS '+name);}console.log(tests.length+' button host cases passed');
`, { require, console, __dirname });
