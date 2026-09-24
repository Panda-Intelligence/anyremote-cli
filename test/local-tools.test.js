import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LocalToolExecutor } from "../src/local-tools.js";

async function withTempDirectory(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "anyremote-cli-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("file tools perform real read, versioned write, list and search operations", async () => {
  await withTempDirectory(async (directory) => {
    const executor = new LocalToolExecutor({ maxReadBytes: 1024 * 1024 });
    const filePath = path.join(directory, "hello world.txt");
    await writeFile(filePath, "hello remote\n", "utf8");
    const read = await executor.execute("files.read", { path: filePath });
    assert.equal(read.content, "hello remote\n");
    const written = await executor.execute("files.write", {
      path: filePath,
      content: "changed",
      expectedVersion: read.version,
    });
    assert.equal(await readFile(filePath, "utf8"), "changed");
    assert.notEqual(written.version, read.version);
    await assert.rejects(
      () =>
        executor.execute("files.write", {
          path: filePath,
          content: "stale",
          expectedVersion: read.version,
        }),
      { code: "CONFLICT" },
    );
    const listed = await executor.execute("files.list", { path: directory });
    assert.equal(listed.entries[0].name, "hello world.txt");
    const searched = await executor.execute("files.search", {
      root: directory,
      query: "hello",
      mode: "filename",
    });
    assert.equal(searched.matches.length, 1);
    const emptyPath = path.join(directory, "empty.txt");
    const empty = await executor.execute("files.write", {
      path: emptyPath,
      content: "",
    });
    assert.equal(empty.size, 0);
  });
});

test("large files are returned with a byte cursor and bounded search reports truncation", async () => {
  await withTempDirectory(async (directory) => {
    const executor = new LocalToolExecutor({
      maxReadBytes: 16,
      maxSearchFiles: 1,
    });
    const filePath = path.join(directory, "large.txt");
    await writeFile(filePath, "0123456789abcdefghijklmnop", "utf8");
    const first = await executor.execute("files.read", {
      path: filePath,
      maxBytes: 8,
    });
    assert.equal(first.content, "01234567");
    assert.equal(first.nextCursor, 8);
    const second = await executor.execute("files.read", {
      path: filePath,
      cursor: first.nextCursor,
      maxBytes: 8,
    });
    assert.equal(second.content, "89abcdef");
    assert.equal(second.truncated, true);
    await writeFile(path.join(directory, "match-a.txt"), "a");
    await writeFile(path.join(directory, "match-b.txt"), "b");
    const search = await executor.execute("files.search", {
      root: directory,
      query: "match",
      limit: 10,
    });
    assert.equal(search.truncated, true);
  });
});

test("utf8 paging keeps cursor boundaries and rejects malformed base64", async () => {
  await withTempDirectory(async (directory) => {
    const executor = new LocalToolExecutor({ maxReadBytes: 16 });
    const filePath = path.join(directory, "unicode.txt");
    await writeFile(filePath, "中文 · Français", "utf8");
    const first = await executor.execute("files.read", {
      path: filePath,
      maxBytes: 5,
    });
    assert.equal(first.content, "中");
    assert.equal(first.nextCursor, 3);
    const second = await executor.execute("files.read", {
      path: filePath,
      cursor: first.nextCursor,
      maxBytes: 3,
    });
    assert.equal(second.content, "文");
    assert.equal(second.nextCursor, 6);
    await assert.rejects(
      () =>
        executor.execute("files.write", {
          path: path.join(directory, "invalid.bin"),
          content: "not base64?",
          encoding: "base64",
        }),
      { code: "VALIDATION_ERROR" },
    );
  });
});

test("process tools capture output, accept stdin and stop long-running processes", async () => {
  const executor = new LocalToolExecutor({ maxOutputBytes: 1024 * 1024 });
  const processInfo = executor.startProcess({
    command: process.execPath,
    args: ["-e", "process.stdin.on('data', d => process.stdout.write(d));"],
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    (
      await executor.execute("process.write", {
        processId: processInfo.processId,
        stdin: "round trip",
        eof: true,
      })
    ).accepted,
    true,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  const output = await executor.execute("process.read", {
    processId: processInfo.processId,
  });
  assert.match(output.stdout, /round trip/);
  const longProcess = await executor.execute("process.start", {
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 10000)"],
  });
  const stopped = await executor.execute("process.stop", {
    processId: longProcess.processId,
  });
  assert.equal(stopped.stopped, true);
  await assert.rejects(
    () =>
      executor.execute("process.start", {
        command: process.execPath,
        cwd: "/path/that/does/not/exist",
      }),
    { code: "NOT_FOUND" },
  );
});

test("process output is retained within the configured byte bound", async () => {
  const executor = new LocalToolExecutor({ maxOutputBytes: 32 });
  const processInfo = await executor.execute("process.start", {
    command: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(128))"],
  });
  await new Promise((resolve) => setTimeout(resolve, 75));
  const output = await executor.execute("process.read", {
    processId: processInfo.processId,
    maxBytes: 64,
  });
  assert.ok(Buffer.byteLength(output.stdout) <= 64);
  assert.equal(output.truncated, true);
});

test("process output paging does not split a utf8 code point", async () => {
  const executor = new LocalToolExecutor({ maxOutputBytes: 1024 });
  const processInfo = await executor.execute("process.start", {
    command: process.execPath,
    args: ["-e", "process.stdout.write('😀abc')"],
  });
  let processOutput;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    processOutput = await executor.execute("process.read", {
      processId: processInfo.processId,
      maxBytes: 1024,
    });
    if (processOutput.exited) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(processOutput.exited, true);
  const first = await executor.execute("process.read", {
    processId: processInfo.processId,
    maxBytes: 5,
  });
  assert.equal(first.stdout, "😀a");
  assert.equal(first.nextCursor, 5);
  const second = await executor.execute("process.read", {
    processId: processInfo.processId,
    cursor: first.nextCursor,
    maxBytes: 5,
  });
  assert.equal(second.stdout, "bc");
});
