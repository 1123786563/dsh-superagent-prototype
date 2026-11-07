# Corsair 外部连接器

dsh-superagent 的 **设置 → 连接器** 面板可保存 Corsair link 并将已连接应用作为 MCP 工具交给 Worker Session。首个向导优先覆盖 GitHub。

## 配置

1. 打开 Superagent 面板的 **设置 → 连接器**，点 **打开 Corsair Hub**。
2. 在 [Corsair Hub](https://hub.corsair.dev) 连接 GitHub 并创建一个 link；首次验证建议选择 **Read** 模式。
3. 将 Hub 提供给 MCP 客户端的 HTTPS `/mcp` 地址与 link API key 粘贴到面板，保存连接。
4. 新建的 Worker Session 会加载 MCP 工具，名称以 `mcp__corsair__` 开头。已有 Worker Session 不会热更新。

面板只显示凭据是否已配置和服务 endpoint，不会把 key 读回浏览器。Host 通过 DSH `credentials` 服务将密钥保存在本机凭据存储中；Worker 插件在 Host 内读取记录并直接交给 DSH 自带的 MCP client。密钥不会进入仓库、profile YAML、进程环境或 Worker 环境变量。

### GitHub 只读验证

保存后新建/启动一个 Superagent Worker，请它只读查询公开仓库 `corsairdev/corsair` 的名称和默认分支，不做修改。只有 Worker 成功返回仓库元数据，才算验证了账户授权和 MCP 调用链；面板上的“已配置”仅代表本机凭据已保存。

连接器继承 Corsair link 的应用范围和权限。需要写操作时，在 Hub 选择与任务相符的权限模式。

## 独立插件包

连接器已内置在 dsh-superagent Worker preset 中。[plugins/corsair](../plugins/corsair/README.md) 仅作为旧 profile 的兼容包保留，全局行已禁用，避免向 Router 和其他 Session 暴露工具。无需单独安装。

## 限制

- 连接需要 Corsair 为 link 提供的有效 MCP endpoint 与 API key；当前 Host 不实现 Corsair 的交互式 OAuth。
- 工具仅进入新建的 dsh-superagent Worker Session，不进入主 Session；已启动 Worker 维持创建时的配置。
- 面板校验 HTTPS Corsair 域名和 `/mcp` 路径，但不在保存时验证远端 key；真实连接需要在 Worker 中执行一次 GitHub 只读查询。