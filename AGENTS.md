# AGENTS.md

GitHub 插件下载器：一个 Chrome / Edge Manifest V3 扩展，批量跟踪 GitHub 上的插件项目，下载 Release 发布包或分支源码，ZIP 自动解压到用户授权的目录，并按周期检查更新。

## 技术栈与约束

- 纯 JavaScript（ES Module），**无依赖、无构建步骤**；仓库根目录就是可直接"加载已解压的扩展程序"的扩展目录
- 最低 Chrome 120（`manifest.json` 的 `minimum_chrome_version`）
- 只支持公开仓库：GitHub API 请求不带认证
- 界面文字和报错信息都是中文

## 目录结构

| 文件 | 作用 |
|---|---|
| `manifest.json` | 权限：`storage`、`downloads`、`alarms`；只允许访问 GitHub 相关域名 |
| `background.js` | Service worker：状态读写、GitHub API、检查更新、下载 / 解压队列、消息处理 |
| `core.js` | 纯函数：仓库地址解析（`repoFrom`）、安全文件名（`safeName`）、设置校验（`settings`）、发布包选择（`chooseAsset`）、项目配置（`projectConfig`） |
| `filesystem.js` | 用 File System Access API 写入用户授权的管理目录；目录句柄存在 IndexedDB `plugin-directories` |
| `zip.js` | 自己实现的 ZIP 解压：CRC 校验、路径校验、大小限制 |
| `manager.html` / `manager.js` / `style.css` | 管理页（`options_page`，点击工具栏图标打开） |
| `examples/RicardoSJin-github-plugins.json` | 可导入的示例配置（作者自己的公开插件） |
| `tests/` | `node:test` 单元测试 |
| `package.ps1` | 打包脚本（PowerShell） |

## 常用命令

| 用途 | 命令 |
|---|---|
| 测试 | `npm test`（即 `node --test tests/*.test.js`，无需安装依赖） |
| 打包（Windows） | `powershell -File package.ps1` → `dist/github-extension-loader-v<版本>.zip` |
| 打包（macOS，生成的 9 个文件与 `package.ps1` 一致，尚未用于正式发布） | `mkdir -p dist && zip -X -j dist/github-extension-loader-v$(node -p "require('./manifest.json').version").zip manifest.json background.js core.js filesystem.js zip.js manager.html manager.js style.css README.md` |

打包只包含 `package.ps1` 里列出的文件；新增运行时文件时要同步加进打包清单。

## 本地调试

1. `chrome://extensions`（或 `edge://extensions`）开启开发者模式 →"加载已解压的扩展程序"→ 选仓库根目录
2. 改代码后在扩展页点"重新加载"；service worker 的日志在扩展卡片的"Service Worker"检查器里看

## 架构要点

- **状态**：全部存在 `chrome.storage.local` 的 `state` 键（`settings`、`projects`、`logs`、`queue`、`blockedUntil`），日志最多 150 条
- **串行化**：所有读改写状态的操作都经过 `background.js` 的 `serial()` 链，避免并发覆盖。新增修改状态的入口必须走 `serial()`
- **定时**：闹钟 `update-tick` 每分钟触发，把到期项目放入队列；闹钟 `queue` 处理队列，每次最多处理 3 个，剩余的稍后继续
- **限流**：GitHub 返回 403 / 429 时按 `x-ratelimit-reset` / `retry-after` 设置 `blockedUntil`，期间暂停处理队列
- **检查模式**：`release`（默认取 latest，可选含预发布）只认 `.zip` / `.crx` / `.xpi` 发布包，多个候选时用 `pattern`（`*` 是唯一通配符）选择；`source` 模式下载指定分支（留空为默认分支）最新提交的源码 ZIP
- **版本标识**：发布包用 `release.id:asset.id:updated_at:size`，源码用提交 SHA；只有标识变化才重新下载
- **ZIP 处理**：下载后在内存中解压，去掉外层包装目录，写入 `<管理目录>/<作者>_<项目>/`；CRX / XPI 只作为普通下载保存
- **管理页与后台通信**：`chrome.runtime.sendMessage`，`type` 为 `get`、`add`、`settings`、`directoryChanged`、`project`、`remove`、`check`、`import`、`clearLogs`；只接受来自本扩展的消息
- **配置导入导出**：格式 `{version: 1, settings, projects}`，最多 500 个项目；不包含下载记录和目录授权

## 安全约束（不要放宽）

- 下载地址只允许 `https://github.com`
- ZIP：拒绝路径穿越、Windows 保留名和别名、重名冲突、符号链接、加密包；最多 5000 个文件、解压后 100 MB；不支持 ZIP64
- 写文件时**只覆盖压缩包里有的文件，绝不递归删除用户目录**；`manifest.json` 最后写入，保证中途失败时不会被当成完整的新版本
- 目录授权由浏览器弹窗确认，不能也不要尝试绕过

## 开发流程

- 功能在分支上开发，通过 PR 合并到 `main`（已有分支命名：`codex/<功能描述>`）
- 发布：更新 `manifest.json` 的 `version` → `npm test` → 打包 → 创建 GitHub Release `v<版本>` 并上传 ZIP
- 修改行为时同步更新 `README.md`（面向用户的中文说明）和相应测试

## 编码风格

- 保持现有的紧凑写法：短函数、少空行、不引入框架和依赖
- 新的纯逻辑放进 `core.js` 并写测试；涉及 `chrome.*` 的逻辑放在 `background.js`
