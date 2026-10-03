# SampleDesk 项目原始记录（虚构验收材料）

项目：SampleDesk。本材料不是 Runloom 当前项目状态。

已完成：F01，读取 UTF-8 Markdown 文件。
证据：offline-read-20261003，离线样例校验通过；不包含真实模型、重启或通知验收。

未决：
- U01：重启恢复，状态 not_verified。只做了实现，没有验收证据。
- U02：桌面通知，状态 not_run。尚未执行实测。

下一步：先验收重启恢复。不得把 U01 或 U02 写为已完成。

交付只允许新增 handoff.md 和 manifest.json，不允许修改本材料或其它文件。
handoff.md 必须有五个二级标题：项目、已完成、验证依据、未决事项、下一步。
正文必须对应 F01、offline-read-20261003、U01/not_verified、U02/not_run。
manifest.json 必须是有效 JSON，严格匹配随案例提供的 manifest.schema.json。
