// 执行编译插件，验证列表声明式更新和失败边界；此宿主回归不替代真实 Editor 验证。
const fs = require('fs'), vm = require('vm'), assert = require('assert/strict'), path = require('path');
const code = fs.readFileSync(path.join(__dirname, '../plugin/main.js'), 'utf8').split('App.add_onUpdate(onUpdate);')[0];
class NativeList {
    constructor() { this.values = []; }
    get Count() { return this.values.length; }
    get_Item(i) { return this.values[i]; }
    Add(v) { this.values.push(v); }
    Clear() { this.values.length = 0; }
}
class Property { constructor() { this.target = ''; this.propertyId = 0; this.value = null; } }
class Item {
    constructor() { this.url = ''; this.name = ''; this.title = ''; this.icon = ''; this.selectedTitle = ''; this.selectedIcon = ''; this.level = 0; this.properties = new NativeList(); }
    CopyFrom(source) {
        for (const k of ['url', 'name', 'title', 'icon', 'selectedTitle', 'selectedIcon', 'level']) this[k] = source[k];
        for (const p of source.properties.values) this.properties.Add(Object.assign(new Property(), p));
    }
}
class Xml {
    constructor(name, attrs = {}, nodes = []) {
        if (nodes === undefined) nodes = [];
        this.name = name; this.attrs = attrs; this.nodes = nodes; this.text = '';
        this.elements = new NativeList(); nodes.forEach(n => this.elements.Add(n));
        this.attributes = { GetEnumerator() { let i = -1; const entries = Object.entries(attrs); return { MoveNext() { return ++i < entries.length; }, get Current() { return { Key: entries[i][0], Value: entries[i][1] }; }, Dispose() {} }; } };
    }
    GetAttribute(k) { return this.attrs[k] ?? null; }
    GetNode(k) { return this.nodes.find(n => n.name === k) || null; }
    ToXMLString() { return JSON.stringify({ name: this.name, attrs: this.attrs, nodes: this.nodes.map(n => JSON.parse(n.ToXMLString())) }); }
}
const parse = s => { const v = typeof s === 'string' ? JSON.parse(s) : s; return new Xml(v.name, v.attrs, v.nodes.map(parse)); };
let ctx, obj, doc, disk, saveMode, assignments, rejectItems;
function setup() {
    assignments = 0; rejectItems = false; saveMode = 'normal';
    const items = new NativeList();
    for (const [name, url] of [['first', ''], ['second', 'ui://itemB'], ['third', '']]) {
        const item = new Item(); item.name = name; item.title = name; item.url = url; item.icon = 'ui://image';
        item.properties.Add(Object.assign(new Property(), { target: 'label', propertyId: 0, value: name }));
        items.Add(item);
    }
    obj = { id: 'list1', name: 'list', objectType: 'list', defaultItem: 'ui://itemA', _items: items,
        get items() { return this._items; }, set items(v) { assignments++; if (!rejectItems) this._items = v; },
        Write() { return new Xml('list', { id: this.id, defaultItem: this.defaultItem, payload: JSON.stringify(this._items.values) }); } };
    const root = { id: '', name: 'root', resourceURL: 'ui://root', numChildren: 1, GetChildAt: () => obj };
    const write = () => new Xml('component', {}, [new Xml('displayList', {}, [obj.Write()])]).ToXMLString();
    root.Write_editMode = () => parse(write());
    disk = write();
    doc = { content: root, isModified: false, savedVersion: 0, SetModified(v) { this.isModified = v; }, RefreshInspectors() {},
        Save() { if (saveMode === 'throw') throw Error('disk full'); if (saveMode === 'dirty') return; if (saveMode !== 'stale') disk = write(); this.isModified = false; this.savedVersion++; } };
    const resource = (url, type = 'component') => ({ type, name: url, GetURL: () => url, file: 'root.xml' });
    const resources = { 'ui://root': resource('ui://root'), 'ui://itemA': resource('ui://itemA'), 'ui://itemB': resource('ui://itemB'), 'ui://image': resource('ui://image', 'image') };
    const app = { project: { GetItemByURL: url => resources[url] || (url === 'ui://Probe/ItemA' ? resources['ui://itemA'] : null) } };
    ctx = vm.createContext({ exports: {}, console, require: () => ({ $generic: () => NativeList }), CS: {
        FairyEditor: { App: app, ListItemData: Item, ComProperty: Property, FPackageItemType: { COMPONENT: 'component' } },
        FairyGUI: { Utils: { XML: class { constructor(s) { return parse(s); } } } }, UnityEngine: { Application: { runInBackground: false } },
        System: { Collections: { Generic: { List$1: NativeList } }, IO: { File: { Exists: () => true, ReadAllText: () => disk }, Directory: {}, Path: { GetDirectoryName: () => '' }, FileInfo: {}, SearchOption: {} } }
    } });
    vm.runInContext(code, ctx);
    ctx.getActiveDocument = () => doc;
    ctx.resolveObject = (_doc, target) => target.id === 'list1' ? obj : target.id === 'nested' ? { id: 'nested', objectType: 'list' } : root;
}
const call = (action, params = {}) => ctx.handleCommand({ action, params: { target: { id: 'list1' }, ...params } });
const set = (settings, more = {}) => call('set_list_item_resources', { settings, ...more });
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('read preserves inherited URLs and all preset attributes without dirtying', () => {
    const r = call('get_list_item_resources').settings;
    assert.equal(r.defaultItem, 'ui://itemA'); assert.equal(r.items[0].url, ''); assert.equal(r.items[0].effectiveUrl, 'ui://itemA');
    assert.equal(r.items[1].effectiveUrl, 'ui://itemB'); assert.equal(r.items[0].properties[0].value, 'first'); assert.equal(doc.isModified, false);
});
test('default changes retain preset attributes and explicit resource overrides', () => {
    const r = set({ defaultItem: 'ui://itemB' }); assert.equal(r.saved, false); assert.equal(r.persisted, false); assert.equal(doc.isModified, true);
    assert.equal(r.after.items[0].url, ''); assert.equal(r.after.items[0].effectiveUrl, 'ui://itemB'); assert.equal(obj.items.get_Item(1).title, 'second');
});
test('one final list adds deletes reorders and preserves source attributes', () => {
    const r = set({ items: [{ sourceIndex: 2 }, { url: 'ui://Probe/ItemA', title: '新项' }, { sourceIndex: 0, url: 'ui://itemB' }] }, { save: true });
    assert.equal(r.persisted, true); assert.equal(assignments, 1); assert.equal(obj.items.Count, 3);
    assert.deepEqual(obj.items.values.map(i => i.title), ['third', '新项', 'first']); assert.equal(obj.items.get_Item(1).url, 'ui://itemA');
    assert.equal(obj.items.get_Item(2).properties.get_Item(0).value, 'first'); assert.match(disk, /新项/);
});
test('all preset text fields support empty strings and selected values', () => {
    const r = set({ items: [{ sourceIndex: 0, name: '', title: '', icon: '', selectedTitle: '选中', selectedIcon: 'ui://image', url: '' }] });
    assert.equal(r.after.items[0].title, ''); assert.equal(r.after.items[0].icon, ''); assert.equal(r.after.items[0].selectedTitle, '选中');
    assert.equal(r.after.items[0].url, ''); assert.equal(obj.items.get_Item(0).properties.Count, 1);
});
test('property arrays replace text icon and controller overrides or clear all', () => {
    set({ items: [{ sourceIndex: 0, properties: [{ target: 'label', propertyId: 0, value: '' }, { target: 'icon', propertyId: 1, value: 'ui://image' }, { target: 'State', propertyId: -1, value: '0' }] }] });
    assert.equal(obj.items.get_Item(0).properties.Count, 3); assert.equal(obj.items.get_Item(0).properties.get_Item(2).value, '0');
    set({ items: [{ sourceIndex: 0, properties: [] }] }); assert.equal(obj.items.get_Item(0).properties.Count, 0);
});
test('source indices refer to the original list and can duplicate independently', () => {
    const old = obj.items; set({ items: [{ sourceIndex: 2 }, { sourceIndex: 2, title: 'copy' }, { sourceIndex: 0 }] });
    assert.equal(old.get_Item(2).title, 'third'); assert.equal(obj.items.get_Item(0).title, 'third'); assert.equal(obj.items.get_Item(1).title, 'copy');
});
test('clearing all presets and the default is valid but inherited items need a resource', () => {
    assert.throws(() => set({ defaultItem: '' }), /没有资源/); assert.equal(doc.isModified, false);
    set({ defaultItem: '', items: [{ sourceIndex: 1 }] }); assert.equal(obj.defaultItem, '');
    set({ defaultItem: '', items: [] }); assert.equal(obj.items.Count, 0);
});
test('identical plans leave history and document unchanged', () => {
    vm.runInContext('agentUndoStack.push({sentinel:true})', ctx);
    assert.equal(set({ items: [{ sourceIndex: 0 }, { sourceIndex: 1 }, { sourceIndex: 2 }] }).changed, false);
    assert.equal(assignments, 0); assert.equal(doc.isModified, false); assert.equal(vm.runInContext('agentUndoStack.length', ctx), 1);
});
test('all malformed settings and references reject before any mutation', () => {
    const original = JSON.stringify(obj.items.values);
    const bad = [null, [], {}, { typo: true }, { defaultItem: null }, { defaultItem: 'file.png' }, { defaultItem: 'ui://missing' },
        { defaultItem: 'ui://image' }, { defaultItem: 'ui://root' }, { items: null }, { items: [null] }, { items: [{ sourceIndex: -1 }] },
        { items: [{ sourceIndex: true }] }, { items: [{ sourceIndex: 3 }] }, { items: [{ url: 'ui://image' }] },
        { items: [{ title: null }] }, { items: [{ unknown: 'x' }] }, { items: [{ properties: null }] },
        { items: [{ properties: [{ target: 'label', propertyId: true, value: '' }] }] },
        { items: [{ properties: [{ target: '', propertyId: 0, value: '' }] }] },
        { items: [{ properties: [{ target: 'label', propertyId: 9, value: '' }] }] },
        { items: [{ properties: [{ target: 'label', propertyId: 0, value: null }] }] },
        { items: [{ properties: [{ target: 'label', propertyId: 0, value: '' }, { target: 'label', propertyId: 0, value: 'x' }] }] },
        { defaultItem: 'ui://itemB', items: [{ sourceIndex: 0, title: 'temporary' }, { sourceIndex: 99 }] }];
    for (const settings of bad) assert.throws(() => set(settings));
    assert.equal(JSON.stringify(obj.items.values), original); assert.equal(obj.defaultItem, 'ui://itemA'); assert.equal(assignments, 0); assert.equal(doc.isModified, false);
    assert.throws(() => set({ defaultItem: 'ui://itemB' }, { save: 'true' }), /save/);
});
test('ownership wrong type and publishing block writing', () => {
    assert.throws(() => call('get_list_item_resources', { target: { id: 'nested' } }), /直属对象/);
    obj.objectType = 'loader'; assert.throws(() => set({ items: [] }), /目标类型/); obj.objectType = 'list';
    vm.runInContext('publishInProgress=true', ctx); assert.throws(() => set({ items: [] }), /发布/); assert.equal(doc.isModified, false);
});
test('native batch dispatch writes presets and verifies the single component save', () => {
    const receipts = new Map();
    ctx.batchReceiptPath = () => 'receipt'; ctx.ensureDirectory = () => {};
    ctx.writeJsonAtomic = (p, value) => receipts.set(p, JSON.stringify(value));
    ctx.CS.System.IO.File.Exists = p => p === 'root.xml' || receipts.has(p);
    ctx.CS.System.IO.File.ReadAllText = p => p === 'root.xml' ? disk : receipts.get(p);
    const params = { operationKey: 'list-batch', documentUrl: 'ui://root', expectedRevision: ctx.documentRevision(doc), save: true,
        operations: [{ action: 'set_list_item_resources', params: { target: { id: 'list1' }, settings: { items: [{ sourceIndex: 2, title: 'batch' }, {}] } } }] };
    const result = call('apply_batch', params);
    assert.equal(result.status, 'succeeded'); assert.equal(result.completed, 1); assert.equal(result.persisted, true);
    assert.equal(obj.items.Count, 2); assert.equal(obj.items.get_Item(0).title, 'batch'); assert.equal(doc.savedVersion, 1);
});
test('Editor rejection reports possible mutation and does not claim rollback', () => {
    rejectItems = true;
    assert.throws(() => set({ items: [] }), e => e.code === 'editor_rejected' && e.details.mutationMayHaveOccurred && !e.details.rollbackAttempted);
    assert.equal(doc.isModified, true);
});
test('save failures distinguish disk errors dirty documents and stale persistence', () => {
    for (const mode of ['throw', 'dirty', 'stale']) {
        setup(); saveMode = mode;
        assert.throws(() => set({ items: [] }, { save: true }), e => e.code === 'persistence_failed' && e.details.saved === (mode === 'stale'));
        assert.equal(obj.items.Count, 0);
    }
});
for (const [name, fn] of tests) { setup(); fn(); console.log('PASS ' + name); }
console.log(`${tests.length} list item host cases passed`);
