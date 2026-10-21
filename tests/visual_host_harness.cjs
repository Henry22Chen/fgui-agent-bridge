// Execute compiled plugin contracts in a mocked native host; live Editor acceptance is tested separately.
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const code = fs.readFileSync(require('node:path').join(__dirname, '../plugin/main.js'), 'utf8').split('App.add_onUpdate(onUpdate);')[0];
class List {
    constructor(values = []) { this.values = values; }
    get Count() { return this.values.length; }
    get_Item(i) { return this.values[i]; }
    Add(v) { this.values.push(v); }
    Clear() { this.values.length = 0; }
}
class Xml {
    constructor(name, attrs = {}, nodes = []) {
        this.name = name; this.attrs = attrs; this.nodes = nodes; this.text = ''; this.elements = new List(nodes);
        this.attributes = { GetEnumerator() { const pairs = Object.entries(attrs); let i = -1;
            return { MoveNext: () => ++i < pairs.length, get Current() { return { Key: pairs[i][0], Value: pairs[i][1] }; }, Dispose() {} }; } };
    }
    GetAttribute(k) { return this.attrs[k] ?? null; }
    GetNode(k) { return this.nodes.find(n => n.name === k) || null; }
    ToXMLString() { return JSON.stringify({ name: this.name, attrs: this.attrs, nodes: this.nodes.map(n => JSON.parse(n.ToXMLString())) }); }
}
const parse = text => { const p = typeof text === 'string' ? JSON.parse(text) : text; return new Xml(p.name, p.attrs, p.nodes.map(parse)); };
class FilterData { constructor() { Object.assign(this, { type: 'none', brightness: 0, contrast: 0, saturation: 0, hue: 0 }); } }
class Vector2 { constructor(x, y) { this.x = Math.fround(x); this.y = Math.fround(y); } }
class Color { constructor(r, g, b, a) { Object.assign(this, { r, g, b, a }); } }
let ctx, doc, root, graph, image, text, group, disk, saveMode, rejectNative, updates, asset;
function setup() {
    saveMode = 'normal'; rejectNative = false; updates = 0; asset = { url: 'ui://pattern', scaleMode: '9grid', scale9Grid: '8,8,48,48' };
    const node = (id, objectType, fields) => ({ id, name: id, objectType, x: 20, y: 30, width: 160, height: 100, blendMode: 'add', _filter: new FilterData(), ...fields,
        get filter() { return this._filter.type; }, get filterData() { return this._filter; }, set filterData(v) { this._filter = v; },
        Write() { return new Xml(objectType, { id: this.id, payload: JSON.stringify(this, (key, value) => key === 'values' ? value : value) }); } });
    graph = node('graph1', 'graph', { type: 'rect', groupId: 'group1', fillColor: new Color(1, 1, 1, 1), lineColor: new Color(0, 0, 0, 1), lineSize: 1,
        cornerRadius: '', polygonPoints: new List(), sides: 3, startAngle: 0, verticesDistance: new List(),
        UpdateGraph() { updates++; if (rejectNative) throw Error('native graph failed'); } });
    image = node('image1', 'image', { color: new Color(1, 1, 1, 1), alpha: 1, resourceURL: 'ui://pattern', flip: 'none', fillMethod: 'none', fillOrigin: 0, fillAmount: 100, fillClockwise: true });
    text = node('text1', 'text', { text: 'retained' }); group = node('group1', 'group', {});
    const objects = [graph, image, text, group];
    root = { id: 'root', name: 'root', objectType: 'component', resourceURL: 'ui://root', numChildren: objects.length, GetChildAt: i => objects[i],
        Write_editMode: () => new Xml('component', {}, [new Xml('displayList', {}, objects.map(o => o.Write()))]) };
    const write = () => root.Write_editMode().ToXMLString(); disk = write();
    doc = { content: root, isModified: false, savedVersion: 0, SetModified(v) { this.isModified = v; }, RefreshInspectors() {},
        Save() { if (saveMode === 'throw') throw Error('disk full'); if (saveMode === 'dirty') return; if (saveMode !== 'stale') disk = write(); this.isModified = false; this.savedVersion++; } };
    const receipts = new Map();
    ctx = vm.createContext({ exports: {}, console, require: () => ({}), CS: {
        FairyEditor: { App: { project: { GetItemByURL: () => ({ file: 'root.xml' }) } }, FilterData },
        FairyGUI: { Utils: { XML: class { constructor(s) { return parse(s); } } } }, UnityEngine: { Application: {}, Color, Vector2 },
        System: { IO: { File: { Exists: p => p === 'root.xml' || receipts.has(p), ReadAllText: p => p === 'root.xml' ? disk : receipts.get(p) }, Directory: {}, Path: { GetDirectoryName: () => '' }, FileInfo: {}, SearchOption: {} } }
    } });
    vm.runInContext(code, ctx);
    ctx.getActiveDocument = () => doc;
    ctx.resolveObject = (_doc, target) => {
        if (target.id === 'nested') return node('nested', 'graph', {});
        const result = target.id === 'root' ? root : objects.find(o => o.id === target.id);
        if (!result) throw Error('object not found'); return result;
    };
    ctx.batchReceiptPath = () => 'receipt'; ctx.ensureDirectory = () => {};
    ctx.writeJsonAtomic = (p, value) => receipts.set(p, JSON.stringify(value));
}
const call = (action, params = {}) => ctx.handleCommand({ action, params });
const setGraph = (settings, extra = {}) => call('set_graph_settings', { target: { id: 'graph1' }, settings, ...extra });
const setImage = (settings, extra = {}) => call('set_image_display', { target: { id: 'image1' }, settings, ...extra });
const setFilter = (settings, extra = {}) => call('set_filter_settings', { target: { id: 'image1' }, settings, ...extra });
const tests = [], test = (name, fn) => tests.push([name, fn]);
test('read returns active fields without dirtying or changing package metadata', () => {
    assert.equal(call('get_graph_settings', { target: { id: 'graph1' } }).settings.type, 'rect');
    const r = call('get_image_display', { target: { id: 'image1' } }).settings;
    assert.equal(r.fillMethod, 'none'); assert.equal(r.fillAmount, undefined); assert.equal(doc.isModified, false);
    assert.equal(call('get_filter_settings', { target: { id: 'image1' } }).settings.type, 'none'); assert.equal(asset.scaleMode, '9grid');
});
test('rect color transparency canonical opaque RGBA zero line and corner order persist', () => {
    const r = setGraph({ fillColor: '#2080d0ff', lineColor: '#10203000', lineSize: 0, cornerRadius: [1, 2, 3, 4] }, { save: true });
    assert.equal(r.persisted, true); assert.equal(r.after.fillColor, '#2080D0'); assert.equal(r.after.lineColor, '#10203000');
    assert.equal(graph.cornerRadius, '1,2,3,4'); assert.equal(graph.x, 20); assert.equal(graph.width, 160); assert.equal(updates, 1);
});
test('zero corners clear and fractional arrays use native float precision', () => {
    setGraph({ cornerRadius: [0.1, 0.2, 0.3, 0.4] }); assert.equal(graph.cornerRadius.split(',')[0], String(Math.fround(0.1)));
    setGraph({ cornerRadius: [0, 0, 0, 0] }); assert.equal(graph.cornerRadius, '0,0,0,0');
});
test('polygon type transition requires valid explicit local points before mutation', () => {
    assert.throws(() => setGraph({ type: 'polygon' }), /points/); assert.equal(graph.type, 'rect'); assert.equal(doc.isModified, false);
    const r = setGraph({ type: 'polygon', points: [{ x: -0.1, y: 0 }, { x: 160, y: 0 }, { x: 80, y: 100 }] }, { save: true });
    assert.equal(r.persisted, true); assert.equal(r.after.points[0].x, Math.fround(-0.1)); assert.equal(r.after.cornerRadius, undefined);
});
test('invalid polygon plans leave the old object untouched', () => {
    for (const points of [[], [{ x: 0, y: 0 }, { x: 1, y: 1 }], [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }],
        [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 }], [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: NaN, y: 1 }],
        [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: '1' }], [{ x: 0, y: 0, typo: 1 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
        [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }, { x: 5, y: 0 }, { x: 6, y: -1 }]]) assert.throws(() => setGraph({ type: 'polygon', points }));
    assert.equal(graph.type, 'rect'); assert.equal(graph.polygonPoints.Count, 0); assert.equal(updates, 0); assert.equal(doc.isModified, false);
});
test('regular polygons preserve radius prefixes and default new vertices to one', () => {
    let r = setGraph({ type: 'regular_polygon', sides: 3, startAngle: 30, distances: [1, 0.5, 1] }, { save: true });
    assert.equal(r.persisted, true); r = setGraph({ sides: 5 }); assert.deepEqual(Array.from(r.after.distances), [1, 0.5, 1, 1, 1]);
    setGraph({ sides: 3 }); assert.deepEqual(graph.verticesDistance.values, [1, 0.5, 1]);
});
test('empty ellipse and incompatible geometry fields have explicit boundaries', () => {
    assert.throws(() => setGraph({ type: 'ellipse', cornerRadius: [0, 0, 0, 0] }));
    setGraph({ type: 'empty' }); assert.equal(Object.keys(call('get_graph_settings', { target: { id: 'graph1' } }).settings).length, 1);
    assert.throws(() => setGraph({ fillColor: '#000000' }));
    const r = setGraph({ type: 'ellipse', fillColor: '#ABCDEF' }, { save: true }); assert.equal(r.persisted, true);
});
test('all malformed typed graph fields reject before mutation', () => {
    const bad = [null, [], {}, { typo: 1 }, { lineSize: '2' }, { lineSize: true }, { lineSize: -1 }, { lineSize: Infinity },
        { fillColor: '#FFF' }, { fillColor: null }, { cornerRadius: [1] }, { cornerRadius: [0, 0, -1, 0] }, { type: 'regular_polygon', sides: true },
        { type: 'regular_polygon', sides: 2 }, { type: 'regular_polygon', sides: 3.5 }, { type: 'regular_polygon', sides: 257 },
        { type: 'regular_polygon', startAngle: 361 }, { type: 'regular_polygon', distances: [1] }];
    for (const value of bad) assert.throws(() => setGraph(value));
    assert.equal(updates, 0); assert.equal(doc.isModified, false);
});
test('image color flip radial fill uses Editor percent and does not mutate source asset', () => {
    const before = JSON.stringify(asset);
    const r = setImage({ color: '#FFFFFF00', flip: 'both', fillMethod: 'radial360', fillOrigin: 3, fillClockwise: false, fillAmount: 50 }, { save: true });
    assert.equal(r.persisted, true); assert.equal(r.after.fillAmount, 50); assert.equal(r.after.color, '#FFFFFF'); assert.equal(r.after.alpha, 0); assert.equal(r.after.fillClockwise, false);
    assert.equal(image.resourceURL, 'ui://pattern'); assert.equal(JSON.stringify(asset), before);
    setImage({ fillAmount: 0 }); assert.equal(image.fillAmount, 0);
});
test('image RGB preserves opacity and RGBA maps to persistent object alpha', () => {
    setImage({ alpha: 0.25 }); setImage({ color: '#123456' }); assert.equal(image.alpha, 0.25);
    const r = setImage({ color: '#12345680' }, { save: true });
    assert.equal(r.after.alpha, Math.fround(0.502)); assert.equal(image.color.a, 1);
    assert.throws(() => setImage({ color: '#12345600', alpha: 0 }));
});
test('fill transitions validate final origin and disabled geometry before mutation', () => {
    setImage({ fillMethod: 'radial90', fillOrigin: 3 });
    assert.throws(() => setImage({ fillMethod: 'hz' }), /fillOrigin/); assert.equal(image.fillMethod, 'radial90');
    setImage({ fillMethod: 'hz', fillOrigin: 0, fillAmount: 100 });
    assert.throws(() => setImage({ fillMethod: 'none', fillAmount: 0 })); assert.equal(image.fillMethod, 'hz');
    const r = setImage({ fillMethod: 'none' }); assert.equal(r.after.fillAmount, undefined);
});
test('all malformed image values reject before mutation', () => {
    for (const settings of [{ color: true }, { alpha: -1 }, { alpha: 1.1 }, { alpha: '0' }, { flip: 'horizontal' }, { fillMethod: 'horizontal' }, { fillAmount: 50 },
        { fillMethod: 'hz', fillOrigin: 2 }, { fillMethod: 'vt', fillOrigin: -1 }, { fillMethod: 'radial90', fillOrigin: true },
        { fillMethod: 'radial180', fillAmount: '50' }, { fillMethod: 'hz', fillClockwise: false }, { fillMethod: 'hz', fillAmount: 101 },
        { fillMethod: 'radial360', fillClockwise: 'false' }, { fillMethod: 'hz', fillAmount: NaN }]) assert.throws(() => setImage(settings));
    assert.equal(image.fillMethod, 'none'); assert.equal(doc.isModified, false);
});
test('filter replacement preserves omitted color values and does not mutate old data during preflight', () => {
    const old = image.filterData;
    let r = setFilter({ type: 'color', brightness: 0.3, saturation: -1 }, { save: true });
    assert.equal(r.persisted, true); assert.equal(image.blendMode, 'add'); assert.equal(old.type, 'none'); assert.equal(old.brightness, 0);
    r = setFilter({ brightness: 0 }); assert.equal(r.after.brightness, 0); assert.equal(r.after.saturation, -1);
    setFilter({ type: 'none' }, { save: true }); assert.equal(image.filter, 'none'); assert.equal(image.filterData.saturation, 0);
});
test('filter clear is explicit and invalid data cannot contaminate the old filter', () => {
    const old = image.filterData;
    for (const settings of [null, {}, { type: 'blur' }, { brightness: 0.3 }, { type: 'none', hue: 0 }, { type: 'color', hue: 1.1 },
        { type: 'color', contrast: -1.1 }, { type: 'color', brightness: false }, { type: 'color', saturation: null }, { type: 'color', hue: NaN }]) assert.throws(() => setFilter(settings));
    assert.equal(image.filterData, old); assert.equal(image.filter, 'none'); assert.equal(doc.isModified, false);
});
test('unknown native filter can be read but needs explicit supported replacement', () => {
    image._filter.type = 'custom'; assert.equal(call('get_filter_settings', { target: { id: 'image1' } }).settings.type, 'custom');
    assert.throws(() => setFilter({ hue: 0.2 })); setFilter({ type: 'color', hue: 0 }); assert.equal(image.filter, 'color');
});
test('no-op canonical color and filter keep undo history and dirty state', () => {
    vm.runInContext('agentUndoStack.push({sentinel:true})', ctx);
    assert.equal(setGraph({ fillColor: '#FFFFFFFF', lineSize: 1 }).changed, false);
    assert.equal(setImage({ color: '#FFFFFFff' }).changed, false); assert.equal(setFilter({ type: 'none' }).changed, false);
    assert.equal(doc.isModified, false); assert.equal(vm.runInContext('agentUndoStack.length', ctx), 1); assert.equal(updates, 0);
});
test('scope type and save validation reject before native writes', () => {
    for (const target of ['root', 'nested', 'image1']) assert.throws(() => setGraph({ lineSize: 0 }, { target: { id: target } }));
    assert.throws(() => setImage({ color: '#000000' }, { target: { id: 'graph1' } }));
    assert.throws(() => setFilter({ type: 'color' }, { target: { id: 'group1' } }));
    assert.throws(() => setGraph({ lineSize: 0 }, { save: 'true' })); assert.equal(doc.isModified, false);
});
test('native failure reports dirty mutation without pretending rollback', () => {
    rejectNative = true;
    assert.throws(() => setGraph({ lineSize: 0 }), e => e.code === 'editor_rejected' && e.details.mutationMayHaveOccurred && !e.details.rollbackAttempted);
    assert.equal(doc.isModified, true); assert.equal(graph.lineSize, 0);
});
test('save failures never claim persistence', () => {
    for (const mode of ['throw', 'dirty', 'stale']) { setup(); saveMode = mode;
        assert.throws(() => setFilter({ type: 'color', brightness: 0.5 }, { save: true }), e => e.code === 'persistence_failed' && e.details.saved === (mode === 'stale'));
    }
});
test('native batch applies all three surfaces and verifies one component save', () => {
    const result = call('apply_batch', { operationKey: 'visual-batch', documentUrl: 'ui://root', expectedRevision: ctx.documentRevision(doc), save: true,
        operations: [
            { action: 'set_graph_settings', params: { target: { id: 'graph1' }, settings: { fillColor: '#11223300', lineSize: 0 } } },
            { action: 'set_image_display', params: { target: { id: 'image1' }, settings: { fillMethod: 'vt', fillOrigin: 1, fillAmount: 25 } } },
            { action: 'set_filter_settings', params: { target: { id: 'text1' }, settings: { type: 'color', brightness: 0.25 } } }
        ] });
    assert.equal(result.status, 'succeeded', JSON.stringify(result)); assert.equal(result.persisted, true); assert.equal(result.completed, 3); assert.equal(doc.savedVersion, 1);
});
test('publishing blocks all new read and write surfaces', () => {
    vm.runInContext('publishInProgress=true', ctx);
    for (const action of ['get_graph_settings', 'set_graph_settings', 'get_image_display', 'set_image_display', 'get_filter_settings', 'set_filter_settings']) assert.throws(() => call(action), /发布/);
});
for (const [name, fn] of tests) { setup(); fn(); console.log('PASS ' + name); }
console.log(`${tests.length} visual host cases passed`);
