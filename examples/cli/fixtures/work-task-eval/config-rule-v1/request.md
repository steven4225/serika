# WT02 固定配置变更（隔离样例，不是 Runloom 配置升级）

在 src/config.mjs 的 parseConfig 增加一个可选 maxItems 字段，不引入依赖。

- 传入时必须是 1 到 50（含两端）的整数，并包含在返回对象里。
- 省略或值为 undefined 时，返回形状仍是旧的 { enabled, mode }，不能自动补 maxItems。
- null、字符串、boolean、NaN、Infinity、小数、0、负数、51 均抛出
  TypeError，消息固定为 maxItems must be an integer from 1 to 50。
- 旧 enabled/mode 的默认、错误消息、校验顺序和忽略未知字段行为不变。
  maxItems 校验在旧 enabled/mode 校验之后。

先读取实现和 test/config.test.mjs。用 edit_file 修改这两个文件，保留现有
测试逐字不变，在测试末尾追加有效边界、无效值、缺省/undefined 的覆盖。
随后直接运行 `node --test test/config.test.mjs`，cwd 为 `.`。

只允许修改 src/config.mjs 和 test/config.test.mjs。不能修改本说明或
unrelated.txt，不能新增文件、安装依赖、调用网络、Git 或拼接 Shell 命令。
交付只报告实际测试回执和仍需人工审核的改动范围。
