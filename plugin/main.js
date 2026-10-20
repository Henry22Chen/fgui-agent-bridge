"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var FairyEditor = CS.FairyEditor;
var UnityEngine = CS.UnityEngine;
const puerts = require("puerts");
const IOFile = CS.System.IO.File;
const IODirectory = CS.System.IO.Directory;
const IOPath = CS.System.IO.Path;
const IOFileInfo = CS.System.IO.FileInfo;
const IOSearchOption = CS.System.IO.SearchOption;
const App = FairyEditor.App;
const previousRunInBackground = UnityEngine.Application.runInBackground;
UnityEngine.Application.runInBackground = true;
const BRIDGE_VERSION = "0.11.0";
const PROTOCOL_VERSION = "2.0";
const POLL_INTERVAL_FRAMES = 6;
const STATUS_MIN_INTERVAL_MS = 1000;
const MAX_COMMANDS_PER_POLL = 4;
// 超过该时长仍未被认领的请求视为残留（客户端可能已中断），拒绝执行。
const REQUEST_MAX_AGE_MS = 60000;
const DOTNET_EPOCH_TICKS = 62135596800000;
const agentUndoStack = [];
const agentRedoStack = [];
let frameCount = 0;
let lastStatusWrittenMs = 0;
let queueRoot = "";
let requestFolder = "";
let processingFolder = "";
let responseFolder = "";
let statusFile = "";
let instanceStatusFile = "";
let editorIdentity = null;
let editorIdentityError = null;
let logFile = "";
let initialized = false;
const requestExecutionTimings = Object.create(null);
let publishInProgress = false;
const animationPreviewContexts = {};
// 资源加载期间保护异步请求；期限由 Editor update 驱动，客户端超时不作为取消信号。
const spineWaits = [];
let loader3dBusy = false;
// Loader3D、Controller 和 Gear 不进入 Agent 事务；原生撤销不能把这些未保存变更标成干净。
const untrackedDocumentVersions = new WeakMap();
function invalidateUntrackedHistory(doc) {
    clearAgentHistory();
    untrackedDocumentVersions.set(doc, doc.savedVersion);
    doc.SetModified(true);
}
function applyNativeHistory(doc, undo) {
    const preserveDirty = doc.isModified && untrackedDocumentVersions.has(doc) && untrackedDocumentVersions.get(doc) === doc.savedVersion;
    try {
        return undo ? doc.history.Undo() : doc.history.Redo();
    }
    finally {
        if (preserveDirty)
            doc.SetModified(true);
    }
}
function invalidateSpineWaits() {
    for (const wait of spineWaits.splice(0))
        wait.reject(new Error("工程关闭或插件卸载，请求已失效"));
}
function boundedSpineLoad(asset, valid) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + 8000;
        let done = false;
        const finish = (error) => {
            if (done)
                return;
            done = true;
            const index = spineWaits.indexOf(wait);
            if (index >= 0)
                spineWaits.splice(index, 1);
            if (error)
                reject(error);
            else
                resolve();
        };
        const wait = { reject: (error) => finish(error), check: () => {
                try {
                    if (!valid())
                        finish(new Error("文档、对象或属性已变化，请重新读取"));
                    else if (Date.now() >= deadline)
                        finish(new Error("Spine 资源加载超时"));
                }
                catch (error) {
                    finish(error);
                }
            } };
        spineWaits.push(wait);
        try {
            puerts.$promise(asset.Load()).then(() => { wait.check(); if (!done)
                finish(); }, finish);
        }
        catch (error) {
            finish(error);
        }
    });
}
const LOADER3D_KEYS = ["url", "animationName", "skinName", "playing", "loop", "frame"];
/**
 * 复用 SpineFixer 的 Spine 4.2 二进制头部布局与锚点算法。
 * 版本、有限值及正尺寸必须先通过校验；空包围盒不能拿任意默认尺寸代替。
 */
function parseSpineBounds(bytes) {
    let pos = 8; // 4.2 hash 是两个裸 int32，不是长度前缀字符串。
    const readByte = () => {
        if (pos >= bytes.length)
            throw new Error("Spine 文件头截断");
        return bytes[pos++];
    };
    let length = 0;
    for (let shift = 0;; shift += 7) {
        const value = readByte();
        if (shift > 28 || (shift === 28 && value > 15))
            throw new Error("Spine 版本长度无效");
        length += (value & 127) * Math.pow(2, shift);
        if (!(value & 128))
            break;
    }
    if (length < 2 || length > 128 || pos + length - 1 + 16 > bytes.length)
        throw new Error("Spine 版本或包围盒数据不完整");
    let version = "";
    for (let i = 0; i < length - 1; i++)
        version += String.fromCharCode(readByte());
    if (!/^4\.2\.\d+$/.test(version))
        verificationError("unsupported_spine_version", "修复器当前仅支持 Spine 4.2 二进制资源", { version });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const x = view.getFloat32(pos, false), y = view.getFloat32(pos + 4, false);
    const width = view.getFloat32(pos + 8, false), height = view.getFloat32(pos + 12, false);
    const w = Math.round(width), h = Math.round(height);
    if (![x, y, width, height].every(Number.isFinite) || w <= 0 || h <= 0 || w > 2147483647 || h > 2147483647)
        throw new Error("Spine 包围盒必须是有限值且取整后尺寸为正整数");
    // 保持原插件的先取整尺寸再乘 pivot；不要简化成 -x、height+y，否则小数尺寸会改变结果。
    const calculatedAnchorX = w * (-x / width), calculatedAnchorY = h * (1 + y / height);
    // Editor 6.1.4 的宿主赋值将正负小数都向零截断（Puerts int 字段语义）。
    // 显式做相同转换，才能与原 SpineFixer 实际落盘结果一致，而非按公式小数误报失败。
    const anchorX = Math.trunc(calculatedAnchorX), anchorY = Math.trunc(calculatedAnchorY);
    if (![anchorX, anchorY].every(value => Number.isFinite(value) && value >= -2147483648 && value <= 2147483647))
        throw new Error("Spine 锚点超出 Editor 整数范围");
    return { version, x, y, width, height, calculatedAnchorX, calculatedAnchorY, corrected: { width: w, height: h, anchorX, anchorY, pma: false } };
}
function spineMetadata(item, asset) {
    return { width: item.width, height: item.height, anchorX: asset.anchorX, anchorY: asset.anchorY, pma: asset.pma };
}
/** 独立资源写操作：保存整个所属包的元数据，不受组件 save=false 控制，不支持文档 undo。 */
function fixSpineResource(item) {
    if (!item || item.type !== FairyEditor.FPackageItemType.SPINE)
        verificationError("unsupported_resource_type", "仅能修复包内 Spine 资源", {});
    const sourceFile = item.file ? IOPath.GetFullPath(IOPath.Combine(item.owner.basePath, item.file)) : "";
    if (!sourceFile || String(IOPath.GetExtension(sourceFile)).toLowerCase() !== ".skel")
        verificationError("unsupported_spine_format", "修复器需要 Spine 4.2 .skel 文件", {});
    let bounds;
    try {
        // 只读取固定大小头部，避免大型动画文件在 Puerts 中逐字节复制。
        const stream = IOFile.OpenRead(sourceFile);
        const header = new Uint8Array(512);
        let count = 0;
        try {
            while (count < header.length) {
                const value = stream.ReadByte();
                if (value < 0)
                    break;
                header[count++] = value;
            }
        }
        finally {
            stream.Dispose();
        }
        bounds = parseSpineBounds(header.subarray(0, count));
    }
    catch (error) {
        if (error.code)
            throw error;
        verificationError("invalid_spine_bounds", String(error), { sourceFile });
    }
    const asset = item.GetAsset();
    if (!asset)
        verificationError("asset_not_ready", "Spine 资产不可用", {});
    const before = spineMetadata(item, asset);
    const expected = bounds.corrected;
    const equal = (actual) => Object.keys(expected).every(key => actual[key] === expected[key]);
    const changed = !equal(before);
    try {
        if (changed) {
            // 包元数据不属于组件事务；旧 Agent 撤销不能跨越这次资源修复。
            clearAgentHistory();
            item.width = expected.width;
            item.height = expected.height;
            asset.anchorX = expected.anchorX;
            asset.anchorY = expected.anchorY;
            asset.pma = false;
            item.SetChanged();
        }
        if (!equal(spineMetadata(item, asset)))
            throw new Error("Editor 未接受 Spine 修复值");
        // 即使内存已经正确，也需保存并回读，不能把一次失败保存后的重试当作持久化成功。
        item.owner.Save();
        const file = IOPath.Combine(item.owner.basePath, "package.xml");
        const xml = new CS.FairyGUI.Utils.XML(String(IOFile.ReadAllText(file)));
        const resources = xml.GetNode("resources");
        let node = null;
        if (resources)
            for (let i = 0; i < resources.elements.Count; i++) {
                const candidate = resources.elements.get_Item(i);
                if (String(candidate.GetAttribute("id")) === String(item.id))
                    node = candidate;
            }
        if (!node || String(node.name) !== "spine")
            throw new Error("package.xml 未找到 Spine 资源");
        const anchor = String(node.GetAttribute("anchor") || "0,0").split(",").map(Number);
        const persisted = { width: Number(node.GetAttribute("width")), height: Number(node.GetAttribute("height")),
            anchorX: anchor[0], anchorY: anchor[1], pma: String(node.GetAttribute("pma")) !== "false" };
        if (!equal(persisted))
            throw new Error("package.xml 的 Spine 修复值与预期不一致");
        return { resourceURL: item.GetURL(), before, after: spineMetadata(item, asset), bounds, changed,
            saved: true, persisted: true, diskWrite: true, file, note: "沿用 SpineFixer：修改包尺寸、锚点及 pma=false；已保存所属包，不受组件 save 控制。" };
    }
    catch (error) {
        verificationError("persistence_failed", String(error), { scope: "spine_resource", before, after: spineMetadata(item, asset),
            sourceFile, mutationMayHaveOccurred: changed, diskState: "unknown", rollbackAttempted: false });
    }
}
function loader3dValues(obj) {
    const values = {};
    for (const key of LOADER3D_KEYS)
        values[key] = obj[key];
    // Editor 新插入对象的未指定名称可为 null；保存为 XML 后是空串，两者语义相同。
    for (const key of ["url", "animationName", "skinName"])
        values[key] = values[key] || "";
    return values;
}
function resolveLoader3d(doc, target, writing) {
    let obj;
    try {
        obj = resolveObject(doc, target);
    }
    catch (error) {
        verificationError("target_not_found", String(error), { target });
    }
    if (String(obj.objectType).toLowerCase() !== "loader3d")
        verificationError("wrong_object_type", "目标不是 FLoader3D", { target });
    if (writing) {
        let owned = false;
        for (let i = 0; i < doc.content.numChildren; i++)
            if (doc.content.GetChildAt(i) === obj)
                owned = true;
        if (!owned)
            verificationError("nested_target", "请打开 Loader3D 所属组件后修改", { target });
    }
    return obj;
}
async function spineAssetInfo(url, valid) {
    const item = App.project.GetItemByURL(url);
    if (!item)
        verificationError("resource_not_found", "未找到 Spine 资源", { url });
    if (item.type !== FairyEditor.FPackageItemType.SPINE)
        verificationError("unsupported_resource_type", "首版仅支持包内 Spine", { url, type: item.type });
    try {
        const asset = item.GetAsset();
        if (!asset)
            throw new Error("GetAsset 未返回资源");
        await boundedSpineLoad(asset, valid);
        const list = (value) => {
            if (!value)
                throw new Error("动画或皮肤列表尚不可用");
            const result = [];
            for (let i = 0; i < value.Count; i++)
                result.push(String(value.get_Item(i)));
            return result;
        };
        try {
            return { animations: list(asset.animations), skins: list(asset.skins), assetInfoStatus: "ready" };
        }
        catch (error) {
            verificationError("asset_info_unavailable", String(error), { url });
        }
    }
    catch (error) {
        if (error.code === "asset_info_unavailable")
            throw error;
        verificationError("asset_not_ready", String(error), { url });
    }
}
async function getLoader3d(params) {
    const doc = getActiveDocument();
    const obj = resolveLoader3d(doc, params.target, false);
    const values = loader3dValues(obj);
    const item = values.url ? App.project.GetItemByURL(values.url) : null;
    const result = { target: targetSummary(obj, params.target), ...values,
        resource: { url: values.url, exists: Boolean(item), id: item ? item.id : null, type: item ? item.type : null,
            package: item && item.owner ? item.owner.name : null, packageId: item && item.owner ? item.owner.id : null },
        assetInfoStatus: params.includeAssetInfo === false ? "not_requested" : "empty",
        layout: { fill: obj.fill, align: obj.align, verticalAlign: obj.verticalAlign, autoSize: obj.autoSize, shrinkOnly: obj.shrinkOnly, color: colorToValue(obj.color) } };
    if (values.url && params.includeAssetInfo !== false) {
        try {
            Object.assign(result, await spineAssetInfo(values.url, () => App.activeDoc === doc && obj.url === values.url));
        }
        catch (error) {
            result.assetInfoStatus = "unavailable";
            result.assetInfoError = { code: error.code, message: String(error) };
        }
    }
    return result;
}
async function setLoader3d(params) {
    if (loader3dBusy)
        verificationError("document_busy", "Loader3D 操作尚未完成", {});
    loader3dBusy = true;
    try {
        const doc = getActiveDocument();
        const project = App.project;
        const obj = resolveLoader3d(doc, params.target, true);
        const before = loader3dValues(obj);
        const changes = {};
        for (const key of LOADER3D_KEYS) {
            if (params[key] === undefined)
                continue;
            const value = params[key];
            const valid = key === "playing" || key === "loop" ? typeof value === "boolean"
                : key === "frame" ? Number.isInteger(value) && value >= 0 : typeof value === "string";
            if (!valid)
                verificationError("invalid_argument", `无效 Loader3D 字段：${key}`, {});
            changes[key] = value;
        }
        if (!Object.keys(changes).length)
            verificationError("invalid_argument", "至少指定一个修改字段", {});
        const desired = { ...before, ...changes };
        const valid = () => {
            if (App.project !== project || App.activeDoc !== doc)
                return false;
            try {
                return resolveLoader3d(doc, params.target, true) === obj && JSON.stringify(loader3dValues(obj)) === JSON.stringify(before);
            }
            catch (_) {
                return false;
            }
        };
        let validationStatus = "verified";
        if (desired.url) {
            let info;
            try {
                info = await spineAssetInfo(desired.url, valid);
            }
            catch (error) {
                // 跳过名称枚举不允许绕过资源类型、资源不存在或文档失效检查。
                if (params.skipNameValidation !== true || error.code !== "asset_info_unavailable" || !valid())
                    throw error;
                validationStatus = "unverified";
            }
            if (info && params.skipNameValidation !== true) {
                if (desired.animationName && info.animations.indexOf(desired.animationName) < 0)
                    verificationError("invalid_animation", "资源不包含指定动画", { animationName: desired.animationName });
                if (desired.skinName && info.skins.indexOf(desired.skinName) < 0)
                    verificationError("invalid_skin", "资源不包含指定皮肤", { skinName: desired.skinName });
            }
            else
                validationStatus = "unverified";
        }
        if (!valid())
            verificationError("editor_rejected", "等待期间文档或对象发生变化，未应用修改", { mutationMayHaveOccurred: false });
        // 只有明确绑定资源时自动修复；暂停、跳帧等操作不应隐式保存资源包。
        const resourceFix = params.url !== undefined && desired.url && params.fixSpine !== false
            ? fixSpineResource(App.project.GetItemByURL(desired.url)) : null;
        const expected = { resourceURL: desired.url, animationName: desired.animationName, skinName: desired.skinName,
            playing: desired.playing, loop: desired.loop, frame: desired.frame };
        // 加载期间用户可能修改了无关字段；回退只恢复真正写入前的 dirty 状态。
        const documentModifiedBefore = doc.isModified;
        if (!valuesEqual(before, desired)) {
            try {
                // URL setter 可能重置播放属性，因此按完整最终快照恢复未传入字段。
                for (const key of LOADER3D_KEYS)
                    obj[key] = desired[key];
                doc.SetModified(true);
                verifyObject(doc, obj, expected, false);
                invalidateUntrackedHistory(doc);
                doc.RefreshInspectors();
            }
            catch (error) {
                let rollbackSucceeded = false;
                try {
                    for (const key of LOADER3D_KEYS)
                        obj[key] = before[key];
                    rollbackSucceeded = JSON.stringify(loader3dValues(obj)) === JSON.stringify(before);
                }
                catch (_) { /* 回退失败保留实际状态，不能伪报恢复成功。 */ }
                if (rollbackSucceeded)
                    doc.SetModified(documentModifiedBefore);
                else
                    invalidateUntrackedHistory(doc);
                verificationError("editor_rejected", String(error), { mutationMayHaveOccurred: true, rollbackSucceeded, before, after: loader3dValues(obj), resourceFix });
            }
        }
        // 保存失败不尝试恢复磁盘；截图是独立只读工具，永远不触发此回退路径。
        try {
            const result = writeVerification(doc, obj, before, loader3dValues(obj), params, expected);
            if (result.saved)
                untrackedDocumentVersions.delete(doc);
            return { ...result, validationStatus, agentUndoSupported: false, resourceFix };
        }
        catch (error) {
            error.details = { ...error.details, mutationMayHaveOccurred: true, diskState: "unknown", rollbackAttempted: false, before, after: loader3dValues(obj), resourceFix };
            throw error;
        }
    }
    finally {
        loader3dBusy = false;
    }
}
const GEAR_TYPES = { display: { index: 0, tag: "gearDisplay" }, xy: { index: 1, tag: "gearXY" },
    size: { index: 2, tag: "gearSize" }, color: { index: 4, tag: "gearColor" }, text: { index: 6, tag: "gearText" }, icon: { index: 7, tag: "gearIcon" } };
function gearTarget(doc, target) {
    const obj = resolveObject(doc, target);
    // Gear 引用的是直接父组件控制器；禁止把嵌套资源当作当前文档的子对象改写。
    let direct = false;
    for (let i = 0; i < doc.content.numChildren; i++)
        if (doc.content.GetChildAt(i) === obj)
            direct = true;
    if (!direct)
        verificationError("nested_target", "Gear 只支持当前文档直属子对象，请打开其所属组件", { target });
    return obj;
}
/** 以排序后的 XML 属性比对语义，忽略宿主序列化时的属性/节点顺序。 */
function gearXmlData(node) {
    const attrs = {}, entries = [], iterator = node.attributes.GetEnumerator();
    try {
        while (iterator.MoveNext())
            entries.push([String(iterator.Current.Key), String(iterator.Current.Value)]);
    }
    finally {
        iterator.Dispose();
    }
    entries.sort((a, b) => a[0].localeCompare(b[0])).forEach(pair => attrs[pair[0]] = pair[1]);
    const children = [];
    for (let i = 0; i < node.elements.Count; i++)
        children.push(gearXmlData(node.elements.get_Item(i)));
    return { name: String(node.name), attrs, text: node.text || "", children };
}
function gearNodes(xml) {
    const nodes = [];
    for (let i = 0; i < xml.elements.Count; i++) {
        const node = xml.elements.get_Item(i);
        if (String(node.name).indexOf("gear") === 0)
            nodes.push(node);
    }
    return nodes;
}
function parseGearValue(type, value) {
    if (type === "text" || type === "icon")
        return value;
    const parts = value.split(",");
    if (type === "color")
        return { color: parts[0].toUpperCase(), strokeColor: (parts[1] || "#000000").toUpperCase() };
    const numbers = parts.map(Number);
    if (type === "xy")
        return { x: numbers[0], y: numbers[1] };
    return { width: numbers[0], height: numbers[1], scaleX: numbers.length > 2 ? numbers[2] : 1, scaleY: numbers.length > 3 ? numbers[3] : 1 };
}
function gearDescription(type, node) {
    if (!node)
        return { type, bound: false };
    const pages = String(node.GetAttribute("pages") || "").split(",").filter(Boolean);
    const result = { type, bound: true, controllerName: String(node.GetAttribute("controller") || ""), xml: String(node.ToXMLString(false)) };
    if (type === "display")
        return { ...result, visiblePageIds: pages, allPagesVisible: pages.length === 0 };
    const raw = node.GetAttribute("default"), values = String(node.GetAttribute("values") || "").split("|");
    return { ...result, defaultValue: raw === null || raw === undefined ? null : parseGearValue(type, String(raw)),
        pageValues: pages.map((pageId, i) => ({ pageId, value: values[i] === undefined ? null : parseGearValue(type, values[i]) })) };
}
function getGears(params) {
    const doc = getActiveDocument(), obj = gearTarget(doc, params.target), xml = obj.WriteGears();
    return { target: targetSummary(obj, params.target), documentUrl: doc.content.resourceURL,
        gears: Object.keys(GEAR_TYPES).map(type => ({ ...gearDescription(type, xml.GetNode(GEAR_TYPES[type].tag)), supported: obj.SupportGear(GEAR_TYPES[type].index) })),
        otherGears: gearNodes(xml).filter(n => !Object.keys(GEAR_TYPES).some(type => GEAR_TYPES[type].tag === String(n.name))).map(n => String(n.ToXMLString(false))) };
}
function encodeGearValue(type, value) {
    const fail = (message) => verificationError("invalid_argument", message, { gearType: type });
    if (type === "text" || type === "icon") {
        if (typeof value !== "string" || /[|\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))
            fail("文字/图标值必须是字符串，不能含竖线或非法 XML 控制字符");
        // Editor 的 values 用 | 分隔，反斜线不能转义；在写入前拒绝，避免悄悄截断内容。
        if (type === "icon" && value) {
            const item = App.project.GetItemByURL(value);
            if (!item || item.type !== FairyEditor.FPackageItemType.IMAGE)
                fail("图标必须为空字符串或工程内图片 ui:// URL");
            return String(item.GetURL());
        }
        return value;
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
        fail("Gear 值必须是字段对象");
    const keys = type === "xy" ? ["x", "y"] : type === "size" ? ["width", "height", "scaleX", "scaleY"] : ["color", "strokeColor"];
    if (Object.keys(value).some(key => keys.indexOf(key) < 0))
        fail("Gear 值包含未知字段");
    if (type === "color") {
        const color = (input) => {
            if (typeof input !== "string" || !/^#[0-9a-fA-F]{6}$/.test(input))
                fail("Gear 颜色必须是 #RRGGBB");
            return input.toLowerCase();
        };
        return `${color(value.color)},${color(value.strokeColor === undefined ? "#000000" : value.strokeColor)}`;
    }
    const numbers = keys.map(key => value[key] === undefined && (key === "scaleX" || key === "scaleY") ? 1 : value[key]);
    if (numbers.some(n => typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 1000000))
        fail("坐标/尺寸/缩放必须是有限数字，绝对值不超过 1000000");
    // Editor 6.1.4 FGearXY.ReadValue 使用 Int32.Parse；小数必须在 ReadGears 前拒绝。
    if (type === "xy" && numbers.some(n => !Number.isInteger(n)))
        fail("GearXY 的 x/y 必须是整数像素");
    if (type === "size" && (!Number.isInteger(numbers[0]) || !Number.isInteger(numbers[1]) || numbers[0] < 0 || numbers[1] < 0))
        fail("宽高必须是非负整数像素");
    return numbers.join(",");
}
/** 替换一个 Gear 的完整页面配置；其它 Gear 和目标 Gear 的缓动等附加设置保留。 */
function setGear(params) {
    const doc = getActiveDocument(), obj = gearTarget(doc, params.target), type = params.gearType;
    const spec = typeof type === "string" && Object.prototype.hasOwnProperty.call(GEAR_TYPES, type) ? GEAR_TYPES[type] : null;
    if (!spec)
        verificationError("unsupported_gear", "仅支持 display/text/icon/xy/size/color", {});
    if (!obj.SupportGear(spec.index))
        verificationError("unsupported_gear", "该对象不支持此 Gear", { type });
    if (params.save !== undefined && typeof params.save !== "boolean")
        verificationError("invalid_argument", "save 必须是布尔值", {});
    const controller = resolveController(doc, params.controllerName), validPages = controllerSnapshot(controller).pages.map(p => p.id);
    const validateIds = (ids) => {
        if (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || validPages.indexOf(id) < 0) || new Set(ids).size !== ids.length)
            verificationError("invalid_argument", "页面 ID 必须属于指定控制器且不能重复", {});
    };
    let ids, values = [], defaultValue;
    if (type === "display") {
        if (params.defaultValue !== undefined || params.pageValues !== undefined)
            verificationError("invalid_argument", "display 仅使用 visiblePageIds；空数组表示所有页可见", {});
        validateIds(params.visiblePageIds);
        ids = params.visiblePageIds.slice();
    }
    else {
        if (params.visiblePageIds !== undefined || !Array.isArray(params.pageValues))
            verificationError("invalid_argument", "非 display Gear 必须提供 defaultValue 和 pageValues 数组", {});
        defaultValue = encodeGearValue(type, params.defaultValue);
        ids = params.pageValues.map(entry => entry && entry.pageId);
        validateIds(ids);
        values = params.pageValues.map(entry => {
            if (!entry || Object.keys(entry).some(key => key !== "pageId" && key !== "value"))
                verificationError("invalid_argument", "页面条目仅允许 pageId/value", {});
            return encodeGearValue(type, entry.value);
        });
    }
    // 按控制器页面顺序序列化，调用方的数组顺序不会改变页面身份。
    const order = ids.map((id, i) => ({ id, value: values[i] })).sort((a, b) => validPages.indexOf(a.id) - validPages.indexOf(b.id));
    ids = order.map(v => v.id);
    values = order.map(v => v.value);
    const beforeXml = obj.WriteGears(), old = beforeXml.GetNode(spec.tag);
    // 百分比位置还需维护 positionsInPercent；首批明确拒绝，避免普通 xy 覆盖高级配置。
    if (type === "xy" && old && (old.GetAttribute("positionsInPercent") || old.GetAttribute("percent")))
        verificationError("unsupported_gear", "百分比位置 Gear 暂不支持编辑", {});
    const Xml = CS.FairyGUI.Utils.XML;
    const xml = new Xml(String(beforeXml.ToXMLString(false)));
    const node = xml.GetNode(spec.tag) || Xml.Create(spec.tag);
    if (!xml.GetNode(spec.tag))
        xml.AppendChild(node);
    node.SetAttribute("controller", String(controller.name));
    node.SetAttribute("pages", ids.join(","));
    if (type !== "display") {
        node.SetAttribute("values", values.join("|"));
        node.SetAttribute("default", defaultValue);
    }
    const expected = gearDescription(type, node), before = gearDescription(type, old);
    const semantic = (v) => { const copy = { ...v }; delete copy.xml; return copy; };
    const changed = !valuesEqual(semantic(before), semantic(expected));
    let after = before;
    if (changed) {
        invalidateUntrackedHistory(doc);
        try {
            // ReadGears 会重建所有 Gear，因此必须传完整快照，随后校验其它 Gear 未受影响。
            obj.ReadGears(xml);
            // 重建后重新应用该对象的所有控制器状态，恢复绑定到其它控制器的显隐等状态。
            // 不调用组件 ApplyController，避免额外执行控制器联动或切换页面。
            for (const current of controllerList(doc))
                obj.HandleControllerChanged(current);
            const actualXml = obj.WriteGears();
            after = gearDescription(type, actualXml.GetNode(spec.tag));
            if (!valuesEqual(semantic(after), semantic(expected)))
                throw new Error("Gear Editor 回读与期望不符");
            const untouched = (root) => gearNodes(root).filter(n => String(n.name) !== spec.tag).map(gearXmlData).sort((a, b) => a.name.localeCompare(b.name));
            if (!valuesEqual(untouched(beforeXml), untouched(actualXml)))
                throw new Error("其它 Gear 的配置发生变化");
            const extras = (n) => { const data = gearXmlData(n); for (const k of ["controller", "pages", "values", "default"])
                delete data.attrs[k]; return data; };
            if (!valuesEqual(extras(node), extras(actualXml.GetNode(spec.tag))))
                throw new Error("目标 Gear 的附加设置发生变化");
            doc.SetModified(true);
            doc.RefreshInspectors();
        }
        catch (error) {
            invalidateUntrackedHistory(doc);
            // 原生解析可能已重建部分 Gear；失败时不能把旧快照伪装成修改后的状态。
            after = null;
            try {
                after = gearDescription(type, obj.WriteGears().GetNode(spec.tag));
            }
            catch (_) { /* 无法回读时明确返回 null。 */ }
            verificationError("editor_rejected", String(error), { before, after, mutationMayHaveOccurred: true, rollbackAttempted: false });
        }
    }
    let saved = false, persisted = false;
    if (params.save === true) {
        try {
            const expectedAll = gearNodes(obj.WriteGears()).map(gearXmlData).sort((a, b) => a.name.localeCompare(b.name));
            doc.Save();
            if (doc.isModified)
                throw new Error("保存后组件仍有未保存修改");
            saved = true;
            clearAgentHistory();
            untrackedDocumentVersions.delete(doc);
            const item = App.project.GetItemByURL(doc.content.resourceURL), disk = new Xml(String(IOFile.ReadAllText(item.file)));
            const list = disk.GetNode("displayList"), matches = [];
            if (list)
                for (let i = 0; i < list.elements.Count; i++) {
                    const child = list.elements.get_Item(i);
                    if (String(child.GetAttribute("id")) === String(obj.id))
                        matches.push(child);
                }
            if (matches.length !== 1 || !valuesEqual(gearNodes(matches[0]).map(gearXmlData).sort((a, b) => a.name.localeCompare(b.name)), expectedAll))
                throw new Error("组件 XML 的 Gear 配置与 Editor 不一致");
            persisted = true;
        }
        catch (error) {
            verificationError("persistence_failed", String(error), { before, after, saved, persisted: false, mutationMayHaveOccurred: changed, diskState: "unknown", rollbackAttempted: false });
        }
    }
    return { target: targetSummary(obj, params.target), before, after, changed, saved, persisted, documentModified: Boolean(doc.isModified), agentUndoSupported: false,
        note: "替换目标 Gear 的完整配置；未列页面使用默认值。display 空列表表示所有页可见。布局、自动尺寸和其它 Gear 仍可能影响最终外观，需切页验证。" };
}
/** 当前文档根组件的控制器；嵌套组件应先打开其所属文档，避免改错资源。 */
function controllerList(doc) {
    const list = doc.content.controllers, result = [];
    for (let i = 0; i < list.Count; i++)
        result.push(list.get_Item(i));
    return result;
}
function controllerSnapshot(c) {
    const pages = [], list = c.GetPages();
    for (let i = 0; i < list.Count; i++) {
        const page = list.get_Item(i);
        pages.push({ id: String(page.id), name: String(page.name), index: i });
    }
    const index = c.selectedIndex;
    return { name: String(c.name), pages, selectedIndex: index,
        selectedPageId: pages[index] ? pages[index].id : null, selectedPage: pages[index] ? pages[index].name : null,
        homePageType: c.homePageType || "", homePage: c.homePage || "", exported: Boolean(c.exported), alias: String(c.alias || "") };
}
function requireControllerName(value) {
    // 页面列表以逗号分隔保存；拒绝无法无损往返的名称，不替用户裁剪或改名。
    if (typeof value !== "string" || !value.trim() || /[,\x00-\x1f]/.test(value))
        verificationError("invalid_argument", "名称不能为空或含逗号/控制字符", {});
    return value;
}
function resolveController(doc, name) {
    requireControllerName(name);
    const matches = controllerList(doc).filter(c => c.name === name);
    if (matches.length !== 1)
        verificationError(matches.length ? "ambiguous_controller" : "controller_not_found", "控制器名称不存在或不唯一", { name });
    return matches[0];
}
function resolveControllerPage(c, params) {
    const keys = ["pageId", "pageName", "pageIndex"].filter(key => params[key] !== undefined && params[key] !== null);
    if (keys.length !== 1)
        verificationError("invalid_argument", "必须且只能提供 pageId、pageName、pageIndex 之一", {});
    const key = keys[0], value = params[key];
    if (key === "pageIndex" ? !Number.isInteger(value) || value < 0 : typeof value !== "string")
        verificationError("invalid_argument", "页面定位参数类型或索引无效", {});
    const pages = controllerSnapshot(c).pages;
    const matches = pages.filter(p => key === "pageIndex" ? p.index === value : key === "pageId" ? p.id === value : p.name === value);
    if (matches.length !== 1)
        verificationError(matches.length ? "ambiguous_page" : "page_not_found", "页面不存在或名称不唯一；优先使用 pageId", { value });
    return matches[0];
}
/** 保存整个组件并回读 Controller XML；选中页不是运行时 homePage 配置。 */
function finishControllerWrite(doc, c, before, params, changed) {
    const after = controllerSnapshot(c);
    let saved = false, persisted = false;
    if (params.save === true) {
        try {
            // 以宿主序列化结果为准，空控制器与省略的默认 selected 均保持原生语义。
            const expected = c.Write();
            doc.Save();
            if (doc.isModified)
                throw new Error("保存后组件仍有未保存修改");
            saved = true;
            clearAgentHistory();
            untrackedDocumentVersions.delete(doc);
            const item = App.project.GetItemByURL(doc.content.resourceURL);
            const xml = new CS.FairyGUI.Utils.XML(String(IOFile.ReadAllText(item.file)));
            const matches = [];
            for (let i = 0; i < xml.elements.Count; i++) {
                const node = xml.elements.get_Item(i);
                if (String(node.name) === "controller" && String(node.GetAttribute("name")) === after.name)
                    matches.push(node);
            }
            if (matches.length !== 1)
                throw new Error("组件 XML 控制器不存在或不唯一");
            for (const key of ["name", "pages", "selected", "homePage", "homePageType", "exported", "alias"]) {
                if (String(matches[0].GetAttribute(key) || "") !== String(expected.GetAttribute(key) || ""))
                    throw new Error(`组件 XML 的 ${key} 与 Editor 不一致`);
            }
            const actionData = (node) => {
                const data = [];
                for (let i = 0; i < node.elements.Count; i++) {
                    const child = node.elements.get_Item(i);
                    if (String(child.name) === "action")
                        data.push(gearXmlData(child));
                }
                return data;
            };
            if (!valuesEqual(actionData(matches[0]), actionData(expected)))
                throw new Error("组件 XML 的控制器联动与 Editor 不一致");
            persisted = true;
        }
        catch (error) {
            verificationError("persistence_failed", String(error), { before, after, saved, persisted: false,
                mutationMayHaveOccurred: changed, diskState: "unknown", rollbackAttempted: false });
        }
    }
    return { before, after, changed, saved, persisted, documentModified: Boolean(doc.isModified), agentUndoSupported: false,
        note: "只操作当前文档控制器；页面 ID 保留。切页应用原生 Gear/联动，不修改运行时 homePage。save 保存整个组件。" };
}
function editController(action, params) {
    const doc = getActiveDocument();
    if (params.save !== undefined && typeof params.save !== "boolean")
        verificationError("invalid_argument", "save 必须是布尔值", {});
    let c, page, name, initialPages;
    if (action === "create_controller") {
        name = requireControllerName(params.name);
        if (controllerList(doc).some(value => value.name === name))
            verificationError("controller_exists", "控制器名称已存在", { name });
        initialPages = params.pages === undefined ? [] : params.pages;
        if (!Array.isArray(initialPages))
            verificationError("invalid_argument", "pages 必须是页面名称数组", {});
        initialPages.forEach(requireControllerName);
        if (new Set(initialPages).size !== initialPages.length)
            verificationError("duplicate_page", "页面名称不能重复", {});
    }
    else {
        c = resolveController(doc, params.controllerName);
        if (action === "add_controller_page" || action === "rename_controller_page") {
            name = requireControllerName(params.name);
            if (action === "rename_controller_page")
                page = resolveControllerPage(c, params);
            if (controllerSnapshot(c).pages.some(p => p.name === name && (!page || p.id !== page.id)))
                verificationError("duplicate_page", "页面名称已存在", { name });
        }
        else
            page = resolveControllerPage(c, params);
    }
    const before = c ? controllerSnapshot(c) : null;
    const changed = action === "create_controller" || action === "add_controller_page"
        || (action === "rename_controller_page" ? page.name !== name : before.selectedPageId !== page.id);
    if (changed) {
        // 没有完整 Controller/Gear/联动事务快照，旧 Agent 历史不能跨过这次编辑。
        invalidateUntrackedHistory(doc);
        try {
            if (action === "create_controller") {
                c = new FairyEditor.FController();
                c.name = name;
                initialPages.forEach(value => c.AddPage(value));
                doc.content.AddController(c);
                if (initialPages.length)
                    c.selectedIndex = 0;
            }
            else if (action === "add_controller_page") {
                c.AddPage(name);
                // 原生 AddPage 不选择首个页面；为新建空控制器补上可见的初始状态。
                if (!before.pages.length)
                    c.selectedIndex = 0;
            }
            else if (action === "rename_controller_page")
                c.GetPages().get_Item(page.index).name = name;
            else
                c.selectedIndex = page.index; // 原生 setter 应用 Gear/联动；不使用静默 SetSelectedIndex。
            const after = controllerSnapshot(c);
            if (action === "create_controller") {
                if (controllerList(doc).indexOf(c) < 0 || !valuesEqual(after.pages.map(p => p.name), initialPages)
                    || (initialPages.length && after.selectedIndex !== 0))
                    throw new Error("Editor 未接受新控制器或初始页面");
            }
            else if (action === "add_controller_page") {
                if (after.pages.length !== before.pages.length + 1 || after.pages[after.pages.length - 1].name !== name
                    || !valuesEqual(after.pages.slice(0, -1), before.pages)
                    || (before.pages.length ? after.selectedPageId !== before.selectedPageId : after.selectedIndex !== 0))
                    throw new Error("Editor 未按追加语义添加页面");
            }
            else if (action === "rename_controller_page") {
                const expected = before.pages.map(p => p.id === page.id ? { ...p, name } : p);
                if (!valuesEqual(after.pages, expected) || after.selectedPageId !== before.selectedPageId)
                    throw new Error("Editor 重命名结果或页面 ID 不符");
            }
            else if (after.selectedPageId !== page.id)
                throw new Error("Editor 未停留在目标页面，可能存在联动");
            doc.SetModified(true);
            doc.RefreshInspectors();
        }
        catch (error) {
            // 切页可能已触发其他控制器，不能只改回 selectedIndex 就伪称完整回退。
            invalidateUntrackedHistory(doc);
            verificationError("editor_rejected", String(error), { before, after: c ? controllerSnapshot(c) : null,
                mutationMayHaveOccurred: true, rollbackAttempted: false });
        }
    }
    return finishControllerWrite(doc, c, before, params, changed);
}
/** 组件属性的原生定位使用点分名称路径；逐层检查重名，避免修改到同名元件。 */
function componentPropertyObject(component, path, propertyId) {
    if (typeof path !== "string" || !path || path.split(".").some(p => !p))
        verificationError("invalid_argument", "childPath 必须为非空点分元件路径", {});
    if (propertyId !== 0 && propertyId !== 1)
        verificationError("unsupported_property", "组件自定义属性只支持 propertyId=0（文本）或 1（图标）", {});
    let current = component;
    for (const name of path.split(".")) {
        const matches = [];
        for (let i = 0; i < Number(current.numChildren || 0); i++)
            if (current.GetChildAt(i).name === name)
                matches.push(current.GetChildAt(i));
        if (matches.length !== 1)
            verificationError(matches.length ? "ambiguous_target" : "target_not_found", "自定义属性目标不存在或不唯一", { childPath: path, name });
        current = matches[0];
    }
    if (typeof current.GetProp(propertyId) !== "string")
        verificationError("unsupported_property", "目标元件不支持指定文本/图标属性", { childPath: path, propertyId });
    return current;
}
function componentPropertyList(component) {
    const result = [], list = component.customProperties;
    if (list)
        for (let i = 0; i < list.Count; i++)
            result.push(list.get_Item(i));
    return result;
}
function componentPropertyDescription(component, p) {
    const result = { target: String(p.target), propertyId: Number(p.propertyId), label: String(p.label || ""), value: safeValue(p.value), overridden: p.value !== null && p.value !== undefined };
    try {
        result.effectiveValue = safeValue(componentPropertyObject(component, p.target, p.propertyId).GetProp(p.propertyId));
    }
    catch (error) {
        result.resolutionError = { code: error.code, message: String(error) };
    }
    return result;
}
function componentInstanceTarget(params) {
    const obj = editingTarget(params);
    if (!obj.controllers || !obj.customProperties || !obj.resourceURL)
        verificationError("wrong_object_type", "目标必须为当前文档直属的组件资源实例", {});
    return obj;
}
function componentInstanceSnapshot(obj) {
    const properties = componentPropertyList(obj);
    return { resourceURL: String(obj.resourceURL), controllers: controllerList({ content: obj }).map(c => {
            const p = properties.filter(p => p.propertyId === -1 && p.target === c.name);
            return { ...controllerSnapshot(c), overridden: p.length === 1 && p[0].value !== null && p[0].value !== undefined,
                overridePageId: p.length === 1 ? safeValue(p[0].value) : null };
        }), properties: properties.filter(p => p.propertyId >= 0).map(p => componentPropertyDescription(obj, p)) };
}
/** 定义使用根组件 Write_editMode；实例 Write 只包含实例配置，不能验证组件定义。 */
function editComponentMetadata(doc, obj, params, read, changed, apply) {
    if (params.save !== undefined && typeof params.save !== "boolean")
        throw new Error("save 必须是布尔值");
    const before = read();
    if (changed) {
        invalidateUntrackedHistory(doc);
        try {
            apply();
            doc.SetModified(true);
            doc.RefreshInspectors();
        }
        catch (error) {
            doc.SetModified(true);
            verificationError("editor_rejected", String(error), { before, after: read(), mutationMayHaveOccurred: true, rollbackAttempted: false });
        }
    }
    let saved = false, persisted = false;
    if (params.save === true) {
        try {
            const Xml = CS.FairyGUI.Utils.XML, expected = gearXmlData(new Xml(editorDocumentSnapshot(doc)));
            doc.Save();
            if (doc.isModified)
                throw new Error("保存后组件仍有未保存修改");
            saved = true;
            if (!valuesEqual(expected, gearXmlData(componentXmlNode(doc, doc.content))))
                throw new Error("磁盘 XML 与组件完整原生快照不一致");
            persisted = true;
            clearAgentHistory();
            untrackedDocumentVersions.delete(doc);
        }
        catch (error) {
            verificationError("persistence_failed", String(error), { before, after: read(), saved, persisted: false, mutationMayHaveOccurred: changed, rollbackAttempted: false });
        }
    }
    return { target: targetSummary(obj, params.target), before, after: read(), changed, saved, persisted,
        documentModified: Boolean(doc.isModified), agentUndoSupported: false,
        note: "实例只写父文档覆盖值；定义只写当前根组件。save=true 保存整个当前组件，失败不自动回滚。" };
}
function getComponentInstance(params) {
    const obj = componentInstanceTarget(params);
    return { target: targetSummary(obj, params.target), ...componentInstanceSnapshot(obj) };
}
function instanceProperty(obj, path, propertyId) {
    const matches = componentPropertyList(obj).filter(p => p.target === path && p.propertyId === propertyId);
    if (matches.length !== 1)
        verificationError(matches.length ? "ambiguous_property" : "property_not_exposed", "实例属性不存在、不唯一或未在源组件中导出", { childPath: path, propertyId });
    return matches[0];
}
function setComponentInstanceController(params) {
    const doc = getActiveDocument(), obj = componentInstanceTarget(params), c = resolveController({ content: obj }, params.controllerName);
    if (!c.exported)
        verificationError("controller_not_exposed", "请先在源组件中将控制器导出为组件属性", { controllerName: c.name });
    const page = resolveControllerPage(c, params), p = instanceProperty(obj, String(c.name), -1);
    const changed = p.value !== page.id || String(c.selectedPageId) !== page.id;
    return editComponentMetadata(doc, obj, params, () => componentInstanceSnapshot(obj), changed, () => {
        // 只切 selectedIndex 不会写入实例 controller 属性；必须同时更新原生 ComProperty。
        p.value = page.id;
        obj.ApplyCustomProperty(p);
        if (String(c.selectedPageId) !== page.id || p.value !== page.id)
            throw new Error("实例控制器被 Gear/联动重定向，未停留在目标页");
    });
}
function setComponentInstanceProperty(params) {
    const doc = getActiveDocument(), obj = componentInstanceTarget(params), field = componentPropertyObject(obj, params.childPath, params.propertyId);
    const p = instanceProperty(obj, params.childPath, params.propertyId);
    // Native ApplyCustomProperty(null) removes XML override but does not restore the visible value; reject it rather than claim reset.
    if (typeof params.value !== "string")
        verificationError("invalid_argument", "value 必须为字符串（允许空串）；本接口不以 null 清除覆盖", {});
    const changed = p.value !== params.value || field.GetProp(params.propertyId) !== params.value;
    return editComponentMetadata(doc, obj, params, () => componentInstanceSnapshot(obj), changed, () => {
        p.value = params.value;
        obj.ApplyCustomProperty(p);
        if (field.GetProp(params.propertyId) !== params.value || p.value !== params.value)
            throw new Error("Editor 未接受实例属性值");
    });
}
function componentPropertyDefinitions(component) {
    return componentPropertyList(component).filter(p => p.propertyId >= 0).map(p => ({ target: String(p.target), propertyId: Number(p.propertyId), label: String(p.label || "") }));
}
function getComponentProperties() {
    const doc = getActiveDocument();
    return { documentUrl: doc.content.resourceURL, properties: componentPropertyDefinitions(doc.content) };
}
function editComponentProperty(params, remove) {
    const doc = getActiveDocument(), root = doc.content;
    if (params.propertyId !== 0 && params.propertyId !== 1)
        verificationError("unsupported_property", "propertyId 只支持文本 0 / 图标 1", {});
    if (typeof params.childPath !== "string" || !params.childPath)
        throw new Error("childPath 不能为空");
    if (!remove)
        componentPropertyObject(root, params.childPath, params.propertyId);
    if (params.label !== undefined && typeof params.label !== "string")
        throw new Error("label 必须为字符串");
    const matches = componentPropertyList(root).filter(p => p.target === params.childPath && p.propertyId === params.propertyId);
    if (matches.length > 1)
        verificationError("ambiguous_property", "存在重复的组件自定义属性定义", {});
    const existing = matches[0], label = params.label === undefined ? String(existing && existing.label || "") : params.label;
    const changed = remove ? Boolean(existing) : !existing || String(existing.label || "") !== label;
    return editComponentMetadata(doc, root, params, () => componentPropertyDefinitions(root), changed, () => {
        if (remove)
            root.customProperties.Remove(existing);
        else if (existing)
            existing.label = label;
        else {
            const p = new FairyEditor.ComProperty();
            p.target = params.childPath;
            p.propertyId = params.propertyId;
            p.label = label;
            root.customProperties.Add(p);
        }
        const found = componentPropertyDefinitions(root).filter(p => p.target === params.childPath && p.propertyId === params.propertyId);
        if (remove ? found.length !== 0 : found.length !== 1 || found[0].label !== label)
            throw new Error("Editor 未接受组件自定义属性定义");
    });
}
function setControllerProperties(params) {
    const doc = getActiveDocument(), c = resolveController(doc, params.controllerName);
    const patch = checkedSettings(params.settings, { exported: "boolean", alias: "string" }), before = controllerSnapshot(c);
    const changed = Object.keys(patch).some(k => before[k] !== patch[k]);
    return editComponentMetadata(doc, doc.content, params, () => controllerSnapshot(c), changed, () => {
        for (const key of Object.keys(patch))
            c[key] = patch[key];
        const after = controllerSnapshot(c);
        if (Object.keys(patch).some(k => after[k] !== patch[k]))
            throw new Error("Editor 未接受控制器导出设置");
    });
}
/** Action 没有稳定 ID；索引按原生执行顺序返回，增删后应重新读取。 */
function controllerActionList(c) {
    const result = [], list = c.GetActions();
    for (let i = 0; i < list.Count; i++)
        result.push(list.get_Item(i));
    return result;
}
function controllerActionSnapshot(action, index) {
    const xml = action.Write(), attr = (key) => String(xml.GetAttribute(key) || "");
    const result = { index, type: String(action.type), fromPageIds: attr("fromPage").split(",").filter(Boolean),
        toPageIds: attr("toPage").split(",").filter(Boolean), xml: String(xml.ToXMLString(false)) };
    if (result.type === "change_page")
        Object.assign(result, { objectId: attr("objectId"), controllerName: attr("controller"), targetPageId: attr("targetPage") });
    if (result.type === "play_transition")
        Object.assign(result, { transitionName: attr("transition"), repeat: Number(action.repeat), delay: Number(action.delay), stopOnExit: Boolean(action.stopOnExit) });
    return result;
}
/** 只列当前组件与直属子组件，调用者可据此获得联动目标的稳定页面 ID。 */
function getControllerActions(params) {
    const doc = getActiveDocument(), c = resolveController(doc, params.controllerName), targets = [];
    const add = (obj, objectId) => targets.push({ objectId, name: String(obj.name || ""), controllers: controllerList({ content: obj }).map(controllerSnapshot) });
    add(doc.content, "");
    for (let i = 0; i < doc.content.numChildren; i++) {
        const child = doc.content.GetChildAt(i);
        // Button/List 等扩展组件也可有控制器，不能只按 objectType="component" 过滤。
        if (typeof child.numChildren === "number" && child.controllers)
            add(child, String(child.id));
    }
    return { documentUrl: doc.content.resourceURL, controller: controllerSnapshot(c), actions: controllerActionList(c).map(controllerActionSnapshot), targets };
}
function buildControllerAction(doc, c, value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        verificationError("invalid_argument", "action 必须是配置对象", {});
    const common = ["type", "fromPageIds", "toPageIds"], change = ["objectId", "controllerName", "targetPageId"], play = ["transitionName", "repeat", "delay", "stopOnExit"];
    if (!["change_page", "play_transition"].includes(value.type))
        verificationError("invalid_argument", "仅支持 change_page/play_transition", {});
    if (Object.keys(value).some(key => !common.concat(value.type === "change_page" ? change : play).includes(key)))
        verificationError("invalid_argument", "action 含未知字段或混用了两种类型的字段", {});
    const xml = CS.FairyGUI.Utils.XML.Create("action");
    xml.SetAttribute("type", value.type);
    for (const key of ["fromPageIds", "toPageIds"]) {
        const ids = value[key] === undefined ? [] : value[key];
        if (!Array.isArray(ids) || ids.some(id => typeof id !== "string") || new Set(ids).size !== ids.length)
            verificationError("invalid_argument", "页面条件必须是不重复的页面 ID 数组；空数组匹配任意页", { key });
        ids.forEach(id => resolveControllerPage(c, { pageId: id }));
        xml.SetAttribute(key === "fromPageIds" ? "fromPage" : "toPage", ids.join(","));
    }
    if (value.type === "change_page") {
        const objectId = value.objectId === undefined ? "" : value.objectId;
        if (typeof objectId !== "string")
            verificationError("invalid_argument", "objectId 必须是直属子组件 ID 或空字符串", {});
        let component = doc.content;
        if (objectId) {
            component = null;
            for (let i = 0; i < doc.content.numChildren; i++) {
                const child = doc.content.GetChildAt(i);
                if (String(child.id) === objectId && typeof child.numChildren === "number" && child.controllers)
                    component = child;
            }
            if (!component)
                verificationError("invalid_target", "联动目标必须是当前组件或直属子组件", { objectId });
        }
        const target = resolveController({ content: component }, value.controllerName);
        resolveControllerPage(target, { pageId: value.targetPageId });
        // 原生 changing 标记可抑制部分递归，但循环仍会导致页结果依赖执行顺序；新增配置拒绝构成回环。
        const visited = [];
        const reachesSource = (current) => {
            if (current === c)
                return true;
            if (visited.indexOf(current) >= 0)
                return false;
            visited.push(current);
            return controllerActionList(current).some(a => {
                if (String(a.type) !== "change_page")
                    return false;
                const next = a.GetControllerObj(current.parent);
                return next ? reachesSource(next) : false;
            });
        };
        if (reachesSource(target))
            verificationError("controller_cycle", "该联动会形成控制器自引用或循环", {});
        xml.SetAttribute("objectId", objectId);
        xml.SetAttribute("controller", value.controllerName);
        xml.SetAttribute("targetPage", value.targetPageId);
    }
    else {
        resolveTransition(doc, value.transitionName);
        const repeat = value.repeat === undefined ? 1 : value.repeat, delay = value.delay === undefined ? 0 : value.delay;
        if (!Number.isInteger(repeat) || repeat < -1 || repeat === 0 || repeat > 2147483647 || typeof delay !== "number" || !Number.isFinite(delay) || delay < 0 || delay > 86400
            || (value.stopOnExit !== undefined && typeof value.stopOnExit !== "boolean"))
            verificationError("invalid_argument", "repeat 为正整数或 -1（循环），delay 为 0..86400 秒，stopOnExit 为布尔值", {});
        xml.SetAttribute("transition", value.transitionName);
        xml.SetAttribute("repeat", String(repeat));
        xml.SetAttribute("delay", String(delay));
        xml.SetAttribute("stopOnExit", value.stopOnExit === true ? "true" : "false");
    }
    // 在脱离文档的原生对象上解析，避免格式错误导致已有 Action 被部分改写。
    const candidate = new FairyEditor.FControllerAction();
    candidate.Read(xml);
    return candidate;
}
/** 完整替换指定 Action；保留其他 Action（含未知类型）、Controller 页面和 Gear。 */
function editControllerAction(operation, params) {
    const doc = getActiveDocument(), c = resolveController(doc, params.controllerName), actions = controllerActionList(c);
    if (params.save !== undefined && typeof params.save !== "boolean")
        verificationError("invalid_argument", "save 必须是布尔值", {});
    const removing = operation === "remove_controller_action", index = params.actionIndex;
    const updating = index !== undefined && index !== null;
    if ((removing && !updating) || (updating && (!Number.isInteger(index) || index < 0 || index >= actions.length)))
        verificationError("invalid_argument", "actionIndex 必须指向已有联动；追加时省略", {});
    const candidate = removing ? null : buildControllerAction(doc, c, params.action);
    const before = actions.map(controllerActionSnapshot), expected = actions.map(a => gearXmlData(a.Write()));
    if (removing)
        expected.splice(index, 1);
    else if (updating)
        expected[index] = gearXmlData(candidate.Write());
    else
        expected.push(gearXmlData(candidate.Write()));
    const changed = !valuesEqual(actions.map(a => gearXmlData(a.Write())), expected);
    const controllerBefore = controllerSnapshot(c);
    if (changed) {
        invalidateUntrackedHistory(doc);
        try {
            if (removing)
                c.RemoveAction(actions[index]);
            else {
                const target = c.AddAction(String(candidate.type));
                // 不调用 RunActions/ApplyController：配置编辑本身不能播放动画或切换其它控制器。
                // 原生 Read 会保留旧对象中被 XML 省略的字段（例如空 fromPage），必须用新对象替换。
                target.Read(candidate.Write());
                if (updating) {
                    c.SwapAction(index, actions.length);
                    c.RemoveAction(actions[index]);
                }
            }
            if (!valuesEqual(controllerActionList(c).map(a => gearXmlData(a.Write())), expected) || !valuesEqual(controllerSnapshot(c), controllerBefore))
                throw new Error("Editor 联动配置回读不符或意外改变控制器页面");
            doc.SetModified(true);
            doc.RefreshInspectors();
        }
        catch (error) {
            let after = null;
            try {
                after = controllerActionList(c).map(controllerActionSnapshot);
            }
            catch (_) { /* 读取失败时不能伪造旧状态。 */ }
            verificationError("editor_rejected", String(error), { before, after, mutationMayHaveOccurred: true, rollbackAttempted: false });
        }
    }
    const result = finishControllerWrite(doc, c, controllerBefore, params, changed);
    return { ...result, controllerName: String(c.name), before, after: controllerActionList(c).map(controllerActionSnapshot),
        actionIndex: removing ? null : updating ? index : actions.length,
        note: "联动按数组顺序执行；配置编辑不触发联动，切页才执行。索引可能随增删变化，请重新读取。save 保存整个组件，不修改子组件资源。" };
}
function captureDocument(params, requestId) {
    let texture = null;
    let refreshStage = false;
    const previousContext = CS.FairyGUI.UpdateContext.current;
    try {
        const doc = getActiveDocument();
        const url = doc.content.resourceURL;
        if (params.expectedDocumentUrl && params.expectedDocumentUrl !== url)
            throw new Error("活动文档与预期不符");
        const scale = params.scale === undefined ? 1 : params.scale;
        const width = Math.ceil(doc.content.width * scale), height = Math.ceil(doc.content.height * scale);
        if (typeof scale !== "number" || !Number.isFinite(scale) || !Number.isFinite(width) || !Number.isFinite(height) || scale <= 0 || scale > 4 || width <= 0 || height <= 0 || width > 4096 || height > 4096 || width * height > 8388608)
            throw new Error("截图尺寸超过限制：scale <= 4，单边 <= 4096，总像素 <= 8388608");
        if (CS.FairyGUI.UpdateContext.working)
            throw new Error("Editor 正在渲染，请稍后重试截图");
        // 6.1.4 的 GetScreenShot 不重建 2D 材质裁剪：直接截图会保留 Editor 视口裁剪，
        // 而 Spine 仍可见。独立上下文保留组件自身 mask，去掉外层 Editor 的裁剪状态。
        const context = new CS.FairyGUI.UpdateContext();
        refreshStage = true;
        context.Begin();
        try {
            doc.content.displayObject.Update(context);
        }
        finally {
            context.End();
        }
        texture = doc.content.displayObject.GetScreenShot(null, scale);
        if (!texture || texture.width <= 0 || texture.height <= 0 || texture.width > 4096 || texture.height > 4096 || texture.width * texture.height > 8388608)
            throw new Error("截图未返回有效尺寸");
        const bytes = UnityEngine.ImageConversion.EncodeToPNG(texture);
        if (!bytes || bytes.Length < 24 || bytes.Length > 16777216)
            throw new Error("PNG 编码为空或超过 16 MiB");
        const signature = [137, 80, 78, 71, 13, 10, 26, 10];
        for (let i = 0; i < signature.length; i++)
            if (Number(bytes.GetValue(i)) !== signature[i])
                throw new Error("PNG 签名无效");
        const folder = IOPath.Combine(queueRoot, "captures");
        ensureDirectory(folder);
        // 仅清理超过一天的本工具截图，给尚未消费图像的客户端留下读取时间。
        const old = IODirectory.GetFiles(folder, "*.png");
        for (let i = 0; i < old.Length; i++) {
            const path = String(old.GetValue(i));
            if (!/^capture-[a-zA-Z0-9_-]+\.png$/.test(IOPath.GetFileName(path)))
                continue;
            try {
                if (Number(IOFile.GetLastWriteTimeUtc(path).Ticks) / 10000 - DOTNET_EPOCH_TICKS < Date.now() - 86400000)
                    IOFile.Delete(path);
            }
            catch (_) { /* 清理失败不影响本次截图。 */ }
        }
        const name = `capture-${safeRequestId(requestId)}.png`;
        IOFile.WriteAllBytes(IOPath.Combine(folder, name), bytes);
        const hasSpine = (obj) => {
            if (String(obj.objectType).toLowerCase() === "loader3d" && obj.url) {
                const item = App.project.GetItemByURL(obj.url);
                if (item && item.type === FairyEditor.FPackageItemType.SPINE)
                    return true;
            }
            for (let i = 0; i < (obj.numChildren || 0); i++)
                if (hasSpine(obj.GetChildAt(i)))
                    return true;
            return false;
        };
        return { path: `captures/${name}`, width: texture.width, height: texture.height, documentUrl: url,
            captureMode: "component", spinePresentInTree: hasSpine(doc.content), spineCaptureSupported: String(UnityEngine.Application.version) === "6.1.4" ? true : null,
            spineCaptured: null, visualVerificationStatus: "pending_review", mutationPerformed: false };
    }
    catch (error) {
        return { visualVerificationStatus: "manual_required", reason: String(error), mutationPerformed: false,
            instruction: "未取得可验证图像。请在 FairyGUI Editor 自行检查资源、布局、遮挡、皮肤与可见性；已完成修改保留，不自动回滚。" };
    }
    finally {
        try {
            if (texture)
                UnityEngine.Object.Destroy(texture);
        }
        finally {
            if (refreshStage) {
                CS.FairyGUI.UpdateContext.current = previousContext;
                // 恢复 Editor 画布的材质裁剪和渲染顺序，不修改/保存文档属性。
                try {
                    CS.FairyGUI.Stage.inst.ForceUpdate();
                }
                catch (error) {
                    appendLog(`capture stage refresh: ${error}`);
                }
            }
        }
    }
}
function nowIso() {
    return new Date().toISOString();
}
function appendLog(message) {
    try {
        if (!logFile)
            return;
        IOFile.AppendAllText(logFile, `[${nowIso()}] ${message}\n`);
    }
    catch (_) {
        // 日志失败不能阻断桥接命令。
    }
}
function ensureDirectory(path) {
    if (!IODirectory.Exists(path))
        IODirectory.CreateDirectory(path);
}
function initializeBridge() {
    if (!App.project || !App.project.opened)
        return false;
    const nextQueueRoot = IOPath.Combine(App.project.basePath, ".agent");
    if (initialized && queueRoot === nextQueueRoot)
        return true;
    if (initialized)
        writeOfflineStatus();
    queueRoot = nextQueueRoot;
    logFile = IOPath.Combine(queueRoot, "bridge.log");
    ensureDirectory(queueRoot);
    if (!editorIdentity) {
        let editorPid = null;
        try {
            const process = CS.System.Diagnostics.Process.GetCurrentProcess();
            try {
                editorPid = Number(process.Id);
                // 保留 100ns 精度的 UTC 文本；Int64 转 JS Number 会丢失启动时间精度。
                editorIdentity = { pid: process.Id, startedAt: process.StartTime.ToUniversalTime().ToString("yyyyMMddHHmmssfffffff") };
            }
            finally {
                process.Dispose();
            }
        }
        catch (error) {
            // IL2CPP 支持当前 PID，但不支持 Process.StartTime；仅将已知 PID 交给隐藏探针查询。
            // Puerts 将 .NET char 映射为数字；客户端仍独立核对真实 exe、启动时间及当前工程。
            try {
                if ((String(IOPath.DirectorySeparatorChar) !== "\\" && Number(IOPath.DirectorySeparatorChar) !== 92) || !Number.isInteger(editorPid) || editorPid <= 0)
                    throw error;
                const probe = IOPath.Combine(App.project.basePath, "plugins", "agent-bridge", "windows-process-identity.ps1");
                const output = IOPath.Combine(queueRoot, `process-probe-${editorPid}-${Date.now()}.json`);
                let identity;
                try {
                    // ProcessUtil.Start 在当前编辑器不返回 stdout；使用专用临时文件传回结果。
                    FairyEditor.ProcessUtil.Start("powershell.exe", toCsStringArray(["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", probe, "-EditorProcessId", String(editorPid), "-OutputPath", output]), App.project.basePath, true);
                    identity = JSON.parse(IOFile.ReadAllText(output));
                }
                finally {
                    if (IOFile.Exists(output))
                        IOFile.Delete(output);
                }
                if (identity.pid !== editorPid || !/^\d{21}$/.test(identity.startedAt))
                    throw new Error("身份探针返回无效 PID 或启动时间");
                editorIdentity = identity;
                editorIdentityError = null;
            }
            catch (probeError) {
                editorIdentityError = `native: ${error}; probe: ${probeError}`;
                appendLog(`process identity unavailable: ${editorIdentityError}`);
            }
        }
    }
    const instanceRoot = editorIdentity ? IOPath.Combine(queueRoot, "instances", `${editorIdentity.pid}-${editorIdentity.startedAt}`) : queueRoot;
    requestFolder = IOPath.Combine(instanceRoot, "requests");
    processingFolder = IOPath.Combine(instanceRoot, "processing");
    responseFolder = IOPath.Combine(instanceRoot, "responses");
    statusFile = IOPath.Combine(queueRoot, "status.json");
    instanceStatusFile = IOPath.Combine(instanceRoot, "status.json");
    logFile = IOPath.Combine(queueRoot, "bridge.log");
    ensureDirectory(queueRoot);
    ensureDirectory(requestFolder);
    ensureDirectory(processingFolder);
    ensureDirectory(responseFolder);
    sweepStaleQueueFiles();
    initialized = true;
    appendLog(`bridge initialized: ${App.project.basePath}`);
    writeStatus();
    App.consoleView.Log(`[FGUI Agent Bridge] 已启动，队列目录：${queueRoot}`);
    return true;
}
function writeJsonAtomic(path, data) {
    const tempPath = `${path}.${editorIdentity ? editorIdentity.pid : "legacy"}.tmp`;
    IOFile.WriteAllText(tempPath, JSON.stringify(data, null, 2));
    if (IOFile.Exists(path))
        IOFile.Delete(path);
    IOFile.Move(tempPath, path);
}
function isStaleFile(path) {
    try {
        const ticks = Number(IOFile.GetLastWriteTimeUtc(path).Ticks);
        return ticks < (Date.now() - REQUEST_MAX_AGE_MS + DOTNET_EPOCH_TICKS) * 10000;
    }
    catch (_) {
        return false;
    }
}
function sweepStaleQueueFiles() {
    const folders = [requestFolder, processingFolder, responseFolder];
    for (const folder of folders) {
        try {
            const files = IODirectory.GetFiles(folder, "*.json");
            for (let i = 0; i < files.Length; i++) {
                const path = String(files.GetValue(i));
                if (isStaleFile(path))
                    IOFile.Delete(path);
            }
        }
        catch (_) { /* 清理失败不阻断桥接初始化。 */ }
    }
}
function writeStatus() {
    if (!initialized || !App.project || !App.project.opened)
        return;
    const activeDoc = App.activeDoc;
    const status = {
        online: true,
        editorProcessId: editorIdentity ? editorIdentity.pid : null,
        editorProcessStartedAt: editorIdentity ? editorIdentity.startedAt : null,
        editorIdentityError,
        bridgeVersion: BRIDGE_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        publishInProgress,
        timestamp: nowIso(),
        project: {
            id: App.project.id,
            name: App.project.name,
            basePath: App.project.basePath,
            type: App.project.type
        },
        activeDocument: activeDoc ? describeDocument(activeDoc) : null,
        capabilities: [
            "ping",
            "get_project",
            "list_packages",
            "list_items",
            "open_document",
            "create_component",
            "import_image",
            "import_font",
            "create_button",
            "import_sound",
            "create_movieclip",
            "get_movieclip",
            "update_movieclip",
            "remove_movieclip",
            "list_transitions",
            "get_transition",
            "upsert_transition",
            "remove_transition",
            "add_transition_item",
            "update_transition_item",
            "remove_transition_item",
            "preview_animation",
            "get_active_document",
            "get_tree",
            "select_object",
            "set_property",
            "insert_object",
            "remove_object",
            "save_document",
            "save_all",
            "get_publish_settings",
            "publish",
            "get_history",
            "discard_document",
            "undo",
            "redo",
            "verify_document", "replace_object_resource", "get_text_style", "set_text_style",
            "get_loader3d", "set_loader3d", "capture_document", "fix_spine_anchor",
            "get_gears", "set_gear", "get_controller_actions", "upsert_controller_action", "remove_controller_action",
            "get_controllers", "create_controller", "add_controller_page", "rename_controller_page", "set_controller_page",
            "apply_batch", "get_batch_result", "get_objects", "capture_states", "begin_external_edit", "finish_external_edit",
            "get_component_instance", "set_component_instance_controller", "set_component_instance_property", "get_component_properties",
            "upsert_component_property", "remove_component_property", "set_controller_properties",
            "get_image_settings", "set_image_settings", "create_object", "set_properties", "get_button_binding", "set_button_binding",
            "get_list_settings", "set_list_settings", "get_scroll_settings", "set_scroll_settings", "get_group", "set_group",
            "get_relations", "add_relation", "remove_relation", "get_loader", "set_loader"
        ]
    };
    // 每个实例独立写入心跳和队列；旧窗口不能覆盖目标实例的身份或抢走指令。
    writeJsonAtomic(instanceStatusFile, status);
    if (instanceStatusFile !== statusFile) {
        try {
            writeJsonAtomic(statusFile, status);
        }
        catch (_) { /* 根目录状态仅供排障；多个实例的诊断快照竞争不影响实例队列。 */ }
    }
    lastStatusWrittenMs = Date.now();
}
function writeOfflineStatus() {
    if (!initialized || !IOFile.Exists(instanceStatusFile))
        return;
    const previous = JSON.parse(IOFile.ReadAllText(instanceStatusFile));
    previous.online = false;
    previous.timestamp = nowIso();
    writeJsonAtomic(instanceStatusFile, previous);
    if (instanceStatusFile !== statusFile) {
        try {
            const diagnostic = JSON.parse(IOFile.ReadAllText(statusFile));
            if (editorIdentity && diagnostic.editorProcessId === editorIdentity.pid)
                writeJsonAtomic(statusFile, previous);
        }
        catch (_) { /* 不覆盖其他实例的诊断状态。 */ }
    }
}
function describeProject() {
    const project = App.project;
    if (!project || !project.opened)
        throw new Error("FairyGUI 工程尚未打开");
    return {
        id: project.id,
        name: project.name,
        type: project.type,
        versionCode: project.versionCode,
        basePath: project.basePath,
        assetsPath: project.assetsPath,
        settingsPath: project.settingsPath,
        activeBranch: project.activeBranch,
        packageCount: project.allPackages.Count
    };
}
function describePackage(pkg) {
    return {
        id: pkg.id,
        name: pkg.name,
        basePath: pkg.basePath,
        opened: pkg.opened,
        itemCount: pkg.items.Count
    };
}
const LARGE_IMAGE_LONG_SIDE_MIN = 1920;
const LARGE_IMAGE_SHORT_SIDE_MIN = 1080;
const LARGE_IMAGE_2K_SIDE_MIN = 2048;
const LARGE_IMAGE_ATLAS = "alone";
function isLargeImageDimensions(width, height) {
    const normalizedWidth = Number(width);
    const normalizedHeight = Number(height);
    if (!isFinite(normalizedWidth) || !isFinite(normalizedHeight) || normalizedWidth <= 0 || normalizedHeight <= 0)
        return false;
    const longSide = Math.max(normalizedWidth, normalizedHeight);
    const shortSide = Math.min(normalizedWidth, normalizedHeight);
    // 覆盖 1920x1080 及以上屏幕大图，或任一边达到 2K（2048）的纹理。
    return (longSide >= LARGE_IMAGE_LONG_SIDE_MIN && shortSide >= LARGE_IMAGE_SHORT_SIDE_MIN)
        || longSide >= LARGE_IMAGE_2K_SIDE_MIN;
}
function applyLargeImageAtlasRule(item) {
    if (!item || item.type !== FairyEditor.FPackageItemType.IMAGE || !isLargeImageDimensions(item.width, item.height))
        return false;
    if (String(item.folderAtlas || "") === LARGE_IMAGE_ATLAS)
        return false;
    // FairyGUI 的 alone 纹理集会为每张图片单独生成图集，不会与小图混排。
    item.folderAtlas = LARGE_IMAGE_ATLAS;
    item.SetChanged();
    return true;
}
function describeItem(item) {
    return {
        id: item.id,
        name: item.name,
        title: item.title,
        type: item.type,
        path: item.path,
        file: item.file,
        width: item.width,
        height: item.height,
        exported: item.exported,
        folderAtlas: item.folderAtlas || "",
        url: item.GetURL()
    };
}
function describeDocument(doc) {
    return {
        url: doc.docURL,
        title: doc.displayTitle,
        itemId: doc.packageItem ? doc.packageItem.id : null,
        itemName: doc.packageItem ? doc.packageItem.name : null,
        packageName: doc.packageItem && doc.packageItem.owner ? doc.packageItem.owner.name : null,
        modified: doc.isModified,
        savedVersion: doc.savedVersion,
        selectionCount: doc.GetSelection().Count,
        transitionCount: doc.content && doc.content.transitions ? doc.content.transitions.items.Count : 0,
        transitions: summarizeTransitions(doc)
    };
}
function safeRequestId(value) {
    const sanitized = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
    return sanitized || `request-${Date.now()}`;
}
function safeValue(value) {
    if (value === null || value === undefined)
        return null;
    const valueType = typeof value;
    if (valueType === "string" || valueType === "number" || valueType === "boolean")
        return value;
    try {
        return String(value);
    }
    catch (_) {
        return null;
    }
}
function describeObject(obj, depth, maxDepth) {
    const result = {
        id: obj.id,
        name: obj.name,
        type: obj.objectType,
        resourceURL: obj.resourceURL || null,
        x: obj.x,
        y: obj.y,
        width: obj.width,
        height: obj.height,
        scaleX: obj.scaleX,
        scaleY: obj.scaleY,
        rotation: obj.rotation,
        alpha: obj.alpha,
        visible: obj.visible,
        touchable: obj.touchable,
        grayed: obj.grayed,
        enabled: obj.enabled,
        locked: obj.locked,
        text: obj.text || "",
        icon: obj.icon || ""
    };
    if (String(obj.objectType) === FairyEditor.FObjectType.MOVIECLIP) {
        const movieClip = obj;
        result.playing = Boolean(movieClip.playing);
        result.frame = Number(movieClip.frame);
        result.frameCount = movieClip.frameCount === undefined ? null : Number(movieClip.frameCount);
        if ((result.frameCount === null || !Number.isFinite(result.frameCount)) && obj.resourceURL) {
            try {
                const resource = resolveItem({ url: obj.resourceURL });
                const asset = resource.GetAsset();
                if (asset && asset.animation)
                    result.frameCount = Number(asset.animation.frameCount);
            }
            catch (_) { /* 资源尚未加载时保留 null。 */ }
        }
        result.color = movieClip.color ? colorToValue(movieClip.color) : null;
    }
    if (String(obj.objectType).toLowerCase() === "loader3d")
        Object.assign(result, loader3dValues(obj));
    const component = obj;
    if (typeof component.numChildren === "number")
        result.opaque = component.opaque;
    if (depth < maxDepth && typeof component.numChildren === "number") {
        const children = [];
        for (let i = 0; i < component.numChildren; i++)
            children.push(describeObject(component.GetChildAt(i), depth + 1, maxDepth));
        result.children = children;
    }
    else if (typeof component.numChildren === "number") {
        result.childCount = component.numChildren;
    }
    return result;
}
function getActiveDocument() {
    const doc = App.activeDoc;
    if (!doc)
        throw new Error("当前没有打开的 FairyGUI 文档");
    return doc;
}
function resolvePackage(params) {
    const project = App.project;
    let pkg = null;
    if (params && params.packageId)
        pkg = project.GetPackage(String(params.packageId));
    if (!pkg && params && params.packageName)
        pkg = project.GetPackageByName(String(params.packageName));
    if (!pkg)
        throw new Error("未找到指定 FairyGUI 包，请提供 packageId 或 packageName");
    pkg.EnsureOpen();
    return pkg;
}
function resolveItem(params) {
    const project = App.project;
    let item = null;
    if (params && params.url)
        item = project.GetItemByURL(String(params.url));
    if (!item && params && params.packageId && params.itemId)
        item = project.GetItem(String(params.packageId), String(params.itemId));
    if (!item && params && params.packageName) {
        const pkg = project.GetPackageByName(String(params.packageName));
        if (pkg) {
            pkg.EnsureOpen();
            if (params.itemId)
                item = pkg.GetItem(String(params.itemId));
            else if (params.itemPath)
                item = pkg.GetItemByPath(String(params.itemPath));
            else if (params.itemName)
                item = pkg.FindItemByName(String(params.itemName));
        }
    }
    if (!item)
        throw new Error("未找到指定 FairyGUI 资源，请提供 url，或 packageName 与 itemName/itemPath");
    return item;
}
function normalizePackagePath(value) {
    const raw = String(value || "").trim().replace(/\\/g, "/");
    const normalized = raw.replace(/^\/+|\/+$/g, "");
    if (!normalized)
        return "/";
    const parts = normalized.split("/");
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i].trim();
        if (!part || part === "." || part === "..")
            throw new Error(`无效的包内目录：${raw}`);
        if (/[\u0000-\u001f:*?"<>|]/.test(part))
            throw new Error(`包内目录包含非法字符：${part}`);
        parts[i] = part;
    }
    return `/${parts.join("/")}/`;
}
function validateResourceName(value, label) {
    const name = String(value || "").trim();
    if (!name)
        throw new Error(`${label}不能为空`);
    if (name === "." || name === ".." || /[\\/:*?"<>|\u0000-\u001f]/.test(name))
        throw new Error(`${label}包含非法字符：${name}`);
    return name;
}
function validateSize(value, fallback, label) {
    const numberValue = value === undefined || value === null ? fallback : Number(value);
    if (!Number.isFinite(numberValue) || numberValue <= 0 || numberValue > 32768)
        throw new Error(`${label}必须大于 0 且不超过 32768`);
    return numberValue;
}
function resolvePackageFolder(pkg, pathValue, createIfMissing) {
    pkg.EnsureOpen();
    const path = normalizePackagePath(pathValue);
    if (path === "/")
        return pkg.rootItem;
    let folder = pkg.GetItemByPath(path);
    if (!folder && createIfMissing)
        folder = pkg.EnsurePathExists(path, true);
    if (!folder)
        throw new Error(`包 ${pkg.name} 中不存在目录：${path}`);
    if (folder.type !== FairyEditor.FPackageItemType.FOLDER)
        throw new Error(`包内路径不是目录：${path}`);
    return folder;
}
function findItemInFolder(pkg, folder, name) {
    return pkg.GetItemByName(folder, name);
}
function resolveNewItemName(pkg, folder, requestedName, autoRename) {
    if (!findItemInFolder(pkg, folder, requestedName))
        return requestedName;
    if (!autoRename)
        throw new Error(`资源已存在：${requestedName}`);
    for (let index = 1; index <= 9999; index++) {
        const candidate = `${requestedName}_${index}`;
        if (!findItemInFolder(pkg, folder, candidate))
            return candidate;
    }
    throw new Error(`无法为资源生成唯一名称：${requestedName}`);
}
function toCsStringArray(values) {
    const result = CS.System.Array.CreateInstance(puerts.$typeof(CS.System.String), values.length);
    for (let i = 0; i < values.length; i++)
        result.SetValue(values[i], i);
    return result;
}
function markPackageChanged(pkg) {
    pkg.SetChanged();
    App.project.SetChanged();
    clearAgentHistory();
    writeStatus();
}
function describeCreatedItem(item, operation, requestedName, folderPath, document = null) {
    return {
        operation,
        requestedName,
        actualName: item.name,
        autoRenamed: item.name !== requestedName,
        folderPath,
        item: describeItem(item),
        document: document ? describeDocument(document) : null,
        packageModified: true,
        requiresSave: true
    };
}
function createComponent(params) {
    const pkg = resolvePackage(params);
    const requestedName = validateResourceName(params.componentName, "componentName");
    const folderPath = normalizePackagePath(params.folderPath);
    const folder = resolvePackageFolder(pkg, folderPath, params.createFolders !== false);
    const actualName = resolveNewItemName(pkg, folder, requestedName, params.autoRename === true);
    const width = validateSize(params.width, 800, "width");
    const height = validateSize(params.height, 600, "height");
    const extensionId = params.extensionId ? String(params.extensionId).trim() : "";
    const exported = params.exported !== false;
    const item = pkg.CreateComponentItem(actualName, width, height, folderPath, extensionId, exported, false);
    if (!item)
        throw new Error(`创建组件失败：${requestedName}`);
    markPackageChanged(pkg);
    const document = params.openAfterCreate === false ? null : openDocument({ url: item.GetURL() });
    return describeCreatedItem(item, "created", requestedName, folderPath, document);
}
function normalizeConflictPolicy(value) {
    const policy = String(value || "error").toLowerCase();
    if (policy !== "error" && policy !== "auto_rename" && policy !== "replace")
        throw new Error(`未知冲突策略：${policy}`);
    return policy;
}
async function importImage(params) {
    const pkg = resolvePackage(params);
    const rawSourcePath = String(params.sourcePath || "").trim();
    if (!rawSourcePath)
        throw new Error("sourcePath 不能为空");
    if (!IOPath.IsPathRooted(rawSourcePath))
        throw new Error("sourcePath 必须是绝对路径");
    const sourcePath = IOPath.GetFullPath(rawSourcePath);
    if (!IOFile.Exists(sourcePath))
        throw new Error(`图片文件不存在：${sourcePath}`);
    const detectedType = FairyEditor.FPackageItemType.GetFileType(sourcePath);
    if (detectedType !== FairyEditor.FPackageItemType.IMAGE)
        throw new Error(`文件不是 FairyGUI 支持的图片资源：${sourcePath}`);
    const folderPath = normalizePackagePath(params.folderPath);
    const folder = resolvePackageFolder(pkg, folderPath, params.createFolders !== false);
    let requestedName = params.resourceName
        ? String(params.resourceName).trim()
        : String(IOPath.GetFileNameWithoutExtension(sourcePath));
    const sourceExtension = String(IOPath.GetExtension(requestedName) || "");
    if (sourceExtension)
        requestedName = String(IOPath.GetFileNameWithoutExtension(requestedName));
    requestedName = validateResourceName(requestedName, "resourceName");
    const policy = normalizeConflictPolicy(params.conflictPolicy);
    let actualName = requestedName;
    let existing = findItemInFolder(pkg, folder, actualName);
    if (existing && policy === "error")
        throw new Error(`资源已存在：${requestedName}`);
    if (existing && policy === "auto_rename") {
        actualName = resolveNewItemName(pkg, folder, requestedName, true);
        existing = null;
    }
    if (existing && policy === "replace") {
        if (existing.type !== FairyEditor.FPackageItemType.IMAGE)
            throw new Error(`同名资源不是图片，不能替换：${requestedName}`);
        await puerts.$promise(pkg.UpdateResource(existing, sourcePath));
        existing.exported = params.exported !== false;
        existing.SetChanged();
        const largeImageAtlasApplied = applyLargeImageAtlasRule(existing);
        markPackageChanged(pkg);
        return {
            operation: "replaced",
            requestedName,
            actualName: existing.name,
            autoRenamed: false,
            sourcePath,
            folderPath,
            largeImageAtlasApplied,
            item: describeItem(existing),
            packageModified: true,
            requiresSave: true,
            diskWrite: true
        };
    }
    const importFileName = `${actualName}${String(IOPath.GetExtension(sourcePath) || "")}`;
    const item = await puerts.$promise(pkg.ImportResource(sourcePath, folderPath, importFileName));
    if (!item)
        throw new Error(`导入图片失败：${sourcePath}`);
    if (item.type !== FairyEditor.FPackageItemType.IMAGE)
        throw new Error(`导入结果不是图片资源：${item.name}`);
    item.exported = params.exported !== false;
    item.SetChanged();
    const largeImageAtlasApplied = applyLargeImageAtlasRule(item);
    markPackageChanged(pkg);
    return {
        operation: "imported",
        requestedName,
        actualName: item.name,
        autoRenamed: item.name !== requestedName,
        sourcePath,
        folderPath,
        largeImageAtlasApplied,
        item: describeItem(item),
        packageModified: true,
        requiresSave: true,
        diskWrite: true
    };
}
async function importFont(params) {
    const pkg = resolvePackage(params);
    const rawSourcePath = String(params.sourcePath || "").trim();
    if (!rawSourcePath)
        throw new Error("sourcePath 不能为空");
    if (!IOPath.IsPathRooted(rawSourcePath))
        throw new Error("sourcePath 必须是绝对路径");
    const sourcePath = IOPath.GetFullPath(rawSourcePath);
    if (!IOFile.Exists(sourcePath))
        throw new Error(`字体文件不存在：${sourcePath}`);
    const detectedType = FairyEditor.FPackageItemType.GetFileType(sourcePath);
    if (detectedType !== FairyEditor.FPackageItemType.FONT)
        throw new Error(`文件不是 FairyGUI 支持的字体资源：${sourcePath}`);
    const folderPath = normalizePackagePath(params.folderPath);
    const folder = resolvePackageFolder(pkg, folderPath, params.createFolders !== false);
    let requestedName = params.resourceName
        ? String(params.resourceName).trim()
        : String(IOPath.GetFileNameWithoutExtension(sourcePath));
    const sourceExtension = String(IOPath.GetExtension(requestedName) || "");
    if (sourceExtension)
        requestedName = String(IOPath.GetFileNameWithoutExtension(requestedName));
    requestedName = validateResourceName(requestedName, "resourceName");
    const policy = normalizeConflictPolicy(params.conflictPolicy);
    let actualName = requestedName;
    let existing = findItemInFolder(pkg, folder, actualName);
    if (existing && policy === "error")
        throw new Error(`资源已存在：${requestedName}`);
    if (existing && policy === "auto_rename") {
        actualName = resolveNewItemName(pkg, folder, requestedName, true);
        existing = null;
    }
    if (existing && policy === "replace") {
        if (existing.type !== FairyEditor.FPackageItemType.FONT)
            throw new Error(`同名资源不是字体，不能替换：${requestedName}`);
        await puerts.$promise(pkg.UpdateResource(existing, sourcePath));
        existing.exported = params.exported !== false;
        existing.SetChanged();
        markPackageChanged(pkg);
        return {
            operation: "replaced",
            requestedName,
            actualName: existing.name,
            autoRenamed: false,
            sourcePath,
            folderPath,
            item: describeItem(existing),
            packageModified: true,
            requiresSave: true,
            diskWrite: true
        };
    }
    const importFileName = `${actualName}${String(IOPath.GetExtension(sourcePath) || "")}`;
    const item = await puerts.$promise(pkg.ImportResource(sourcePath, folderPath, importFileName));
    if (!item)
        throw new Error(`导入字体失败：${sourcePath}`);
    if (item.type !== FairyEditor.FPackageItemType.FONT)
        throw new Error(`导入结果不是字体资源：${item.name}`);
    item.exported = params.exported !== false;
    item.SetChanged();
    markPackageChanged(pkg);
    return {
        operation: "imported",
        requestedName,
        actualName: item.name,
        autoRenamed: item.name !== requestedName,
        sourcePath,
        folderPath,
        item: describeItem(item),
        packageModified: true,
        requiresSave: true,
        diskWrite: true
    };
}
function normalizeButtonMode(value) {
    const mode = String(value || "common").toLowerCase();
    if (mode === "common")
        return "Common";
    if (mode === "check")
        return "Check";
    if (mode === "radio")
        return "Radio";
    throw new Error(`未知按钮模式：${mode}`);
}
function resolveButtonImages(params) {
    const input = params.imageUrls === undefined || params.imageUrls === null ? [] : params.imageUrls;
    if (!Array.isArray(input))
        throw new Error("imageUrls 必须是数组");
    if (input.length > 6)
        throw new Error("imageUrls 最多包含 6 个状态图片");
    const result = [];
    for (let i = 0; i < input.length; i++) {
        const raw = String(input[i] || "").trim();
        if (!raw) {
            result.push("");
            continue;
        }
        const item = resolveItem({ url: raw });
        if (item.type !== FairyEditor.FPackageItemType.IMAGE)
            throw new Error(`按钮状态资源不是图片：${raw}`);
        result.push(item.GetURL());
    }
    while (result.length < 6)
        result.push("");
    return result;
}
function createButton(params) {
    const pkg = resolvePackage(params);
    const requestedName = validateResourceName(params.buttonName, "buttonName");
    const folderPath = normalizePackagePath(params.folderPath);
    const folder = resolvePackageFolder(pkg, folderPath, params.createFolders !== false);
    const actualName = resolveNewItemName(pkg, folder, requestedName, params.autoRename === true);
    const width = validateSize(params.width, 160, "width");
    const height = validateSize(params.height, 60, "height");
    const mode = normalizeButtonMode(params.mode);
    const images = resolveButtonImages(params);
    const extensionId = params.extensionId
        ? String(params.extensionId).trim()
        : FairyEditor.FObjectType.EXT_BUTTON;
    const templates = new FairyEditor.ComponentTemplates(pkg);
    const item = templates.CreateButtonItem(actualName, extensionId, mode, toCsStringArray(images), width, height, params.asListItem === true, params.createRelations !== false, params.createText !== false, params.createIcon !== false, params.exported !== false, folderPath);
    if (!item)
        throw new Error(`创建按钮失败：${requestedName}`);
    markPackageChanged(pkg);
    const document = params.openAfterCreate === false ? null : openDocument({ url: item.GetURL() });
    const result = describeCreatedItem(item, "created", requestedName, folderPath, document);
    result.mode = mode;
    result.imageUrls = images;
    return result;
}
function openDocument(params) {
    const item = resolveItem(params);
    if (item.type !== FairyEditor.FPackageItemType.COMPONENT)
        throw new Error(`资源 ${item.name} 不是组件，无法作为文档打开`);
    const opened = App.docView.OpenDocument(item.GetURL(), true);
    if (!opened)
        throw new Error(`打开文档失败：${item.GetURL()}`);
    return opened;
}
function findObjectById(root, id) {
    if (root.id === id)
        return root;
    const component = root;
    if (typeof component.numChildren !== "number")
        return null;
    for (let i = 0; i < component.numChildren; i++) {
        const found = findObjectById(component.GetChildAt(i), id);
        if (found)
            return found;
    }
    return null;
}
function findObjectsByResourceUrl(root, resourceUrl, result) {
    if (String(root.resourceURL || "") === resourceUrl)
        result.push(root);
    const component = root;
    if (typeof component.numChildren !== "number")
        return;
    for (let i = 0; i < component.numChildren; i++)
        findObjectsByResourceUrl(component.GetChildAt(i), resourceUrl, result);
}
function findObjectsByName(root, name, result) {
    if (root.name === name)
        result.push(root);
    const component = root;
    if (typeof component.numChildren !== "number")
        return;
    for (let i = 0; i < component.numChildren; i++)
        findObjectsByName(component.GetChildAt(i), name, result);
}
function findObjectByPath(root, path) {
    const normalized = path.replace(/^\/+|\/+$/g, "");
    if (!normalized || normalized === "root")
        return root;
    const parts = normalized.split("/");
    if (parts[0] === "root")
        parts.shift();
    let current = root;
    for (const part of parts) {
        const component = current;
        if (typeof component.numChildren !== "number")
            return null;
        current = component.GetChild(part);
        if (!current)
            return null;
    }
    return current;
}
function resolveObject(doc, locator) {
    if (!locator || locator.path === "root")
        return doc.content;
    if (locator.id) {
        const foundById = findObjectById(doc.content, String(locator.id));
        if (!foundById)
            throw new Error(`未找到对象 ID：${locator.id}`);
        return foundById;
    }
    if (locator.path) {
        const foundByPath = findObjectByPath(doc.content, String(locator.path));
        if (!foundByPath)
            throw new Error(`未找到对象路径：${locator.path}`);
        return foundByPath;
    }
    if (locator.name || locator.resourceURL) {
        const matches = [];
        if (locator.name)
            findObjectsByName(doc.content, String(locator.name), matches);
        else
            findObjectsByResourceUrl(doc.content, String(locator.resourceURL), matches);
        const filtered = locator.type ? matches.filter((candidate) => String(candidate.objectType || candidate.type || "") === String(locator.type)) : matches;
        if (filtered.length === 0)
            throw new Error(locator.resourceURL ? `未找到资源引用对象：${locator.resourceURL}` : `未找到对象名称：${locator.name}`);
        if (filtered.length > 1)
            throw new Error(`对象定位不唯一，共找到 ${filtered.length} 个，请改用 path 或 id`);
        return filtered[0];
    }
    throw new Error("对象定位信息缺失，请提供 target.path、target.id、target.name 或 target.resourceURL");
}
function unityColor(value, label) {
    const hex = normalizedColor(value, label).substring(1);
    const r = parseInt(hex.substring(0, 2), 16) / 255;
    const g = parseInt(hex.substring(2, 4), 16) / 255;
    const b = parseInt(hex.substring(4, 6), 16) / 255;
    const a = hex.length === 8 ? parseInt(hex.substring(6, 8), 16) / 255 : 1;
    const Color = CS.UnityEngine.Color;
    return new Color(r, g, b, a);
}
function normalizedColor(value, label) {
    const color = String(value || "").trim().toUpperCase();
    if (!/^#[0-9A-F]{6}([0-9A-F]{2})?$/.test(color))
        throw new Error(`${label} 必须是 #RRGGBB 或 #RRGGBBAA`);
    return color;
}
function targetSummary(obj, target) {
    return { id: obj.id || null, name: obj.name || null, path: target && target.path ? String(target.path) : null, type: String(obj.objectType || "unknown") };
}
// Verification is deliberately limited to properties with a known serialized meaning.
const TEXT_BOOLEAN_KEYS = ["bold", "italic", "underline", "strike", "stroke", "shadow", "ubbEnabled", "varsEnabled", "singleLine"];
const TEXT_COLOR_KEYS = ["color", "strokeColor", "shadowColor"];
const VERIFIED_TEXT_KEYS = ["font", "fontSize", "color", "align", "vAlign", "autoSize", "lineGap", "letterSpacing", "width", "height", "x", "y",
    "text", "strokeColor", "strokeSize", "shadowColor", "shadowX", "shadowY", "outlineSoftness", "underlaySoftness", "faceDilate"].concat(TEXT_BOOLEAN_KEYS);
const VERIFIED_KEYS = ["id", "name", "type", "resourceURL"].concat(VERIFIED_TEXT_KEYS, ["animationName", "skinName", "playing", "loop", "frame"]);
function verificationError(code, message, details) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    throw error;
}
function validateExpectations(expected) {
    if (!expected || typeof expected !== "object" || Array.isArray(expected) || Object.keys(expected).length === 0)
        verificationError("invalid_argument", "expected 必须是非空属性对象", { stage: "input" });
    const result = {};
    for (const key of Object.keys(expected)) {
        if (VERIFIED_KEYS.indexOf(key) < 0)
            verificationError("unsupported_property", `不支持验证属性：${key}`, { stage: "input", property: key });
        const value = expected[key];
        if (value !== null && typeof value !== "string" && typeof value !== "number" && !((["playing", "loop"].concat(TEXT_BOOLEAN_KEYS)).indexOf(key) >= 0 && typeof value === "boolean"))
            verificationError("invalid_argument", `expected.${key} 必须是字符串、数字或 null`, { stage: "input" });
        if (typeof value === "number" && !Number.isFinite(value))
            verificationError("invalid_argument", `expected.${key} 必须是有限数字`, { stage: "input" });
        result[key] = TEXT_COLOR_KEYS.indexOf(key) >= 0 ? normalizedColor(value, key) : value;
    }
    return result;
}
function verifiedObjectValues(obj) {
    const value = { id: obj.id || "", name: obj.name || "", type: String(obj.objectType || "unknown").toLowerCase(), resourceURL: String(obj.objectType).toLowerCase() === "loader" ? (obj.url || null) : (obj.resourceURL || null) };
    const aliases = { vAlign: "verticalAlign", lineGap: "leading" };
    for (const key of VERIFIED_TEXT_KEYS) {
        const property = aliases[key] || key;
        value[key] = TEXT_COLOR_KEYS.indexOf(key) >= 0 ? colorHex(obj[key]) : (obj[property] === undefined ? null : safeValue(obj[property]));
    }
    // An unspecified/default font is represented by the empty string in XML.
    if (String(obj.objectType).toLowerCase() === "loader3d") {
        Object.assign(value, loader3dValues(obj));
        value.resourceURL = obj.url || "";
    }
    if (value.font === null)
        value.font = "";
    return value;
}
function compareVerification(expected, actual, stage, obj) {
    const differences = [];
    for (const key of Object.keys(expected)) {
        const a = actual[key] === undefined ? null : actual[key];
        const e = expected[key];
        if (!(typeof e === "number" && typeof a === "number" ? Math.abs(e - a) <= 0.00001 : e === a))
            differences.push({ property: key, expected: e, actual: a });
    }
    if (differences.length)
        verificationError(stage === "xml" ? "persistence_failed" : "editor_rejected", `验证失败：${stage}`, { stage, target: targetSummary(obj, null), expected, actual, differences, mutationMayHaveOccurred: true });
    return actual;
}
function persistedObjectValues(doc, obj) {
    const item = App.project.GetItemByURL(doc.content.resourceURL);
    if (!item || !item.file || !IOFile.Exists(item.file))
        verificationError("persistence_failed", "无法读取组件 XML", { stage: "xml", target: targetSummary(obj, null) });
    const XmlType = CS.FairyGUI.Utils.XML;
    const xml = new XmlType(String(IOFile.ReadAllText(item.file)));
    let node = null;
    if (obj === doc.content)
        node = xml;
    else {
        // Only direct displayList children belong to this component's serialized document.
        // Do not accidentally match a nested component or transition's target ID.
        const list = xml.GetNode("displayList");
        if (list) {
            for (let i = 0; i < list.elements.Count; i++) {
                const candidate = list.elements.get_Item(i);
                if (String(candidate.GetAttribute("id")) === String(obj.id)) {
                    if (node)
                        verificationError("persistence_failed", "XML 对象 ID 不唯一", { stage: "xml", id: obj.id });
                    node = candidate;
                }
            }
        }
    }
    if (!node)
        verificationError("persistence_failed", "XML 中未找到目标对象", { stage: "xml", target: targetSummary(obj, null) });
    const attr = (key) => { const v = node.GetAttribute(key); return v === null || v === undefined ? null : String(v); };
    const value = { id: attr("id") || "", name: attr("name") || "", type: String(node.name), resourceURL: null };
    if (value.type === "loader3D") {
        value.type = "loader3d";
        value.resourceURL = attr("url") || "";
        value.animationName = attr("animation") || "";
        value.skinName = attr("skin") || "";
        value.playing = attr("playing") !== "false";
        value.loop = attr("loop") === "true";
        value.frame = Number(attr("frame") || "0");
    }
    else if (value.type === "loader")
        value.resourceURL = attr("url");
    else if (attr("src"))
        value.resourceURL = `ui://${attr("pkg") || item.owner.id}${attr("src")}`;
    for (const key of ["font", "fontSize", "color", "align", "vAlign", "autoSize", "letterSpacing"])
        value[key] = attr(key);
    value.font = value.font || "";
    value.lineGap = attr("leading");
    if (String(node.name).toLowerCase().indexOf("text") >= 0) {
        const textDefaults = { color: "#000000", align: "left", vAlign: "top", autoSize: "both", letterSpacing: "0", lineGap: "0" };
        for (const key of Object.keys(textDefaults))
            if (value[key] === null)
                value[key] = textDefaults[key];
    }
    if (value.color !== null)
        value.color = normalizedColor(value.color, "XML color");
    for (const key of ["fontSize", "letterSpacing", "lineGap"])
        if (value[key] !== null)
            value[key] = Number(value[key]);
    const xy = (attr("xy") || "0,0").split(",").map(Number);
    value.x = xy[0];
    value.y = xy[1];
    let size = attr("size");
    // 组件实例与图片都会省略等于引用资源默认值的尺寸，必须按资源引用解析而非使用当前内存尺寸。
    if (!size && ["image", "component"].indexOf(value.type) >= 0 && value.resourceURL) {
        const resource = App.project.GetItemByURL(value.resourceURL);
        if (resource)
            size = `${resource.width},${resource.height}`;
    }
    const dimensions = size ? size.split(",").map(Number) : [null, null];
    value.width = dimensions[0];
    value.height = dimensions[1];
    const defaults = { bold: false, italic: false, underline: false, strike: false, stroke: false, shadow: false,
        ubbEnabled: false, varsEnabled: false, singleLine: false, strokeColor: "#000000", shadowColor: "#000000", strokeSize: 1,
        shadowX: 1, shadowY: 1, outlineSoftness: 0, underlaySoftness: 0, faceDilate: 0, text: "" };
    for (const key of Object.keys(defaults)) {
        let raw = attr(key === "ubbEnabled" ? "ubb" : key === "varsEnabled" ? "vars" : key);
        if (key === "stroke")
            raw = attr("strokeColor") !== null ? "true" : "false";
        if (key === "shadow")
            raw = attr("shadowColor") !== null ? "true" : "false";
        value[key] = raw === null ? defaults[key] : typeof defaults[key] === "boolean" ? raw === "true"
            : typeof defaults[key] === "number" ? Number(raw) : TEXT_COLOR_KEYS.indexOf(key) >= 0 ? normalizedColor(raw, key) : raw;
    }
    const shadowOffset = attr("shadowOffset");
    if (shadowOffset) {
        const offset = shadowOffset.split(",").map(Number);
        value.shadowX = offset[0];
        value.shadowY = offset[1];
    }
    return { values: value, file: String(item.file) };
}
function verifyObject(doc, obj, expected, readXml) {
    const editor = compareVerification(expected, verifiedObjectValues(obj), "editor", obj);
    let disk = null;
    if (readXml) {
        try {
            disk = persistedObjectValues(doc, obj);
            compareVerification(expected, disk.values, "xml", obj);
        }
        catch (error) {
            if (error.code)
                throw error;
            verificationError("persistence_failed", "XML 读取或解析失败", { stage: "xml", target: targetSummary(obj, null), reason: String(error), expected });
        }
    }
    return { editorReadback: true, xmlReadback: Boolean(disk), externalReload: false, expected, editor, xml: disk ? disk.values : null, file: disk ? disk.file : null };
}
function writeVerification(doc, obj, before, after, params, expected) {
    // Editor acceptance is checked even with verify=false; that flag only skips disk readback.
    const verification = verifyObject(doc, obj, expected, false);
    let saved = false;
    if (params.save) {
        try {
            doc.Save();
        }
        catch (error) {
            verificationError("persistence_failed", "保存失败", { stage: "save", target: targetSummary(obj, null), reason: String(error), expected });
        }
        saved = doc.isModified === false;
        if (!saved)
            verificationError("persistence_failed", "保存后文档仍处于修改状态", { stage: "save", target: targetSummary(obj, null), expected });
    }
    const checked = saved && params.verify !== false ? verifyObject(doc, obj, expected, true) : verification;
    return { ok: true, target: targetSummary(obj, params.target), before, after, documentModified: Boolean(doc.isModified), saved, persisted: saved && checked.xmlReadback, verification: checked, note: "仅验证 expected 中的字段；未执行 external reload。失败不自动回滚。" };
}
function replaceObjectResource(params) {
    const doc = getActiveDocument();
    let obj = resolveObject(doc, params.target);
    if (params.externalReload)
        verificationError("unsupported_property", "暂不支持自动 external reload", { stage: "input" });
    const type = String(obj.objectType || "").toLowerCase();
    if (["image", "loader"].indexOf(type) < 0 || params.state)
        verificationError("unsupported_property", "可信资源替换目前仅支持 Image/Loader；Button 状态请使用专用 API", { stage: "input" });
    const url = String(params.resourceURL || params.url || "").trim();
    if (url.indexOf("ui://") !== 0)
        verificationError("invalid_argument", "resourceURL 必须是 ui:// URL", { stage: "input" });
    const resource = resolveItem({ url });
    if (resource.type !== FairyEditor.FPackageItemType.IMAGE || (params.expectedType && String(params.expectedType).toLowerCase() !== "image"))
        verificationError("invalid_argument", "本切片的资源类型必须是 image", { stage: "input", resourceURL: url });
    const canonicalUrl = String(resource.GetURL());
    const before = verifiedObjectValues(obj);
    const expected = { id: before.id, name: before.name, type, resourceURL: canonicalUrl };
    const preserveSize = params.preserveSize !== false;
    if (preserveSize) {
        expected.width = obj.width;
        expected.height = obj.height;
    }
    if (before.resourceURL !== canonicalUrl) {
        if (type === "loader")
            obj.url = canonicalUrl;
        else {
            doc.SetSelection(obj);
            doc.ReplaceSelection(canonicalUrl);
            // ReplaceSelection can invalidate the old object reference. Re-resolve by stable ID.
            obj = resolveObject(doc, { id: before.id });
        }
        if (preserveSize) {
            obj.width = expected.width;
            obj.height = expected.height;
        }
        doc.SetModified(true);
        doc.RefreshInspectors();
    }
    return writeVerification(doc, obj, before, verifiedObjectValues(obj), params, expected);
}
function colorHex(value) {
    if (value === null || value === undefined)
        return null;
    const c = value;
    const channel = (v) => Math.max(0, Math.min(255, Math.round(Number(v) * 255)));
    if (c.r === undefined || c.g === undefined || c.b === undefined)
        return null;
    const hex = (v) => v.toString(16).padStart(2, "0");
    const alpha = c.a === undefined ? 255 : channel(c.a);
    return `#${hex(channel(c.r))}${hex(channel(c.g))}${hex(channel(c.b))}${alpha < 255 ? hex(alpha) : ""}`.toUpperCase();
}
function textStyle(obj) {
    const value = {}, all = verifiedObjectValues(obj);
    for (const key of VERIFIED_TEXT_KEYS)
        if (obj[TEXT_ALIASES[key] || key] !== undefined)
            value[key] = all[key];
    return value;
}
const TEXT_ALIASES = { vAlign: "verticalAlign", lineGap: "leading" };
function getTextStyle(params) {
    const doc = getActiveDocument();
    const obj = resolveObject(doc, params.target);
    const type = String(obj.objectType || "").toLowerCase();
    if (type.indexOf("text") < 0 && type.indexOf("rich") < 0)
        throw new Error("目标不是文本对象");
    return { ok: true, target: targetSummary(obj, params.target), style: textStyle(obj) };
}
function setTextStyle(params) {
    const doc = getActiveDocument();
    const obj = resolveObject(doc, params.target);
    if (params.externalReload)
        verificationError("unsupported_property", "暂不支持自动 external reload", { stage: "input" });
    const type = String(obj.objectType || "").toLowerCase();
    if (type.indexOf("text") < 0 && type.indexOf("rich") < 0)
        throw new Error("目标不是文本对象");
    const style = validateExpectations(params.style);
    for (const key of Object.keys(style)) {
        if (VERIFIED_TEXT_KEYS.indexOf(key) < 0)
            verificationError("unsupported_property", `不支持文本样式：${key}`, { stage: "input" });
        if (["fontSize", "lineGap", "letterSpacing", "width", "height", "x", "y"].indexOf(key) >= 0) {
            if (typeof style[key] !== "number")
                verificationError("invalid_argument", `${key} 必须是数字`, { stage: "input" });
            numberValue(style[key], key, ["fontSize", "width", "height"].indexOf(key) >= 0 ? 0 : -10000, 10000);
        }
        else if (TEXT_BOOLEAN_KEYS.indexOf(key) >= 0) {
            if (typeof style[key] !== "boolean")
                verificationError("invalid_argument", `${key} 必须是布尔值`, { stage: "input" });
        }
        else if (["strokeSize", "shadowX", "shadowY", "outlineSoftness", "underlaySoftness", "faceDilate"].indexOf(key) >= 0) {
            numberValue(style[key], key, ["shadowX", "shadowY", "faceDilate"].indexOf(key) >= 0 ? -10000 : 0, 10000);
        }
        else if (typeof style[key] !== "string")
            verificationError("invalid_argument", `${key} 必须是字符串`, { stage: "input" });
    }
    const enums = { align: ["left", "center", "right"], vAlign: ["top", "middle", "bottom"], autoSize: ["none", "both", "height", "shrink"] };
    for (const key of Object.keys(enums))
        if (style[key] !== undefined && enums[key].indexOf(style[key]) < 0)
            verificationError("invalid_argument", `${key} 枚举值无效`, { stage: "input" });
    if (style.font && style.font.indexOf("ui://") === 0) {
        const font = resolveItem({ url: style.font });
        if (font.type !== FairyEditor.FPackageItemType.FONT)
            verificationError("invalid_argument", "font 必须引用字体资源", { stage: "input" });
        style.font = String(font.GetURL());
    }
    const before = textStyle(obj);
    requireOwnedEditingTarget(doc, obj, false);
    validateGeometry(obj, style);
    for (const effect of ["stroke", "shadow"]) {
        const enabled = style[effect] === undefined ? Boolean(obj[effect]) : style[effect];
        const keys = effect === "stroke" ? ["strokeColor", "strokeSize"] : ["shadowColor", "shadowX", "shadowY"];
        if (!enabled && keys.some(k => style[k] !== undefined))
            verificationError("layout_conflict", `设置 ${effect} 参数时必须同时启用 ${effect}=true`, { stage: "input" });
    }
    // 自动尺寸与文本先应用，尺寸忽略 Pivot 位移，坐标最后写入，避免调用方 JSON 键顺序改变结果。
    invalidateUntrackedHistory(doc);
    for (const key of Object.keys(style).filter(k => ["x", "y", "width", "height"].indexOf(k) < 0))
        obj[TEXT_ALIASES[key] || key] = TEXT_COLOR_KEYS.indexOf(key) >= 0 ? unityColor(style[key], key) : style[key];
    applyGeometry(obj, style);
    doc.SetModified(true);
    doc.RefreshInspectors();
    const expected = Object.assign({ id: obj.id, type }, style);
    return writeVerification(doc, obj, before, textStyle(obj), params, expected);
}
function verifyDocument(params) {
    const doc = getActiveDocument();
    if (params.externalReload)
        verificationError("unsupported_property", "暂不支持自动 external reload", { stage: "input" });
    const includeTree = params.includeTree === true || (params.includeTree !== false && params.expected === undefined);
    const tree = includeTree ? describeObject(doc.content, 0, params.maxDepth === undefined ? 12 : Number(params.maxDepth)) : undefined;
    if (params.expected !== undefined) {
        if (!params.target)
            verificationError("invalid_argument", "expected 必须提供 target", { stage: "input" });
        const expected = validateExpectations(params.expected);
        const obj = resolveObject(doc, params.target);
        const verification = verifyObject(doc, obj, expected, params.readXml !== false);
        return { ok: true, document: describeDocument(doc), target: targetSummary(obj, params.target), tree, verification, saved: !doc.isModified, persisted: !doc.isModified && verification.xmlReadback, note: "只验证 expected 字段；不会保存或重载文档。" };
    }
    return { ok: true, document: describeDocument(doc), target: params.target ? describeObject(resolveObject(doc, params.target), 0, 1) : null, tree, verification: { editorReadback: false, xmlReadback: false, externalReload: false }, persisted: false, note: "仅返回快照，未比对预期值。传入 target 和 expected 执行验证。" };
}
// Animation bridge helpers. FairyGUI Editor 6.1.4 exposes these APIs through Puerts.
const TRANSITION_TYPES = [
    "XY", "Size", "Pivot", "Scale", "Skew", "Alpha", "Rotation", "Color",
    "Animation", "Visible", "Sound", "Transition", "Shake", "ColorFilter", "Text", "Icon"
];
const TRANSITION_TYPE_SET = {};
for (const transitionType of TRANSITION_TYPES)
    TRANSITION_TYPE_SET[transitionType] = true;
function numberValue(value, label, minimum = -1000000, maximum = 1000000) {
    const result = Number(value);
    if (!Number.isFinite(result) || result < minimum || result > maximum)
        throw new Error(`${label}必须是 ${minimum} 到 ${maximum} 之间的有限数字`);
    return result;
}
function nonNegativeInt(value, label, fallback = 0) {
    const result = value === undefined || value === null ? fallback : Number(value);
    if (!Number.isInteger(result) || result < 0 || result > 1000000)
        throw new Error(`${label}必须是 0 到 1000000 之间的整数`);
    return result;
}
function normalizeTransitionName(value) {
    return validateResourceName(value, "transitionName");
}
function normalizeTransitionType(value) {
    const type = String(value || "").trim();
    if (!TRANSITION_TYPE_SET[type])
        throw new Error(`不支持的 Transition 轨道类型：${type}`);
    return type;
}
function normalizeEase(value) {
    const ease = String(value || "Quad.Out").trim();
    const normalized = ease.replace(/\./g, "");
    const allowed = [
        "Linear", "SineIn", "SineOut", "SineInOut", "QuadIn", "QuadOut", "QuadInOut",
        "CubicIn", "CubicOut", "CubicInOut", "QuartIn", "QuartOut", "QuartInOut",
        "QuintIn", "QuintOut", "QuintInOut", "ExpoIn", "ExpoOut", "ExpoInOut",
        "CircIn", "CircOut", "CircInOut", "ElasticIn", "ElasticOut", "ElasticInOut",
        "BackIn", "BackOut", "BackInOut", "BounceIn", "BounceOut", "BounceInOut", "Custom"
    ];
    if (allowed.indexOf(normalized) < 0)
        throw new Error(`不支持的缓动类型：${ease}`);
    if (normalized === "Linear" || normalized === "Custom")
        return normalized;
    return normalized.replace(/(InOut|In|Out)$/, ".$1");
}
function transitionValueObject(raw) {
    if (raw === null || raw === undefined)
        return {};
    if (typeof raw === "number" || typeof raw === "boolean" || typeof raw === "string")
        return { value: raw };
    if (typeof raw !== "object" || Array.isArray(raw))
        throw new Error("Transition value 必须是对象、数字、布尔值或字符串");
    return raw;
}
function assertKnownKeys(value, allowed, label) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return;
    for (const key of Object.keys(value)) {
        if (allowed.indexOf(key) < 0)
            throw new Error(`${label} 包含未知字段：${key}`);
    }
}
function validateTransitionValueKeys(type, raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return;
    const common2 = ["x", "y", "f1", "f2", "b1", "b2"];
    const allowed = {
        XY: common2.concat(["percent", "b3"]), Size: common2, Pivot: common2, Scale: common2, Skew: common2,
        Alpha: ["value", "f1"], Rotation: ["value", "f1"], Color: ["r", "g", "b", "a"],
        Animation: ["playing", "frame", "animationName", "skinName"], Visible: ["visible", "value"],
        Sound: ["soundUrl", "volume", "s", "i"], Transition: ["transitionName", "playTimes", "stopTime", "s", "i", "f1"],
        Shake: ["amplitude", "duration", "f1", "f2"],
        ColorFilter: ["brightness", "contrast", "saturation", "hue", "f1", "f2", "f3", "f4"],
        Text: ["text", "value", "s"], Icon: ["text", "value", "s"]
    };
    assertKnownKeys(raw, allowed[type] || [], `${type} value`);
}
function describePathPoints(points) {
    const result = [];
    if (!points)
        return result;
    for (let index = 0; index < points.Count; index++) {
        const point = points.get_Item(index);
        result.push({
            x: Number(point.pos.x), y: Number(point.pos.y), curveType: String(point.curveType), smooth: Boolean(point.smooth),
            control1: point.control1 ? { x: Number(point.control1.x), y: Number(point.control1.y) } : null,
            control2: point.control2 ? { x: Number(point.control2.x), y: Number(point.control2.y) } : null
        });
    }
    return result;
}
function applyPathPoints(item, raw, custom) {
    if (raw === undefined || raw === null)
        return;
    if (typeof raw === "string" || (typeof raw === "object" && !Array.isArray(raw) && raw.encoded !== undefined)) {
        const encoded = typeof raw === "string" ? raw : String(raw.encoded || "");
        if (custom)
            item.customEaseData = encoded;
        else
            item.pathData = encoded;
        return;
    }
    if (!Array.isArray(raw))
        throw new Error(`${custom ? "customEase" : "path"} 必须是路径点数组、{encoded, points}、内部编码字符串或 null`);
    if (custom) {
        const customEase = item.customEase;
        customEase.points.Clear();
        const PointType = CS.FairyGUI.GPathPoint;
        const Vector3Type = CS.UnityEngine.Vector3;
        for (let index = 0; index < raw.length; index++) {
            const point = raw[index];
            assertKnownKeys(point, ["x", "y", "curveType", "smooth", "control1", "control2", "near"], `customEase[${index}]`);
            const pos = new Vector3Type(numberValue(point.x, `customEase[${index}].x`), numberValue(point.y, `customEase[${index}].y`), 0);
            let value;
            if (point.control1 && point.control2) {
                const c1 = new Vector3Type(numberValue(point.control1.x, "control1.x"), numberValue(point.control1.y, "control1.y"), 0);
                const c2 = new Vector3Type(numberValue(point.control2.x, "control2.x"), numberValue(point.control2.y, "control2.y"), 0);
                value = new PointType(pos, c1, c2);
            }
            else if (point.control1) {
                const c = new Vector3Type(numberValue(point.control1.x, "control1.x"), numberValue(point.control1.y, "control1.y"), 0);
                value = new PointType(pos, c);
            }
            else
                value = new PointType(pos);
            value.smooth = Boolean(point.smooth);
            customEase.points.Add(value);
        }
        customEase.Update();
        return;
    }
    item.usePath = true;
    for (let index = 0; index < raw.length; index++) {
        const point = raw[index];
        assertKnownKeys(point, ["x", "y", "curveType", "smooth", "control1", "control2", "near"], `path[${index}]`);
        item.AddPathPoint(numberValue(point.x, `path[${index}].x`), numberValue(point.y, `path[${index}].y`), Boolean(point.near));
        if (point.control1)
            item.UpdateControlPoint(index, 1, numberValue(point.control1.x, "control1.x"), numberValue(point.control1.y, "control1.y"));
        if (point.control2)
            item.UpdateControlPoint(index, 2, numberValue(point.control2.x, "control2.x"), numberValue(point.control2.y, "control2.y"));
        if (point.smooth !== undefined && item.pathPoints && item.pathPoints.Count > index) {
            const stored = item.pathPoints.get_Item(index);
            stored.smooth = Boolean(point.smooth);
            item.pathPoints.set_Item(index, stored);
        }
    }
}
function colorFromValue(raw) {
    const value = transitionValueObject(raw);
    const r = numberValue(value.r, "color.r", 0, 1);
    const g = numberValue(value.g, "color.g", 0, 1);
    const b = numberValue(value.b, "color.b", 0, 1);
    const a = value.a === undefined ? 1 : numberValue(value.a, "color.a", 0, 1);
    return new CS.UnityEngine.Color(r, g, b, a);
}
function colorToValue(color) {
    if (!color)
        return null;
    return { r: Number(color.r), g: Number(color.g), b: Number(color.b), a: Number(color.a) };
}
function applyTransitionValue(doc, type, destination, raw) {
    validateTransitionValueKeys(type, raw);
    const value = transitionValueObject(raw);
    switch (type) {
        case "XY":
        case "Size":
        case "Pivot":
        case "Scale":
        case "Skew":
            destination.f1 = numberValue(value.x === undefined ? value.f1 : value.x, `${type}.x`);
            destination.f2 = numberValue(value.y === undefined ? value.f2 : value.y, `${type}.y`);
            destination.b1 = value.b1 === undefined ? true : Boolean(value.b1);
            destination.b2 = value.b2 === undefined ? true : Boolean(value.b2);
            if (type === "XY")
                destination.b3 = Boolean(value.percent === undefined ? value.b3 : value.percent);
            break;
        case "Alpha":
        case "Rotation":
            destination.f1 = numberValue(value.value === undefined ? value.f1 : value.value, `${type}.value`);
            break;
        case "Color":
            destination.iu = colorFromValue(value);
            break;
        case "Animation":
            destination.b1 = Boolean(value.playing);
            destination.i = nonNegativeInt(value.frame, "Animation.frame", 0);
            destination.s = value.animationName === undefined || value.animationName === null ? "" : String(value.animationName);
            destination.s2 = value.skinName === undefined || value.skinName === null ? "" : String(value.skinName);
            break;
        case "Visible":
            destination.b1 = Boolean(value.visible === undefined ? value.value : value.visible);
            break;
        case "Sound":
            destination.s = String(value.soundUrl === undefined ? value.s || "" : value.soundUrl);
            if (!destination.s)
                throw new Error("Sound.soundUrl 不能为空");
            const soundItem = resolveItem({ url: destination.s });
            if (soundItem.type !== FairyEditor.FPackageItemType.SOUND)
                throw new Error(`Sound.soundUrl 不是声音资源：${destination.s}`);
            const volume = value.volume === undefined ? 1 : numberValue(value.volume, "Sound.volume", 0, 1);
            destination.i = Math.round(volume * 100);
            break;
        case "Transition":
            destination.s = normalizeTransitionName(value.transitionName === undefined ? value.s : value.transitionName);
            if (!doc.content.transitions.GetItem(destination.s))
                throw new Error(`嵌套 Transition 不存在：${destination.s}`);
            destination.i = value.playTimes === undefined ? 1 : Number(value.playTimes);
            if (!Number.isInteger(destination.i) || destination.i < -1 || destination.i > 1000000)
                throw new Error("Transition.playTimes 必须是 -1 到 1000000 之间的整数");
            destination.f1 = value.stopTime === undefined ? 0 : numberValue(value.stopTime, "Transition.stopTime", -1);
            break;
        case "Shake":
            destination.f1 = numberValue(value.amplitude === undefined ? value.f1 : value.amplitude, "Shake.amplitude", 0);
            destination.f2 = numberValue(value.duration === undefined ? value.f2 : value.duration, "Shake.duration", 0);
            break;
        case "ColorFilter":
            destination.f1 = numberValue(value.brightness === undefined ? value.f1 : value.brightness, "ColorFilter.brightness");
            destination.f2 = numberValue(value.contrast === undefined ? value.f2 : value.contrast, "ColorFilter.contrast");
            destination.f3 = numberValue(value.saturation === undefined ? value.f3 : value.saturation, "ColorFilter.saturation");
            destination.f4 = numberValue(value.hue === undefined ? value.f4 : value.hue, "ColorFilter.hue");
            break;
        case "Text":
        case "Icon":
            destination.s = String(value.text === undefined ? (value.value === undefined ? value.s || "" : value.value) : value.text);
            break;
    }
}
function describeTransitionValue(type, source) {
    if (!source)
        return null;
    switch (type) {
        case "XY":
        case "Size":
        case "Pivot":
        case "Scale":
        case "Skew":
            return { x: source.f1, y: source.f2, b1: source.b1, b2: source.b2, percent: type === "XY" ? source.b3 : undefined };
        case "Alpha":
        case "Rotation":
            return source.f1;
        case "Color":
            return colorToValue(source.iu);
        case "Animation":
            return { playing: source.b1, frame: source.i, animationName: source.s || "", skinName: source.s2 || "" };
        case "Visible":
            return { visible: source.b1 };
        case "Sound":
            return { soundUrl: source.s || "", volume: Number(source.i) / 100 };
        case "Transition":
            return { transitionName: source.s || "", playTimes: source.i, stopTime: source.f1 };
        case "Shake":
            return { amplitude: source.f1, duration: source.f2 };
        case "ColorFilter":
            return { brightness: source.f1, contrast: source.f2, saturation: source.f3, hue: source.f4 };
        case "Text":
        case "Icon":
            return { text: source.s || "" };
    }
    return null;
}
function resolveTransition(doc, name) {
    const transitionName = normalizeTransitionName(name);
    const transition = doc.content.transitions.GetItem(transitionName);
    if (!transition)
        throw new Error(`当前组件中不存在 Transition：${transitionName}`);
    return transition;
}
function isSyntheticTweenEndpoint(item) {
    return Boolean(item && item.prevItem && item.prevItem.tween && !item.tween);
}
function describeTransitionItem(item) {
    const type = String(item.type);
    const result = {
        targetId: item.targetId || "",
        type,
        frame: item.frame,
        label: item.label || "",
        value: describeTransitionValue(type, item.value),
        tween: null
    };
    if (item.tween) {
        const next = item.nextItem;
        if (!next)
            throw new Error(`Transition Tween 缺少结束关键帧：${type}@${item.frame}`);
        result.tween = {
            duration: Math.max(0, Number(next.frame) - Number(item.frame)),
            ease: item.easeName || item.easeType || "Quad.Out",
            repeat: item.repeat || 0,
            yoyo: Boolean(item.yoyo),
            start: describeTransitionValue(type, item.value),
            end: describeTransitionValue(type, next.value),
            path: item.usePath ? { encoded: item.pathData, points: describePathPoints(item.pathPoints) } : null,
            customEase: String(item.easeType || "").replace(/\./g, "") === "Custom" ? { encoded: item.customEaseData, points: describePathPoints(item.customEase.points) } : null
        };
    }
    return result;
}
function describeTransition(transition) {
    const items = [];
    for (let index = 0; index < transition.items.Count; index++) {
        const item = transition.items.get_Item(index);
        if (!isSyntheticTweenEndpoint(item))
            items.push(describeTransitionItem(item));
    }
    return {
        name: transition.name,
        options: transition.options,
        autoPlay: transition.autoPlay,
        autoPlayDelay: transition.autoPlayDelay,
        autoPlayRepeat: transition.autoPlayRepeat,
        frameRate: transition.frameRate,
        playTimes: transition.playTimes,
        maxFrame: transition.maxFrame,
        playing: transition.playing,
        items
    };
}
function summarizeTransitions(doc) {
    const result = [];
    if (!doc || !doc.content || !doc.content.transitions)
        return result;
    const transitions = doc.content.transitions.items;
    for (let index = 0; index < transitions.Count; index++) {
        const transition = transitions.get_Item(index);
        let publicItemCount = 0;
        for (let itemIndex = 0; itemIndex < transition.items.Count; itemIndex++) {
            if (!isSyntheticTweenEndpoint(transition.items.get_Item(itemIndex)))
                publicItemCount++;
        }
        result.push({ name: transition.name, frameRate: transition.frameRate, maxFrame: transition.maxFrame, itemCount: publicItemCount, autoPlay: transition.autoPlay });
    }
    return result;
}
function listTransitions(doc) {
    const list = [];
    const transitions = doc.content.transitions.items;
    for (let index = 0; index < transitions.Count; index++)
        list.push(describeTransition(transitions.get_Item(index)));
    return list;
}
function validateTransitionTarget(doc, targetId, type) {
    const id = targetId === undefined || targetId === null ? "" : String(targetId);
    const target = id ? findObjectById(doc.content, id) : doc.content;
    if (!target)
        throw new Error(`Transition targetId 不存在：${id}`);
    if (type && !FairyEditor.FTransition.GetAllowType(target, type))
        throw new Error(`目标 ${id || "root"} 不支持 Transition 轨道：${type}`);
    return id;
}
function getOrCreateTransitionItem(transition, targetId, type, frame) {
    for (let index = 0; index < transition.items.Count; index++) {
        const existing = transition.items.get_Item(index);
        if (Number(existing.frame) === frame && String(existing.targetId || "") === targetId && String(existing.type) === type)
            return existing;
    }
    const item = transition.CreateItem(targetId, type, frame);
    if (!item)
        throw new Error(`无法创建 Transition 轨道：${type}@${frame}`);
    return item;
}
function applyTransitionItem(doc, transition, raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("Transition item 必须是对象");
    assertKnownKeys(raw, ["targetId", "type", "frame", "label", "value", "tween"], "Transition item");
    const type = normalizeTransitionType(raw.type);
    const targetId = validateTransitionTarget(doc, raw.targetId, type);
    const frame = nonNegativeInt(raw.frame, "item.frame", 0);
    const item = getOrCreateTransitionItem(transition, targetId, type, frame);
    item.label = raw.label === undefined || raw.label === null ? "" : String(raw.label);
    if (raw.tween !== undefined && raw.tween !== null && raw.tween !== false) {
        const tween = raw.tween;
        if (typeof tween !== "object" || Array.isArray(tween))
            throw new Error("item.tween 必须是对象");
        assertKnownKeys(tween, ["duration", "ease", "repeat", "yoyo", "start", "end", "path", "customEase"], "Transition tween");
        const duration = nonNegativeInt(tween.duration, "tween.duration", 1);
        if (duration <= 0)
            throw new Error("tween.duration 必须大于 0");
        const endItem = getOrCreateTransitionItem(transition, targetId, type, frame + duration);
        item.tween = true;
        const ease = normalizeEase(tween.ease);
        const easeParts = ease.split(".");
        item.easeType = easeParts[0];
        if (easeParts.length > 1 && String(item.easeInOutType || "") !== easeParts[1])
            item.easeInOutType = easeParts[1];
        item.repeat = tween.repeat === undefined ? 0 : Number(tween.repeat);
        if (!Number.isInteger(item.repeat) || item.repeat < -1 || item.repeat > 1000000)
            throw new Error("tween.repeat 必须是 -1 到 1000000 之间的整数");
        item.yoyo = Boolean(tween.yoyo);
        applyPathPoints(item, tween.path, false);
        applyPathPoints(item, tween.customEase, true);
        applyTransitionValue(doc, type, item.value, tween.start === undefined ? raw.value : tween.start);
        applyTransitionValue(doc, type, endItem.value, tween.end === undefined ? raw.value : tween.end);
    }
    else {
        item.tween = false;
        applyTransitionValue(doc, type, item.value, raw.value);
    }
    return item;
}
function applyTransitionDefinition(doc, transition, raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("Transition 定义必须是对象");
    assertKnownKeys(raw, ["name", "options", "autoPlay", "autoPlayDelay", "autoPlayRepeat", "frameRate", "playTimes", "items", "maxFrame", "playing"], "Transition");
    const name = normalizeTransitionName(raw.name || transition.name);
    if (transition.name !== name)
        transition.name = name;
    transition.frameRate = nonNegativeInt(raw.frameRate, "frameRate", 60);
    if (transition.frameRate < 1 || transition.frameRate > 255)
        throw new Error("frameRate 必须是 1 到 255 之间的整数");
    transition.options = raw.options === undefined ? 0 : Number(raw.options);
    if (!Number.isInteger(transition.options) || transition.options < 0 || transition.options > 0xffff)
        throw new Error("options 必须是 0 到 65535 之间的整数");
    transition.autoPlay = Boolean(raw.autoPlay);
    transition.autoPlayDelay = raw.autoPlayDelay === undefined ? 0 : numberValue(raw.autoPlayDelay, "autoPlayDelay", 0);
    transition.autoPlayRepeat = raw.autoPlayRepeat === undefined ? 1 : Number(raw.autoPlayRepeat);
    if (!Number.isInteger(transition.autoPlayRepeat) || transition.autoPlayRepeat < -1 || transition.autoPlayRepeat > 1000000)
        throw new Error("autoPlayRepeat 必须是 -1 到 1000000 之间的整数");
    if (raw.playTimes !== undefined) {
        transition.playTimes = Number(raw.playTimes);
        if (!Number.isInteger(transition.playTimes) || transition.playTimes < -1 || transition.playTimes > 1000000)
            throw new Error("playTimes 必须是 -1 到 1000000 之间的整数");
    }
    const existing = [];
    for (let index = 0; index < transition.items.Count; index++)
        existing.push(transition.items.get_Item(index));
    for (const item of existing)
        transition.DeleteItem(item);
    const items = raw.items === undefined ? [] : raw.items;
    if (!Array.isArray(items))
        throw new Error("Transition.items 必须是数组");
    for (const item of items)
        applyTransitionItem(doc, transition, item);
    transition.Validate();
    return transition;
}
function restoreTransitions(doc, snapshot) {
    const XmlType = CS.FairyGUI.Utils.XML;
    const xml = new XmlType(snapshot);
    doc.UpdateTransitions(xml);
    doc.RefreshTransition();
    doc.RefreshInspectors();
}
function transitionSnapshot(doc) {
    return String(doc.content.transitions.Write().ToXMLString(false));
}
function pushAnimationHistory(doc, before, documentModifiedBefore) {
    const after = transitionSnapshot(doc);
    if (JSON.stringify(before) === JSON.stringify(after))
        return;
    agentUndoStack.push({ kind: "animation", documentUrl: doc.docURL, before, after, documentModifiedBefore });
    agentRedoStack.length = 0;
}
function applyAnimationHistory(entry, undo) {
    const doc = openDocumentByUrl(entry.documentUrl);
    const expected = undo ? entry.after : entry.before;
    const next = undo ? entry.before : entry.after;
    if (JSON.stringify(transitionSnapshot(doc)) !== JSON.stringify(expected))
        throw new Error("动画结构已被其他操作修改，拒绝撤销或重做");
    restoreTransitions(doc, next);
    doc.SetModified(undo ? entry.documentModifiedBefore : true);
    return { mode: "agent-animation", document: describeDocument(doc), transitions: listTransitions(doc) };
}
function mutateTransitions(params, operation, mutate) {
    const doc = getActiveDocument();
    const before = transitionSnapshot(doc);
    const documentModifiedBefore = doc.isModified;
    try {
        const result = mutate(doc);
        doc.RefreshTransition();
        doc.RefreshInspectors();
        doc.SetModified(true);
        pushAnimationHistory(doc, before, documentModifiedBefore);
        return { operation, result, document: describeDocument(doc), transitions: listTransitions(doc) };
    }
    catch (error) {
        try {
            restoreTransitions(doc, before);
            doc.SetModified(documentModifiedBefore);
        }
        catch (_) { /* preserve the original editor error */ }
        throw error;
    }
}
function upsertTransition(params) {
    const definition = params.transition;
    if (!definition || typeof definition !== "object" || Array.isArray(definition))
        throw new Error("transition 必须是对象");
    const name = normalizeTransitionName(definition.name || params.name);
    return mutateTransitions(params, "upserted", (doc) => {
        const transitions = doc.content.transitions;
        const existing = transitions.GetItem(name);
        const transition = existing || transitions.AddItem(name);
        return describeTransition(applyTransitionDefinition(doc, transition, { ...definition, name }));
    });
}
function addTransitionItem(params) {
    return mutateTransitions(params, "item_added", (doc) => {
        const transition = resolveTransition(doc, params.name);
        const definition = describeTransition(transition);
        definition.items.push(params.item);
        applyTransitionDefinition(doc, transition, definition);
        return describeTransition(transition);
    });
}
function publicTransitionItem(definition, index) {
    const itemIndex = nonNegativeInt(index, "itemIndex");
    if (itemIndex >= definition.items.length)
        throw new Error(`Transition itemIndex 超出范围：${itemIndex}`);
    return { itemIndex, item: definition.items[itemIndex] };
}
function mergePlainObjects(base, patch) {
    if (!base || typeof base !== "object" || Array.isArray(base) || !patch || typeof patch !== "object" || Array.isArray(patch))
        return patch;
    const result = { ...base };
    for (const key of Object.keys(patch))
        result[key] = mergePlainObjects(base[key], patch[key]);
    return result;
}
function updateTransitionItem(params) {
    return mutateTransitions(params, "item_updated", (doc) => {
        const transition = resolveTransition(doc, params.name);
        const definition = describeTransition(transition);
        const found = publicTransitionItem(definition, params.itemIndex);
        const raw = params.item;
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
            throw new Error("item 必须是对象");
        const replacement = mergePlainObjects(found.item, raw);
        definition.items[found.itemIndex] = replacement;
        applyTransitionDefinition(doc, transition, definition);
        return describeTransition(transition);
    });
}
function removeTransitionItem(params) {
    return mutateTransitions(params, "item_removed", (doc) => {
        const transition = resolveTransition(doc, params.name);
        const definition = describeTransition(transition);
        const found = publicTransitionItem(definition, params.itemIndex);
        definition.items.splice(found.itemIndex, 1);
        applyTransitionDefinition(doc, transition, definition);
        return found.item;
    });
}
function removeTransition(params) {
    return mutateTransitions(params, "removed", (doc) => {
        const transition = resolveTransition(doc, params.name);
        const removed = describeTransition(transition);
        doc.content.transitions.RemoveItem(transition);
        return removed;
    });
}
async function importSound(params) {
    const pkg = resolvePackage(params);
    const rawSourcePath = String(params.sourcePath || "").trim();
    if (!rawSourcePath || !IOPath.IsPathRooted(rawSourcePath))
        throw new Error("sourcePath 必须是存在的绝对路径");
    const sourcePath = IOPath.GetFullPath(rawSourcePath);
    if (!IOFile.Exists(sourcePath))
        throw new Error(`声音文件不存在：${sourcePath}`);
    if (FairyEditor.FPackageItemType.GetFileType(sourcePath) !== FairyEditor.FPackageItemType.SOUND)
        throw new Error(`文件不是 FairyGUI 支持的声音资源：${sourcePath}`);
    const folderPath = normalizePackagePath(params.folderPath);
    const folder = resolvePackageFolder(pkg, folderPath, params.createFolders !== false);
    let requestedName = params.resourceName ? String(params.resourceName).trim() : String(IOPath.GetFileNameWithoutExtension(sourcePath));
    if (IOPath.GetExtension(requestedName))
        requestedName = String(IOPath.GetFileNameWithoutExtension(requestedName));
    requestedName = validateResourceName(requestedName, "resourceName");
    const policy = normalizeConflictPolicy(params.conflictPolicy);
    let existing = findItemInFolder(pkg, folder, requestedName);
    let actualName = requestedName;
    if (existing && policy === "error")
        throw new Error(`资源已存在：${requestedName}`);
    if (existing && policy === "auto_rename") {
        actualName = resolveNewItemName(pkg, folder, requestedName, true);
        existing = null;
    }
    if (existing && policy === "replace") {
        if (existing.type !== FairyEditor.FPackageItemType.SOUND)
            throw new Error(`同名资源不是声音，不能替换：${requestedName}`);
        await puerts.$promise(pkg.UpdateResource(existing, sourcePath));
        existing.exported = params.exported !== false;
        existing.SetChanged();
        markPackageChanged(pkg);
        return { operation: "replaced", requestedName, actualName: existing.name, sourcePath, folderPath, item: describeItem(existing), packageModified: true, requiresSave: true, diskWrite: true };
    }
    const item = await puerts.$promise(pkg.ImportResource(sourcePath, folderPath, `${actualName}${String(IOPath.GetExtension(sourcePath) || "")}`));
    if (!item || item.type !== FairyEditor.FPackageItemType.SOUND)
        throw new Error(`导入声音失败：${sourcePath}`);
    item.exported = params.exported !== false;
    item.SetChanged();
    markPackageChanged(pkg);
    return { operation: "imported", requestedName, actualName: item.name, sourcePath, folderPath, item: describeItem(item), packageModified: true, requiresSave: true, diskWrite: true };
}
function normalizeFramePaths(value) {
    if (!Array.isArray(value) || value.length === 0)
        throw new Error("framePaths 必须是至少包含一帧的绝对图片路径数组");
    return value.map((raw, index) => {
        const path = String(raw || "").trim();
        if (!path || !IOPath.IsPathRooted(path))
            throw new Error(`framePaths[${index}] 必须是绝对路径`);
        const fullPath = IOPath.GetFullPath(path);
        if (!IOFile.Exists(fullPath) || FairyEditor.FPackageItemType.GetFileType(fullPath) !== FairyEditor.FPackageItemType.IMAGE)
            throw new Error(`framePaths[${index}] 不是 FairyGUI 支持的图片：${fullPath}`);
        return fullPath;
    });
}
function movieClipAsset(item) {
    if (!item || item.type !== FairyEditor.FPackageItemType.MOVIECLIP)
        throw new Error("目标资源不是 MovieClip");
    const asset = item.GetAsset();
    if (!asset)
        throw new Error(`无法加载 MovieClip 资源：${item.name}`);
    return asset;
}
async function ensureMovieClipAsset(item) {
    const asset = movieClipAsset(item);
    if (asset.Load)
        await puerts.$promise(asset.Load());
    if (!asset.animation)
        throw new Error(`MovieClip 动画数据不可用：${item.name}`);
    return asset;
}
function describeLoadedMovieClip(item, asset) {
    const animation = asset.animation;
    const frames = [];
    for (let index = 0; index < animation.frameList.Count; index++) {
        const frame = animation.frameList.get_Item(index);
        frames.push({ index, spriteIndex: frame.spriteIndex, delay: frame.delay, rect: frame.rect ? { x: frame.rect.x, y: frame.rect.y, width: frame.rect.width, height: frame.rect.height } : null });
    }
    return { item: describeItem(item), fps: animation.fps, speed: animation.speed, repeatDelay: animation.repeatDelay, swing: animation.swing, frameCount: animation.frameCount, frames };
}
async function getMovieClip(params) {
    const item = resolveItem(params.movieClip || params);
    return describeLoadedMovieClip(item, await ensureMovieClipAsset(item));
}
function movieClipFileState(item) {
    const Convert = CS.System.Convert;
    return {
        fileBase64: IOFile.Exists(item.file) ? String(Convert.ToBase64String(IOFile.ReadAllBytes(item.file))) : null,
        width: Number(item.width),
        height: Number(item.height),
        exported: Boolean(item.exported)
    };
}
function movieClipStatesEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
function pushMovieClipHistory(item, before) {
    const after = movieClipFileState(item);
    if (movieClipStatesEqual(before, after))
        return;
    agentUndoStack.push({ kind: "movieclip", packageId: item.owner.id, itemId: item.id, before, after });
    agentRedoStack.length = 0;
}
function applyMovieClipHistory(entry, undo) {
    const item = App.project.GetItem(entry.packageId, entry.itemId);
    if (!item || item.type !== FairyEditor.FPackageItemType.MOVIECLIP)
        throw new Error("MovieClip 资源不存在，无法撤销或重做");
    const expected = undo ? entry.after : entry.before;
    const next = undo ? entry.before : entry.after;
    if (!movieClipStatesEqual(movieClipFileState(item), expected))
        throw new Error("MovieClip 资源已被其他操作修改，拒绝撤销或重做");
    if (next.fileBase64 === null)
        throw new Error("MovieClip 历史缺少可恢复的资源数据");
    const Convert = CS.System.Convert;
    IOFile.WriteAllBytes(item.file, Convert.FromBase64String(next.fileBase64));
    item.width = next.width;
    item.height = next.height;
    item.exported = next.exported;
    item.UnloadAsset();
    item.SetChanged();
    item.owner.SetChanged();
    App.project.SetChanged();
    return { mode: "agent-movieclip", item: describeItem(item), requiresSave: true, diskWrite: true };
}
async function configureMovieClip(item, params) {
    if (!item || item.type !== FairyEditor.FPackageItemType.MOVIECLIP)
        throw new Error("目标资源不是 MovieClip");
    const recordHistory = params.recordHistory === true;
    const beforeFileState = movieClipFileState(item);
    const asset = await ensureMovieClipAsset(item);
    const animation = asset.animation;
    const framePaths = params.framePaths === undefined ? null : normalizeFramePaths(params.framePaths);
    if (params.fps !== undefined) {
        const fps = nonNegativeInt(params.fps, "fps");
        if (fps < 1 || fps > 255)
            throw new Error("fps 必须是 1 到 255 之间的整数");
    }
    if (params.speed !== undefined)
        numberValue(params.speed, "speed", 0.001, 1000);
    if (params.repeatDelay !== undefined) {
        const repeatDelay = nonNegativeInt(params.repeatDelay, "repeatDelay");
        if (repeatDelay > 255)
            throw new Error("repeatDelay 必须是 0 到 255 之间的额外延迟帧数");
    }
    if (params.frameDelays !== undefined && !Array.isArray(params.frameDelays))
        throw new Error("frameDelays 必须是数组");
    const AniDataType = FairyEditor.AniData;
    const backup = new AniDataType();
    backup.CopyFrom(animation);
    try {
        if (framePaths)
            animation.ImportImages(toCsStringArray(framePaths), Boolean(params.compressPng));
        if (!animation.frameCount)
            throw new Error("MovieClip 至少需要一帧图片");
        if (params.fps !== undefined)
            animation.fps = Number(params.fps);
        if (params.speed !== undefined)
            animation.speed = Number(params.speed);
        if (params.repeatDelay !== undefined)
            animation.repeatDelay = Number(params.repeatDelay);
        if (params.swing !== undefined)
            animation.swing = Boolean(params.swing);
        if (params.frameDelays !== undefined) {
            if (params.frameDelays.length !== animation.frameList.Count)
                throw new Error("frameDelays 必须与 MovieClip 帧数相同");
            for (let index = 0; index < animation.frameList.Count; index++) {
                const delay = nonNegativeInt(params.frameDelays[index], `frameDelays[${index}]`);
                if (delay > 255)
                    throw new Error(`frameDelays[${index}] 必须是 0 到 255 之间的整数`);
                animation.frameList.get_Item(index).delay = delay;
            }
        }
        animation.CalculateBoundsRect();
        if (animation.boundsRect) {
            item.width = Number(animation.boundsRect.width);
            item.height = Number(animation.boundsRect.height);
        }
        if (params.exported !== undefined)
            item.exported = Boolean(params.exported);
        animation.Save(item.file);
        item.SetChanged();
        item.owner.SetChanged();
        App.project.SetChanged();
    }
    catch (error) {
        animation.CopyFrom(backup);
        item.width = beforeFileState.width;
        item.height = beforeFileState.height;
        item.exported = beforeFileState.exported;
        try {
            const Convert = CS.System.Convert;
            if (beforeFileState.fileBase64 === null) {
                if (IOFile.Exists(item.file))
                    IOFile.Delete(item.file);
            }
            else {
                IOFile.WriteAllBytes(item.file, Convert.FromBase64String(beforeFileState.fileBase64));
            }
            item.UnloadAsset();
        }
        catch (_) { /* 尽力恢复磁盘快照，保留原始错误。 */ }
        throw error;
    }
    if (recordHistory)
        pushMovieClipHistory(item, beforeFileState);
    const result = describeLoadedMovieClip(item, asset);
    result.frameSources = framePaths || [];
    result.resourceChanges = framePaths ? framePaths.map((sourcePath, index) => ({ index, sourcePath, operation: "embedded" })) : [];
    return result;
}
async function createMovieClip(params) {
    const pkg = resolvePackage(params);
    const requestedName = validateResourceName(params.movieClipName, "movieClipName");
    const folderPath = normalizePackagePath(params.folderPath);
    const folder = resolvePackageFolder(pkg, folderPath, params.createFolders !== false);
    const policy = normalizeConflictPolicy(params.conflictPolicy);
    let name = requestedName;
    let item = findItemInFolder(pkg, folder, name);
    if (item && policy === "error")
        throw new Error(`资源已存在：${name}`);
    if (item && policy === "auto_rename") {
        name = resolveNewItemName(pkg, folder, name, true);
        item = null;
    }
    if (item && item.type !== FairyEditor.FPackageItemType.MOVIECLIP)
        throw new Error(`同名资源不是 MovieClip：${requestedName}`);
    const created = !item;
    if (!item)
        item = pkg.CreateMovieClipItem(name, folderPath, false);
    if (!item)
        throw new Error(`创建 MovieClip 失败：${name}`);
    try {
        const result = await configureMovieClip(item, { ...params, exported: params.exported !== false, recordHistory: !created });
        if (created)
            clearAgentHistory();
        return {
            operation: created ? "created" : "replaced",
            requestedName,
            actualName: item.name,
            folderPath,
            movieClip: result,
            resourceChanges: [{ operation: created ? "created" : "replaced", item: describeItem(item) }].concat(result.resourceChanges || []),
            packageModified: true,
            requiresSave: true,
            diskWrite: true,
            undoable: !created
        };
    }
    catch (error) {
        if (created) {
            try {
                if (IOFile.Exists(item.file))
                    IOFile.Delete(item.file);
                pkg.DeleteItem(item);
                markPackageChanged(pkg);
            }
            catch (_) { /* 尽力清理本次新建资源，保留原始错误。 */ }
        }
        throw error;
    }
}
async function updateMovieClip(params) {
    const item = resolveItem(params.movieClip || params);
    const updateKeys = ["framePaths", "fps", "speed", "repeatDelay", "swing", "frameDelays", "exported", "compressPng"];
    if (!updateKeys.some((key) => params[key] !== undefined))
        throw new Error("update_movieclip 至少需要提供一个更新字段");
    const result = await configureMovieClip(item, { ...params, recordHistory: true });
    return { operation: "updated", movieClip: result, resourceChanges: result.resourceChanges || [], packageModified: true, requiresSave: true, diskWrite: true, undoable: true };
}
function findMovieClipReferences(item) {
    const references = [];
    const seen = {};
    const add = (value) => {
        if (!seen[value]) {
            seen[value] = true;
            references.push(value);
        }
    };
    try {
        const activeDoc = App.activeDoc;
        if (activeDoc) {
            const matches = [];
            findObjectsByResourceUrl(activeDoc.content, item.GetURL(), matches);
            for (const match of matches)
                add(`${activeDoc.docURL}#${match.id || match.name}`);
        }
    }
    catch (_) { /* 继续执行磁盘引用扫描。 */ }
    const files = IODirectory.GetFiles(App.project.assetsPath, "*.xml", IOSearchOption.AllDirectories);
    const ownBasePath = String(item.owner.basePath || "");
    const url = String(item.GetURL());
    for (let index = 0; index < files.Length; index++) {
        const file = String(files.GetValue(index));
        if (String(IOPath.GetFileName(file)).toLowerCase() === "package.xml")
            continue;
        let text = "";
        try {
            text = String(IOFile.ReadAllText(file));
        }
        catch (_) {
            continue;
        }
        const samePackage = ownBasePath && file.indexOf(ownBasePath) === 0;
        const localReference = samePackage && (text.indexOf(`src="${item.id}"`) >= 0 || text.indexOf(`src='${item.id}'`) >= 0);
        const urlReference = text.indexOf(url) >= 0;
        const crossPackageReference = (text.indexOf(`pkg="${item.owner.id}"`) >= 0 || text.indexOf(`pkg='${item.owner.id}'`) >= 0)
            && (text.indexOf(`src="${item.id}"`) >= 0 || text.indexOf(`src='${item.id}'`) >= 0);
        if (localReference || urlReference || crossPackageReference)
            add(file);
    }
    return references;
}
async function removeMovieClip(params) {
    const item = resolveItem(params.movieClip || params);
    if (item.type !== FairyEditor.FPackageItemType.MOVIECLIP)
        throw new Error("目标资源不是 MovieClip");
    if (params.force !== true)
        throw new Error("删除 MovieClip 是不可逆包资源操作；请显式传 force=true 确认");
    const references = findMovieClipReferences(item);
    if (references.length > 0)
        throw new Error(`MovieClip 正在被引用，不能删除：${references.join(", ")}`);
    const pkg = item.owner;
    const removed = describeLoadedMovieClip(item, await ensureMovieClipAsset(item));
    clearAgentHistory();
    pkg.DeleteItem(item);
    markPackageChanged(pkg);
    return { operation: "removed", movieClip: removed, references, packageModified: true, requiresSave: true, diskWrite: true, undoable: false };
}
async function previewAnimation(params) {
    const kind = String(params.kind || "").toLowerCase();
    const operation = String(params.operation || "").toLowerCase();
    if (["play", "pause", "stop", "seek", "next", "previous", "status"].indexOf(operation) < 0)
        throw new Error(`不支持的预览操作：${operation}`);
    if (kind === "transition") {
        const doc = params.target && params.target.documentUrl ? openDocumentByUrl(String(params.target.documentUrl)) : getActiveDocument();
        const transition = resolveTransition(doc, params.target ? params.target.name : params.name);
        const contextKey = `transition:${doc.docURL}:${transition.name}`;
        const context = animationPreviewContexts[contextKey] || { frame: Number(doc.head) || 0, paused: false };
        let frame = params.frame === undefined
            ? (params.startFrame === undefined ? (context.paused ? context.frame : Number(doc.head) || 0) : nonNegativeInt(params.startFrame, "startFrame"))
            : nonNegativeInt(params.frame, "frame");
        if (operation === "play") {
            const times = params.times === undefined ? 1 : Number(params.times);
            if (!Number.isInteger(times) || times < -1 || times > 1000000)
                throw new Error("times 必须是 -1 到 1000000 之间的整数");
            const delay = params.delay === undefined ? 0 : numberValue(params.delay, "delay", 0);
            const endFrame = params.endFrame === undefined ? -1 : Number(params.endFrame);
            if (!Number.isInteger(endFrame) || endFrame < -1)
                throw new Error("endFrame 必须是 -1 或非负整数");
            transition.Play(undefined, times, delay, frame, endFrame, true);
            animationPreviewContexts[contextKey] = { frame, paused: false, endFrame };
        }
        else if (operation === "pause") {
            transition.Stop(false, false);
            frame = Number(doc.head) || context.frame || 0;
            animationPreviewContexts[contextKey] = { ...context, frame, paused: true };
        }
        else if (operation === "stop") {
            transition.Stop(false, false);
            doc.EnterTimelineMode(transition.name);
            doc.head = 0;
            frame = 0;
            delete animationPreviewContexts[contextKey];
        }
        else if (operation !== "status") {
            doc.EnterTimelineMode(transition.name);
            frame = operation === "next" ? frame + 1 : operation === "previous" ? Math.max(0, frame - 1) : frame;
            doc.head = frame;
            animationPreviewContexts[contextKey] = { ...context, frame, paused: true };
        }
        else {
            frame = Number(doc.head) || context.frame || 0;
        }
        return { kind, operation, transition: describeTransition(transition), frame, playing: Boolean(transition.playing), paused: Boolean(animationPreviewContexts[contextKey] && animationPreviewContexts[contextKey].paused), document: describeDocument(doc), persisted: false };
    }
    if (kind === "movieclip") {
        const doc = getActiveDocument();
        const object = resolveObject(doc, params.target);
        if (String(object.objectType) !== FairyEditor.FObjectType.MOVIECLIP)
            throw new Error("预览目标不是 MovieClip 对象");
        const movieClip = object;
        let frameCount = null;
        if (object.resourceURL) {
            const resourceItem = resolveItem({ url: object.resourceURL });
            const asset = await ensureMovieClipAsset(resourceItem);
            frameCount = Number(asset.animation.frameCount);
        }
        if (operation === "play")
            movieClip.playing = true;
        if (operation === "pause")
            movieClip.playing = false;
        if (operation === "stop") {
            movieClip.playing = false;
            movieClip.frame = 0;
        }
        if (operation === "seek")
            movieClip.frame = nonNegativeInt(params.frame, "frame");
        if (operation === "next")
            movieClip.frame = Number(movieClip.frame) + 1;
        if (operation === "previous")
            movieClip.frame = Math.max(0, Number(movieClip.frame) - 1);
        if (frameCount !== null && movieClip.frame >= frameCount)
            movieClip.frame = Math.max(0, frameCount - 1);
        return { kind, operation, target: { id: object.id, name: object.name, resourceURL: object.resourceURL || null }, playing: Boolean(movieClip.playing), frame: Number(movieClip.frame), frameCount, persisted: false };
    }
    throw new Error("kind 必须是 transition 或 movieclip");
}
const writableProperties = {
    name: true,
    x: true,
    y: true,
    width: true,
    height: true,
    scaleX: true,
    scaleY: true,
    skewX: true,
    skewY: true,
    pivotX: true,
    pivotY: true,
    anchor: true,
    rotation: true,
    alpha: true,
    visible: true,
    touchable: true,
    opaque: true,
    grayed: true,
    enabled: true,
    locked: true,
    hideByEditor: true,
    useSourceSize: true,
    text: true,
    icon: true,
    font: true,
    tooltips: true,
    blendMode: true,
    customData: true,
    notes: true
};
function validatePropertyTarget(doc, obj, property) {
    const isRoot = obj === doc.content;
    if (isRoot && property === "touchable") {
        throw new Error("FairyGUI 组件根节点不序列化 touchable，无法持久化该属性；" +
            "如需让透明根区域不拦截点击，请设置根组件 opaque=false，并分别设置需要穿透的子对象 touchable=false");
    }
    if (property === "opaque" && !isRoot)
        throw new Error("opaque 是组件定义属性，只能对当前文档根组件设置");
}
function getWritableProperty(obj, property) {
    if (property === "opaque")
        return obj.opaque;
    return obj.GetProperty(property);
}
function setWritableProperty(obj, property, value) {
    if (property === "opaque") {
        if (typeof value !== "boolean")
            throw new Error("opaque 只接受布尔值");
        obj.opaque = value;
        return;
    }
    obj.SetProperty(property, value);
}
function valuesEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}
function historyTarget(obj, requestedTarget) {
    if (obj.id)
        return { id: obj.id };
    if (requestedTarget && requestedTarget.path)
        return { path: requestedTarget.path };
    return { path: "root" };
}
function clearAgentHistory() {
    agentUndoStack.length = 0;
    agentRedoStack.length = 0;
}
function openDocumentByUrl(url) {
    const opened = App.docView.OpenDocument(url, true);
    if (!opened)
        throw new Error(`无法打开历史记录对应文档：${url}`);
    return opened;
}
function applyAgentHistory(entry, undo) {
    const doc = openDocumentByUrl(entry.documentUrl);
    const obj = resolveObject(doc, entry.target);
    const expected = undo ? entry.after : entry.before;
    const nextValue = undo ? entry.before : entry.after;
    validatePropertyTarget(doc, obj, entry.property);
    const current = safeValue(getWritableProperty(obj, entry.property));
    if (!valuesEqual(current, expected))
        throw new Error(`对象属性已被其他操作修改，拒绝${undo ? "撤销" : "重做"}：${entry.property}`);
    setWritableProperty(obj, entry.property, nextValue);
    doc.SetModified(undo ? entry.documentModifiedBefore : true);
    doc.RefreshInspectors();
    return {
        mode: "agent-property",
        target: { id: obj.id, name: obj.name, type: obj.objectType },
        property: entry.property,
        before: current,
        after: safeValue(getWritableProperty(obj, entry.property)),
        document: describeDocument(doc)
    };
}
function getActivePackage() {
    const doc = getActiveDocument();
    const item = App.project.GetItemByURL(doc.content.resourceURL);
    if (!item || !item.owner)
        throw new Error("无法从当前文档确定所属包");
    return item.owner;
}
function resolvePublishPackages(params) {
    const scope = String(params.scope || "active");
    const result = [];
    if (scope === "active")
        result.push(getActivePackage());
    else if (scope === "all") {
        for (let i = 0; i < App.project.allPackages.Count; i++)
            result.push(App.project.allPackages.get_Item(i));
    }
    else if (scope === "packages") {
        const names = params.packageNames;
        if (!names || !Array.isArray(names) || names.length === 0)
            throw new Error("scope=packages 时必须提供非空 packageNames");
        const seen = {};
        for (let i = 0; i < names.length; i++) {
            const packageName = String(names[i] || "").trim();
            if (!packageName)
                throw new Error("packageNames 不能包含空名称");
            if (seen[packageName])
                continue;
            const pkg = App.project.GetPackageByName(packageName);
            if (!pkg)
                throw new Error(`未找到包：${packageName}`);
            seen[packageName] = true;
            result.push(pkg);
        }
    }
    else
        throw new Error(`未知发布范围：${scope}`);
    if (result.length === 0)
        throw new Error("没有可发布的 FairyGUI 包");
    return result;
}
function validatePublishBranch(branch) {
    if (!branch)
        return;
    const branches = App.project.allBranches;
    for (let i = 0; i < branches.Count; i++) {
        if (branches.get_Item(i) === branch)
            return;
    }
    throw new Error(`未找到分支：${branch}`);
}
function normalizeOutputPath(path) {
    if (!path)
        return "";
    if (/^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path))
        return path;
    if (IOPath.IsPathRooted(path))
        return IOPath.GetFullPath(path);
    return IOPath.GetFullPath(IOPath.Combine(App.project.basePath, path));
}
function stringListToArray(list) {
    const result = [];
    for (let i = 0; i < list.Count; i++)
        result.push(String(list.get_Item(i)));
    return result;
}
function describePublishSettings(params) {
    const settings = App.project.GetSettings("Publish");
    if (!settings)
        throw new Error("FairyGUI 工程缺少 Publish 设置");
    const packages = [];
    const packageName = params && params.packageName ? String(params.packageName) : "";
    const sourcePackages = [];
    if (packageName) {
        const pkg = App.project.GetPackageByName(packageName);
        if (!pkg)
            throw new Error(`未找到包：${packageName}`);
        sourcePackages.push(pkg);
    }
    else {
        for (let i = 0; i < App.project.allPackages.Count; i++)
            sourcePackages.push(App.project.allPackages.get_Item(i));
    }
    for (let i = 0; i < sourcePackages.length; i++) {
        const pkg = sourcePackages[i];
        const packageSettings = pkg.publishSettings;
        const configuredPath = packageSettings.path || settings.path;
        const configuredCodePath = packageSettings.codePath || settings.codeGeneration.codePath;
        packages.push({
            package: describePackage(pkg),
            path: packageSettings.path,
            effectivePath: normalizeOutputPath(configuredPath),
            fileName: packageSettings.fileName || pkg.name,
            packageCount: packageSettings.packageCount,
            genCode: packageSettings.genCode,
            codePath: packageSettings.codePath,
            effectiveCodePath: packageSettings.genCode ? normalizeOutputPath(configuredCodePath) : "",
            branchPath: packageSettings.branchPath,
            useGlobalAtlasSettings: packageSettings.useGlobalAtlasSettings,
            excludedCount: packageSettings.excludedList ? packageSettings.excludedList.Count : 0
        });
    }
    return {
        largeImageAtlasRule: {
            longSideMin: LARGE_IMAGE_LONG_SIDE_MIN,
            shortSideMin: LARGE_IMAGE_SHORT_SIDE_MIN,
            side2kMin: LARGE_IMAGE_2K_SIDE_MIN,
            atlas: LARGE_IMAGE_ATLAS
        },
        activeBranch: App.project.activeBranch,
        branches: stringListToArray(App.project.allBranches),
        global: {
            path: settings.path,
            effectivePath: normalizeOutputPath(settings.path),
            branchPath: settings.branchPath,
            fileExtension: settings.fileExtension,
            packageCount: settings.packageCount,
            compressDesc: settings.compressDesc,
            binaryFormat: settings.binaryFormat,
            jpegQuality: settings.jpegQuality,
            compressPNG: settings.compressPNG,
            includeHighResolution: settings.includeHighResolution,
            branchProcessing: settings.branchProcessing,
            seperatedAtlasForBranch: settings.seperatedAtlasForBranch,
            codeGeneration: {
                allowGenCode: settings.codeGeneration.allowGenCode,
                codePath: settings.codeGeneration.codePath,
                effectiveCodePath: normalizeOutputPath(settings.codeGeneration.codePath),
                classNamePrefix: settings.codeGeneration.classNamePrefix,
                memberNamePrefix: settings.codeGeneration.memberNamePrefix,
                packageName: settings.codeGeneration.packageName,
                ignoreNoname: settings.codeGeneration.ignoreNoname,
                getMemberByName: settings.codeGeneration.getMemberByName,
                codeType: settings.codeGeneration.codeType
            },
            atlasSetting: {
                maxSize: settings.atlasSetting.maxSize,
                paging: settings.atlasSetting.paging,
                sizeOption: settings.atlasSetting.sizeOption,
                forceSquare: settings.atlasSetting.forceSquare,
                allowRotation: settings.atlasSetting.allowRotation,
                trimImage: settings.atlasSetting.trimImage
            }
        },
        packages
    };
}
function snapshotOutputPaths(paths) {
    const snapshot = {};
    const visited = {};
    for (let i = 0; i < paths.length; i++) {
        const path = normalizeOutputPath(paths[i]);
        if (!path || visited[path] || !IODirectory.Exists(path))
            continue;
        visited[path] = true;
        const files = IODirectory.GetFiles(path, "*", IOSearchOption.AllDirectories);
        for (let j = 0; j < files.Length; j++) {
            const file = String(files.GetValue(j));
            const info = new IOFileInfo(file);
            snapshot[file] = {
                length: String(info.Length),
                modifiedTicks: String(IOFile.GetLastWriteTimeUtc(file).Ticks)
            };
        }
    }
    return snapshot;
}
function diffSnapshots(before, after) {
    const created = [];
    const updated = [];
    const deleted = [];
    for (const path in after) {
        if (!before[path])
            created.push(path);
        else if (before[path].length !== after[path].length || before[path].modifiedTicks !== after[path].modifiedTicks)
            updated.push(path);
    }
    for (const path in before) {
        if (!after[path])
            deleted.push(path);
    }
    created.sort();
    updated.sort();
    deleted.sort();
    const maxReturnedFiles = 1000;
    let remaining = maxReturnedFiles;
    const returnedCreated = created.slice(0, remaining);
    remaining -= returnedCreated.length;
    const returnedUpdated = updated.slice(0, remaining);
    remaining -= returnedUpdated.length;
    const returnedDeleted = deleted.slice(0, remaining);
    return {
        createdCount: created.length,
        updatedCount: updated.length,
        deletedCount: deleted.length,
        truncated: created.length + updated.length + deleted.length > maxReturnedFiles,
        created: returnedCreated,
        updated: returnedUpdated,
        deleted: returnedDeleted
    };
}
function forEachPackageItem(items, visit) {
    if (!items)
        return;
    for (let i = 0; i < items.Count; i++) {
        const item = items.get_Item(i);
        visit(item);
        forEachPackageItem(item.children, visit);
    }
}
function enforceLargeImageAtlasRule(pkg) {
    const changed = [];
    forEachPackageItem(pkg.items, (item) => {
        if (!applyLargeImageAtlasRule(item))
            return;
        changed.push({
            id: item.id,
            name: item.name,
            width: item.width,
            height: item.height,
            folderAtlas: LARGE_IMAGE_ATLAS,
            url: item.GetURL()
        });
    });
    if (changed.length > 0)
        pkg.SetChanged();
    return changed;
}
async function publishPackages(params) {
    if (publishInProgress)
        throw new Error("已有 FairyGUI 发布任务正在执行");
    const packages = resolvePublishPackages(params);
    const branch = params.branch === undefined ? String(App.project.activeBranch || "") : String(params.branch || "");
    const saveBeforePublish = params.saveBeforePublish !== false;
    const publishDescOnly = params.publishDescOnly === true;
    validatePublishBranch(branch);
    const largeImageAtlasChanges = [];
    for (let i = 0; i < packages.length; i++) {
        const changes = enforceLargeImageAtlasRule(packages[i]);
        for (let j = 0; j < changes.length; j++) {
            largeImageAtlasChanges.push({
                package: packages[i].name,
                ...changes[j]
            });
        }
    }
    if (largeImageAtlasChanges.length > 0)
        App.project.SetChanged();
    publishInProgress = true;
    const startedAt = nowIso();
    const startedMs = Date.now();
    const handlers = [];
    try {
        if (saveBeforePublish) {
            App.docView.SaveAllDocuments();
            App.project.Save();
            clearAgentHistory();
        }
        const outputPaths = [];
        for (let i = 0; i < packages.length; i++) {
            const pkg = packages[i];
            pkg.EnsureOpen();
            const handler = new FairyEditor.PublishHandler(pkg, branch);
            handler.publishDescOnly = publishDescOnly;
            handlers.push(handler);
            if (handler.exportPath)
                outputPaths.push(handler.exportPath);
            if (handler.genCode && handler.exportCodePath)
                outputPaths.push(handler.exportCodePath);
        }
        const before = snapshotOutputPaths(outputPaths);
        const published = [];
        for (let i = 0; i < handlers.length; i++) {
            const handler = handlers[i];
            await puer.$promise(handler.Run());
            if (!handler.isSuccess)
                throw new Error(`发布包失败：${handler.pkg.name}`);
            if (handler.exportPath)
                outputPaths.push(handler.exportPath);
            if (handler.genCode && handler.exportCodePath)
                outputPaths.push(handler.exportCodePath);
            published.push({
                package: describePackage(handler.pkg),
                exportPath: normalizeOutputPath(handler.exportPath),
                exportCodePath: handler.genCode ? normalizeOutputPath(handler.exportCodePath) : "",
                fileName: handler.fileName,
                fileExtension: handler.fileExtension,
                generatedCode: handler.genCode,
                publishDescOnly: handler.publishDescOnly
            });
        }
        const after = snapshotOutputPaths(outputPaths);
        return {
            success: true,
            scope: String(params.scope || "active"),
            branch,
            saveBeforePublish,
            publishDescOnly,
            startedAt,
            finishedAt: nowIso(),
            durationMs: Date.now() - startedMs,
            packages: published,
            largeImageAtlasRule: {
                longSideMin: LARGE_IMAGE_LONG_SIDE_MIN,
                shortSideMin: LARGE_IMAGE_SHORT_SIDE_MIN,
                side2kMin: LARGE_IMAGE_2K_SIDE_MIN,
                atlas: LARGE_IMAGE_ATLAS,
                changedCount: largeImageAtlasChanges.length,
                changes: largeImageAtlasChanges
            },
            fileChanges: diffSnapshots(before, after)
        };
    }
    finally {
        publishInProgress = false;
        writeStatus();
    }
}
/** 直属对象属于当前组件文档；嵌套组件的定义须先打开其所属文档再编辑。 */
function requireOwnedEditingTarget(doc, obj, allowRoot) {
    if (allowRoot && obj === doc.content)
        return;
    for (let i = 0; i < doc.content.numChildren; i++)
        if (doc.content.GetChildAt(i) === obj)
            return;
    verificationError("nested_target", "请打开对象所属组件，只能修改当前文档直属对象", {});
}
function editingTarget(params, types = [], allowRoot = false) {
    const doc = getActiveDocument(), obj = resolveObject(doc, params.target);
    requireOwnedEditingTarget(doc, obj, allowRoot);
    if (types.length && types.indexOf(String(obj.objectType).toLowerCase()) < 0)
        verificationError("wrong_object_type", `目标类型必须为 ${types.join("/")}`, { target: targetSummary(obj, params.target) });
    return obj;
}
function componentXmlNode(doc, obj) {
    const item = App.project.GetItemByURL(doc.content.resourceURL);
    if (!item || !item.file || !IOFile.Exists(item.file))
        throw new Error("无法读取组件 XML");
    const root = new CS.FairyGUI.Utils.XML(String(IOFile.ReadAllText(item.file)));
    if (obj === doc.content)
        return root;
    const list = root.GetNode("displayList"), matches = [];
    if (list)
        for (let i = 0; i < list.elements.Count; i++) {
            const node = list.elements.get_Item(i);
            if (String(node.GetAttribute("id")) === String(obj.id))
                matches.push(node);
        }
    if (matches.length !== 1)
        throw new Error("组件 XML 对象不存在或 ID 不唯一");
    return matches[0];
}
/** 以 Editor 自己的序列化快照比对保存结果，保留默认省略、扩展节点和未编辑设置的语义。 */
function finishEditingWrite(doc, obj, before, after, params, changed) {
    let saved = false, persisted = false;
    if (params.save === true) {
        try {
            const expected = gearXmlData(obj.Write());
            doc.Save();
            if (doc.isModified)
                throw new Error("保存后组件仍有未保存修改");
            saved = true;
            if (!valuesEqual(expected, gearXmlData(componentXmlNode(doc, obj))))
                throw new Error("磁盘 XML 与 Editor 序列化快照不一致");
            persisted = true;
            clearAgentHistory();
            untrackedDocumentVersions.delete(doc);
        }
        catch (error) {
            verificationError("persistence_failed", String(error), { before, after, saved, mutationMayHaveOccurred: changed, rollbackAttempted: false });
        }
    }
    return { target: targetSummary(obj, params.target), before, after, changed, saved, persisted,
        documentModified: Boolean(doc.isModified), agentUndoSupported: false, externalReload: false,
        note: "save=true 保存整个当前组件；无完整 Agent 事务撤销，失败不自动回滚。" };
}
function editObjectSettings(doc, obj, params, read, patch, apply) {
    if (params.save !== undefined && typeof params.save !== "boolean")
        throw new Error("save 必须是布尔值");
    const equal = (a, b) => typeof a === "number" && typeof b === "number" ? Math.abs(a - b) <= 0.00001 : valuesEqual(a, b);
    const before = read(), changed = !patch || Object.keys(patch).some(k => !equal(before[k], patch[k]));
    if (changed) {
        invalidateUntrackedHistory(doc);
        try {
            apply();
            const after = read();
            if (patch && Object.keys(patch).some(k => !equal(after[k], patch[k])))
                throw new Error("Editor 未接受全部设置，请检查自动尺寸、分组、控制器及布局约束");
            doc.RefreshInspectors();
        }
        catch (error) {
            verificationError("editor_rejected", String(error), { before, after: read(), mutationMayHaveOccurred: true, rollbackAttempted: false });
        }
    }
    return finishEditingWrite(doc, obj, before, read(), params, changed);
}
function checkedSettings(value, spec) {
    assertKnownKeys(value, Object.keys(spec), "settings");
    if (!Object.keys(value).length)
        throw new Error("settings 必须包含至少一个属性");
    const result = {};
    for (const key of Object.keys(value)) {
        const rule = spec[key], v = value[key];
        if (Array.isArray(rule)) {
            if (rule.indexOf(v) < 0)
                throw new Error(`${key} 只能为 ${rule.join(", ")}`);
        }
        else if (rule === "boolean" || rule === "string") {
            if (typeof v !== rule)
                throw new Error(`${key} 必须是 ${rule}`);
        }
        else {
            numberValue(v, key, rule === "nonnegative" || rule === "int" ? 0 : -1000000, 1000000);
            if (rule === "int" && !Number.isInteger(v))
                throw new Error(`${key} 必须是非负整数`);
        }
        result[key] = v;
    }
    return result;
}
/** 显式尺寸与自动尺寸不能同时作保证；冲突在任何写操作前拒绝。 */
function validateGeometry(obj, patch) {
    const auto = patch.autoSize === undefined ? obj.autoSize : patch.autoSize;
    if ((patch.width !== undefined || patch.height !== undefined) && (auto === true || auto === "both"
        || (auto === "height" && patch.height !== undefined)))
        verificationError("layout_conflict", "显式尺寸与自动尺寸冲突，请同时设置 autoSize=none（文本）或 false（Loader）", { stage: "input" });
    if ((patch.width !== undefined || patch.height !== undefined) && (patch.useSourceSize === undefined ? obj.useSourceSize : patch.useSourceSize))
        verificationError("layout_conflict", "显式尺寸要求 useSourceSize=false", { stage: "input" });
}
function applyGeometry(obj, patch) {
    if (patch.pivotX !== undefined || patch.pivotY !== undefined || patch.anchor !== undefined)
        obj.SetPivot(patch.pivotX === undefined ? obj.pivotX : patch.pivotX, patch.pivotY === undefined ? obj.pivotY : patch.pivotY, patch.anchor === undefined ? obj.anchor : patch.anchor);
    if (patch.width !== undefined || patch.height !== undefined)
        obj.SetSize(patch.width === undefined ? obj.width : patch.width, patch.height === undefined ? obj.height : patch.height, true);
    if (patch.x !== undefined || patch.y !== undefined)
        obj.SetXY(patch.x === undefined ? obj.x : patch.x, patch.y === undefined ? obj.y : patch.y);
}
function setProperties(params) {
    const doc = getActiveDocument(), obj = editingTarget(params, [], true);
    const spec = {};
    for (const k of Object.keys(writableProperties))
        spec[k] = ["visible", "touchable", "opaque", "grayed", "enabled", "locked", "hideByEditor", "anchor", "useSourceSize"].indexOf(k) >= 0 ? "boolean"
            : ["name", "text", "icon", "font", "tooltips", "blendMode", "customData", "notes"].indexOf(k) >= 0 ? "string"
                : ["width", "height"].indexOf(k) >= 0 ? "nonnegative" : "number";
    const text = String(obj.objectType).toLowerCase().indexOf("text") >= 0;
    if (obj.autoSize !== undefined)
        spec.autoSize = text ? ["none", "both", "height", "shrink"] : "boolean";
    const patch = checkedSettings(params.properties, spec);
    for (const k of Object.keys(patch))
        if (obj[k] === undefined)
            verificationError("unsupported_property", `目标对象没有可持久化属性：${k}`, { stage: "input" });
    Object.keys(patch).forEach(k => validatePropertyTarget(doc, obj, k));
    validateGeometry(obj, patch);
    const geometry = ["x", "y", "width", "height", "pivotX", "pivotY", "anchor"];
    const read = () => { const v = {}; Object.keys(patch).forEach(k => v[k] = safeValue(obj[k])); return v; };
    return editObjectSettings(doc, obj, params, read, patch, () => {
        for (const k of Object.keys(patch).filter(k => geometry.indexOf(k) < 0))
            obj[k] = patch[k];
        applyGeometry(obj, patch);
    });
}
function createObject(params) {
    const doc = getActiveDocument(), type = String(params.objectType || "").toLowerCase();
    if (["text", "richtext", "inputtext", "loader", "list", "group", "graph"].indexOf(type) < 0)
        throw new Error("不支持此原生节点类型");
    const name = params.name === undefined ? "" : String(params.name).trim();
    if (name && /[\/\x00-\x1f]/.test(name))
        throw new Error("节点名称不能包含路径分隔符或控制字符");
    for (let i = 0; name && i < doc.content.numChildren; i++)
        if (doc.content.GetChildAt(i).name === name)
            throw new Error("同层节点名称已存在");
    const x = params.x === undefined ? 0 : numberValue(params.x, "x"), y = params.y === undefined ? 0 : numberValue(params.y, "y");
    const width = params.width === undefined ? 100 : numberValue(params.width, "width", 0), height = params.height === undefined ? 30 : numberValue(params.height, "height", 0);
    const index = params.insertIndex === undefined ? -1 : numberValue(params.insertIndex, "insertIndex", -1, doc.content.numChildren);
    if (!Number.isInteger(index))
        throw new Error("insertIndex 必须是整数");
    const memberIds = params.groupMemberIds === undefined ? [] : params.groupMemberIds;
    if (!Array.isArray(memberIds) || memberIds.some(id => typeof id !== "string") || new Set(memberIds).size !== memberIds.length)
        throw new Error("groupMemberIds 必须是不重复的对象 ID 数组");
    if (memberIds.length && type !== "group")
        throw new Error("groupMemberIds 仅适用于分组");
    const members = memberIds.map(id => editingTarget({ target: { id } }));
    // Editor 不序列化空分组；显式保存时须一次提供成员，避免声称创建成功但重开丢失。
    if (type === "group" && params.save === true && !members.length)
        verificationError("empty_group", "空分组不能持久化，请提供 groupMemberIds 或先不保存再添加成员", { stage: "input" });
    invalidateUntrackedHistory(doc);
    let obj;
    try {
        // 使用 Document 原生插入入口，统一生成对象 ID、文档元素和编辑器层级。
        obj = doc.InsertObject(type, new UnityEngine.Vector2(x, y), index);
        if (!obj || String(obj.objectType).toLowerCase() !== type)
            throw new Error("Editor 未创建目标节点类型");
        if (name)
            obj.name = name;
        if (obj.autoSize !== undefined)
            obj.autoSize = type.indexOf("text") >= 0 ? "none" : false;
        if (obj.useSourceSize)
            obj.useSourceSize = false;
        if (type === "group") {
            members.forEach(member => member.groupId = obj.id);
            obj.UpdateImmdediately(); // 分组位置和尺寸由成员边界决定，不拉伸用户成员以满足默认创建尺寸。
        }
        else
            applyGeometry(obj, { width, height, x, y });
        doc.RefreshInspectors();
    }
    catch (error) {
        verificationError("editor_rejected", String(error), { createdObjectId: obj ? obj.id : null, mutationMayHaveOccurred: true });
    }
    return finishEditingWrite(doc, obj, null, describeObject(obj, 0, 0), params, true);
}
function imageSettings(item) {
    if (item.type !== FairyEditor.FPackageItemType.IMAGE)
        throw new Error("目标必须是图片资源");
    const asset = item.GetAsset(), grid = asset.scale9Grid;
    return { resourceURL: item.GetURL(), width: item.width, height: item.height, scaleMode: asset.scaleOption || "none",
        scale9Grid: { x: grid.x, y: grid.y, width: grid.width, height: grid.height }, gridTile: asset.gridTile };
}
function setImageSettings(params) {
    const item = resolveItem(params), before = imageSettings(item), asset = item.GetAsset();
    assertKnownKeys(params.settings, ["scaleMode", "scale9Grid", "gridTile"], "settings");
    if (!Object.keys(params.settings).length)
        throw new Error("settings 不能为空");
    const expected = { ...before, ...params.settings }, modes = ["none", FairyEditor.ImageAsset.SCALE_9GRID, FairyEditor.ImageAsset.SCALE_TILE];
    if (modes.indexOf(expected.scaleMode) < 0)
        throw new Error("scaleMode 必须为 none/9grid/tile");
    if (params.settings.scale9Grid !== undefined || expected.scaleMode === modes[1]) {
        if (expected.scaleMode !== modes[1])
            throw new Error("scale9Grid 仅能用于 9grid 缩放");
        const g = checkedSettings(expected.scale9Grid, { x: "int", y: "int", width: "int", height: "int" });
        if (Object.keys(g).length !== 4 || g.width <= 0 || g.height <= 0 || g.x + g.width > item.width || g.y + g.height > item.height)
            throw new Error("九宫格中心矩形必须为图片原始尺寸内的正整数矩形");
        expected.scale9Grid = { x: g.x, y: g.y, width: g.width, height: g.height };
    }
    if (!Number.isInteger(expected.gridTile) || expected.gridTile < 0 || expected.gridTile > 31)
        throw new Error("gridTile 必须为 0..31 的位标志");
    const changed = !valuesEqual(before, expected);
    if (changed) {
        clearAgentHistory();
        asset.scaleOption = expected.scaleMode === "none" ? "" : expected.scaleMode;
        if (params.settings.scale9Grid !== undefined)
            asset.scale9Grid = new UnityEngine.Rect(expected.scale9Grid.x, expected.scale9Grid.y, expected.scale9Grid.width, expected.scale9Grid.height);
        asset.gridTile = expected.gridTile;
        item.SetChanged();
    }
    const after = imageSettings(item);
    if (!valuesEqual(after, expected))
        verificationError("editor_rejected", "图片设置回读不一致", { before, after, expected, mutationMayHaveOccurred: changed });
    let saved = false, persisted = false;
    if (params.save === true) {
        try {
            const Xml = CS.FairyGUI.Utils.XML, native = Xml.Create("image");
            asset.WriteSettings(native, false);
            item.owner.Save();
            saved = true;
            const xml = new Xml(String(IOFile.ReadAllText(IOPath.Combine(item.owner.basePath, "package.xml")))), resources = xml.GetNode("resources");
            let found = null;
            for (let i = 0; resources && i < resources.elements.Count; i++) {
                const n = resources.elements.get_Item(i);
                if (String(n.GetAttribute("id")) === String(item.id)) {
                    if (found)
                        throw new Error("图片 ID 不唯一");
                    found = n;
                }
            }
            if (!found)
                throw new Error("package.xml 没有目标图片");
            for (const k of Array.from(new Set(["scale", "scale9grid", "gridTile"].concat(Object.keys(gearXmlData(native).attrs)))))
                if (String(native.GetAttribute(k) || "") !== String(found.GetAttribute(k) || ""))
                    throw new Error(`图片 ${k} 未持久化`);
            persisted = true;
        }
        catch (error) {
            verificationError("persistence_failed", String(error), { before, after, saved, mutationMayHaveOccurred: changed });
        }
    }
    return { before, after, changed, saved, persisted, diskWrite: saved, agentUndoSupported: false, scope: "package",
        note: "修改图片资源的包级元数据，影响所有引用；save=true 保存所属整个包，不受组件 save 控制。" };
}
function buttonBinding(obj) {
    const b = obj.extention;
    if (!b || String(obj.extentionId).toLowerCase() !== "button")
        throw new Error("目标必须是 Button 组件实例");
    return { controllerName: b.controller || "", pageId: b.page || "", selected: Boolean(b.selected) };
}
function setButtonBinding(params) {
    const doc = getActiveDocument(), obj = editingTarget(params, ["component"]), before = buttonBinding(obj);
    const patch = checkedSettings(params.settings, { controllerName: "string", pageId: "string", selected: "boolean" });
    const next = { ...before, ...patch };
    if (next.controllerName) {
        const c = resolveController(doc, next.controllerName);
        resolveControllerPage(c, { pageId: next.pageId });
    }
    else {
        if (patch.pageId)
            throw new Error("清除控制器时不能指定页面");
        patch.pageId = "";
    }
    return editObjectSettings(doc, obj, params, () => buttonBinding(obj), patch, () => {
        const b = obj.extention;
        if (patch.controllerName !== undefined)
            b.controller = patch.controllerName;
        if (patch.pageId !== undefined)
            b.page = patch.pageId;
        if (patch.selected !== undefined)
            b.selected = patch.selected;
    });
}
const LIST_SETTING_SPEC = { layout: ["column", "row", "flow_hz", "flow_vt", "pagination"], repeatX: "int", repeatY: "int", lineGap: "number", columnGap: "number",
    align: ["left", "center", "right"], vAlign: ["top", "middle", "bottom"], autoResizeItem: "boolean", selectionMode: ["single", "multiple", "multipleSingleClick", "none"] };
const LOADER_SETTING_SPEC = { fill: ["none", "scale", "scaleMatchHeight", "scaleMatchWidth", "scaleFree", "scaleNoBorder"], align: ["left", "center", "right"],
    vAlign: ["top", "middle", "bottom"], autoSize: "boolean", shrinkOnly: "boolean", useResize: "boolean" };
function readSimpleSettings(obj, spec) {
    const out = {};
    for (const k of Object.keys(spec))
        out[k] = safeValue(obj[k === "vAlign" ? "verticalAlign" : k]);
    return out;
}
function setSimpleSettings(params, type, spec) {
    const doc = getActiveDocument(), obj = editingTarget(params, [type]), patch = checkedSettings(params.settings, spec);
    return editObjectSettings(doc, obj, params, () => readSimpleSettings(obj, spec), patch, () => {
        // 自动布局开关先写，避免后续尺寸或位置变更被旧状态覆盖。
        if (patch.autoSize !== undefined)
            obj.autoSize = patch.autoSize;
        for (const k of Object.keys(patch))
            obj[k === "vAlign" ? "verticalAlign" : k] = patch[k];
    });
}
function scrollTarget(params) {
    const obj = editingTarget(params, [], true);
    if (obj !== getActiveDocument().content && String(obj.objectType).toLowerCase() !== "list")
        throw new Error("ScrollPane 设置只支持当前组件根或原生 List；子组件需打开其所属文档");
    return obj;
}
function scrollSettings(obj) {
    return { overflow: obj.overflow, scroll: obj.scroll, scrollBarDisplay: obj.scrollBarDisplay, scrollBarFlags: obj.scrollBarFlags,
        pageMode: Boolean(obj.scrollBarFlags & FairyEditor.FScrollPane.PAGE_MODE), pageControllerName: obj.pageController || "" };
}
function setScrollSettings(params) {
    const doc = getActiveDocument(), obj = scrollTarget(params), patch = checkedSettings(params.settings, { overflow: ["visible", "hidden", "scroll"], scroll: ["horizontal", "vertical", "both"],
        scrollBarDisplay: ["default", "visible", "auto", "hidden"], scrollBarFlags: "int", pageMode: "boolean", pageControllerName: "string" });
    if (patch.pageControllerName)
        resolveController(doc, patch.pageControllerName);
    const flag = FairyEditor.FScrollPane.PAGE_MODE;
    if (patch.pageMode !== undefined && patch.scrollBarFlags !== undefined && Boolean(patch.scrollBarFlags & flag) !== patch.pageMode)
        throw new Error("pageMode 与 scrollBarFlags 冲突");
    if (patch.pageMode !== undefined)
        patch.scrollBarFlags = patch.pageMode ? (patch.scrollBarFlags === undefined ? obj.scrollBarFlags : patch.scrollBarFlags) | flag
            : (patch.scrollBarFlags === undefined ? obj.scrollBarFlags : patch.scrollBarFlags) & ~flag;
    return editObjectSettings(doc, obj, params, () => scrollSettings(obj), patch, () => {
        for (const k of ["overflow", "scroll", "scrollBarDisplay", "scrollBarFlags", "pageControllerName"])
            if (patch[k] !== undefined)
                obj[k === "pageControllerName" ? "pageController" : k] = patch[k];
    });
}
function setGroup(params) {
    const doc = getActiveDocument(), obj = editingTarget(params), id = params.groupId;
    if (typeof id !== "string")
        throw new Error("groupId 必须是字符串，空字符串表示解除分组");
    if (id) {
        const group = editingTarget({ target: { id } }, ["group"]);
        let current = group;
        const visited = new Set();
        while (current) {
            if (current === obj || visited.has(current.id))
                throw new Error("不能建立循环分组");
            visited.add(current.id);
            current = current.groupId ? findObjectById(doc.content, current.groupId) : null;
        }
    }
    return editObjectSettings(doc, obj, params, () => ({ groupId: obj.groupId || "" }), { groupId: id }, () => obj.groupId = id);
}
const RELATION_NAMES = ["Left_Left", "Left_Center", "Left_Right", "Center_Center", "Right_Left", "Right_Center", "Right_Right", "LeftExt_Left", "LeftExt_Right", "RightExt_Left", "RightExt_Right", "Width",
    "Top_Top", "Top_Middle", "Top_Bottom", "Middle_Middle", "Bottom_Top", "Bottom_Middle", "Bottom_Bottom", "TopExt_Top", "TopExt_Bottom", "BottomExt_Top", "BottomExt_Bottom", "Height"];
function relationsSnapshot(obj) {
    const out = [], items = obj.relations.items;
    for (let i = 0; i < items.Count; i++) {
        const item = items.get_Item(i), defs = [];
        for (let j = 0; j < item.defs.Count; j++) {
            const d = item.defs.get_Item(j), name = RELATION_NAMES.find(k => FairyEditor.FRelationType[k] === d.type);
            defs.push({ relationType: name || String(d.type), usePercent: Boolean(d.percent) });
        }
        out.push({ targetId: item.target === obj.parent ? "parent" : item.target.id, readOnly: Boolean(item.readOnly), definitions: defs });
    }
    return out;
}
function editRelation(params, remove) {
    const doc = getActiveDocument(), obj = editingTarget(params), id = params.relationTargetId || "parent";
    const target = id === "parent" ? doc.content : editingTarget({ target: { id } });
    const name = String(params.relationType || "").replace(/-/g, "_").toLowerCase(), key = RELATION_NAMES.find(k => k.toLowerCase() === name);
    if (!key)
        throw new Error("未知关系类型，请使用 get_relations 返回的 relationTypes");
    if (target === obj)
        throw new Error("关系目标不能是自身");
    const seen = new Set(), reaches = (node) => {
        if (node === obj)
            return true;
        if (seen.has(node))
            return false;
        seen.add(node);
        const items = node.relations.items;
        for (let i = 0; i < items.Count; i++)
            if (reaches(items.get_Item(i).target))
                return true;
        return false;
    };
    if (!remove && reaches(target))
        throw new Error("不能建立循环关系");
    if (params.usePercent !== undefined && typeof params.usePercent !== "boolean")
        throw new Error("usePercent 必须是布尔值");
    const type = FairyEditor.FRelationType[key], old = obj.relations.GetItem(target);
    if (old && old.readOnly)
        throw new Error("不能改写继承的只读关系");
    let previous = null;
    if (old)
        for (let i = 0; i < old.defs.Count; i++)
            if (old.defs.get_Item(i).type === type)
                previous = old.defs.get_Item(i);
    const changed = remove ? Boolean(previous) : !previous || Boolean(previous.percent) !== Boolean(params.usePercent);
    if (!changed)
        return finishEditingWrite(doc, obj, relationsSnapshot(obj), relationsSnapshot(obj), params, false);
    return editObjectSettings(doc, obj, params, () => ({ relations: relationsSnapshot(obj) }), null, () => {
        if (old) {
            const keep = [];
            for (let i = 0; i < old.defs.Count; i++) {
                const d = old.defs.get_Item(i);
                if (d.type !== type)
                    keep.push({ type: d.type, percent: d.percent });
            }
            obj.relations.RemoveItem(old);
            keep.forEach(d => obj.relations.AddItem(target, d.type, d.percent));
        }
        if (!remove)
            obj.relations.AddItem(target, type, Boolean(params.usePercent));
        const now = obj.relations.GetItem(target);
        if (remove ? now && now.HasDef(type) : !now || !now.HasDef(type))
            throw new Error("Editor 未接受关系变更");
    });
}
// A revision is opaque and process-local; full native snapshots detect out-of-band Editor edits.
const documentRevisions = new WeakMap();
let nextDocumentRevision = 0;
const revisionEpoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const externalEditTickets = Object.create(null);
function editorDocumentSnapshot(doc) {
    return String(doc.content.Write_editMode().ToXMLString(false));
}
function documentRevision(doc) {
    const snapshot = editorDocumentSnapshot(doc), previous = documentRevisions.get(doc);
    if (previous && previous.snapshot === snapshot && previous.savedVersion === doc.savedVersion && previous.modified === Boolean(doc.isModified))
        return previous.revision;
    const revision = `${revisionEpoch}:${++nextDocumentRevision}`;
    documentRevisions.set(doc, { snapshot, savedVersion: doc.savedVersion, modified: Boolean(doc.isModified), revision });
    return revision;
}
function guardedDocument(url, expectedRevision) {
    if (typeof url !== "string" || !url.startsWith("ui://"))
        throw new Error("documentUrl 必须是明确的组件 URL");
    const doc = getActiveDocument();
    if (doc.content.resourceURL !== url)
        verificationError("wrong_document", "活动文档与计划目标不符", { expected: url, actual: doc.content.resourceURL });
    if (expectedRevision !== undefined && expectedRevision !== documentRevision(doc))
        verificationError("stale_revision", "文档已变化，请重新读取后制定计划", { expected: expectedRevision, actual: documentRevision(doc) });
    return doc;
}
const OBJECT_QUERY_FIELDS = ["x", "y", "width", "height", "scaleX", "scaleY", "pivotX", "pivotY", "anchor", "rotation", "alpha", "visible", "touchable", "opaque", "grayed", "enabled", "text", "icon", "font", "fontSize", "autoSize", "groupId"];
function getObjects(params) {
    const doc = guardedDocument(params.documentUrl);
    if (!Array.isArray(params.targets) || params.targets.length > 200)
        throw new Error("targets 必须是最多 200 项的数组，空数组仅取 revision");
    const fields = params.fields === undefined ? ["x", "y", "width", "height"] : params.fields;
    if (!Array.isArray(fields) || fields.some(field => typeof field !== "string" || OBJECT_QUERY_FIELDS.indexOf(field) < 0))
        throw new Error("fields 包含不支持的读取字段");
    const objects = params.targets.map(target => {
        validateBatchTarget(target);
        const obj = resolveObject(doc, target);
        requireOwnedEditingTarget(doc, obj, true);
        const value = { id: String(obj.id), name: String(obj.name), type: String(obj.objectType) };
        fields.forEach(field => value[field] = safeValue(obj[field]));
        return value;
    });
    return { documentUrl: doc.content.resourceURL, revision: documentRevision(doc), modified: Boolean(doc.isModified), objects };
}
const BATCH_FIELDS = {
    create_object: ["objectType", "name", "x", "y", "width", "height", "insertIndex", "groupMemberIds"],
    insert_object: ["url", "name", "x", "y", "insertIndex"],
    set_properties: ["target", "properties"], set_text_style: ["target", "style"],
    set_button_binding: ["target", "settings"], set_list_settings: ["target", "settings"],
    set_scroll_settings: ["target", "settings"], set_loader: ["target", "settings"], set_group: ["target", "groupId"],
    add_relation: ["target", "relationTargetId", "relationType", "usePercent"], remove_relation: ["target", "relationTargetId", "relationType"],
    set_gear: ["target", "gearType", "controllerName", "defaultValue", "pageValues", "visiblePageIds"],
    create_controller: ["name", "pages"], set_controller_page: ["controllerName", "pageId", "pageName", "pageIndex"],
    set_component_instance_controller: ["target", "controllerName", "pageId", "pageName", "pageIndex"],
    set_component_instance_property: ["target", "childPath", "propertyId", "value"],
    upsert_component_property: ["childPath", "propertyId", "label"], remove_component_property: ["childPath", "propertyId"],
    set_controller_properties: ["controllerName", "settings"],
    remove_object: ["target"]
};
function validateBatchTarget(target) {
    if (!target || typeof target !== "object" || Array.isArray(target) || Object.keys(target).length !== 1
        || ["id", "path", "name"].indexOf(Object.keys(target)[0]) < 0 || typeof target[Object.keys(target)[0]] !== "string" || !target[Object.keys(target)[0]])
        throw new Error("target 必须且只能提供非空 id/path/name 之一");
}
function batchReference(value, aliases) {
    if (typeof value === "string" && value.startsWith("$")) {
        const key = value.slice(1);
        if (!Object.prototype.hasOwnProperty.call(aliases, key))
            throw new Error(`未知或前向 ref：${value}`);
        return aliases[key];
    }
    return value;
}
function batchParams(params, aliases) {
    const value = JSON.parse(JSON.stringify(params));
    if (value.target && value.target.id)
        value.target.id = batchReference(value.target.id, aliases);
    for (const key of ["groupId", "relationTargetId"])
        if (value[key] !== undefined)
            value[key] = batchReference(value[key], aliases);
    if (Array.isArray(value.groupMemberIds))
        value.groupMemberIds = value.groupMemberIds.map(id => batchReference(id, aliases));
    return value;
}
function validateBatch(params, doc) {
    if (!Array.isArray(params.operations) || params.operations.length < 1 || params.operations.length > 200)
        throw new Error("operations 必须包含 1..200 项");
    if (JSON.stringify(params.operations).length > 262144)
        throw new Error("批量计划超过 256 KiB 字符限制");
    for (const key of ["save", "dryRun", "verbose"])
        if (params[key] !== undefined && typeof params[key] !== "boolean")
            throw new Error(`${key} 必须是布尔值`);
    const aliases = Object.create(null), names = new Set();
    for (let i = 0; i < doc.content.numChildren; i++)
        names.add(String(doc.content.GetChildAt(i).name));
    params.operations.forEach((op, index) => {
        if (!op || typeof op !== "object" || Array.isArray(op) || Object.keys(op).some(key => ["action", "params", "ref"].indexOf(key) < 0)
            || !Object.prototype.hasOwnProperty.call(BATCH_FIELDS, op.action))
            throw new Error(`第 ${index} 项不是允许的批量操作`);
        const value = op.params;
        if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => BATCH_FIELDS[op.action].indexOf(key) < 0))
            throw new Error(`第 ${index} 项包含未知或禁止参数（禁止单步保存/切换文档/资源写入）`);
        const creates = op.action === "create_object" || op.action === "insert_object";
        if (op.ref !== undefined && (!creates || typeof op.ref !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(op.ref) || Object.prototype.hasOwnProperty.call(aliases, op.ref)))
            throw new Error(`第 ${index} 项 ref 无效或重复`);
        if (BATCH_FIELDS[op.action].indexOf("target") >= 0) {
            validateBatchTarget(value.target);
            const id = value.target.id;
            if (typeof id === "string" && id.startsWith("$"))
                batchReference(id, aliases);
            else
                requireOwnedEditingTarget(doc, resolveObject(doc, value.target), op.action === "set_properties" || op.action === "set_scroll_settings");
        }
        for (const key of ["groupId", "relationTargetId"])
            if (typeof value[key] === "string" && value[key].startsWith("$"))
                batchReference(value[key], aliases);
        if (value.groupMemberIds !== undefined) {
            if (!Array.isArray(value.groupMemberIds))
                throw new Error("groupMemberIds 必须是数组");
            value.groupMemberIds.forEach(id => {
                if (typeof id === "string" && id.startsWith("$"))
                    batchReference(id, aliases);
                else
                    requireOwnedEditingTarget(doc, resolveObject(doc, { id }), false);
            });
        }
        if (op.action === "set_properties" && (!value.properties || typeof value.properties !== "object" || Array.isArray(value.properties)
            || Object.keys(value.properties).some(key => !Object.prototype.hasOwnProperty.call(writableProperties, key) && key !== "autoSize")))
            throw new Error("properties 包含未知字段");
        if (op.action === "create_object" && ["text", "richtext", "inputtext", "loader", "list", "group", "graph"].indexOf(value.objectType) < 0)
            throw new Error("不支持此原生节点类型");
        if (op.action === "insert_object") {
            const item = resolveItem(value);
            if ([FairyEditor.FPackageItemType.IMAGE, FairyEditor.FPackageItemType.COMPONENT].indexOf(item.type) < 0)
                throw new Error("批量插入仅允许 Image/Component；复杂资源使用专用入口");
        }
        if (creates && value.name) {
            if (typeof value.name !== "string" || /[\/\x00-\x1f]/.test(value.name) || names.has(value.name))
                throw new Error("创建名称无效或同层重复");
            names.add(value.name);
        }
        if (op.ref !== undefined)
            aliases[op.ref] = true;
    });
}
function batchReceiptPath(key) {
    if (typeof key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(key))
        throw new Error("operationKey 必须为 1..96 位字母数字、横线或下划线");
    return IOPath.Combine(IOPath.GetDirectoryName(instanceStatusFile), "batch-results", `${key}.json`);
}
function compactBatchReceipt(receipt, verbose) {
    const result = { operationKey: receipt.operationKey, documentUrl: receipt.documentUrl, status: receipt.status,
        completed: receipt.results.length, total: receipt.total, aliases: receipt.aliases, saved: Boolean(receipt.saved), persisted: Boolean(receipt.persisted),
        revision: receipt.revision, error: receipt.error || null, mutationMayHaveOccurred: Boolean(receipt.mutationMayHaveOccurred),
        agentUndoSupported: false, note: "批量不是原子事务；失败停止且不自动回滚。仅显式整批 save；保存阶段错误以 saved/persisted 为准。超时先查询 operationKey。" };
    if (verbose)
        result.results = receipt.results;
    else
        result.changed = receipt.results.filter(value => value.result.changed !== false).length;
    return result;
}
function getBatchResult(params) {
    const path = batchReceiptPath(params.operationKey);
    if (!IOFile.Exists(path))
        return { operationKey: params.operationKey, status: "unknown", retrySafe: false, note: "仅当前 Editor 进程实例回执有效；unknown 不代表未执行。" };
    const receipt = JSON.parse(IOFile.ReadAllText(path));
    if (params.documentUrl !== receipt.documentUrl)
        throw new Error("回执不属于目标文档");
    return compactBatchReceipt(receipt, params.verbose === true);
}
function stablePlan(value) {
    if (Array.isArray(value))
        return `[${value.map(stablePlan).join(",")}]`;
    if (value && typeof value === "object")
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stablePlan(value[key])}`).join(",")}}`;
    return JSON.stringify(value);
}
function applyBatch(params, request) {
    const path = batchReceiptPath(params.operationKey);
    const fingerprint = stablePlan({ documentUrl: params.documentUrl, expectedRevision: params.expectedRevision, operations: params.operations, save: params.save === true });
    if (IOFile.Exists(path) && params.dryRun !== true) {
        const receipt = JSON.parse(IOFile.ReadAllText(path));
        if (receipt.fingerprint !== fingerprint)
            verificationError("operation_key_reused", "operationKey 已绑定其他参数；请使用新的操作键", {});
        return { ...compactBatchReceipt(receipt, params.verbose === true), replayed: true };
    }
    if (typeof params.expectedRevision !== "string" || !params.expectedRevision)
        throw new Error("批量操作必须提供读取时的 expectedRevision");
    const doc = guardedDocument(params.documentUrl, params.expectedRevision);
    validateBatch(params, doc);
    if (params.dryRun === true)
        return { status: "preflight", total: params.operations.length, revision: documentRevision(doc), mutationPerformed: false,
            note: "仅预检结构、作用域与引用；动态原生属性约束在执行时校验，不保证整批原子性。" };
    const receipt = { operationKey: params.operationKey, documentUrl: params.documentUrl, fingerprint, status: "running", total: params.operations.length,
        results: [], aliases: Object.create(null), saved: false, persisted: false, mutationMayHaveOccurred: true };
    ensureDirectory(IOPath.GetDirectoryName(path));
    writeJsonAtomic(path, receipt); // Write before the first mutation: an interrupted execution can never silently replay.
    try {
        params.operations.forEach((operation, index) => {
            guardedDocument(params.documentUrl);
            const value = { ...batchParams(operation.params, receipt.aliases), save: false };
            if (operation.action === "insert_object")
                value.fixSpine = false;
            receipt.mutationMayHaveOccurred = true;
            const result = handleCommand({ ...request, action: operation.action, params: value });
            if (result && typeof result.then === "function")
                throw new Error("批量不支持异步操作");
            if (operation.ref) {
                const id = result.target && result.target.id || result.id;
                if (!id)
                    throw new Error("原生创建未返回对象 ID");
                receipt.aliases[operation.ref] = String(id);
            }
            receipt.results.push({ index, action: operation.action, ref: operation.ref, result });
            writeJsonAtomic(path, receipt);
        });
        if (params.save === true) {
            // Empty groups are omitted by native serialization, so validate them before the only save.
            for (let index = 0; index < doc.content.numChildren; index++) {
                const obj = doc.content.GetChildAt(index);
                if (String(obj.objectType) === "group") {
                    let members = 0;
                    for (let i = 0; i < doc.content.numChildren; i++)
                        if (doc.content.GetChildAt(i).groupId === obj.id)
                            members++;
                    if (!members)
                        throw new Error("空分组不能持久化；批量未保存");
                }
            }
            const expected = gearXmlData(doc.content.Write_editMode());
            doc.Save();
            receipt.saved = !doc.isModified;
            if (!receipt.saved || !valuesEqual(expected, gearXmlData(componentXmlNode(doc, doc.content))))
                throw new Error("批量保存后的 XML 与原生快照不一致");
            receipt.persisted = true;
            clearAgentHistory();
            untrackedDocumentVersions.delete(doc);
        }
        receipt.status = "succeeded";
    }
    catch (error) {
        receipt.status = "failed";
        receipt.error = { index: receipt.results.length, code: error.code || "batch_failed", message: String(error), details: error.details || null };
    }
    receipt.revision = documentRevision(doc);
    writeJsonAtomic(path, receipt);
    return compactBatchReceipt(receipt, params.verbose === true);
}
function captureStates(params, requestId) {
    const doc = guardedDocument(params.documentUrl), states = params.states;
    const snapshotBefore = editorDocumentSnapshot(doc);
    if (!Array.isArray(states) || states.length < 1 || states.length > 12)
        throw new Error("states 必须包含 1..12 项");
    const originals = Object.create(null), labels = new Set();
    const prepared = states.map(state => {
        if (!state || Object.keys(state).some(key => ["label", "controllers"].indexOf(key) < 0) || typeof state.label !== "string" || !state.label.trim() || state.label.length > 80 || labels.has(state.label))
            throw new Error("状态标签必须非空、唯一且最多 80 字符");
        labels.add(state.label);
        if (!state.controllers || typeof state.controllers !== "object" || Array.isArray(state.controllers))
            throw new Error("controllers 必须是名称到页面 ID 的对象");
        const changes = Object.keys(state.controllers).map(name => {
            const controller = resolveController(doc, name), page = resolveControllerPage(controller, { pageId: state.controllers[name] });
            if (!Object.prototype.hasOwnProperty.call(originals, name))
                originals[name] = { controller, index: controller.selectedIndex };
            return { controller, index: page.index };
        });
        return { label: state.label, controllers: state.controllers, changes };
    });
    const captures = [], restoreErrors = [];
    let failure = null;
    try {
        prepared.forEach((state, index) => {
            guardedDocument(params.documentUrl);
            Object.keys(originals).forEach(name => originals[name].controller.selectedIndex = originals[name].index);
            state.changes.forEach(change => change.controller.selectedIndex = change.index);
            const result = captureDocument({ scale: params.scale === undefined ? 0.5 : params.scale, expectedDocumentUrl: params.documentUrl }, `${requestId}-${index}`);
            captures.push({ label: state.label, controllers: state.controllers, ...result });
            if (result.visualVerificationStatus === "manual_required")
                throw new Error(result.reason);
        });
    }
    catch (error) {
        failure = String(error);
    }
    finally {
        for (const name of Object.keys(originals)) {
            try {
                originals[name].controller.selectedIndex = originals[name].index;
            }
            catch (error) {
                restoreErrors.push({ controller: name, error: String(error) });
            }
        }
    }
    const snapshotRestored = editorDocumentSnapshot(doc) === snapshotBefore;
    return { documentUrl: params.documentUrl, captures, restored: restoreErrors.length === 0 && snapshotRestored, snapshotRestored, restoreErrors,
        error: failure, modified: Boolean(doc.isModified), saved: false, visualVerificationStatus: failure || restoreErrors.length || !snapshotRestored ? "manual_required" : "pending_review" };
}
function beginExternalEdit(params, requestId) {
    const doc = guardedDocument(params.documentUrl);
    if (doc.isModified)
        verificationError("document_dirty", "外部编辑交接前文档必须已保存；不会自动保存或放弃", {});
    if (Object.keys(externalEditTickets).length >= 32)
        throw new Error("外部编辑令牌过多，请完成已有交接或重载插件");
    const token = safeRequestId(requestId);
    externalEditTickets[token] = { doc, url: params.documentUrl, snapshot: editorDocumentSnapshot(doc), file: String(doc.packageItem.file) };
    return { token, documentUrl: params.documentUrl, file: String(doc.packageItem.file), revision: documentRevision(doc), modified: false,
        note: "只读交接；可在已授权范围修改该 XML。完成后使用令牌重载，期间不要编辑此文档。" };
}
function finishExternalEdit(params) {
    const ticket = externalEditTickets[params.token];
    if (!ticket)
        throw new Error("外部编辑令牌未知、已使用或插件已重载");
    const doc = guardedDocument(params.documentUrl);
    if (ticket.doc !== doc || ticket.url !== params.documentUrl || ticket.file !== String(doc.packageItem.file))
        throw new Error("令牌与当前原生文档实例不一致");
    if (editorDocumentSnapshot(doc) !== ticket.snapshot)
        verificationError("editor_changed", "交接期间 Editor 文档已变化，拒绝放弃内存内容", {});
    if (doc.isModified && params.allowUnchangedDirty !== true)
        verificationError("document_dirty", "文档已标记 dirty；仅完整快照不变时可显式 allowUnchangedDirty", {});
    const disk = String(IOFile.ReadAllText(ticket.file));
    const xml = new CS.FairyGUI.Utils.XML(disk);
    if (String(xml.name) !== "component")
        throw new Error("外部 XML 根节点必须为 component");
    const display = xml.GetNode("displayList"), ids = new Set();
    if (display)
        for (let index = 0; index < display.elements.Count; index++) {
            const id = String(display.elements.get_Item(index).GetAttribute("id") || "");
            if (!id || ids.has(id))
                throw new Error("外部 XML 存在空或重复控件 ID，拒绝重载");
            ids.add(id);
        }
    doc.DiscardChanges();
    if (String(IOFile.ReadAllText(ticket.file)) !== disk)
        throw new Error("重载期间 XML 又发生变化，请重新核对磁盘与 Editor");
    delete externalEditTickets[params.token];
    clearAgentHistory();
    untrackedDocumentVersions.delete(doc);
    return { documentUrl: params.documentUrl, reloaded: true, modified: Boolean(doc.isModified), revision: documentRevision(doc), saved: false,
        note: "仅重载已授权外部写入；未执行保存或发布。请使用 get_objects 和截图验收。" };
}
function handleCommand(request) {
    const action = String(request.action || "");
    const params = request.params || {};
    const requestProtocol = String(request.protocolVersion || "");
    if (requestProtocol && requestProtocol.split(".")[0] !== PROTOCOL_VERSION.split(".")[0])
        throw new Error(`协议版本不兼容：编辑器 ${PROTOCOL_VERSION}，客户端 ${requestProtocol}`);
    if (request.projectPath) {
        const expected = String(IOPath.GetFullPath(request.projectPath)).replace(/[\\/]+$/, "");
        const actual = App.project && App.project.opened ? String(IOPath.GetFullPath(App.project.basePath)).replace(/[\\/]+$/, "") : "";
        const windows = String(IOPath.DirectorySeparatorChar) === "\\" || Number(IOPath.DirectorySeparatorChar) === 92;
        if (windows ? expected.toLowerCase() !== actual.toLowerCase() : expected !== actual)
            throw new Error("请求目标工程与编辑器当前工程不一致，拒绝执行");
    }
    if (loader3dBusy && ["ping", "get_project", "get_active_document", "list_packages", "list_items", "get_batch_result"].indexOf(action) < 0)
        verificationError("document_busy", "Loader3D 加载中，请等待当前请求完成", {});
    const actionsBlockedDuringPublish = {
        apply_batch: true, capture_states: true, begin_external_edit: true, finish_external_edit: true,
        set_image_settings: true, create_object: true, set_properties: true, set_button_binding: true, set_list_settings: true,
        set_component_instance_controller: true, set_component_instance_property: true, upsert_component_property: true,
        remove_component_property: true, set_controller_properties: true,
        set_scroll_settings: true, set_group: true, add_relation: true, remove_relation: true, set_loader: true,
        set_text_style: true, replace_object_resource: true,
        set_gear: true,
        upsert_controller_action: true, remove_controller_action: true,
        create_controller: true, add_controller_page: true, rename_controller_page: true, set_controller_page: true,
        get_loader3d: true, set_loader3d: true, capture_document: true, fix_spine_anchor: true,
        open_document: true,
        create_component: true,
        import_image: true,
        import_font: true,
        create_button: true,
        import_sound: true,
        create_movieclip: true,
        update_movieclip: true,
        remove_movieclip: true,
        upsert_transition: true,
        remove_transition: true,
        add_transition_item: true,
        update_transition_item: true,
        remove_transition_item: true,
        select_object: true,
        set_property: true,
        insert_object: true,
        remove_object: true,
        save_document: true,
        save_all: true,
        discard_document: true,
        undo: true,
        redo: true
    };
    if (publishInProgress && actionsBlockedDuringPublish[action])
        throw new Error(`FairyGUI 发布进行中，暂不能执行：${action}`);
    switch (action) {
        case "get_objects": return getObjects(params);
        case "get_component_instance": return getComponentInstance(params);
        case "set_component_instance_controller": return setComponentInstanceController(params);
        case "set_component_instance_property": return setComponentInstanceProperty(params);
        case "get_component_properties": return getComponentProperties();
        case "upsert_component_property": return editComponentProperty(params, false);
        case "remove_component_property": return editComponentProperty(params, true);
        case "set_controller_properties": return setControllerProperties(params);
        case "apply_batch": return applyBatch(params, request);
        case "get_batch_result": return getBatchResult(params);
        case "capture_states": return captureStates(params, request.id || String(Date.now()));
        case "begin_external_edit": return beginExternalEdit(params, request.id || String(Date.now()));
        case "finish_external_edit": return finishExternalEdit(params);
        case "get_image_settings": return { settings: imageSettings(resolveItem(params)), scope: "package" };
        case "set_image_settings": return setImageSettings(params);
        case "create_object": return createObject(params);
        case "set_properties": return setProperties(params);
        case "get_button_binding": {
            const obj = editingTarget(params, ["component"]);
            return { target: targetSummary(obj, params.target), binding: buttonBinding(obj), controllers: controllerList(getActiveDocument()).map(controllerSnapshot) };
        }
        case "set_button_binding": return setButtonBinding(params);
        case "get_list_settings": {
            const obj = editingTarget(params, ["list"]);
            return { target: targetSummary(obj, params.target), settings: readSimpleSettings(obj, LIST_SETTING_SPEC) };
        }
        case "set_list_settings": return setSimpleSettings(params, "list", LIST_SETTING_SPEC);
        case "get_scroll_settings": {
            const obj = scrollTarget(params);
            return { target: targetSummary(obj, params.target), settings: scrollSettings(obj) };
        }
        case "set_scroll_settings": return setScrollSettings(params);
        case "get_group": {
            const obj = editingTarget(params);
            return { target: targetSummary(obj, params.target), groupId: obj.groupId || "" };
        }
        case "set_group": return setGroup(params);
        case "get_relations": {
            const obj = editingTarget(params);
            return { target: targetSummary(obj, params.target), relations: relationsSnapshot(obj), relationTypes: RELATION_NAMES };
        }
        case "add_relation": return editRelation(params, false);
        case "remove_relation": return editRelation(params, true);
        case "get_loader": {
            const obj = editingTarget(params, ["loader"]);
            return { target: targetSummary(obj, params.target), settings: readSimpleSettings(obj, LOADER_SETTING_SPEC) };
        }
        case "set_loader": return setSimpleSettings(params, "loader", LOADER_SETTING_SPEC);
        case "get_gears": return getGears(params);
        case "get_controller_actions": return getControllerActions(params);
        case "upsert_controller_action":
        case "remove_controller_action": return editControllerAction(action, params);
        case "set_gear": return setGear(params);
        case "get_controllers": return { documentUrl: getActiveDocument().content.resourceURL, controllers: controllerList(getActiveDocument()).map(controllerSnapshot) };
        case "create_controller":
        case "add_controller_page":
        case "rename_controller_page":
        case "set_controller_page": return editController(action, params);
        case "get_loader3d": return getLoader3d(params);
        case "fix_spine_anchor": return fixSpineResource(resolveItem(params));
        case "set_loader3d": return setLoader3d(params);
        case "capture_document": return captureDocument(params, request.id || String(Date.now()));
        case "ping":
            return {
                bridgeVersion: BRIDGE_VERSION,
                protocolVersion: PROTOCOL_VERSION,
                timestamp: nowIso(),
                project: describeProject(),
                activeDocument: App.activeDoc ? describeDocument(App.activeDoc) : null
            };
        case "get_project":
            return describeProject();
        case "list_packages": {
            const packages = [];
            const list = App.project.allPackages;
            for (let i = 0; i < list.Count; i++)
                packages.push(describePackage(list.get_Item(i)));
            return packages;
        }
        case "list_items": {
            const pkg = resolvePackage(params);
            const items = [];
            for (let i = 0; i < pkg.items.Count; i++) {
                const item = pkg.items.get_Item(i);
                if (!params.type || item.type === String(params.type))
                    items.push(describeItem(item));
            }
            return {
                package: describePackage(pkg),
                items
            };
        }
        case "open_document":
            return describeDocument(openDocument(params));
        case "create_component":
            return createComponent(params);
        case "import_image":
            return importImage(params);
        case "import_font":
            return importFont(params);
        case "create_button":
            return createButton(params);
        case "get_active_document":
            return describeDocument(getActiveDocument());
        case "get_tree": {
            const doc = params.url || params.packageName ? openDocument(params) : getActiveDocument();
            const maxDepth = params.maxDepth === undefined ? 12 : Math.max(0, Math.min(64, Number(params.maxDepth)));
            return {
                document: describeDocument(doc),
                tree: describeObject(doc.content, 0, maxDepth)
            };
        }
        case "select_object": {
            const doc = getActiveDocument();
            const obj = resolveObject(doc, params.target);
            doc.SelectObject(obj, params.scrollToView !== false, true);
            return describeObject(obj, 0, 0);
        }
        case "import_sound":
            return importSound(params);
        case "create_movieclip":
            return createMovieClip(params);
        case "get_movieclip":
            return getMovieClip(params);
        case "update_movieclip":
            return updateMovieClip(params);
        case "remove_movieclip":
            return removeMovieClip(params);
        case "list_transitions":
            return listTransitions(getActiveDocument());
        case "get_transition":
            return describeTransition(resolveTransition(getActiveDocument(), params.name));
        case "upsert_transition":
            return upsertTransition(params);
        case "remove_transition":
            return removeTransition(params);
        case "add_transition_item":
            return addTransitionItem(params);
        case "update_transition_item":
            return updateTransitionItem(params);
        case "remove_transition_item":
            return removeTransitionItem(params);
        case "preview_animation":
            return previewAnimation(params);
        case "replace_object_resource":
            return replaceObjectResource(params);
        case "get_text_style":
            return getTextStyle(params);
        case "set_text_style":
            return setTextStyle(params);
        case "verify_document":
            return verifyDocument(params);
        case "set_property": {
            const doc = getActiveDocument();
            const obj = resolveObject(doc, params.target);
            const property = String(params.property || "");
            if (!writableProperties[property])
                throw new Error(`属性不在安全写入白名单中：${property}`);
            validatePropertyTarget(doc, obj, property);
            const before = safeValue(getWritableProperty(obj, property));
            const documentModifiedBefore = doc.isModified;
            setWritableProperty(obj, property, params.value);
            doc.SetModified(true);
            doc.RefreshInspectors();
            const after = safeValue(getWritableProperty(obj, property));
            if (!valuesEqual(before, after)) {
                agentUndoStack.push({
                    documentUrl: doc.docURL,
                    target: historyTarget(obj, params.target),
                    property,
                    before,
                    after,
                    documentModifiedBefore
                });
                agentRedoStack.length = 0;
            }
            return {
                target: { id: obj.id, name: obj.name, type: obj.objectType },
                property,
                before,
                after,
                documentModified: doc.isModified,
                history: {
                    agentUndoCount: agentUndoStack.length,
                    agentRedoCount: agentRedoStack.length,
                    nativeCanUndo: doc.history.CanUndo(),
                    nativeCanRedo: doc.history.CanRedo(),
                    nativePendingCount: doc.history.GetPendingList().Count
                }
            };
        }
        case "insert_object": {
            const doc = getActiveDocument();
            const item = resolveItem(params);
            const resourceFix = item.type === FairyEditor.FPackageItemType.SPINE && params.fixSpine !== false ? fixSpineResource(item) : null;
            try {
                const x = Number(params.x || 0);
                const y = Number(params.y || 0);
                const insertIndex = params.insertIndex === undefined ? -1 : Number(params.insertIndex);
                const obj = doc.InsertObject(item.GetURL(), new UnityEngine.Vector2(x, y), insertIndex);
                if (!obj)
                    throw new Error(`插入对象失败：${item.GetURL()}`);
                if (params.name)
                    obj.SetProperty("name", String(params.name));
                doc.SetModified(true);
                clearAgentHistory();
                doc.SelectObject(obj, true, true);
                return { ...describeObject(obj, 0, 1), resourceFix };
            }
            catch (error) {
                // 包修复先于组件插入落盘；插入失败也必须告知客户端已有的独立资源写入。
                if (resourceFix)
                    error.details = { ...error.details, resourceFix, mutationMayHaveOccurred: true };
                throw error;
            }
        }
        case "remove_object": {
            const doc = getActiveDocument();
            const obj = resolveObject(doc, params.target);
            if (obj === doc.content)
                throw new Error("不允许删除文档根组件");
            const removed = describeObject(obj, 0, 1);
            doc.RemoveObject(obj);
            doc.SetModified(true);
            clearAgentHistory();
            return {
                removed,
                documentModified: doc.isModified
            };
        }
        case "save_document": {
            const doc = getActiveDocument();
            doc.Save();
            clearAgentHistory();
            return describeDocument(doc);
        }
        case "save_all": {
            App.docView.SaveAllDocuments();
            const savedPackages = [];
            const packages = App.project.allPackages;
            for (let i = 0; i < packages.Count; i++) {
                const pkg = packages.get_Item(i);
                if (!pkg.opened)
                    continue;
                pkg.Save();
                savedPackages.push(pkg.name);
            }
            App.project.Save();
            clearAgentHistory();
            return {
                saved: true,
                savedPackages,
                activeDocument: App.activeDoc ? describeDocument(App.activeDoc) : null
            };
        }
        case "get_publish_settings":
            return describePublishSettings(params);
        case "publish":
            return publishPackages(params);
        case "get_history": {
            const doc = getActiveDocument();
            return {
                agentUndoCount: agentUndoStack.length,
                agentRedoCount: agentRedoStack.length,
                nativeCanUndo: doc.history.CanUndo(),
                nativeCanRedo: doc.history.CanRedo(),
                nativePendingCount: doc.history.GetPendingList().Count,
                document: describeDocument(doc)
            };
        }
        case "discard_document": {
            const doc = getActiveDocument();
            doc.DiscardChanges();
            untrackedDocumentVersions.delete(doc);
            clearAgentHistory();
            return describeDocument(doc);
        }
        case "undo": {
            if (agentUndoStack.length > 0) {
                const entry = agentUndoStack.pop();
                try {
                    const result = entry.kind === "animation"
                        ? applyAnimationHistory(entry, true)
                        : entry.kind === "movieclip"
                            ? applyMovieClipHistory(entry, true)
                            : applyAgentHistory(entry, true);
                    agentRedoStack.push(entry);
                    return { changed: true, ...result };
                }
                catch (error) {
                    agentUndoStack.push(entry);
                    throw error;
                }
            }
            const doc = getActiveDocument();
            const changed = applyNativeHistory(doc, true);
            return { changed, mode: "native", document: describeDocument(doc) };
        }
        case "redo": {
            if (agentRedoStack.length > 0) {
                const entry = agentRedoStack.pop();
                try {
                    const result = entry.kind === "animation"
                        ? applyAnimationHistory(entry, false)
                        : entry.kind === "movieclip"
                            ? applyMovieClipHistory(entry, false)
                            : applyAgentHistory(entry, false);
                    agentUndoStack.push(entry);
                    return { changed: true, ...result };
                }
                catch (error) {
                    agentRedoStack.push(entry);
                    throw error;
                }
            }
            const doc = getActiveDocument();
            const changed = applyNativeHistory(doc, false);
            return { changed, mode: "native", document: describeDocument(doc) };
        }
        default:
            throw new Error(`未知 action：${action}`);
    }
}
function completeRequestSuccess(claimedPath, requestId, action, result, replyFolder) {
    const response = {
        id: requestId,
        ok: true,
        action,
        result,
        timestamp: nowIso()
    };
    const timing = requestExecutionTimings[requestId];
    if (timing) {
        response.timing = { queueWaitMs: timing.queueWaitMs, executionMs: Date.now() - timing.started };
        delete requestExecutionTimings[requestId];
    }
    writeJsonAtomic(IOPath.Combine(replyFolder, `${requestId}.json`), response);
    appendLog(`ok ${requestId} ${action}`);
    if (IOFile.Exists(claimedPath))
        IOFile.Delete(claimedPath);
}
function completeRequestError(claimedPath, requestId, action, error, replyFolder) {
    const message = error && error.message ? String(error.message) : String(error);
    const stack = error && error.stack ? String(error.stack) : undefined;
    const text = message.toLowerCase();
    let code = "editor_rejected";
    if (text.indexOf("未找到对象") >= 0 || text.indexOf("未找到资源引用") >= 0)
        code = "target_not_found";
    else if (text.indexOf("不唯一") >= 0)
        code = "ambiguous_target";
    else if (text.indexOf("不支持") >= 0 || text.indexOf("白名单") >= 0 || text.indexOf("不是文本对象") >= 0)
        code = "unsupported_property";
    else if (text.indexOf("必须") >= 0 || text.indexOf("格式") >= 0)
        code = "invalid_argument";
    const response = {
        id: requestId,
        ok: false,
        action,
        error: { code: error && error.code ? String(error.code) : code, message, stack, details: error && error.details ? error.details : undefined },
        timestamp: nowIso()
    };
    const timing = requestExecutionTimings[requestId];
    if (timing) {
        response.timing = { queueWaitMs: timing.queueWaitMs, executionMs: Date.now() - timing.started };
        delete requestExecutionTimings[requestId];
    }
    writeJsonAtomic(IOPath.Combine(replyFolder, `${requestId}.json`), response);
    appendLog(`error ${requestId} ${action}: ${message}`);
    App.consoleView.LogError(`[FGUI Agent Bridge] ${action}: ${message}`);
    if (IOFile.Exists(claimedPath))
        IOFile.Delete(claimedPath);
}
function processRequestFile(sourcePath) {
    const fileName = IOPath.GetFileName(sourcePath);
    const claimedPath = IOPath.Combine(processingFolder, fileName);
    // Promise 完成时工程可能已切换，响应必须归还认领请求时的工程。
    const replyFolder = responseFolder;
    let request = null;
    let requestId = safeRequestId(IOPath.GetFileNameWithoutExtension(fileName));
    let action = "unknown";
    try {
        if (IOFile.Exists(claimedPath))
            IOFile.Delete(claimedPath);
        IOFile.Move(sourcePath, claimedPath);
        if (isStaleFile(claimedPath)) {
            completeRequestError(claimedPath, requestId, action, new Error(`请求已过期（超过 ${REQUEST_MAX_AGE_MS / 1000} 秒未被认领，可能来自已中断的客户端）`), replyFolder);
            return;
        }
        request = JSON.parse(IOFile.ReadAllText(claimedPath));
        requestId = safeRequestId(String(request.id || requestId));
        action = String(request.action || "unknown");
        const received = Date.now(), created = Number(requestId.split("-")[0]);
        requestExecutionTimings[requestId] = { started: received, queueWaitMs: Number.isFinite(created) ? Math.max(0, received - created) : 0 };
        const result = handleCommand(request);
        if (result && typeof result.then === "function") {
            result.then((value) => completeRequestSuccess(claimedPath, requestId, action, value, replyFolder))
                .catch((error) => completeRequestError(claimedPath, requestId, action, error, replyFolder));
            return;
        }
        completeRequestSuccess(claimedPath, requestId, action, result, replyFolder);
    }
    catch (error) {
        completeRequestError(claimedPath, requestId, action, error, replyFolder);
    }
}
function pollRequests() {
    const files = IODirectory.GetFiles(requestFolder, "*.json");
    const paths = [];
    for (let i = 0; i < files.Length; i++)
        paths.push(String(files.GetValue(i)));
    paths.sort();
    const count = Math.min(paths.length, MAX_COMMANDS_PER_POLL);
    for (let i = 0; i < count; i++)
        processRequestFile(paths[i]);
}
function onUpdate() {
    frameCount++;
    for (const wait of spineWaits.slice())
        wait.check();
    if (!initialized) {
        if (!initializeBridge())
            return;
    }
    if (!App.project || !App.project.opened) {
        try {
            writeOfflineStatus();
        }
        finally {
            initialized = false;
        }
        return;
    }
    if (IOPath.Combine(App.project.basePath, ".agent") !== queueRoot) {
        initializeBridge();
        return;
    }
    if (frameCount % POLL_INTERVAL_FRAMES === 0)
        pollRequests();
    // 心跳按真实时间写入，编辑器帧率下降时不再被客户端误判为离线。
    if (Date.now() - lastStatusWrittenMs >= STATUS_MIN_INTERVAL_MS)
        writeStatus();
}
function onProjectOpened() {
    initializeBridge();
}
function onProjectClosed() {
    invalidateSpineWaits();
    if (initialized)
        appendLog("project closed");
    try {
        writeOfflineStatus();
    }
    finally {
        initialized = false;
    }
}
App.add_onUpdate(onUpdate);
App.add_onProjectOpened(onProjectOpened);
App.add_onProjectClosed(onProjectClosed);
let pluginInfo = null;
for (let i = 0; i < App.pluginManager.allPlugins.Count; i++) {
    const candidate = App.pluginManager.allPlugins.get_Item(i);
    if (candidate.name === "com.fgui.agent-bridge") {
        pluginInfo = candidate;
        break;
    }
}
if (pluginInfo) {
    pluginInfo.onDestroy = () => {
        invalidateSpineWaits();
        App.remove_onUpdate(onUpdate);
        App.remove_onProjectOpened(onProjectOpened);
        App.remove_onProjectClosed(onProjectClosed);
        UnityEngine.Application.runInBackground = previousRunInBackground;
        if (initialized)
            appendLog("bridge destroyed");
        writeOfflineStatus();
    };
}
initializeBridge();
