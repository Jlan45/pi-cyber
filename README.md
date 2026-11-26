# pi-cyber

面向网络安全场景的模块化 Pi 插件包（Pi Package）。以**统一 Cyber 工作区**（一次任务 / 同一目标一个目录）为上下文边界，在同一目录内通过工作模式切换开展渗透、逆向、溯源与修复。

## 核心模型

- **目录 = 任务边界**：`/cyber <任务名>` 在固定根目录下创建 `<name>-YYYYMMDD` 工作区并迁移会话。根目录默认 `~/cyber-workspaces`，可用环境变量 `PI_CYBER_ROOT` 或 `~/.pi/agent/pi-cyber/settings.json` 的 `workspaceRoot` 改；不再跟着 pi 的启动目录走
- **模式 = 工作视角**：`/cyber pentest|reverse` 只切换模式，不更换目录。每个模式只暴露自己的工具和命令；溯源、漏洞修复模式还没有实现，选择器里不列出
- **模式外就是普通会话**：没进入模式、或 `/cyber off` 之后，不注入工作区 prompt 和 skill，不重定向路径，bash 和 Pi 内置的一致（沿用你设置里的 `shellPath` / `shellCommandPrefix`）
- **产物落盘**：各模式写入工作区内约定子目录；范围与资产由 `scope.json` / `targets/` 共享

```text
<engagement>-YYYYMMDD/
├── .cyber/manifest.json
├── scope.json
├── targets/
├── notes/  evidence/  reports/
├── pentest/  reverse/  attribution/  remediation/
└── .cyber-tools/<toolName>/
```

## 目录结构

```text
pi-cyber/
├── package.json
├── tsconfig.json
├── src/shared/
│   ├── mode.ts          # 模式定义、按模式分组的工具/命令可见性
│   ├── engage.ts        # 一步进入：登记目标 + 建区 + 迁移会话
│   ├── workspace.ts     # 统一工作区创建 / 会话迁移 / 布局
│   ├── execution.ts     # 本机 / SSH 执行环境、主机密钥校验、SFTP 拉回
│   ├── tools.ts         # 通用 MCP 工具生命周期管理
│   └── scope.ts         # scope.json 解析与越界检查
├── extensions/
│   ├── core/            # /cyber 工作区总控 + 路径重定向
│   ├── pentest/         # 渗透：scope 护栏、工具、prompt
│   ├── reverse/         # 逆向：目标登记、工具、prompt
│   ├── attribution/
│   └── remediation/
├── skills/
├── prompts/
└── tests/               # npm test
```

## 常用命令

| 命令 | 作用 |
|------|------|
| `/cyber` | 两级选择器：先选项目，再选模式（可新建） |
| `/cyber <任务名>` | 直接创建工作区并迁移会话 |
| `/cyber reverse <样本路径>` | 一步完成：建区（无工作区时）、登记样本、进入逆向模式 |
| `/cyber pentest\|reverse` | 在当前工作区内切换模式 |
| `/cyber off` | 退出工作模式（保留目录） |
| `/pentest` / `/reverse` | 已进入工作模式后在两个模式间切换；`/reverse <路径>` 同时登记样本 |
| `/runtime` | 仅渗透模式：选择执行环境，远程时接管 bash / `!` |
| `/reverse-tools` | 仅逆向模式：手动管理逆向 MCP。模型自己用 `reverse_tool` 工具 |

## 渗透模式要点

1. `/cyber <任务名>` 创建工作区  
2. 配置执行环境（列表，含 `name` / `type`；ssh 含认证）：  
   - 全局默认：`~/.pi/agent/pi-cyber/execution.json`（`/runtime ssh lab root@host --global`）  
   - 工作区覆盖：`.cyber/execution.json`（同名覆盖 + `active`）  
   - 切换：`/runtime` 选择器，或 `/runtime use <name>` / `local`
3. `pentest_set_scope` 写入授权范围（`in_scope` / `out_of_scope`）  
4. 信息收集与安全评估（httpx/nuclei 等在远程 runtime 上执行，不再加载本机 MCP）  
5. 远程命令写出的文件在远端磁盘上。用 `pentest_fetch` 通过 SFTP 拉回 `evidence/` 再读  
6. 证据与报告写入 `notes/` `evidence/` `reports/` `pentest/`

授权范围（`scope.json`）：
- `pentest_set_scope` 写入 `in_scope` / `out_of_scope` 并注入系统提示词，由模型自行判断边界；框架侧不对 `bash` / `!` 做拦截或确认
- 可用 `pentest_check_scope` 辅助核对目标（支持域名、通配符、IPv4/IPv6 与 CIDR）

SSH 执行环境：
- 主机密钥默认 `accept-new`：首次连接记下指纹（`~/.pi/agent/pi-cyber/known_hosts`，同时读 `~/.ssh/known_hosts`），之后密钥变了会拒绝连接。环境里可设 `hostKeyCheck` 为 `strict` 或 `off`
- `execution.json` 无效时不会回退到本机，bash 和 `!` 会被直接拒绝并提示原因
- `execution.json` 以 0600 权限写入；优先用 key 或 ssh-agent，密码是明文保存

## 逆向模式要点

1. 任何时候：`/cyber reverse <样本路径>`。没有工作区就按样本名在工作区根目录下新建，登记样本并进入逆向模式  
2. 已在逆向模式：`/reverse <二进制>` 或 `reverse_add_target` 将样本拷入 `targets/`  
3. 模型用 `reverse_tool`（或你用 `/reverse-tools`）按类型启动 MCP：原生用 IDA / Ghidra / Rizin，APK 用 `apk`（smali）和 `jadx`（Java），IPA 用 `ipa`。`reverse_tool start` 会等到 MCP 连上或失败才返回；同一个工具重复 start 不会重启；`target` 参数可指定分析哪个已登记样本
   - `tools.json` 里 `mcp.timeout` 是单次请求超时，单位**秒**；`mcp.startupTimeoutSec` 是启动上限，超过就报失败
4. 工具路径不写死在仓库里。首次启动会在 `~/.pi/agent/pi-cyber/tool-paths.json` 写入探测结果，改这个文件即可换 Ghidra、Java、Rizin、jadx jar 等位置

## 开发

```bash
npm run typecheck
npm test
```

## 本地调试

加载整个插件包：

```bash
pi -e .
```

仅加载单个扩展：

```bash
pi -e ./extensions/pentest/index.ts
```
