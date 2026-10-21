# 图形、图片显示和颜色滤镜

需要 Bridge 与插件 **0.14.0** 或更高版本。六个工具只编辑当前文档直属对象；默认不保存，`save=true` 保存整个当前组件并核对原生 XML。没有完整 Agent 撤销，失败不自动回滚。批量使用对应三个 `set_*` Action；旧插件在入队前被拒绝。

## Graph 图形

`fgui_get_graph_settings(target)` 读取当前类型使用的字段；`fgui_set_graph_settings(settings, target, save=false)` 按补丁写入。

| 字段 | 约定 |
|---|---|
| type | `empty`、`rect`、`ellipse`、`polygon`、`regular_polygon` |
| fillColor / lineColor | 非空图形的填充/线条颜色，`#RRGGBB` 或 `#RRGGBBAA`，Alpha=00 有效；不透明 RGBA 规范化为 RGB |
| lineSize | 非空图形线宽，0..1000000，0 表示无线条 |
| cornerRadius | 仅 rect，四项非负数组：**左上、右上、左下、右下**，各 0..1000000；全 0 清除 |
| points | 仅 polygon，3..1024 个 `{x,y}` 局部坐标，绝对值不超过 1000000；可为负数或超出对象尺寸 |
| sides | 仅 regular_polygon，3..256 的整数 |
| startAngle | 仅 regular_polygon，角度 -360..360 |
| distances | 仅 regular_polygon，各顶点的非负半径倍率，长度等于最终 sides；1 为常规半径，每项不超过 1000000 |

切入 polygon 必须同时提供 points。拒绝相邻重复点、零面积/退化和自交轮廓；不自动移动坐标或调整对象尺寸。切换类型不接受新类型无效的几何字段。empty 只接受 type；Getter 不返回非活动类型的缓存参数，避免把缓存当作可持久化设置。

改变边数时，未提供 distances 则保留现有正多边形倍率的公共前缀、移除多余项、新顶点补 1；从其他类型切入时倍率默认全 1。角度、染色、线条和未修改字段保持原生值。向量/数组按宿主 Single 精度规范化，返回小数可能含浮点尾数。

```json
{"type":"rect","fillColor":"#2080D0","lineSize":0,"cornerRadius":[12,12,12,12]}
```

## Image 显示属性

`fgui_get_image_display(target)` / `fgui_set_image_display(settings, target, save=false)` 只编辑直属 **Image**。图片资源缩放/九宫格仍用 `fgui_get_image_settings` / `fgui_set_image_settings`，二者作用域不同。

| 字段 | 约定 |
|---|---|
| color | RGB/RGBA 染色；RGB 保留现有透明度，RGBA 的 A 写入对象 alpha |
| alpha | 对象透明度 0..1，0 有效；按原生 XML 三位小数规范化，不能与 RGBA color 同时提供 |
| flip | `none`、`hz`、`vt`、`both` |
| fillMethod | `none`、`hz`、`vt`、`radial90`、`radial180`、`radial360` |
| fillAmount | **Editor 百分数 0..100**，不是 Unity 运行时的 0..1；0 有效 |
| fillOrigin | 线性填充 0..1，径向填充 0..3，沿用 Editor 原生枚举 |
| fillClockwise | 布尔值，仅径向填充可设置，false 有效 |

关闭填充使用 `{"fillMethod":"none"}`，不能同时传填充参数。切换活动填充方式保留旧比例和合法原点；若旧原点不适合新方式，必须显式指定新原点。由 none 首次启用时，省略参数使用 origin=0、amount=100、clockwise=true，避免隐藏缓存影响结果。Getter 只返回已启用/适用的填充字段。

Editor 的 Image 染色原生 XML 仅保存 RGB，颜色中的 Alpha 无法独立重载。因此 RGBA 输入被拆为 RGB 和对象 alpha，Getter 明确返回 RGB `color` 与数值 `alpha`。这与通用属性中的对象 alpha 是同一个字段；不引入第二层透明度。

修改不替换图片 URL、不改资源文件和包级九宫格，也不影响其他引用同一资源的对象。Loader 的布局属性继续使用 Loader 工具。

```json
{"flip":"hz","fillMethod":"radial360","fillOrigin":0,"fillAmount":50,"fillClockwise":false}
```

## 颜色滤镜

`fgui_get_filter_settings(target)` / `fgui_set_filter_settings(settings, target, save=false)` 支持当前文档直属显示对象，包括 Image、Graph、文本、Loader 和组件实例；不支持根或逻辑 Group。

- `type="color"`：`brightness`、`contrast`、`saturation`、`hue` 各为 -1..1。0 是中性值，饱和度 -1 为灰度；色相为归一化值，不是角度。
- 已有 color 滤镜允许只改部分参数，省略保持。
- 从其他类型启用须显式 `type="color"`，省略参数用 0；构造新的原生 FilterData 后一次赋值，不在预检时修改旧数据。
- `{"type":"none"}` 明确清除，不允许同时提供颜色参数；空串、null 和参数全 0 都不等同于清除。
- 遇到未支持的原生滤镜，读取仅返回类型标识；写入必须明确选择 color 或 none 才能替换，不静默丢弃。
- 不修改 `blendMode`。组件实例只写父文档，不改源组件和其他实例。

## CLI 与批量

```bash
fgui-agent get-graph-settings --id shapeID
fgui-agent set-graph-settings --id shapeID '{"type":"rect","fillColor":"#2080D0","lineSize":0,"cornerRadius":[12,12,12,12]}' --save
fgui-agent set-image-display --id imageID '{"fillMethod":"hz","fillOrigin":0,"fillAmount":50}' --save
fgui-agent set-filter-settings --id imageID '{"type":"color","saturation":-1}' --save
fgui-agent set-filter-settings --id imageID '{"type":"none"}' --save
```

批量 Action 为 `set_graph_settings`、`set_image_display`、`set_filter_settings`，参数均为 `target + settings`；单步禁止 save，只能整批保存。仍须提供 document_url、读取时的 expected_revision、唯一 operation_key，并先查失败/超时回执。
