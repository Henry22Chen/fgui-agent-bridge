// Compiled plugin contracts in the established mock host; real native save/reload is covered separately.
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const prelude = fs.readFileSync(path.join(__dirname, 'visual_host_harness.cjs'), 'utf8').split('const tests = [], test =')[0];
vm.runInNewContext(prelude + `
Xml.prototype.SetAttribute=function(k,v){this.attrs[k]=String(v);};
Xml.prototype.RemoveAttribute=function(k){delete this.attrs[k];};
Xml.prototype.RemoveChildren=function(k){this.nodes=this.nodes.filter(n=>n.name!==k);this.elements=new List(this.nodes);};
let objects, allocation, failAt, failHydrate;
function structureSetup(){
    setup(); allocation=0;failAt=0;failHydrate=false;
    const copy=n=>parse(n.ToXMLString());
    const make=(type,id,name,x,y,w,h,attrs={},nodes=[])=>{
        const obj={objectType:type,id,name,x,y,width:w,height:h,groupId:'',resourceURL:type==='image'?'ui://image':null,
            raw:{...attrs},nodes:nodes.map(copy),parent:root,
            Write(){const attrs={...this.raw,id:this.id,name:this.name,xy:this.x+','+this.y,size:this.width+','+this.height};if(this.groupId)attrs.group=this.groupId;else delete attrs.group;
                return new Xml(this.objectType,attrs,this.nodes.map(copy));},
            Read_beforeAdd(xml){if(failHydrate)throw Error('native read failed');this.raw={...xml.attrs};this.id=xml.GetAttribute('id');this.name=xml.GetAttribute('name');
                [this.x,this.y]=xml.GetAttribute('xy').split(',').map(Number);[this.width,this.height]=xml.GetAttribute('size').split(',').map(Number);this.nodes=xml.nodes.map(copy);this.groupId=xml.GetAttribute('group')||'';},
            Read_afterAdd(){},HandleControllerChanged(){},
            UpdateImmdediately(){const members=objects.filter(o=>o.groupId===this.id);if(!members.length)return;this.x=Math.min(...members.map(o=>o.x));this.y=Math.min(...members.map(o=>o.y));
                this.width=Math.max(...members.map(o=>o.x+o.width))-this.x;this.height=Math.max(...members.map(o=>o.y+o.height))-this.y;},
        };
        obj.relations={Read(xml){obj.nodes=obj.nodes.filter(n=>n.name!=='relation').concat(xml.nodes.filter(n=>n.name==='relation').map(copy));}};
        return obj;
    };
    graph=make('graph','graph1','panel',10,20,100,80,{type:'rect',fillColor:'#ff112233'});graph.groupId='group1';
    text=make('text','text1','caption',20,30,60,20,{fontSize:'20',text:'First'},[
        new Xml('gearXY',{controller:'State',pages:'1',values:'30,35',default:'20,30'}),new Xml('relation',{target:'graph1',sidePair:'left-left'})]);text.groupId='group1';
    image=make('image','image1','picture',200,20,64,64,{src:'asset',fileName:'Image.png'});
    group=make('group','group1','cluster',10,20,100,80,{});
    objects=[graph,text,image,group];
    root={id:'root',name:'root',objectType:'component',resourceURL:'ui://root',childrenRenderOrder:'ascent',apexIndex:0,
        get numChildren(){return objects.length;},GetChildAt:i=>objects[i],GetChildIndex:obj=>objects.indexOf(obj),
        SetChildIndex(obj,index){objects.splice(objects.indexOf(obj),1);objects.splice(index,0,obj);},UpdateDisplayList(){},
        controllers:new List([]),Write_editMode(){return new Xml('component',{},[new Xml('controller',{name:'State',pages:'0,Idle,1,Active'}),new Xml('displayList',{},objects.map(o=>o.Write()))]);}
    };
    objects.forEach(o=>o.parent=root);doc.content=root;
    ctx.resolveObject=(_doc,target)=>{if(!target||target.path==='root'||target.id==='root')return root;
        if(target.id==='nested')return {id:'nested',objectType:'text'};
        const obj=objects.find(o=>target.id?o.id===target.id:o.name===target.name);if(!obj)throw Error('missing object');return obj;};
    doc.InsertObject=(kind,pos)=>{allocation++;if(allocation===failAt)throw Error('native insert failed');const type=kind==='ui://image'?'image':kind;
        const obj=make(type,'editor-'+allocation,'new',pos.x,pos.y,10,10);objects.push(obj);return obj;};
    disk=root.Write_editMode().ToXMLString();
}
const tests=[],test=(name,fn)=>tests.push([name,fn]);
const duplicate=(params={})=>call('duplicate_objects',{targets:[{id:'image1'}],...params});
test('read complete order is stable and does not mutate',()=>{
    const r=call('get_child_order');assert.deepEqual(Array.from(r.order),['graph1','text1','image1','group1']);assert.equal(r.children[0].groupId,'group1');assert.equal(doc.isModified,false);
});
test('actual ID resolver prefers root children over colliding instance-local IDs',()=>{
    const nested={id:'image1',objectType:'component'};graph.numChildren=1;graph.GetChildAt=()=>nested;
    assert.equal(ctx.findObjectById(root,'image1'),image);
});
test('clone uses host IDs preserves source resource and appends in order',()=>{
    const r=duplicate({offset:{x:10,y:5},refs:{image1:'picture'},save:true});assert.equal(r.idMap.image1,'editor-1');assert.equal(r.aliases.picture,'editor-1');
    assert.equal(r.created[0].name,'picture_copy');assert.equal(r.clipboardTouched,false);assert.equal(r.persisted,true);assert.equal(objects[4].x,210);assert.equal(objects[4].Write().GetAttribute('src'),'asset');
});
test('group closure remaps internal group and Relation plus every GearXY value',()=>{
    const r=duplicate({targets:[{id:'group1'}],offset:{x:50,y:10},save:true});assert.deepEqual(Array.from(r.expandedSourceIds),['graph1','text1','group1']);
    const cloned=objects.find(o=>o.id===r.idMap.text1);assert.equal(cloned.groupId,r.idMap.group1);assert.equal(cloned.Write().GetNode('relation').GetAttribute('target'),r.idMap.graph1);
    const gear=cloned.Write().GetNode('gearXY');assert.equal(gear.GetAttribute('default'),'70,40');assert.equal(gear.GetAttribute('values'),'80,45');assert.equal(graph.x,10);
});
test('external references reject by default and preserve only explicitly',()=>{
    assert.throws(()=>duplicate({targets:[{id:'text1'}]}),e=>e.code==='external_reference');assert.equal(objects.length,4);
    const r=duplicate({targets:[{id:'text1'}],externalReferences:'preserve'});assert.equal(r.externalReferences.length,2);
    assert.equal(objects[4].groupId,'group1');assert.equal(objects[4].Write().GetNode('relation').GetAttribute('target'),'graph1');
});
test('name conflict policies are resolved before allocations',()=>{
    assert.throws(()=>duplicate({names:{image1:'panel'},namingPolicy:'error'}));assert.equal(allocation,0);
    duplicate();const r=duplicate();assert.equal(r.created[0].name,'picture_copy_2');
});
test('root nested duplicate sources bad names and extra keys reject before writes',()=>{
    for(const params of [{targets:[{path:'root'}]},{targets:[{id:'nested'}]},{targets:[{id:'image1'},{name:'picture'}]},
        {names:{image1:'bad/name'}},{names:{missing:'x'}},{refs:{missing:'x'}},{refs:{image1:'$bad'}},{offset:{x:'2'}},{offset:{x:true}},{offset:{x:Infinity}},{offset:{z:1}},{typo:1}]) assert.throws(()=>duplicate(params));
    assert.equal(allocation,0);assert.equal(doc.isModified,false);
});
test('GearXY integer and percent offset rejection happens before allocation',()=>{
    assert.throws(()=>duplicate({targets:[{id:'group1'}],offset:{x:0.5}}));assert.equal(allocation,0);
    text.nodes[0].SetAttribute('positionsInPercent','0.5,0.5');assert.throws(()=>duplicate({targets:[{id:'group1'}],offset:{x:10}}));assert.equal(allocation,0);
    assert.equal(duplicate({targets:[{id:'group1'}]}).created.length,3);
});
test('empty groups and unknown object types refuse cleanly',()=>{
    graph.groupId='';text.groupId='';assert.throws(()=>duplicate({targets:[{id:'group1'}]}));
    image.objectType='unsupported';assert.throws(()=>duplicate());assert.equal(allocation,0);
});
test('complete reorder returns before after and persists',()=>{
    const order=['image1','group1','text1','graph1'];const r=call('reorder_objects',{orderedIds:order,save:true});
    assert.equal(r.persisted,true);assert.deepEqual(Array.from(r.afterOrder),order);assert.equal(graph.groupId,'group1');
});
test('invalid orders and nonboolean save reject without mutations',()=>{
    for(const ids of [[],['graph1'],['graph1','text1','image1','foreign'],['graph1','text1','image1','image1']])assert.throws(()=>call('reorder_objects',{orderedIds:ids}));
    assert.throws(()=>duplicate({save:'yes'}));assert.equal(allocation,0);assert.equal(doc.isModified,false);
});
test('no-op reorder preserves existing history',()=>{
    vm.runInContext('agentUndoStack.push({sentinel:true})',ctx);assert.equal(call('reorder_objects',{orderedIds:call('get_child_order').order}).changed,false);
    assert.equal(vm.runInContext('agentUndoStack.length',ctx),1);assert.equal(doc.isModified,false);
});
test('partial allocation failure reports actual created IDs and order',()=>{
    failAt=2;assert.throws(()=>duplicate({targets:[{id:'group1'}]}),e=>e.code==='editor_rejected'&&e.details.createdIds.length===1&&e.details.afterOrder.length===5&&!e.details.rollbackAttempted);
    assert.equal(objects.length,5);assert.equal(doc.isModified,true);
});
test('native hydration failure does not pretend rollback',()=>{
    failHydrate=true;assert.throws(()=>duplicate(),e=>e.code==='editor_rejected'&&e.details.createdIds.length===1&&e.details.mutationMayHaveOccurred);
});
test('save failures retain actual created mapping without persistence claims',()=>{
    for(const mode of ['throw','dirty','stale']){structureSetup();saveMode=mode;assert.throws(()=>duplicate({save:true}),e=>e.code==='persistence_failed'&&e.details.idMap.image1==='editor-1'&&!e.details.persisted);}
});
test('multi-clone batch refs feed later operations and complete reorder',()=>{
    const r=call('apply_batch',{operationKey:'structure',documentUrl:'ui://root',expectedRevision:ctx.documentRevision(doc),save:true,operations:[
        {action:'duplicate_objects',params:{targets:[{id:'image1'}],refs:{image1:'pic'}}},
        {action:'set_properties',params:{target:{id:'$pic'},properties:{name:'Batch'}}},
        {action:'reorder_objects',params:{orderedIds:['$pic','graph1','text1','image1','group1']}}
    ]});assert.equal(r.status,'succeeded',JSON.stringify(r));assert.equal(r.aliases.pic,'editor-1');assert.equal(doc.savedVersion,1);assert.equal(objects[0].name,'Batch');
});
test('batch forbids ambiguous single ref duplicate aliases and forward refs',()=>{
    const base={operationKey:'bad',documentUrl:'ui://root',expectedRevision:ctx.documentRevision(doc)};
    for(const operations of [
        [{action:'duplicate_objects',ref:'x',params:{targets:[{id:'image1'}]}}],
        [{action:'duplicate_objects',params:{targets:[{id:'image1'}],refs:{image1:'x',graph1:'x'}}}],
        [{action:'reorder_objects',params:{orderedIds:['$later']}}]
    ])assert.throws(()=>call('apply_batch',{...base,operations}));assert.equal(allocation,0);
});
test('all new surfaces blocked while publishing',()=>{
    vm.runInContext('publishInProgress=true',ctx);for(const action of ['duplicate_objects','get_child_order','reorder_objects'])assert.throws(()=>call(action),/发布/);
});
for(const [name,fn]of tests){structureSetup();fn();console.log('PASS '+name);}console.log(tests.length+' structure host cases passed');
`, { require, console, __dirname });
