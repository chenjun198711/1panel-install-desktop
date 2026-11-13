# 第三方组件与许可声明

本项目自身代码以 MIT 许可发布（见 LICENSE）。以下组件随发布产物或运行时一同使用，
各自遵循其原有许可。

## 一、随发布产物分发的组件

| 组件 | 许可 | 说明 |
| --- | --- | --- |
| Node.js 运行时 | MIT | 内置 `runtime/node.exe`，许可原文见 `runtime/LICENSE` |
| express | MIT | npm 依赖 |
| socket.io | MIT | npm 依赖，含前端客户端 |
| ssh2 | MIT | npm 依赖 |
| Microsoft Edge WebView2 SDK | Microsoft 软件许可条款 | 桌面窗口内核，随应用分发其 DLL，不得单独再分发 |

## 二、运行时下载、未随本项目分发的组件

| 组件 | 许可 | 说明 |
| --- | --- | --- |
| 1Panel 面板安装脚本与面板本体 | GPLv3 | 由 1Panel 官方发布（https://github.com/1Panel-dev/1Panel），安装时从官方源下载并在用户服务器上执行；本程序不包含其源码或二进制 |
| Docker Engine / Docker Compose | Apache-2.0 | 由 1Panel 官方 install.sh 在用户选择安装时从 Docker 官方源获取，本程序不分发 |

## 三、说明

本项目为第三方封装工具，与 1Panel 官方（杭州飞致云信息科技有限公司 / FIT2CLOUD）无隶属关系。
所有安装动作均通过 1Panel 官方安装脚本完成，脚本内容与行为以官方发布为准。
1Panel 为 GPLv3 软件；本工具仅在运行时调用官方脚本，不修改、不内嵌、不再分发 1Panel 程序。