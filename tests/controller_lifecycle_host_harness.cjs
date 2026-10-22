// Native execution is covered by the isolated Editor report; this host checks mutation boundaries.
const fs = require('fs'), vm = require('vm'), assert = require('assert'), path = require('path');
const code = fs.readFileSync(path.join(__dirname, '../plugin/main.js'), 'utf8').split('App.add_onUpdate(onUpdate);')[0];
const list = a => ({ get Count() { return a.length; }, get_Item: i => a[i] });
const node = (name, attrs = {}, children = []) => ({ name, attrs, children });
class XML {
    constructor(data) { this.data = typeof data === 'string' ? JSON.parse(data) : data; }
    static Create(name) { return new XML(node(name)); }
    get name() { return this.data.name; }
    get text() { return ''; }
    get attributes() {
        const entries = Object.entries(this.data.attrs); let i = -1;
        return { GetEnumerator: () => ({ MoveNext: () => ++i < entries.length, get Current() { return { Key: entries[i][0], Value: entries[i][1] }; }, Dispose() {} }) };
    }
    get elements() { return list(this.data.children.map(n => new XML(n))); }
    GetAttribute(k) { return this.data.attrs[k] ?? null; }
    SetAttribute(k, v) { this.data.attrs[k] = String(v); }
    ToXMLString() { return JSON.stringify(this.data); }
}
let ctx, doc, root, child, source, local, sub, disk, saveMode, readMode, mutations;
class Action {
    constructor() { this.data = node('action'); this.attached = false; }
    get type() { return this.data.attrs.type; }
    get repeat() { return Number(this.data.attrs.repeat ?? 1); }
    get delay() { return Number(this.data.attrs.delay ?? 0); }
    get stopOnExit() { return this.data.attrs.stopOnExit === 'true'; }
    Read(xml) {
        // Editor Read does not clear omitted/empty filter attributes on a reused action.
        const data = JSON.parse(xml.ToXMLString());
        if (!data.attrs.fromPage && this.data.attrs.fromPage) data.attrs.fromPage = this.data.attrs.fromPage;
        this.data = data;
        if (this.attached) {
            mutations++;
            if (readMode === 'throw') throw Error('native partial mutation');
            if (readMode === 'corrupt') this.data.attrs.toPage = 'invalid';
        }
    }
    Write() { return new XML(JSON.stringify(this.data)); }
    GetControllerObj(parent) {
        const owner = this.data.attrs.objectId ? parent.children.find(c => c.id === this.data.attrs.objectId) : parent;
        return owner?.items.find(c => c.name === this.data.attrs.controller) || null;
    }
}
class Controller {
    constructor(name, parent) { this.name = name; this.parent = parent; this.selectedIndex = 0; this.actions = []; this.pages = [{ id: '0', name: 'Idle' }, { id: '1', name: 'Active' }]; }
    GetPages() { return list(this.pages); }
    GetActions() { return list(this.actions); }
    AddAction(type) { const a = new Action(); a.data.attrs.type = type; a.attached = true; this.actions.push(a); return a; }
    RemoveAction(a) { this.actions.splice(this.actions.indexOf(a), 1); mutations++; }
    SwapAction(a, b) { [this.actions[a], this.actions[b]] = [this.actions[b], this.actions[a]]; }
    Write() { return new XML(node('controller', { name: this.name, pages: this.pages.flatMap(p => [p.id, p.name]).join(','), selected: String(this.selectedIndex) }, this.actions.map(a => a.Write().data))); }
}
function component(id) {
    return { id, name: id, objectType: 'component', children: [], items: [], get numChildren() { return this.children.length; },
        GetChildAt(i) { return this.children[i]; }, get controllers() { return list(this.items); }, transitions: { GetItem: name => name === 'Pulse' ? { name } : null } };
}
function setup() {
    saveMode = readMode = 'normal'; mutations = 0; disk = node('component');
    root = component('root'); root.resourceURL = 'ui://test'; child = component('child'); root.children.push(child, { id: 'text', objectType: 'text' });
    source = new Controller('Main', root); local = new Controller('Local', root); sub = new Controller('Sub', child);
    root.items.push(source, local); child.items.push(sub);
    doc = { content: root, isModified: false, savedVersion: 0, SetModified(v) { this.isModified = v; }, RefreshInspectors() {},
        Save() {
            if (saveMode === 'throw') throw Error('disk full');
            if (saveMode === 'dirty') return;
            disk = node('component', {}, root.items.map(c => c.Write().data));
            if (saveMode === 'dropAction') disk.children[0].children = [];
            if (saveMode === 'reorder') disk.children[0].children.reverse();
            this.isModified = false; this.savedVersion++;
        } };
    ctx = vm.createContext({ exports: {}, console, require: () => ({}), CS: { FairyEditor: { App: { activeDoc: doc, project: { GetItemByURL: () => ({ file: 'test.xml' }) } }, FControllerAction: Action },
        FairyGUI: { Utils: { XML } }, UnityEngine: { Application: {} }, System: { IO: { File: { ReadAllText: () => JSON.stringify(disk) }, Directory: {}, Path: {}, FileInfo: {}, SearchOption: {} } } } });
    vm.runInContext(code, ctx); ctx.getActiveDocument = () => doc;
}
const call = (action, params = {}) => ctx.handleCommand({ action, params: { controllerName: 'Main', ...params } });
const upsert = (action, extra = {}) => call('upsert_controller_action', { action, ...extra });
const change = { type: 'change_page', controllerName: 'Local', targetPageId: '1' };
const play = { type: 'play_transition', transitionName: 'Pulse', toPageIds: ['1'], repeat: -1, delay: 0.25, stopOnExit: true };
const tests = []; const test = (name, run) => tests.push([name, run]);

const setupBase = setup;
let impact;
setup = () => {
    setupBase();
    source.homePageType = local.homePageType = 'default';
    source.SetSelectedIndex = v => { source.selectedIndex = v; };
    source.SwapPage = (a,b) => { [source.pages[a],source.pages[b]]=[source.pages[b],source.pages[a]]; };
    source.RemovePageAt = i => source.pages.splice(i,1);
    root.RemoveController = c => root.items.splice(root.items.indexOf(c),1);
    root.Write_editMode = () => new XML(node('component',{},root.items.map(c=>c.Write().data)));
    child.HandleControllerChanged = () => {};
    root.children[1].HandleControllerChanged = () => {};
    impact = {references:[],unknown:[],complete:true};
    ctx.CS.System.IO.File.Exists = () => true;
    ctx.scanControllerReferences = () => impact;
};
test('reorder keeps stable page and selected identities',()=>{
    source.selectedIndex=1;
    const result=call('reorder_controller_pages',{orderedPageIds:['1','0'],save:true});
    assert.equal(result.persisted,true);assert.equal(source.pages[0].id,'1');assert.equal(source.selectedIndex,0);
    assert.throws(()=>call('reorder_controller_pages',{orderedPageIds:['1','1']}),e=>e.code==='invalid_order');
});
test('last/default/selected page rules reject before history invalidation',()=>{
    vm.runInContext('agentUndoStack.push({sentinel:true})',ctx);
    assert.throws(()=>call('remove_controller_page',{pageId:'0'}),e=>e.code==='default_page');
    assert.equal(vm.runInContext('agentUndoStack.length',ctx),1);
    call('remove_controller_page',{pageId:'0',replacementPageId:'1'});
    assert.equal(source.pages[0].id,'1');assert.equal(source.homePage,'1');assert.equal(source.homePageType,'specific');
    assert.throws(()=>call('remove_controller_page',{pageId:'1'}),e=>e.code==='last_page');
});
test('unknown and dirty external references block every partial write',()=>{
    for(const value of [{unknown:[{documentUrl:'external',reason:'unknown'}],references:[]},
        {unknown:[],references:[{local:false,documentUrl:'external',modified:true,kind:'instance_override'}]}]){
        impact=value;const before=source.Write().ToXMLString();
        for(const action of ['rename_controller','remove_controller','remove_controller_page']){
            const params={referencePolicy:'local',...(action==='rename_controller'?{name:'New'}:action==='remove_controller_page'?{pageId:'1'}:{})};
            assert.throws(()=>call(action,params),e=>['unknown_references','external_references'].includes(e.code)&&e.details.impact===impact);
            assert.equal(source.Write().ToXMLString(),before);assert.equal(doc.isModified,false);
        }
    }
});
test('local action cleanup is explicit and preserves unrelated actions',()=>{
    upsert(change);local.AddAction('change_page').Read(new XML(node('action',{type:'change_page',controller:'Main',targetPage:'1'})));
    impact={unknown:[],references:[{kind:'action',local:true,controllerName:'Local',actionIndex:0,target:true}]};
    assert.throws(()=>call('remove_controller'),e=>e.code==='controller_referenced');
    call('remove_controller',{referencePolicy:'local',save:true});assert.equal(local.actions.length,0);assert.equal(root.items.length,1);
});
test('rename migrates incoming action without changing source filters or page IDs',()=>{
    const a=local.AddAction('change_page');a.Read(new XML(node('action',{type:'change_page',controller:'Main',targetPage:'1',fromPage:'0'})));
    Object.defineProperty(a,'controllerName',{set(v){this.data.attrs.controller=v;}});
    impact={unknown:[],references:[{kind:'action',local:true,controllerName:'Local',actionIndex:0,target:true}]};
    call('rename_controller',{name:'Renamed',referencePolicy:'local'});
    assert.equal(a.data.attrs.controller,'Renamed');assert.equal(a.data.attrs.fromPage,'0');assert.equal(source.pages[1].id,'1');
});
test('rename leaves its own source conditions and unrelated action target intact',()=>{
    upsert({...change,fromPageIds:['0']});
    impact={unknown:[],references:[{kind:'action',local:true,controllerName:'Main',actionIndex:0,target:false}]};
    call('rename_controller',{name:'Renamed'});
    assert.equal(source.actions[0].data.attrs.controller,'Local');assert.equal(source.actions[0].data.attrs.fromPage,'0');
});
test('read-only scanner classifies Gear, unknown fields, invalid IDs and implicit preset resources',()=>{
    const own='ui://test', external=node('component',{},[
        node('displayList',{},[node('component',{id:'instance',src:'test',controller:'Main,1'}),node('list',{defaultItem:own},[node('item',{controllers:'Main,0'})])]),
        node('controller',{name:'Caller'},[node('action',{type:'change_page',objectId:'instance',controller:'Main',targetPage:'1'})])]);
    const current=node('component',{},[node('controller',{name:'Main'}),node('displayList',{},[node('text',{id:'text'},[node('gearText',{controller:'Main',pages:'0,1'})])])]);
    source.exported=true;
    ctx.controllerReferenceDocuments=()=>({unknown:[],documents:[{url:own,packageId:'',node:ctx.gearXmlData(new XML(current))},{url:'ui://external',packageId:'',modified:true,source:'editor',node:ctx.gearXmlData(new XML(external))}]});
    ctx.scanControllerReferences=vm.runInContext('scanControllerReferences',ctx);
    // Function declarations overwritten by the setup hook are recovered from the original compiled source.
    vm.runInContext(code.slice(code.indexOf('function scanControllerReferences('),code.indexOf('/** 完整全序输入')),ctx);
    const result=call('get_controller_references');
    assert.equal(result.complete,true);assert.equal(result.references.filter(r=>r.kind==='instance_override').length,2);
    assert(result.references.some(r=>r.kind==='action'&&!r.local&&r.modified));
    current.children[1].children[0].children[0].attrs.pages='missing';
    current.children[1].children[0].attrs.futureController='Main';
    const bad=call('get_controller_references');assert.equal(bad.complete,false);assert.equal(bad.unknown.length,2);assert.equal(doc.isModified,false);
});
test('action order preserves unknown actions and same-index ordering is a no-op',()=>{
    source.AddAction('future_action');upsert(change);
    const objects=[...source.actions];call('reorder_controller_actions',{orderedIndices:[1,0],save:true});
    assert.equal(source.actions[1],objects[0]);assert.equal(source.actions[0],objects[1]);
    assert.equal(call('reorder_controller_actions',{orderedIndices:[0,1]}).changed,false);
    assert.throws(()=>call('reorder_controller_actions',{orderedIndices:[0]}),e=>e.code==='invalid_order');
});
test('named follow modes retain cycle prevention and reject magic strings/ambiguous fields',()=>{
    for(const mode of ['follow_index','follow_name'])assert.equal(upsert({type:'change_page',controllerName:'Local',targetMode:mode}).changed,true);
    for(const action of [{...change,targetMode:'follow_index'}, {...change,targetMode:'future'}, {...change,targetPageId:'~1'}])assert.throws(()=>upsert(action));
    assert.throws(()=>upsert({type:'change_page',controllerName:'Main',targetMode:'follow_name'}),e=>e.code==='controller_cycle');
});
test('failed persistence reports mutation without fake rollback',()=>{
    saveMode='throw';assert.throws(()=>call('remove_controller',{save:true}),e=>e.code==='persistence_failed'&&e.details.mutationMayHaveOccurred&&!e.details.persisted&&!e.details.rollbackAttempted);
    assert.equal(root.items.includes(source),false);assert.equal(doc.isModified,true);
});
let failed=0;for(const [name,run] of tests){try{setup();run();console.log('PASS',name);}catch(e){failed++;console.error('FAIL',name,e);}}if(failed)process.exitCode=1;
