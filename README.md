# pi-cyber

面向网络安全场景的模块化 Pi 插件包（Pi Package）。以**统一 Cyber 工作区**（一次任务 / 同一目标一个目录）为上下文边界，在同一目录内通过工作模式切换开展渗透、逆向、溯源与修复。

## 核心模型

- **目录 = 任务边界**：`/cyber <任务名>` 创建 `<name>-YYYYMMDD` 工作区并迁移会话
- **模式 = 工作视角**：`/pentest` `/reverse` `/attribution` `/remediation`（或 `/cyber <mode>`）只切换模式，不更换目录
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
│   ├── mode.ts          # 模式定义与事件总线
│   ├── workspace.ts     # 统一工作区创建 / 会话迁移 / 布局
│   ├── tools.ts         # 通用 MCP 工具生命周期管理
│   └── scope.ts         # scope.json 解析与越界检查
├── extensions/
│   ├── core/            # /cyber 工作区总控 + 路径重定向
│   ├── pentest/         # 渗透：scope 护栏、工具、prompt
│   ├── reverse/         # 逆向：目标登记、工具、prompt
│   ├── attribution/
│   └── remediation/
├── skills/
└── prompts/
```

## 常用命令

| 命令 | 作用 |
|------|------|
| `/cyber` | 两级选择器：先选项目，再选模式（可新建） |
| `/cyber <任务名>` | 直接创建工作区并迁移会话 |
| `/cyber pentest\|reverse\|...` | 在当前工作区内切换模式 |
| `/cyber off` | 退出工作模式（保留目录） |
| `/pentest` / `/reverse` / … | 已进入工作模式后切换；模式外不可用 |
| `/runtime` | 已进入工作模式后选择执行环境；渗透模式下劫持 bash / `!` |
| `/reverse-tools` | 已进入工作模式后管理逆向 MCP（IDA / Ghidra 等） |

## 渗透模式要点

1. `/cyber <任务名>` 创建工作区  
2. 配置执行环境（列表，含 `name` / `type`；ssh 含认证）：  
   - 全局默认：`~/.pi/agent/pi-cyber/execution.json`（`/runtime ssh lab root@host --global`）  
   - 工作区覆盖：`.cyber/execution.json`（同名覆盖 + `active`）  
   - 切换：`/runtime` 选择器，或 `/runtime use <name>` / `local`
3. `pentest_set_scope` 写入授权范围（`in_scope` / `out_of_scope`）  
4. 信息收集与安全评估（httpx/nuclei 等在远程 runtime 上执行，不再加载本机 MCP）；主机越界会被护栏拦截  
5. 证据与报告写入 `notes/` `evidence/` `reports/` `pentest/`

## 逆向模式要点

1. 已有工作区：`/reverse <二进制>` 或 `reverse_add_target` 将样本拷入 `targets/`  
2. 无工作区：`/reverse <路径>` 按目标名创建 Cyber 工作区、登记目标并迁移会话  
3. `/reverse-tools` 按类型启动 MCP：原生用 IDA / Ghidra / Rizin，APK 用 `apk`（smali）和 `jadx`（Java），IPA 用 `ipa`
4. 工具路径不写死在仓库里。首次启动会在 `~/.pi/agent/pi-cyber/tool-paths.json` 写入探测结果，改这个文件即可换 Ghidra、Java、Rizin、jadx jar 等位置

## 本地调试

加载整个插件包：

```bash
pi -e .
```

仅加载单个扩展：

```bash
pi -e ./extensions/pentest/index.ts
```
