# 参与开发

## 分支

- `main` 保持可用，只通过合并请求（Merge Request）进入。
- 功能分支命名：`feat/<简述>`、`fix/<简述>`、`docs/<简述>`。

## 提交信息

使用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/) 前缀，一句话说明“为什么改”：

```
feat: 手机端支持上传图片
fix: macOS 没有 /proc 导致看不到实时会话
docs: 补充中继部署步骤
test: 覆盖会话取名规则
chore: 升级插件版本号
```

常用前缀：`feat` 新功能、`fix` 修复、`docs` 文档、`test` 测试、`refactor` 重构、`chore` 构建与杂项。

## 提交前

1. 运行 `make test`，全部通过。
2. 改了中继（`relay.py`、`relay_lib/`）：至少在 Python 3.8 上也跑一遍，保持 3.8 兼容（不要用 `dict | dict`、`match` 等新语法）。
3. 改了 `web/`、`relay.py` 或 `relay_lib/`：运行 `make relay-package` 验证能打包，并在合并请求里写明“需要重新部署中继”。
4. 改了插件：在 `vscode-extension/package.json` 里升版本号（更新只会安装更高的版本），并写进 `CHANGELOG.md`；发布步骤见 README 的“插件与自动更新”。
5. 不要提交凭据、令牌、`relay.env`、更新签名的私钥（`update-private.pem`，应在仓库之外）、构建产物（`dist/`、`*.vsix`、`*.tgz`）。`.gitignore` 已经屏蔽，但提交前仍请看一眼 `git status`。

## 代码放在哪

| 改什么 | 放哪里 |
|---|---|
| Bridge 的会话、任务、审批、转录，中继客户端 | `bridge-js/`（入口 `server.js`、`relay-client.js`） |
| 中继的飞书登录、二维码 | `relay_lib/`（入口 `relay.py`） |
| 手机端页面 | `web/` |
| VS Code 插件 | `vscode-extension/` |
| 测试 | `tests/bridge/`、`tests/relay/`、`tests/web/`，与被测代码同名对应 |

Python 包内互相引用统一写成 `from relay_lib import qr`，不要写平铺的 `import qr`。新增模块放进对应目录，不要放回仓库根目录；根目录只保留入口脚本。

## 代码约定

- 中继只用 Python 标准库，Bridge 只用 Node 内置模块，都不引入第三方依赖。
- 中继客户端的输出文案被插件当作接口解析，改动文案要同步改插件和 `vscode-extension/test/`。
- 页面里新增会经过中继的内容（代码、文件、图片），要先考虑是否包含敏感信息；目前传输是明文。
