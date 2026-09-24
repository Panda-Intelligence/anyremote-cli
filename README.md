# @panda-ai/anyremote

<p align="center">
  <img src="https://preview.anyremote.dev/anyremote-app-icon.svg" alt="AnyRemote" width="112" height="112" />
</p>

更新：2026-09-24；维护：Codex。

AnyRemote 本地连接器。它在目标电脑上运行，接收云端 MCP 请求并通过 Node.js 标准文件与进程 API 执行操作。

运行时要求 Bun，或 Node.js `>=20.9.0`。需要使用 Node.js 运行包时，请先检查
`node --version`；低于此版本的 Node 不受当前图像处理依赖支持。

开发版本一条命令接入（先启动本地应用）：

```sh
bun run src/bin.js remote --base-url http://localhost:5173
```

命令打开浏览器，登录后确认授权，随后持续连接本机。浏览器无法打开时使用终端
显示的 URL 与批准码，也可加 `--no-browser`。同一 Origin 必须与应用配置一致。
仅设备凭据保存在配置文件中，不保存本次授权的账号会话或 enrollment token。
每次显式运行 `remote` 都会打开浏览器并要求一次新的设备授权。若本机保存的设备
仍然有效，授权后复用原设备 ID 和控制台名称，只轮换设备凭据；设备已撤销或删除
时会在同一轮授权中登记替代设备。`connect` 才是使用已保存凭据直接连接的命令。
Ctrl+C、SIGTERM 或设备撤销会断开连接并停止本 CLI 管理的进程任务；短暂断网重连
保留任务，不重新授权、不重新执行请求。本命令不是后台服务，也不提供开机自启。
独立配置可使用
`ANYREMOTE_CONFIG_DIR`。

新设备默认使用系统电脑名称：macOS 读取 ComputerName，Linux 尝试 pretty
hostname，Windows 使用主机名；读取失败回退到主机名，再回退到平台通用名称。
可使用 `--name '工作电脑'` 指定名称（1–120字符，不能只有空白或包含控制字符）。
自动名称保留 Unicode，过滤控制字符并限制长度。`remote` 与 `pair` 使用相同规则。
重新授权同一设备不会更新名称，即使提供新的 `--name`；请在控制台明确重命名。

公共包发布后可用下列任一包管理器启动 `remote`（将域名替换为你的 AnyRemote
服务地址）：

```sh
# Bun
bunx @panda-ai/anyremote remote --base-url https://你的应用域名
# npm
npx @panda-ai/anyremote remote --base-url https://你的应用域名
# pnpm
pnpm dlx @panda-ai/anyremote remote --base-url https://你的应用域名
# Yarn
yarn dlx @panda-ai/anyremote remote --base-url https://你的应用域名
```

四种命令都调用同一个已发布的 `@panda-ai/anyremote` 包；请选择本机已安装的包
管理器。仓库内的 `bun run --cwd` 命令仅用于本地验证，不能将未发布的包当成可安装
版本。

以下为已有的分步流程（需要已发布包或已安装的本地包）：

```sh
bunx @panda-ai/anyremote doctor
bunx @panda-ai/anyremote login --base-url https://example.com --email you@example.com --password 'your-password'
bunx @panda-ai/anyremote pair --base-url https://example.com --token "$ANYREMOTE_TOKEN" --wait
bunx @panda-ai/anyremote connect --base-url https://example.com --token "$ANYREMOTE_TOKEN"
bunx @panda-ai/anyremote logout --base-url https://example.com
bunx @panda-ai/anyremote revoke --base-url https://example.com
```

开发时也可以直接使用未发布的 workspace 版本：

```sh
bun run src/bin.js doctor
bun pm pack --destination artifacts
bun install --global ./artifacts/panda-ai-anyremote-0.2.1.tgz
```

`login` 也读取 `ANYREMOTE_EMAIL` 和 `ANYREMOTE_PASSWORD`；`pair`、`connect` 和
账号管理命令读取 `ANYREMOTE_URL`、`ANYREMOTE_TOKEN`。登录会话保存在本机配置目录。
ChatGPT 网页连接 `/mcp` 时在 ChatGPT 中完成 OAuth 授权，不使用 CLI 账号令牌。

`logout` 只结束当前账号会话，不会撤销设备；它会清除本机保存的账号凭证，已失效
的会话也会按成功处理，网络或服务端错误则保留凭证以便重试。`revoke` 撤销保存的
设备并清除本机设备凭证，要求账号会话或 `ANYREMOTE_TOKEN`；没有保存设备时是成功的
幂等空操作。旧命令 `disconnect` 仍可作为 `revoke` 的兼容别名。撤销后如需再次连接，
重新运行 `remote` 完成设备授权即可。

`pair` 返回的配对码需要在 AnyRemote 控制台批准。`connect` 只主动建立 WSS；网络中断不会自动重新执行已经派发的副作用请求。

设备收到工具调用后，CLI 仅在 stderr 输出时间、request ID、工具名、状态和耗时。
参数、路径、文件内容、命令、环境变量、结果、token 与授权码不会写入日志；stdout
仍只用于命令输出。

## 开发与测试

此 repository 独立维护 CLI 与共享协议契约。需要 Bun 1.3.11 和 Node.js 20.9 或更新版本；
从仓库根目录运行：

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
bun run build
```

`bun run test` 会运行 CLI 与 `packages/contracts` 的测试。CLI 以 MIT 授权发布；父项目
通过 `packages/cli` Git submodule 固定使用的 CLI commit。

### 截图视觉回传

远程工具 `screen.capture` 捕获目标电脑的默认桌面，并在同一次 MCP 调用结果中
返回文字摘要和标准 PNG 图片 content block。截图在目标电脑本地处理；PNG 经缩放与
调色板压缩后不超过 1 MiB，结果只在现有设备请求记录中保留 60 秒。CLI 不上传
第三方图床，也不会把临时文件路径放进响应或诊断日志。

macOS 首次使用时需允许当前终端进行“屏幕与系统录音”访问。Linux 需要至少安装
`grim`（Wayland）、`gnome-screenshot` 或 `scrot`（X11）；Windows 使用系统
PowerShell 截取主显示器。没有桌面会话、权限被拒绝、图片无法压缩到限制内时，工具会
返回结构化错误。服务器支持 MCP image block 不代表每个客户端界面都必定显示图片；
请以你所用 MCP 客户端的实际展示能力为准。
