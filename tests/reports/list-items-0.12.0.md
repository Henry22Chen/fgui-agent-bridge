# 列表项资源与预置项编辑交付报告

版本：0.12.0（Git 标签 v0.12.0），协议：2.0，MCP 工具：89。实现位于独立 Bridge 源仓库。

## 本轮实现

- 新增 `fgui_get_list_item_resources` / `fgui_set_list_item_resources`，并提供同名 CLI 连字符命令。
- 编辑默认项资源与各项资源；使用最终有序 items 清单新增、删除、重排或复制预置项。
- `sourceIndex` 指向调用前的原项，保留未提供的名称、标题、图标、选中标题/图标及内部属性和控制器覆盖。
- 编辑 `name/title/icon/selectedTitle/selectedIcon`；支持空字符串清除，`properties=[]` 清空内部覆盖。
- 覆盖支持 `propertyId=-1/0/1`（控制器/文本/图标）；同项重复 target/propertyId 在写入前拒绝。
- 增加旧插件能力协商、批量白名单、发布期间拒绝写入、默认不保存、原生 setter 应用后回读和显式保存后的 XML 比对。
- 同步插件编译产物、Python/插件版本、锁文件、工具数、README 和 Skill；安装示例指向 v0.12.0。

## 验证

- TypeScript 5.4.5 编译成功，main.js 已更新。
- `python -m unittest discover -s tests`：92 项测试全部通过；其中新增 6 项 Python 回归，编译插件宿主含 13 个列表项用例。
- 宿主覆盖继承资源、资源规范化、增删重排、属性保留与清空、索引/URL/属性预检、批量保存、Editor 拒绝和磁盘保存失败。
- `compileall`、CLI 新命令帮助、MCP 启动帮助、`uv lock --offline` 和 `uv sync --frozen` 成功。
- 当前真实 Editor 状态为 offline，未执行真实 Editor 列表编辑/保存/重开联调；宿主回归不代表原生 Editor 行为已经验证。
- 0.12.0 以独立提交及标签交付，通过同步脚本升级项目插件和 Skill；未修改业务 UI 资源。Git 远端推送与 Editor 重载结果另行报告。

## 影响文件

以下均相对于独立 Bridge 源仓库，行号指向本轮变更的主要入口。列表项参数示例见 Skill 的 `references/list-items.md`。

| 文件与行号 |
| --- |
| `plugin/main.ts:3981` |
| `plugin/main.js:4039` |
| `plugin/package.json:5` |
| `plugin/types/puerts.d.ts:7` |
| `pyproject.toml:7` |
| `uv.lock:258` |
| `src/fairygui_agent/__init__.py:3` |
| `src/fairygui_agent/bridge_client.py:77` |
| `src/fairygui_agent/cli.py:343` |
| `src/fairygui_agent/mcp_server.py:871` |
| `src/fairygui_agent/performance.py:21` |
| `tests/test_animation_surfaces.py:144` |
| `tests/test_list_items.py:16` |
| `tests/list_items_host_harness.cjs:66` |
| `README.md:5` |
| `.agents/skills/fgui-agent-bridge/SKILL.md:66` |
| `.agents/skills/fgui-agent-bridge/references/current-capabilities.md:49` |
| `.agents/skills/fgui-agent-bridge/references/list-items.md:1` |
| `tests/reports/list-items-0.12.0.md:1` |
