// Compiled-plugin regression host; this does not replace live native Editor validation.
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const code = fs.readFileSync(require('node:path').join(__dirname, '../plugin/main.js'), 'utf8').split('App.add_onUpdate(onUpdate);')[0];
class List {
    constructor(values = []) { this.values = values; }
    get Count() { return this.values.length; }
    get_Item(i) { return this.values[i]; }
}
class Xml {
    constructor(name, attrs = {}, nodes = []) {
        this.name = name; this.attrs = attrs; this.nodes = nodes; this.text = '';
        this.elements = new List(nodes);
        this.attributes = { GetEnumerator() { const entries = Object.entries(attrs); let i = -1;
            return { MoveNext: () => ++i < entries.length, get Current() { return { Key: entries[i][0], Value: entries[i][1] }; }, Dispose() {} }; } };
    }
    GetAttribute(k) { return this.attrs[k] ?? null; }
    GetNode(k) { return this.nodes.find(n => n.name === k) || null; }
    ToXMLString() { return JSON.stringify({ name: this.name, attrs: this.attrs, nodes: this.nodes.map(n => JSON.parse(n.ToXMLString())) }); }
}
const parse = text => { const p = typeof text === 'string' ? JSON.parse(text) : text; return new Xml(p.name, p.attrs, p.nodes.map(parse)); };
let ctx, doc, root, objects, disk, saveMode, replaceMode, replacements;
function setup() {
    saveMode = 'normal'; replaceMode = 'normal'; replacements = 0;
    const node = (id, objectType, fields) => ({ id, name: id, objectType, ...fields,
        Write() { const attrs = {}; for (const [k, v] of Object.entries(this)) if (['string', 'number', 'boolean'].includes(typeof v)) attrs[k] = String(v); return new Xml(objectType, attrs); } });
    objects = [
        node('group', 'group', { advanced: false, layout: 'none', lineGap: 0, columnGap: 0, excludeInvisibles: false, autoSizeDisabled: false,
            hasMainGrid: false, mainGridIndex: 0, mainGridMinSize: 0, children: new List([{}, {}]), UpdateImmdediately() {} }),
        node('input', 'inputtext', { promptText: '', maxLength: 0, restrict: '', password: false, keyboardType: 0, text: 'retain' }),
        node('list', 'list', { clearOnPublish: false, items: new List([{level: 0, properties: new List()}]), SetBoundsChangedFlag() {}, EnsureBoundsCorrect() {}, UpdateDisplayList() {} }),
        node('mask', 'graph', {}),
        node('instance', 'component', { resourceURL: 'ui://old', x: 12, y: 34, width: 80, height: 90, pivotX: 0.5, pivotY: 0.5, anchor: true,
            scaleX: 2, scaleY: 1, rotation: 15, alpha: 0.7, visible: true, touchable: true, grayed: false, groupId: 'group',
            customProperties: new List([{ target: 'title', propertyId: 0, value: 'old override' }]) })
    ];
    root = { id: 'root', name: 'root', objectType: 'component', resourceURL: 'ui://root', mask: null, reversedMask: false,
        get numChildren() { return objects.length; }, GetChildAt: i => objects[i],
        Write_editMode() { return new Xml('component', { mask: this.mask?.id || '', reversedMask: String(this.reversedMask) }, [new Xml('displayList', {}, objects.map(o => o.Write()))]); } };
    const write = () => root.Write_editMode().ToXMLString(); disk = write();
    doc = { content: root, isModified: false, savedVersion: 0, selection: null,
        SetModified(v) { this.isModified = v; }, RefreshInspectors() {}, SetSelection(o) { this.selection = o; },
        Save() { if (saveMode === 'throw') throw Error('disk full'); if (saveMode === 'dirty') return; if (saveMode !== 'stale') disk = write(); this.isModified = false; this.savedVersion++; },
        ReplaceSelection(url) { replacements++; if (replaceMode === 'reject') return;
            const old = this.selection, next = { ...old, resourceURL: url, width: 240, height: 120, customProperties: new List() };
            if (replaceMode === 'move') next.x++;
            objects[objects.indexOf(old)] = next;
        }
    };
    const resource = (url, type = 'component') => ({ type, file: 'root.xml', GetURL: () => url });
    const resources = { 'ui://root': resource('ui://root'), 'ui://new': resource('ui://new'), 'ui://old': resource('ui://old'), 'ui://image': resource('ui://image', 'image') };
    ctx = vm.createContext({ exports: {}, console, require: () => ({}), CS: {
        FairyEditor: { App: { project: { GetItemByURL: url => resources[url] } }, FPackageItemType: { COMPONENT: 'component', IMAGE: 'image' } },
        FairyGUI: { Utils: { XML: class { constructor(s) { return parse(s); } } } }, UnityEngine: { Application: {} },
        System: { IO: { File: { Exists: () => true, ReadAllText: () => disk }, Directory: {}, Path: {}, FileInfo: {}, SearchOption: {} } }
    } });
    vm.runInContext(code, ctx);
    ctx.getActiveDocument = () => doc;
    ctx.resolveObject = (_doc, target) => {
        if (target.id === 'nested') return node('nested', 'graph', {});
        const result = target.id === 'root' ? root : objects.find(o => o.id === target.id);
        if (!result) throw Error('object not found'); return result;
    };
}
const call = (action, params = {}) => ctx.handleCommand({ action, params });
const set = (kind, settings, extra = {}) => call('set_' + kind + '_settings', { target: { id: kind === 'group' ? 'group' : kind === 'input' ? 'input' : 'list' }, settings, ...extra });
const tests = [], test = (name, fn) => tests.push([name, fn]);
test('group advanced settings persist through native snapshot', () => {
    const r = set('group', { advanced: true, layout: 'hz', columnGap: 5, excludeInvisibles: true, autoSizeDisabled: true, hasMainGrid: true, mainGridIndex: 1 }, { save: true });
    assert.equal(r.persisted, true); assert.equal(r.after.mainGridIndex, 1); assert.equal(r.after.advanced, true);
    assert.equal(call('get_group_settings', { target: { id: 'group' } }).settings.layout, 'hz');
});
test('group no-op preserves history; invalid index rejects before dirty', () => {
    assert.equal(set('group', { advanced: false }).changed, false); assert.equal(doc.isModified, false);
    assert.throws(() => set('group', { advanced: true, hasMainGrid: true, mainGridIndex: 2 }), /mainGridIndex/);
    assert.equal(doc.isModified, false); assert.equal(objects[0].advanced, false);
});
test('input prompt including UBB and empty strings does not change entered text', () => {
    const r = set('input', { promptText: '[color=#888888]请输入[/color]', maxLength: 12, restrict: '0-9', password: true, keyboardType: 2 }, { save: true });
    assert.equal(r.persisted, true); assert.equal(objects[1].text, 'retain');
    set('input', { promptText: '', restrict: '', maxLength: 0, password: false });
    assert.equal(call('get_input_settings', { target: { id: 'input' } }).settings.promptText, '');
});
test('list clear-on-publish does not delete editor presets', () => {
    const items = objects[2].items; const r = set('list', { clearOnPublish: true }, { save: true });
    assert.equal(r.persisted, true); assert.equal(objects[2].items, items); assert.equal(items.Count, 1);
    set('list', { clearOnPublish: false }); assert.equal(objects[2].clearOnPublish, false);
});
test('root mask bind invert clear persist complete document', () => {
    const r = call('set_mask_settings', { settings: { maskId: 'mask', reversedMask: true }, save: true });
    assert.equal(r.persisted, true); assert.equal(root.mask, objects[3]); assert.equal(call('get_mask_settings').settings.reversedMask, true);
    call('set_mask_settings', { settings: { maskId: '' }, save: true }); assert.equal(root.mask, null); assert.equal(root.reversedMask, false);
});
test('root mask rejects foreign nested root group missing and inverse without mask before write', () => {
    for (const id of ['nested', 'root', 'group', 'missing']) assert.throws(() => call('set_mask_settings', { settings: { maskId: id } }));
    assert.throws(() => call('set_mask_settings', { settings: { reversedMask: true } }));
    assert.equal(doc.isModified, false); assert.equal(root.mask, null);
});
test('all typed settings reject unknown null and malformed fields before mutation', () => {
    for (const [kind, values] of [['group', [{ layout: 'horizontal' }, { advanced: 'true' }, { mainGridIndex: -1 }]],
        ['input', [{ promptText: null }, { maxLength: -1 }, { maxLength: 1.2 }, { keyboardType: true }]], ['list', [{ clearOnPublish: 'true' }]]]) {
        for (const settings of [null, [], {}, { typo: 1 }, ...values]) assert.throws(() => set(kind, settings));
    }
    assert.equal(doc.isModified, false);
});
test('component replacement re-resolves ID preserves outer metadata and reports old overrides', () => {
    const r = call('replace_object_resource', { target: { id: 'instance' }, resourceURL: 'ui://new', expectedType: 'component', save: true });
    assert.equal(r.persisted, true); assert.equal(r.after.resourceURL, 'ui://new'); assert.equal(r.after.outer.width, 80);
    assert.equal(r.before.overrides[0].value, 'old override'); assert.equal(r.after.overrides.length, 0); assert.equal(replacements, 1);
    assert.equal(r.after.outer.x, 12); assert.equal(r.after.outer.groupId, 'group');
});
test('replacement supports resource size and no-op without dirtying', () => {
    assert.equal(call('replace_object_resource', { target: { id: 'instance' }, resourceURL: 'ui://old' }).changed, false);
    assert.equal(replacements, 0); assert.equal(doc.isModified, false);
    const r = call('replace_object_resource', { target: { id: 'instance' }, resourceURL: 'ui://new', preserveSize: false });
    assert.equal(r.after.outer.width, 240);
});
test('replacement rejects self wrong type root and nested before mutation', () => {
    for (const url of ['ui://root', 'ui://image', 'ui://missing']) assert.throws(() => call('replace_object_resource', { target: { id: 'instance' }, resourceURL: url }));
    assert.throws(() => call('replace_object_resource', { target: { id: 'root' }, resourceURL: 'ui://new' }));
    assert.equal(replacements, 0); assert.equal(doc.isModified, false);
});
test('native rejection and damaged outer metadata report possible mutation without rollback', () => {
    for (const mode of ['reject', 'move']) { setup(); replaceMode = mode;
        assert.throws(() => call('replace_object_resource', { target: { id: 'instance' }, resourceURL: 'ui://new' }), e => e.code === 'editor_rejected' && e.details.mutationMayHaveOccurred && !e.details.rollbackAttempted);
    }
});
test('save errors dirty state and stale XML cannot claim persistence', () => {
    for (const mode of ['throw', 'dirty', 'stale']) { setup(); saveMode = mode;
        assert.throws(() => call('set_mask_settings', { settings: { maskId: 'mask' }, save: true }), e => e.code === 'persistence_failed');
    }
});
test('publishing and wrong input type prevent mutation', () => {
    assert.throws(() => set('input', { promptText: 'x' }, { target: { id: 'group' } }), /目标类型/);
    vm.runInContext('publishInProgress=true', ctx);
    for (const action of ['set_group_settings', 'set_input_settings', 'set_mask_settings']) assert.throws(() => call(action, { settings: {} }), /发布/);
});
for (const [name, fn] of tests) { setup(); fn(); console.log('PASS ' + name); }
console.log(`${tests.length} editor settings host cases passed`);
