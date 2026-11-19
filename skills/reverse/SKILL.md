---
name: reverse
description: 逆向模式主流程。拿到样本后按类型路由到 Ghidra、Rizin、IDA、jadx、apktool 或 IPA MCP，并按分诊、静态、动态、结论推进。适用于二进制、APK、IPA、DEX、JAR 和 Mach-O 分析。
---

# 逆向主流程

流程参考 [reverse-skill](https://github.com/zhaoxuya520/reverse-skill) 的路由加阶段门闩，执行面换成 pi-cyber 的工作区和 `/reverse-tools`。只分析工作区 `targets/` 里已登记、且用户明确要分析的样本。不要执行未知样本，不要改原始文件，动态验证只在工作区副本上进行。

读完后直接做下一步，不要停在「已理解」。

## 1. 接入

1. 确认当前是逆向模式，样本已在 `targets/`。没有就用 `/reverse <路径>` 或 `reverse_add_target`。
2. 用 `file` 识别类型，再选一个主 MCP。路径以 `~/.pi/agent/pi-cyber/tool-paths.json` 为准，缺了就改这个文件，不要猜绝对路径。
3. `/reverse-tools start <name>`。Ghidra 若返回 `[NOT_READY]`，立刻调用一次 `ghidra_wait_ready`，不要让用户干等。

| 类型 | 主 MCP | 接着做什么 |
|------|--------|------------|
| ELF / PE / Mach-O / .so | `ghidra` | 等分析完成后 `get_program_info`，再反编译关键函数 |
| 只要快速看函数、导入、字符串 | `rizin` | 打开目标做侦察；深挖再切 Ghidra |
| 已有 IDA 9.4+ | `ida-pro` | 官方 Hex-Rays MCP。启动时已打开样本。先 `reference` 查 API，再用 `execute_python` 反编译和查交叉引用 |
| APK / DEX / JAR 的 Java | `jadx` | `load_apk` 后读类和方法 |
| APK 的 manifest / smali / 资源 | `apk` | `decode_apk` 到 `.cyber-tools/apk/workspace` |
| IPA / `.app` | `ipa` | `parse_ipa_tool` 或 `full_static_analysis` |
| APK 里的 native `.so` | 先 `apk` 或 `jadx` 定位 so，再对 so 走 `ghidra` | 不要停在 Java 层 |

一条路没有关键函数，就换工具，不要在同一个失败结果上重复刷。

## 2. 分诊

在进反编译之前写清这些事实，记到 `reverse/triage.md`：

- 样本路径、类型、架构
- 导入或导出，或 APK 的组件与权限，或 IPA 的 bundle 与 entitlements
- 字符串里的 URL、密钥材料、算法名
- 是否加壳或加密；看不清就写「未能解析」，不要当成「没有该能力」

分诊没写完，不要声称静态分析已经完成。

## 3. 静态

只追和用户问题有关的函数或类：校验、加解密、网络、授权。把地址或符号、结论、证据来源写到 `reverse/notes.md`。

- 原生：Ghidra / Rizin / IDA 的交叉引用和反编译
- Android：jadx 看 Java，apktool 看 smali 和 manifest
- iOS：IPA MCP 看包和 Mach-O；需要伪代码时把主二进制交给 Ghidra

大约一刻钟仍没有关键路径，就说明卡在哪里，并转入动态或换锚点。不要无限挖无关函数。

## 4. 动态

只有静态假设需要验证，且用户明确允许运行或挂钩时才做。在工作区副本上操作，把命令和观察写到 `reverse/dynamic.md`。没有行为或立刻退出时，记下反调试或环境检测的嫌疑，不要写成「样本无害」。

## 5. 结论

能回答用户问题时，把结果写到 `reports/`：问题、结论、证据文件、未解决项。证据要能回溯到某次 MCP 或命令输出。没有证据就不要下确定性结论。

阶段之间只补充新的决定。范围、样本路径和当前工具没变时，不要把整段上下文再复述一遍。
