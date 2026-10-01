import assert from "node:assert/strict";
import { once } from "node:events";
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

test("process tools capture output, accept stdin and stop long-running processes", async (t) => {
  const executor = new LocalToolExecutor({ maxOutputBytes: 1024 * 1024 });
  t.after(() => executor.shutdown());
  const processInfo = await executor.startProcess({
    command: process.execPath,
    args: ["-e", "process.stdin.on('data', d => process.stdout.write(d));"],
    waitMs: 0,
  });
  const written = await executor.execute("process.write", {
    processId: processInfo.processId,
    stdin: "round trip",
    eof: true,
  });
  assert.equal(written.accepted, true);
  assert.equal(written.stdout, "round trip");
  const output = await executor.execute("process.read", {
    processId: processInfo.processId,
  });
  assert.match(output.stdout, /round trip/);
  const longProcess = await executor.execute("process.start", {
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 10000)"],
    waitMs: 0,
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
  assert.equal(processInfo.exited, true);
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

test("short process start returns both streams and the actual nonzero exit in one call", async (t) => {
  const executor = new LocalToolExecutor();
  t.after(() => executor.shutdown());
  const output = await executor.execute("process.start", {
    command: process.execPath,
    args: [
      "-e",
      'process.stdout.write("ready\\n");process.stderr.write("note\\n");process.exitCode=7',
    ],
  });
  assert.equal(output.stdout, "ready\n");
  assert.equal(output.stderr, "note\n");
  assert.equal(output.exitCode, 7);
  assert.equal(output.running, false);
  assert.equal(output.exited, true);
  assert.equal(output.outputStartCursor, 0);
  assert.equal(output.nextCursor, 11);
  assert.equal(output.truncated, false);
  assert.equal("outputCursor" in output, false);
  assert.equal(executor.processes.size, 1);
  const tail = await executor.execute("process.read", {
    processId: output.processId,
    cursor: output.nextCursor,
  });
  assert.equal(tail.stdout, "");
  assert.equal(tail.stderr, "");
  assert.equal(tail.nextCursor, 11);
  assert.equal(tail.exited, true);
});

test("response budgets leave a silent process alive and clean deadline, abort and stop waits", async (t) => {
  const executor = new LocalToolExecutor();
  t.after(() => executor.shutdown());
  const begin = performance.now();
  const running = await executor.execute("process.start", {
    command: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    waitMs: 25,
  });
  assert.ok(performance.now() - begin < 500);
  assert.equal(running.running, true);
  assert.equal(running.exited, false);
  assert.equal(running.stdout, "");
  const state = executor.processes.get(running.processId);
  assert.equal(state.listenerCount("changed"), 0);

  const readStarted = performance.now();
  const deadlineRead = await executor.execute(
    "process.read",
    { processId: running.processId, waitMs: 10_000 },
    { deadline: Date.now() + 60 },
  );
  assert.ok(performance.now() - readStarted < 300);
  assert.equal(deadlineRead.running, true);
  assert.equal(state.listenerCount("changed"), 0);

  const controller = new AbortController();
  const cancelled = executor.execute(
    "process.read",
    { processId: running.processId, waitMs: 10_000 },
    { signal: controller.signal },
  );
  assert.equal(state.listenerCount("changed"), 1);
  controller.abort();
  await assert.rejects(cancelled, { code: "REQUEST_TIMEOUT" });
  assert.equal(state.listenerCount("changed"), 0);
  assert.equal(state.finishedAt, null);

  const stoppedRead = executor.execute("process.read", {
    processId: running.processId,
    waitMs: 10_000,
  });
  await executor.execute("process.stop", { processId: running.processId });
  const stopped = await stoppedRead;
  assert.equal(stopped.exited, true);
  assert.equal(stopped.running, false);
  assert.equal(state.listenerCount("changed"), 0);
});

test("existing output returns immediately and concurrent readers share an independent byte cursor", async (t) => {
  const executor = new LocalToolExecutor();
  t.after(() => executor.shutdown());
  const running = await executor.execute("process.start", {
    command: process.execPath,
    args: [
      "-e",
      'process.stdout.write("ready");process.stdin.on("data",data=>process.stdout.write(data))',
    ],
    waitMs: 0,
  });
  const state = executor.processes.get(running.processId);
  await once(state.child.stdout, "data", { signal: AbortSignal.timeout(3000) });
  const begin = performance.now();
  const ready = await executor.execute("process.read", {
    processId: running.processId,
    waitMs: 10_000,
  });
  assert.equal(ready.stdout, "ready");
  assert.ok(performance.now() - begin < 300);
  const parameters = {
    processId: running.processId,
    cursor: ready.nextCursor,
    waitMs: 1000,
  };
  const first = executor.execute("process.read", parameters);
  const second = executor.execute("process.read", parameters);
  assert.equal(state.listenerCount("changed"), 2);
  state.child.stdin.write("next");
  const [firstOutput, secondOutput] = await Promise.all([first, second]);
  assert.equal(firstOutput.stdout, "next");
  assert.equal(secondOutput.stdout, "next");
  assert.equal(firstOutput.nextCursor, 9);
  assert.equal(secondOutput.nextCursor, 9);
  assert.equal(state.listenerCount("changed"), 0);
});

test("write returns a response from the pre-input tail and queues EOF once", async (t) => {
  const executor = new LocalToolExecutor();
  t.after(() => executor.shutdown());
  const running = await executor.execute("process.start", {
    command: process.execPath,
    args: [
      "-e",
      'process.stdout.write("ready\\n");let input="";process.stdin.on("data",data=>input+=data);process.stdin.on("end",()=>process.stdout.write("input:"+input))',
    ],
    waitMs: 0,
  });
  const state = executor.processes.get(running.processId);
  await once(state.child.stdout, "data", { signal: AbortSignal.timeout(3000) });
  await assert.rejects(
    executor.execute("process.write", {
      processId: running.processId,
      stdin: "should not be written",
      maxBytes: 0,
    }),
    { code: "VALIDATION_ERROR" },
  );
  const response = await executor.execute("process.write", {
    processId: running.processId,
    stdin: "once",
    eof: true,
  });
  assert.equal(response.accepted, true);
  assert.equal(response.eof, true);
  assert.equal(response.stdout, "input:once");
  assert.equal(response.nextCursor, 16);
  assert.equal(response.outputStartCursor, 0);
  await assert.rejects(
    executor.execute("process.write", {
      processId: running.processId,
      stdin: "second",
    }),
    { code: "CONFLICT" },
  );
  const all = await executor.execute("process.read", {
    processId: running.processId,
    cursor: 0,
  });
  assert.equal(all.stdout, "ready\ninput:once");
});

test("process wait and page limits reject invalid inputs before starting or writing", async (t) => {
  const executor = new LocalToolExecutor();
  t.after(() => executor.shutdown());
  for (const input of [
    { waitMs: -1 },
    { waitMs: 10001 },
    { waitMs: 0.5 },
    { maxBytes: 0 },
    { maxBytes: 65537 },
    { maxBytes: 1.5 },
  ]) {
    await assert.rejects(
      executor.execute("process.start", {
        command: process.execPath,
        ...input,
      }),
      { code: "VALIDATION_ERROR" },
    );
  }
  await assert.rejects(
    executor.execute(
      "process.start",
      { command: process.execPath },
      { deadline: Date.now() - 1 },
    ),
    { code: "REQUEST_TIMEOUT" },
  );
  assert.equal(executor.processes.size, 0);
  const immediate = await executor.execute("process.start", {
    command: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    waitMs: 0,
    maxBytes: 1,
  });
  assert.equal(immediate.running, true);
  assert.equal(immediate.nextCursor, 0);
  for (const tool of ["process.read", "process.write"]) {
    await assert.rejects(
      executor.execute(tool, {
        processId: immediate.processId,
        cursor: -1,
        stdin: "invalid",
      }),
      { code: "VALIDATION_ERROR" },
    );
  }
});

test("small Unicode write pages retain the handle and recover without writing stdin again", async (t) => {
  const executor = new LocalToolExecutor();
  t.after(() => executor.shutdown());
  const started = await executor.execute("process.start", {
    command: process.execPath,
    args: [
      "-e",
      'process.stdout.write("ready\\n");process.stdin.on("data",data=>process.stdout.write(data))',
    ],
    waitMs: 0,
  });
  const state = executor.processes.get(started.processId);
  await once(state.child.stdout, "data", { signal: AbortSignal.timeout(3000) });
  const response = await executor.execute("process.write", {
    processId: started.processId,
    stdin: "😀",
    maxBytes: 1,
  });
  assert.equal(response.accepted, true);
  assert.equal(response.processId, started.processId);
  assert.equal(response.nextCursor, 6);
  assert.match(response.error, /VALIDATION_ERROR.*maxBytes at least 4/);
  const recovered = await executor.execute("process.read", {
    processId: response.processId,
    cursor: response.nextCursor,
    maxBytes: 4,
  });
  assert.equal(recovered.stdout, "😀");
  assert.equal(recovered.nextCursor, 10);
  assert.equal(recovered.error, undefined);
  const complete = await executor.execute("process.read", {
    processId: started.processId,
    cursor: 0,
  });
  assert.equal(complete.stdout, "ready\n😀");
  assert.equal(executor.processes.size, 1);
});

test("UTF-8 pages smaller than a code point leave the cursor intact", async (t) => {
  const executor = new LocalToolExecutor();
  t.after(() => executor.shutdown());
  const output = await executor.execute("process.start", {
    command: process.execPath,
    args: ["-e", 'process.stdout.write("😀中文abc")'],
    maxBytes: 1,
  });
  assert.equal(output.stdout, "");
  assert.equal(output.nextCursor, 0);
  assert.equal(output.truncated, true);
  assert.match(output.error, /VALIDATION_ERROR.*maxBytes at least 4/);
  assert.equal(executor.processes.size, 1);
  const first = await executor.execute("process.read", {
    processId: output.processId,
    cursor: output.nextCursor,
    maxBytes: 4,
  });
  assert.equal(first.stdout, "😀");
  assert.equal(first.nextCursor, 4);
  assert.equal(first.error, undefined);
  const second = await executor.execute("process.read", {
    processId: output.processId,
    cursor: first.nextCursor,
    maxBytes: 6,
  });
  assert.equal(second.stdout, "中文");
  assert.equal(second.nextCursor, 10);
  const third = await executor.execute("process.read", {
    processId: output.processId,
    cursor: second.nextCursor,
    maxBytes: 3,
  });
  assert.equal(third.stdout, "abc");
  assert.equal(third.nextCursor, 13);
});

test("split OS chunks and interleaved stderr preserve complete UTF-8 output", async (t) => {
  const executor = new LocalToolExecutor();
  t.after(() => executor.shutdown());
  const started = await executor.execute("process.start", {
    command: process.execPath,
    args: [
      "-e",
      'const bytes=Buffer.from("😀中文");process.stdout.write(bytes.subarray(0,2));process.stderr.write("!");process.stdin.once("data",()=>process.stdout.write(bytes.subarray(2)))',
    ],
    waitMs: 0,
  });
  const state = executor.processes.get(started.processId);
  await once(state.child.stderr, "data", { signal: AbortSignal.timeout(3000) });
  const partial = await executor.execute("process.read", {
    processId: started.processId,
    waitMs: 0,
  });
  assert.equal(partial.stdout, "");
  assert.equal(partial.stderr, "!");
  assert.equal(partial.nextCursor, 1);
  assert.equal(partial.error, undefined);
  const closed = once(state.child, "close", {
    signal: AbortSignal.timeout(3000),
  });
  const completeRead = executor.execute("process.read", {
    processId: started.processId,
    cursor: partial.nextCursor,
  });
  assert.equal(state.listenerCount("changed"), 1);
  state.child.stdin.end("continue");
  const complete = await completeRead;
  await closed;
  assert.equal(complete.stdout, "😀中文");
  assert.equal(complete.stderr, "");
  assert.equal(complete.nextCursor, 11);
  assert.equal(complete.truncated, false);
});

test("a split Unicode character around large stderr output still pages forward", async (t) => {
  const executor = new LocalToolExecutor();
  t.after(() => executor.shutdown());
  const started = await executor.execute("process.start", {
    command: process.execPath,
    args: [
      "-e",
      'const bytes=Buffer.from("😀中文");process.stdout.write(bytes.subarray(0,2));process.stderr.write("x".repeat(200000),()=>process.stdout.write(bytes.subarray(2)))',
    ],
  });
  assert.equal(started.exited, true);
  assert.equal(started.truncated, true);
  let cursor = 0;
  let stdout = "";
  let stderr = "";
  let page;
  do {
    page = await executor.execute("process.read", {
      processId: started.processId,
      cursor,
      maxBytes: 4096,
    });
    assert.equal(page.error, undefined);
    assert.ok(page.nextCursor > cursor);
    assert.ok(
      Buffer.byteLength(page.stdout) + Buffer.byteLength(page.stderr) <= 4096,
    );
    stdout += page.stdout;
    stderr += page.stderr;
    cursor = page.nextCursor;
  } while (page.truncated);
  assert.equal(stdout, "😀中文");
  assert.equal(stderr, "x".repeat(200000));
  assert.equal(cursor, 200010);
});

test("invalid raw UTF-8 and evicted Unicode use normalized text byte cursors", async (t) => {
  const executor = new LocalToolExecutor();
  const smallBuffer = new LocalToolExecutor({ maxOutputBytes: 5 });
  t.after(() => Promise.all([executor.shutdown(), smallBuffer.shutdown()]));
  const invalid = await executor.execute("process.start", {
    command: process.execPath,
    args: ["-e", "process.stdout.write(Buffer.from([0xff,0xc3]))"],
  });
  assert.equal(invalid.stdout, "��");
  assert.equal(invalid.nextCursor, Buffer.byteLength(invalid.stdout));
  assert.equal(invalid.nextCursor, 6);
  const first = await executor.execute("process.read", {
    processId: invalid.processId,
    maxBytes: 3,
  });
  assert.equal(first.stdout, "�");
  assert.equal(first.nextCursor, 3);
  const second = await executor.execute("process.read", {
    processId: invalid.processId,
    cursor: first.nextCursor,
    maxBytes: 3,
  });
  assert.equal(second.stdout, "�");
  assert.equal(second.nextCursor, 6);
  const evicted = await smallBuffer.execute("process.start", {
    command: process.execPath,
    args: ["-e", 'process.stdout.write("😀abc")'],
  });
  assert.equal(evicted.stdout, "abc");
  assert.equal(evicted.truncated, true);
  assert.equal(evicted.outputStartCursor, 2);
  assert.equal(evicted.nextCursor, 7);
});

test("a failed spawn wakes start and cleans its wait listener", async (t) => {
  const executor = new LocalToolExecutor();
  t.after(() => executor.shutdown());
  const failed = await executor.execute("process.start", {
    command: path.join(os.tmpdir(), "anyremote-command-does-not-exist"),
  });
  assert.equal(failed.running, false);
  assert.equal(failed.exited, true);
  assert.equal(failed.exitCode, null);
  assert.match(failed.error, /ENOENT/);
  assert.equal(
    executor.processes.get(failed.processId).listenerCount("changed"),
    0,
  );
});
