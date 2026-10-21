# 根容器与滚动设置

需要 Bridge、插件 **0.17.0** 或更高版本。新增 get/set_container_settings，扩展既有 get/set_scroll_settings；当前工具总数 110，协议 2.0。默认不保存；save=true 保存整个当前组件并比对完整原生 XML，可能包含文档既有未保存内容。没有完整 Agent 撤销，中途失败返回真实 before/after，不自动回滚。

## 根容器

`fgui_get_container_settings()` 无 target；`fgui_set_container_settings(settings, save=false)` 只写当前根定义。不要通过它改一个实例引用背后的共享定义，嵌套组件需先打开所属文档。

| 字段 | 约定 |
|---|---|
| margin | {left?,right?,top?,bottom?}；整数，可为负，范围 -1000000..1000000；只修改给出的边，省略保持，全部0清除 |
| minWidth / maxWidth / minHeight / maxHeight | 0..1000000 整数；0表示未设置限制，非零 max 不得小于 min，按最终组合预检 |
| hitTestSourceId | 当前根下直属 Image 或非空 Graph 的 ID，空串清除；拒绝根、嵌套、文本、分组和不存在目标 |

getter 的 settings 是完整当前配置，viewport 返回当前 width/height/viewWidth/viewHeight；约束和布局可能影响实际尺寸，以回读为准。原生 restrictSize 顺序是 minWidth,maxWidth,minHeight,maxHeight；marginStr 的顺序是 top,bottom,left,right，调用者无需自行拼字符串。Int32 字段提前拒绝小数、布尔值和数字字符串，不能依赖 Puerts 截断。

命中、遮罩和裁剪含义不同：hitTestSourceId 提供根的像素/形状检测区域，不修改子对象 touchable 或根 opaque；maskId/reversedMask 控制根内容的显示遮罩，沿用独立 mask 接口；overflow 与柔化边缘控制容器视口裁剪。引用可分别设置和清除。源对象的形状/图片及游戏 SDK 的命中行为仍会影响实际交互，Editor 保存验证不等于设备触控验证。

## 扩展滚动

`fgui_get_scroll_settings(object_path="root")` / `fgui_set_scroll_settings(settings, object_path="root", save=false)` 操作当前根。直属原生 List 使用 object_id/path/name；普通组件实例及嵌套对象拒绝。

原有 overflow、scroll、scrollBarDisplay、scrollBarFlags、pageMode、pageControllerName 保持原格式。pageMode 单独切换时只修改分页位；同时传 flags 和 pageMode 时二者必须一致。pageControllerName 引用**父文档**控制器，支持直属 List；根定义没有父控制器，非空绑定在写前拒绝，不把根自身控制器冒充父控制器。

绑定分页控制器时 List 必须明确处于 overflow=scroll。原生在非 scroll 模式不序列化 scrollBarDisplay、scrollBarFlags 和 pageMode，重载会回默认值；写入响应的 inactiveScrollFields 会列出这些字段，不能把内存残留值当成已持久化。资源引用、边距与柔化参数可独立序列化。

| 新字段 | 约定 |
|---|---|
| scrollBarMargin | 与 margin 相同的有名整数补丁，省略的边保持 |
| clipSoftness | {x?,y?}，0..1000000 整数；省略轴保持，0清除对应轴 |
| hzScrollBarRes / vtScrollBarRes | 横/竖滚动条组件 ui:// URL；必须是 ScrollBar 扩展，具备唯一直属 bar 与 grip 元件 |
| headerRes / footerRes | 下拉头/尾组件 ui:// URL；不改组件定义、不实现刷新请求或运行时业务 |

所有资源空串明确解除引用，null 拒绝，getter 将原生 null 统一为空串；拒绝图片、缺失资源和当前根自身。横/竖资源槽确定使用方向；组件没有额外方向标记，需选择按该方向设计的滚动条，不能按宽高比例猜测方向。

新设置非空资源或非零滚动条边距时，最终 overflow 必须为 scroll；写入横条时 scroll 不能是 vertical，写入竖条时不能是 horizontal。非零 clipSoftness 要求 hidden/scroll，scroll 时不能带 MASK_DISABLED。工具不隐式切换模式；可在同一补丁明确给出最终模式。零值与空串可在任意模式清除。未修改的已存资源/边缘在切换模式时保持，非活动模式不保证显示；scrollBarDisplay=hidden 时也不会绘制滚动条。

更新先完成类型、引用、模式与范围预检，再应用原生属性并刷新视口/滚动条；pageMode、未修改 flags 位、分页控制器和其余资源会在回读中核对。头/尾资源保存与发布验证不等于实际拖拽、下拉刷新事件或游戏滚动物理验证。

## 批量、能力与 CLI

`set_container_settings` 使用 params.settings，无 target，支持前序 `settings.hitTestSourceId="$ref"`；`set_scroll_settings` 沿用 params.target + settings，新增字段同样可批量。禁止单步 save，整批保存，失败先查回执。dry_run 不能完整模拟原生布局和资源应用。

插件声明 get_container_settings、set_container_settings 与 scroll_settings_extended。旧插件收到新增容器操作或包含任一扩展字段的滚动写入时，Python 在入队前拒绝，批量同样校验。仅使用旧滚动字段时保留原能力检查；旧插件 getter 可能只返回旧字段，读取扩展配置前核对 capability。

```bash
fgui-agent get-container-settings
fgui-agent set-container-settings '{"margin":{"left":20,"top":12},"maxWidth":900,"hitTestSourceId":"shapeID"}' --save
fgui-agent set-scroll-settings --path root '{"overflow":"scroll","scroll":"vertical","vtScrollBarRes":"ui://packageScrollbar","scrollBarMargin":{"right":8}}' --save
fgui-agent set-scroll-settings --id listID '{"clipSoftness":{"y":16},"headerRes":"ui://packageHeader"}' --save
```

兼容基线为 Editor 6.1.4；源 XML、原生保存重载、Editor 设计态裁剪和实际游戏交互是不同证据。测试日志、截图、临时工程和发布产物放仓库外。

检查根容器的边距/裁剪/滚动条时，将该组件实例放入独立宿主后截图；根定义编辑画布用于搭建内容，不完整呈现自身视口。隐藏对象也可能作为编辑参考显示，需避免让测试辅助图形覆盖验收区域。
