# 验证记录

时间：2026-11-06，Asia/Shanghai。

- Harness 安装结果：`@local/dsh-pr-automation@1.0.0`，`application: applied`。
- Live Config：`include:dsh-pr-automation`，schema 可读取。
- 本机状态接口：HTTP 200，`phase: ready`、`autoMerge: true`、`label: auto-review`、`lastError: null`。
- 无专用头 / 跨域请求：403；POST 状态接口：405。
- OpenBot 已创建 `auto-review` 标签，保留专用机器人身份。
- 对真实草稿 PR #1033 做只读适配器检查：2 个 check suites、21 项 checks、0 个 statuses、0 个 review threads，base 已包含于 head。未改变该 PR。
- 插件的 23 项 Node 测试通过，涵盖审核版本、CI suites 重跑、分页截断、标签撤销、暂停、多实例锁、启动失败释放锁、stdin EPIPE/abort、模型输出异常和携带 SHA 合并。
- 全仓库检查 `env -u GIT_CONFIG_GLOBAL pnpm check` 通过：typecheck，59 个测试文件 / 1197 个测试，build。首次直接 `pnpm check` 的 2 项环境恢复测试失败，原因为当前 Superagent 进程继承的 `GIT_CONFIG_GLOBAL`；仅对验证子进程清除该变量后通过，未改变运行服务环境。
- 包分发 dry-run 检查通过：包含所有 5 个运行模块、patch、双语 locale、原创 SVG 和说明。SVG 解析成功，尺寸小于 256 KiB。
- Superagent 团队 delivery 提示词通过管理 API 保存为 revision 3，返回 `context_delivery: injected`，重新读取确认只有 delivery 改变，撤销了 worker 直接合并/启用 auto-merge 的旧指令。

## 验证边界

当时唯一打开的 PR 是无 `auto-review` 标签的草稿，因此插件正确保持空任务列表。未创建测试 PR、未调用真实模型进行 PR 审核、未发布测试 review，也未执行真实合并；模型与合并分支通过模拟适配器测试。第一次真实带标签 PR 才会完整触发线上审核路径。

使用隔离的 agent-browser 打开现有 GUI 地址时遇到 `dsh web authentication required`，所以未确认插件管理器内标题和图标的实际渲染；安装资源、locale、icon 和运行状态已检查，未更改用户浏览器状态或启动替代服务。

安装还报告已有 `orca-agent-hooks` 缺少 `@deepseek-ai/dsh-hooks-claude-code` 的导入警告；本插件已 applied 并正常轮询，该警告未在本任务修改。

仓库当前为私有库，GraphQL `main.branchProtectionRule` 为 null，active rules REST 接口返回 403 并提示需升级套餐或改为公共仓库。机器人有 push 权限，没有 admin 权限。插件未更改这些权限。当前 commit 的 CI 必须全成功；已有主分支失败结果没有被忽略。

REST merge 请求的 SHA 只原子校验 head。插件在较慢的 CI 和可用性读取之后再读取 PR，要求 head 已包含已审核的当前 base，并紧接着请求合并；标签、base、CI 和审核在最后读取与提交之间仍可能变化。若需要服务端原子保证这些条件，需要管理员提供适用的分支保护或 ruleset。说明中未把本地复查描述为服务器事务保证。
