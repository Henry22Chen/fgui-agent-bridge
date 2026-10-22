# Gear 高级类型、删除与缓动（0.21.0）

先调用 get_gears，按返回的 supported、editable、capabilities 选择。当前支持十类 Gear，所有目标仍是当前文档直属对象；嵌套定义先打开所属文档。默认不保存，save=true 保存整个组件并回读。修改清除旧 Agent 历史，无完整 Gear 事务撤销，失败报告实际状态，不自动回滚。

get_gears.currentDisplay 与配置分开：visible 是手动开关，effectiveVisible 计入 Gear/分组的实际显隐结果；另返回当前几何、look、字号及动画 playing/frame。不要把 visible=true 当作 Display Gear 已显示。

## 值结构

| gear_type | default_value / page_values 的 value |
|---|---|
| display | 使用 visible_page_ids；空数组表示本 Gear 全页匹配，不表示全部隐藏 |
| display2 | 同 display，condition=and/or 与主 Display 的结果组合；省略保留原条件，新建默认为 and |
| text / icon | 字符串；icon 为图片 ui:// 或空串；文本不接受竖线 |
| xy | {x,y}，整数绝对像素；百分比模式为 {x,y,percentX,percentY} |
| size | {width,height,scaleX?,scaleY?}，非负整数尺寸，省略缩放为1 |
| color | {color:"#RRGGBB",strokeColor?:"#RRGGBB"} |
| look | {alpha,rotation,grayed,touchable}，四项必填；alpha为0..1，rotation为有限角度，两开关为布尔值 |
| animation | {frame,playing}，frame为0..1000000整数，playing为布尔值 |
| font_size | 1..10000的整数字号 |

非 Display 类型完整替换该 Gear 的 default_value 与 page_values，未列页面使用默认值；页面 ID 必须属于指定根控制器且不能重复。新类型保持旧六类调用语义。百分比、条件和缓动仅对对应类型开放，未知字段拒绝。

动画原生标签为 gearAni，公开接口不传 p/s 字符串。timeScale、动画名和皮肤覆盖尚未开放；读取带动画名/皮肤的已有配置时保留诊断数据、editable=false，拒绝用窄字段覆盖，仍允许显式整项删除。未知 Gear 返回原始 XML；编辑其它类型时传递完整原生快照并比较其余配置，不能据能读 XML 宣称能写未知类型。

## 百分比 XY

set_gear 新增 positions_in_percent（Bridge 字段 positionsInPercent）。省略保留已有模式；显式 false 切回绝对坐标，true 时每个默认/页面值必须同时提供整数 x/y 和比例 percentX/percentY。比例1表示父组件宽/高的100%，允许负比例或超出1；有限值绝对值不超过1000000，不能用像素取整替代比例。Editor 原生 XML 将比例和 look 浮点值写为约三位小数、时间写为四位小数，API 返回实际序列化值；不承诺保留任意双精度小数。

原生保存绝对坐标及比例四个值。父尺寸变化后，下次原生 Gear 应用/切页用新父尺寸计算位置；本接口不额外创建 Relation，不承诺父尺寸每帧变化即刻重排。需要即时响应布局时显式维护关系。已有无法识别的百分比格式在写入前拒绝。

## 缓动补丁

set_gear 的 tween 为 {enabled?,duration?,delay?,ease?}，只开放 xy/size/look/color。单位为秒，duration为0.0001..3600，delay为0..3600；enabled是布尔值。ease使用 Linear、Quad.Out、Cubic.InOut 等有名内置曲线；未知曲线拒绝。自定义曲线仅保留，不能新建、编辑或隐式清除。

省略整个 tween 保留原 XML；提供补丁时省略的字段保持。关闭 enabled 也保留时长、延迟和曲线。原生默认值为 enabled=false、duration=0.3、delay=0、ease=Quad.Out。非缓动类型拒绝 tween，不能因基类可序列化而宣称运行时有效。

设计文档对象与运行预览对象相互独立。验证运行预览中的缓动应采样副本，不能只以设计对象坐标变化作为运行副本的插值证据；配置编辑本身不启动预览或播放动画。

## 删除和解绑

fgui_remove_gear(gear_type,target,save=false) 删除该类型的默认值、全部页面值、缓动及绑定。返回 configurationRemoved、bindingCleared、displayBefore/displayAfter 和实际显隐前后值。

普通几何、颜色、字号、playing/frame 等保留当前值，不恢复源资源默认值。剩余 Display/Display2 重新决定实际可见性；删除最后一个显隐 Gear 后仍尊重手动 visible 和分组状态。重复删除无配置的 Gear 为无变化，不清历史。

原生单纯把 controller 设空能暂时保留内存页面配置，但不会序列化这套未绑定配置，因此本接口明确同时删除配置，不提供“解绑但保存原页面配置”的假象。需要重新绑定时先读出配置，再通过 set_gear 完整设置。

## 批量、CLI 与兼容

set_gear 新增字段和 remove_gear 可放入 apply_batch，仍按 document_url/revision/operation_key 协调；单步禁止 save，批量失败可部分执行，不自动回滚。

CLI：set-gear 的 JSON 可含 defaultValue/pageValues/visiblePageIds/positionsInPercent/tween/condition；remove-gear TYPE --id ID [--save] 删除整项。旧插件缺少 gear_advanced/gear_tween/gear_xy_percent/remove_gear 能力时，直接调用和嵌套批量均在入队前拒绝。

自动化入口：test_gear_lifecycle.py、gear_host_harness.cjs、live_gear_lifecycle.py。live_gear_preview.py 与 gear_preview_probe.js 仅对固定 ID 的仓库外测试夹具安装临时预览钩子，验证后恢复正式插件；正式插件不暴露该钩子。所有日志、截图、探针、临时工程及发布产物放 FGUI 工程 .agent/tmp/<任务名>/，不入库。
