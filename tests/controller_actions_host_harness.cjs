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
test('read exposes current and direct component pages without writes', () => {
    const r = call('get_controller_actions'); assert.equal(r.targets.length, 2); assert.equal(r.targets[1].controllers[0].pages[1].id, '1'); assert.equal(mutations, 0); assert.equal(doc.isModified, false);
});
test('append, replace and remove preserve other actions and page identities', () => {
    const unknown = source.AddAction('future_action'); unknown.data.attrs.custom = 'keep';
    const pages = JSON.stringify(source.pages), old = unknown.Write().ToXMLString();
    assert.equal(upsert(change).actionIndex, 1); assert.equal(upsert(play).actionIndex, 2);
    upsert({ ...change, targetPageId: '0' }, { actionIndex: 1 });
    call('remove_controller_action', { actionIndex: 1 });
    assert.equal(source.actions[0].Write().ToXMLString(), old); assert.equal(source.actions[1].type, 'play_transition'); assert.equal(JSON.stringify(source.pages), pages);
    assert.equal(source.selectedIndex, 0); assert.equal(local.selectedIndex, 0);
});
test('direct child target validates its own controller pages', () => {
    child.objectType = 'button'; // Component extensions must remain valid controller targets.
    upsert({ ...change, objectId: 'child', controllerName: 'Sub' }, { save: true }); assert.equal(doc.isModified, false); assert.equal(sub.actions.length, 0);
    assert.throws(() => upsert({ ...change, objectId: 'child' }), e => e.code === 'controller_not_found');
    assert.throws(() => upsert({ ...change, objectId: 'text' }), e => e.code === 'invalid_target');
    assert.throws(() => upsert({ ...change, objectId: 'nested' }), e => e.code === 'invalid_target');
});
test('source filters and destination pages reject unknown, duplicate and nonstring IDs', () => {
    for (const patch of [{ fromPageIds: ['missing'] }, { toPageIds: ['1', '1'] }, { toPageIds: [1] }, { fromPageIds: null }, { targetPageId: '~1' }, { targetPageId: 1 }]) assert.throws(() => upsert({ ...change, ...patch }));
    assert.equal(mutations, 0); assert.equal(doc.isModified, false);
});
test('type-specific fields and transition parameters validate before mutation', () => {
    for (const value of [null, [], { type: 'future' }, { ...change, transitionName: 'Pulse' }, { ...play, objectId: '' }, { ...play, repeat: 0 }, { ...play, repeat: 1.5 }, { ...play, repeat: -2 }, { ...play, delay: NaN }, { ...play, delay: -1 }, { ...play, stopOnExit: 1 }, { ...play, transitionName: 'Missing' }]) assert.throws(() => upsert(value));
    assert.equal(mutations, 0);
});
test('invalid index or save type leaves existing history intact', () => {
    vm.runInContext('agentUndoStack.push({sentinel:true})', ctx);
    for (const actionIndex of [-1, 0, 0.5, '0']) assert.throws(() => upsert(change, { actionIndex }));
    assert.throws(() => call('remove_controller_action')); assert.throws(() => upsert(change, { save: 'true' }));
    assert.equal(vm.runInContext('agentUndoStack.length', ctx), 1); assert.equal(mutations, 0);
});
test('self links and indirect cycles are rejected', () => {
    assert.throws(() => upsert({ ...change, controllerName: 'Main' }), e => e.code === 'controller_cycle');
    upsert(change);
    assert.throws(() => call('upsert_controller_action', { controllerName: 'Local', action: { ...change, controllerName: 'Main' } }), e => e.code === 'controller_cycle');
});
test('no-op preserves history while edits invalidate old undo', () => {
    upsert(play); vm.runInContext('agentUndoStack.push({sentinel:true})', ctx);
    assert.equal(upsert(play, { actionIndex: 0 }).changed, false); assert.equal(vm.runInContext('agentUndoStack.length', ctx), 1);
    upsert(change, { actionIndex: 0 }); assert.equal(vm.runInContext('agentUndoStack.length', ctx), 0);
});
test('complete replacement clears old filters even when native Read retains omissions', () => {
    upsert({ ...change, fromPageIds: ['0'] }); upsert(play, { actionIndex: 0 });
    assert.equal(call('get_controller_actions').actions[0].fromPageIds.length, 0);
});
test('save verifies actions, including order, and supports deletion persistence', () => {
    assert.equal(upsert(change, { save: true }).persisted, true); assert.equal(upsert(play, { save: true }).persisted, true);
    assert.equal(call('remove_controller_action', { actionIndex: 0, save: true }).persisted, true);
    upsert(change); saveMode = 'reorder'; assert.throws(() => upsert(change, { actionIndex: 1, save: true }), e => e.code === 'persistence_failed');
});
test('disk errors or dropped actions never claim success or rollback', () => {
    for (const mode of ['throw', 'dirty', 'dropAction']) {
        setup(); saveMode = mode;
        assert.throws(() => upsert(change, { save: true }), e => e.code === 'persistence_failed' && !e.details.persisted && !e.details.rollbackAttempted);
    }
});
test('partial native mutation reports actual state and retains dirty', () => {
    for (const mode of ['throw', 'corrupt']) {
        setup(); readMode = mode;
        assert.throws(() => upsert(change), e => e.code === 'editor_rejected' && e.details.after.length === 1 && e.details.mutationMayHaveOccurred);
        assert.equal(doc.isModified, true);
    }
});
test('publish and asynchronous load block writes', () => {
    vm.runInContext('publishInProgress=true', ctx); assert.throws(() => upsert(change));
    vm.runInContext('publishInProgress=false;loader3dBusy=true', ctx); assert.throws(() => upsert(change), e => e.code === 'document_busy');
});
let failed = 0;
for (const [name, run] of tests) { try { setup(); run(); console.log('PASS', name); } catch (error) { failed++; console.error('FAIL', name, error); } }
if (failed) process.exitCode = 1;
