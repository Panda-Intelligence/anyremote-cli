# @panda-ai/anyremote

<p align="center">
  <img src="https://preview.anyremote.dev/anyremote-app-icon.svg" alt="AnyRemote" width="112" height="112" />
</p>

Updated September 24, 2026. Editor: Codex.

The AnyRemote CLI runs on a computer you want to control. It receives MCP requests from AnyRemote and uses Node.js file and process APIs on that computer.

## Requirements

Run the published CLI with Node.js `>=20.9.0`. The repository's development scripts use Bun `1.3.11`.

## Start a remote session

Start the local AnyRemote app, then run this command from the repository root:

```sh
bun run src/bin.js remote --base-url http://localhost:5173
```

The CLI opens a browser so you can sign in and approve the device. If it cannot open a browser, visit the URL and enter the approval code printed in the terminal. Add `--no-browser` to skip the automatic browser launch. The CLI and app must use the same origin.

The `remote` flow saves device credentials. It does not save the browser authorization session or enrollment token. Each time you start `remote`, the CLI asks you to authorize the device again. If the saved device is still active, the CLI keeps its device ID and dashboard name and rotates its device token. If the device was revoked or deleted, the CLI registers a replacement during the same authorization flow.

Use `connect` to connect with saved device credentials. Both commands reconnect after a temporary network failure without asking you to authorize again or replaying a request. Press Ctrl+C, send SIGTERM, or revoke the device to disconnect. The CLI also stops process tasks that it started. It does not install a background service or configure startup at login.

## Device names

The CLI chooses a device name from the operating system. On macOS it reads ComputerName. On Linux it tries the pretty hostname. On Windows it uses the host name. If a lookup fails, the CLI falls back to the host name and then a platform default.

Pass `--name 'Work computer'` to choose a name. Names must contain 1 to 120 characters, cannot be blank, and cannot include control characters. Automatic names keep Unicode characters, remove control characters, and stay within the length limit. The `remote` and `pair` commands use the same rules.

Reauthorizing an existing device does not change its name, even when you pass a different `--name`. Rename it in the dashboard.

## Run the published package

After you publish the package, use one of these commands to start `remote`. Replace the example address with your AnyRemote service URL.

```sh
# Bun
bunx @panda-ai/anyremote remote --base-url https://your-anyremote-domain
# npm
npx @panda-ai/anyremote remote --base-url https://your-anyremote-domain
# pnpm
pnpm dlx @panda-ai/anyremote remote --base-url https://your-anyremote-domain
# Yarn
yarn dlx @panda-ai/anyremote remote --base-url https://your-anyremote-domain
```

You can also use these commands with a published package:

```sh
bunx @panda-ai/anyremote doctor
bunx @panda-ai/anyremote login --base-url https://your-anyremote-domain --email you@example.com --password 'your-password'
bunx @panda-ai/anyremote pair --base-url https://your-anyremote-domain --token "$ANYREMOTE_TOKEN" --wait
bunx @panda-ai/anyremote connect --base-url https://your-anyremote-domain --token "$ANYREMOTE_TOKEN"
bunx @panda-ai/anyremote logout --base-url https://your-anyremote-domain
bunx @panda-ai/anyremote revoke --base-url https://your-anyremote-domain
```

## Develop and test

Run these commands from the repository root. They install the CLI and shared protocol contracts from this repository's Bun workspace.

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
bun run build
```

`bun run test` runs the CLI tests and the contract tests in `packages/contracts`. The build writes the CLI entry points to `dist/`.

To run the source version against a local AnyRemote app, use the `remote` command shown above. To create and install a package tarball, run:

```sh
bun pm pack --destination artifacts
bun install --global ./artifacts/panda-ai-anyremote-0.2.1.tgz
```

The CLI repository includes the shared protocol contracts and uses the MIT License. The parent AnyRemote repository pins its CLI version through a Git submodule.

`login` also reads `ANYREMOTE_EMAIL` and `ANYREMOTE_PASSWORD`. The `pair`, `connect`, and account-management commands read `ANYREMOTE_URL` and `ANYREMOTE_TOKEN`. The CLI stores account sessions in the local config directory. Set `ANYREMOTE_CONFIG_DIR` to use a separate config directory. ChatGPT uses its own OAuth flow when it connects to `/mcp`; it does not use the CLI account token.

The `logout` command ends the account session and keeps the device connection. It clears saved account credentials, including a session that has already expired. It keeps the credentials when a network or server error prevents logout. The `revoke` command revokes the saved device and clears its local credentials. It requires an account session or `ANYREMOTE_TOKEN`. The older `disconnect` command remains an alias for `revoke`. If no device is saved, `revoke` succeeds without making a request. The dashboard must approve a pairing code before `pair` can connect.

## Request logs

The CLI writes request time, request ID, tool name, status, and duration to stderr. It does not log request arguments, paths, file contents, commands, environment variables, results, tokens, or approval codes. Stdout remains available for command output.

## Screen capture

The `screen.capture` tool captures the primary desktop on the target computer. It returns a text summary and a PNG image in the same MCP response. The CLI scales and compresses the image to no more than 1 MiB. The Worker retains the result in the existing device request record for 60 seconds. The CLI does not upload the image to a third-party image host or include a temporary file path in the response or diagnostic log.

On macOS, allow the terminal app to record the screen the first time you use this tool. On Linux, install `grim`, `gnome-screenshot`, or `scrot`. On Windows, the CLI uses PowerShell to capture the primary display.

The tool returns a structured error if there is no desktop session, the operating system denies permission, or the image cannot be compressed below the size limit. An MCP client may support image blocks without displaying them in its interface. Check the behavior of your MCP client.
