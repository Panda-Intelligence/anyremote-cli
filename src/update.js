import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import process from "node:process";

function isBunxCacheEntry(cliPath, packageName, env) {
  const [scope, name] = packageName.split("/");
  if (!scope?.startsWith("@") || !name) return false;

  const bunInstall = env.BUN_INSTALL || join(homedir(), ".bun");
  const configuredCache =
    env.BUN_INSTALL_CACHE_DIR || join(bunInstall, "install", "cache");
  let cacheRoot = resolve(configuredCache);
  try {
    cacheRoot = realpathSync(cacheRoot);
  } catch {}

  const relativePath = relative(cacheRoot, cliPath).split(sep);
  return (
    (relativePath[0] === scope && relativePath[1]?.startsWith(`${name}@`)) ||
    relativePath[0]?.toLowerCase().startsWith(`${scope}+${name}@`)
  );
}

async function getLatestVersion(packageName, fetchImpl) {
  const packagePath = encodeURIComponent(packageName);
  const url = new URL(`https://registry.npmjs.org/${packagePath}/latest`);
  url.searchParams.set("check", `${Date.now()}-${process.pid}`);
  const response = await fetchImpl(url, {
    cache: "no-store",
    headers: {
      accept: "application/json",
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error("npm registry request failed");
  const metadata = await response.json();
  if (
    metadata?.name !== packageName ||
    typeof metadata.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
      metadata.version,
    )
  )
    throw new Error("npm registry returned invalid package metadata");
  return metadata.version;
}

function runLatestCli(packageName, version, argv, spawnImpl, stderr) {
  return new Promise((resolveExitCode) => {
    const child = spawnImpl(
      "bun",
      ["x", "--silent", `${packageName}@${version}`, ...argv],
      { stdio: "inherit" },
    );
    child.once("error", (error) => {
      stderr.write(
        `Could not start AnyRemote CLI ${version}: ${error.message}\n`,
      );
      resolveExitCode(1);
    });
    child.once("close", (code) => resolveExitCode(code ?? 1));
  });
}

export async function updateBunxCliIfNeeded({
  argv,
  cliPath,
  cliVersion,
  packageName,
  env = process.env,
  fetchImpl = fetch,
  spawnImpl = spawn,
  stderr = process.stderr,
}) {
  if (!isBunxCacheEntry(cliPath, packageName, env)) return false;

  let latestVersion;
  try {
    latestVersion = await getLatestVersion(packageName, fetchImpl);
  } catch {
    stderr.write(
      "Could not check for AnyRemote CLI updates; continuing with the cached version.\n",
    );
    return false;
  }

  if (latestVersion === cliVersion) return false;

  stderr.write(
    `Updating AnyRemote CLI from ${cliVersion} to ${latestVersion}.\n`,
  );
  process.exitCode = await runLatestCli(
    packageName,
    latestVersion,
    argv,
    spawnImpl,
    stderr,
  );
  return true;
}
