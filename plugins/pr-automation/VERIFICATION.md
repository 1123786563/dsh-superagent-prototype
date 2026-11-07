# 验证记录

## 本地 act CI（2026-11-07，Asia/Shanghai）

固定提交的实测结果（汇总多轮日志，不作为一份全绿 CI 证明）：

| job / 矩阵 | 结果 | 证据摘要 |
| --- | --- | --- |
| static | 失败 | 格式检查 6 个错误，后续 lint / types 未执行 |
| deployables / agent-computer | 成功 | 根 job 成功事件 |
| deployables / supervisor | 成功 | 根 job 成功事件 |
| test | 失败 | 环境准备通过，test:ci 收集阶段缺少 bun.SQL，随后覆盖审计失败 |
| build | 失败 | worker 缺少直接依赖 drizzle-orm，TS2307；app 构建单独成功 |

合并门禁拒绝真实失败记录。用户重启 DSH 后，最新版插件的运行代际、act 版本、固定镜像和配置指纹均已通过实时接口核对，状态为 ready、lastError 为 null。实现、直接执行与激活验证已完成；OpenBot 当前固定提交的检查结果仍为失败，未执行真实合并。

- 本地插件回归：`node --test plugins/pr-automation/tests/*.node.js`，85/85 通过，覆盖 SHA/base/配置绑定、完整矩阵证据、缺项/失败/取消、资源清理失败及三种 CI 模式的合并门禁。真实模型审核与真实合并仍未在本次测试触发。
- 已构建隔离版 act `0.2.97-dsh2`（独立 toolcache 和服务网络两处 patch），数据库 smoke 验证通过；最终 runner 固定为 `sha256:8cb9d32523bd18f280c365eb461d07f7b49ba7e06e3497584f128fb50d408a8b`（pip 固定 25.3；此前各轮使用 `sha256:2dfe82833be3b113b1b259de84a5cbfd8e5a42fa4b8137ea5d206fca6d75af4b`），`linux/arm64`。每项 job 使用独立 toolcache 和 action cache，容器不挂 Docker socket，环境/secret/input/var 文件为空，串行执行且限制 4 CPU / 10 GiB，总超时 5400 秒。
- 实测对象：OpenBot 草稿 PR #1033，head `92d7dddfd835b3f1d4e9f11df612d2d359ea4e81`，base `0bf4522f662b3b50b200d750d162d2f197e6cfd6`。仅在测试进程内模拟标签和非草稿资格，`publishStatus: false`，未调用审核/合并引擎。GitHub 重读确认 PR 仍为 open/draft，labels 为空，未合并。
- 首轮有效业务结果保存在 `.artifacts/openbot-act-test-1033-1794020795914/ci/pr-1033-b3fa319bcd72b08cdd2c46e0/`：`static` 在 `bun run format:check` 发现源代码格式差异并失败，后续 lint/typecheck 因 workflow 顺序未执行；`deployables` 的 agent-computer 和 supervisor 两项都成功。该结果不代表 PR 的 CI 全部通过。
- 修复执行适配缺陷：detached checkout 的空 `.git/refs` 目录被 act 的文件归档省略，容器内 Git 因而不识别仓库；并非 `.gitignore` 排除了 `.git`。现在创建仅指向目标 head SHA 的 `refs/heads/dsh-ci-head`，保持 HEAD detached。受控容器复现中，修复前两种 use-gitignore 模式均失败，修复后两种均能读取正确 head SHA，资源清理成功；新增 checkout 引用回归先失败、修复后通过。
- 修正服务转发配置：须匹配固定 base workflow 的 `5432/5434/5433 -> 5432`，原先配置的 `15432/15434/15433` 与 workflow 中测试连接端口不符。新增编译校验拒绝映射不匹配，回归测试先失败、修复后通过。错误端口的重跑已主动取消，记录 `cancelled`，checkout、action cache、4 个容器、3 个命名卷及服务网络均清理成功；其中子模块初始化已成功，证明 Git 适配修复有效。
- 进一步修复 act 的服务网络选择：显式 `--network bridge` 使 hosted runner job 留在普通 bridge，数据库却位于 act 创建的服务网络。dsh2 在存在 services 时将 job 加入同一私有网络；最小 PostgreSQL smoke 已实际经容器 loopback 代理收到协议响应，job/全部步骤/尾部见证均成功、清理成功。网络不通那轮已取消并按 nonce 手动补清理完成，原记录如实保留 cleanup failure。
- dsh2 的 OpenBot 重跑记录位于 `.artifacts/openbot-act-test-1033-1794024331688/`：`test` 在代理步骤前 job 容器提前停止，act 报 container is not running，未执行测试，清理成功；原因尚未证实，不能算作业务测试通过。`build` 已执行并失败，worker 的 `src/index.ts(20,25)` 报 TS2307：无法解析 `drizzle-orm`；前端 app 构建单独成功。固定 Git 对象复核确认：worker 直接 import 并使用 `drizzle-orm`，自己的 package.json 和 bun.lock workspace 条目均未声明它；只有 sibling server 声明 `^0.45.2`。因此 frozen install 成功并不代表所有源代码 import 均有依赖声明。建议在 worker 的 dependencies 声明与仓库一致的 drizzle-orm，并用 Bun 1.4.3 更新根锁文件后重跑；本任务未修改 OpenBot 依赖或代码。两项任务的资源清理、action cache 删除和 checkout 删除均成功。将这份真实失败记录交给 `localCiBlockers` 后确认 `mergePermitted: false`。act 自身 `go test -short ./...` 返回失败：artifactcache 测试访问本机 `198.18.0.1` 时收到 EOF；Git commit fixture 缺少提交身份；Docker options 测试断言与 macOS `unknown server OS: darwin` 错误文本不符。涉及补丁的 `go test -short ./pkg/runner ./pkg/filecollector` 单独通过，显式设置测试子进程的 Git author/committer 后 `TestGitFindRef` 通过；未修改宿主 Git 配置，也未把全套短测试报告为通过。此前被宿主进程中断的 build 没有成功证据，已按 nonce 验证并清理遗留容器和卷及临时 checkout/action cache，未操作其他 Docker 工作负载。
- 单独重试 test（`.artifacts/openbot-act-test-1033-1794024705247/`）已通过代理、checkout、子模块及 Bun 依赖安装，在 pip 步骤因旧镜像 pip 22.0.2 不支持 `--break-system-packages` 失败，业务测试未启动；资源清理完整。已在 runner Dockerfile 固定 pip 25.3 并构建上述新镜像，在一次性容器中执行 workflow 原始 Python 依赖命令成功（defusedxml 0.7.1 / lxml 6.1.1 / Pillow 12.2.0）。新镜像的 test job（`.artifacts/openbot-act-test-1033-1794024994271/`）重跑时子模块初始化成功；在该真实 job 容器中私下传入 workflow 的 DATABASE_URL 后执行只读 `SELECT 1` 返回 1，验证最终镜像、实际服务网络与 loopback 转发均可连接主 PostgreSQL。该轮已结束为 failure：Python 安装、主库迁移、多租户及 billing 数据库准备、企业迁移预检和企业库准备均成功；`bun run test:ci` 收集 `server/tests/openshell-capacity.test.ts` 时报告 `bun` 模块缺少 `SQL` 导出，随后 collection reconcile 失败，报告仅运行 1 个测试、低于最低 400 个。未把预检通过解释为完整测试通过。最终记录确认 cleanup.success、actionCacheRemoved、workspaceRemoved 均为 true；额外 Docker 核对确认没有带 CI 标识的容器、toolcache 卷、act 卷和网络残留。真实失败结果再次被本地合并门禁拒绝。
- 最终安装已保存且 enabled=true，但插件管理器持续返回 `restart-required` / `unmanaged-plugin`。实时 `/pr-automation/api/status` 的 policy `88f43f6171b7fcbc` 与本地 Config 校验后的最终配置指纹一致（包含新镜像与正确端口），且 `phase: ready`、`ciMode: local`、4 类 job 配置、`lastError: null`；这证明配置更新，不能证明源码代际更新。
- 增加 `ciRuntime` 诊断字段（实现版本 2、actVersion、runnerImage、configKey），并将本地 CI 缓存策略版本升至 2，避免复用旧执行实现的结果。85 项插件测试仍全部通过。重启前该字段缺失，因此曾暂停激活验收。
- 用户确认重启 DSH 后，再次请求实时接口并逐项断言通过：`ciRuntime.version=2`、`actVersion=act version 0.2.97-dsh2`、runnerImage 与上述最终 SHA 完全一致、`configKey=fd8e5b3f6f2664857dca1095`、`policy=88f43f6171b7fcbc`；仓库为 OpenBot，`phase=ready`、`lastError=null`、`ciMode=local`、`autoMerge=true`、标签为 `auto-review`，4 类 job 均匹配最终配置。激活核对已通过，证据保存在 [activation-check.json](../../.artifacts/pr-automation/activation-check.json)，其中 `active=true`、`remaining=null`。
- 包分发检查包含新增运行模块、act patch/构建脚本、runner Dockerfile、双语 locale 和原有 SVG。插件管理器图标的实际渲染仍未验证。
- 本地结果不替代 GitHub 分支保护要求；`local` 模式不会将外部 GitHub CI 算入本地门禁，但 GitHub 服务端仍可能拒绝 merge。本次没有通过忽略失败来放行任何 PR。

## 原始审核与合并插件

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
