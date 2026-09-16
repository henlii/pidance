/**
 * 队列消费边界的回归测试（issue #42 / D2）。
 *
 * 每个用例对应一个已发生过的真实缺陷，而不是接口练习：
 * - `send()` 返回结构化 rejected/queued（不抛异常）时，旧实现当成「已投递」并按 id
 *   删掉条目 → 丢消息或重复投递
 * - flush 开始时固定了条目正文，用户中途清掉的条目仍会被旧批次发出去
 * - `followUpSending` 是全局布尔，外部 prompt 会在 flush 在途窗口并发起 run
 * - 认领落盘失败后 resetIdleTimer → scheduleFollowUpFlush 立刻重入同一失败
 * - compact-only 时整队转引导谎报「已投递」而实际只是重新入队
 *
 * 通过覆盖实例上的 send / commitFollowUpQueue 注入失败与在途时序，
 * 不调用真实模型 API。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { startSdkSessionHost } = await jiti.import("./sdk-session-host.ts");
const { updatePidancePref } = await jiti.import("./pidance-prefs-file.ts");

async function waitFor(predicate, message, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 起一个空会话 host（无模型请求），返回 host + 清理函数。 */
async function withHost(run) {
  const cwd = mkdtempSync(join(tmpdir(), "sdk-queue-consume-cwd-"));
  const agentDir = mkdtempSync(join(tmpdir(), "sdk-queue-consume-agent-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let host;
  try {
    host = await startSdkSessionHost({
      sessionId: "__new__queue-consume",
      sessionFile: "",
      cwd,
      agentDir,
      toolNames: [],
      idleTimeoutMs: 60_000,
    });
    const persistedQueue = () => {
      let raw;
      try {
        raw = readFileSync(join(agentDir, "pidance-preferences.json"), "utf8");
      } catch {
        return [];
      }
      const prefs = JSON.parse(raw);
      return prefs.sessionQueue?.[host.sessionId]?.items ?? [];
    };
    /** 阻止自动投递：让队列断言不被 flush 时序干扰。 */
    const hold = () => updatePidancePref(`sessionQueueHold.${host.sessionId}`, true, agentDir);
    return await run({ host, hold, persistedQueue, agentDir });
  } finally {
    try { await host?.destroyAsync?.(); } catch { /* ignore */ }
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
}

test("#42 整队转引导：prompt 回执为 rejected 时不得删除队列条目", async () => {
  await withHost(async ({ host, hold, persistedQueue }) => {
    hold();
    await host.send({ type: "set_follow_up_queue", items: ["必须留在队列里"] });
    const originalSend = host.send.bind(host);
    // 结构化拒绝（不抛异常）：旧实现把「没抛异常」当成已投递并删掉条目。
    host.send = async (command, ticket) => {
      if (command.type === "prompt" && command.streamingBehavior === "steer") {
        return {
          submissionId: command.submissionId ?? "dispatch-probe",
          sessionId: host.sessionId,
          status: "rejected",
          reason: "busy",
        };
      }
      return originalSend(command, ticket);
    };

    const receipt = await host.send({
      type: "dispatch_follow_up_queue",
      expectedRevision: null,
      submissionId: "dispatch-rejected",
    });
    assert.equal(receipt.ok, false, "拒绝的派发不能回 ok");
    assert.equal(receipt.status, "rejected");
    assert.equal(receipt.reason, "busy");
    assert.deepEqual(
      receipt.items.map((item) => [item.text, item.state]),
      [["必须留在队列里", "waiting"]],
      "未被受理的载荷必须还回队列等待重试",
    );
    assert.deepEqual(persistedQueue().map((item) => item.state), ["waiting"], "磁盘上也不能留在 claimed");
  });
});

test("#42 整队转引导：自动投递在途时拒绝重入（同一批内容不得投递两次）", async () => {
  await withHost(async ({ host }) => {
    let releaseInternal;
    const gate = new Promise((resolve) => { releaseInternal = resolve; });
    const originalSend = host.send.bind(host);
    let internalCalls = 0;
    host.send = async (command, ticket) => {
      if (command.type === "prompt" && ticket) {
        internalCalls += 1;
        await gate;
        return {
          submissionId: command.submissionId ?? `flush-${internalCalls}`,
          sessionId: host.sessionId,
          status: "accepted",
        };
      }
      return originalSend(command, ticket);
    };

    await host.send({ type: "set_follow_up_queue", items: ["自动投递中"] });
    // 自动 flush 已认领并卡在投递里：此刻手动派发必须冲突，而不是并发送出。
    await waitFor(() => internalCalls === 1, "自动投递未开始");
    const receipt = await host.send({
      type: "dispatch_follow_up_queue",
      expectedRevision: null,
      submissionId: "dispatch-in-flight",
    });
    assert.equal(receipt.conflict, true, "在途必须冲突");
    assert.equal(receipt.reason, "in-flight");
    releaseInternal();
    await waitFor(() => internalCalls === 1 && !host.isRunning(), "投递未收尾");
    assert.equal(internalCalls, 1, `同一批内容被投递 ${internalCalls} 次`);
  });
});

test("#42 投递在途：外部 prompt 必须结构化回绝 busy，不得并发起 run", async () => {
  await withHost(async ({ host }) => {
    let releaseInternal;
    let flushing = false;
    const gate = new Promise((resolve) => { releaseInternal = resolve; });
    const originalSend = host.send.bind(host);
    host.send = async (command, ticket) => {
      if (command.type === "prompt" && ticket) {
        flushing = true;
        await gate;
        return {
          submissionId: command.submissionId ?? "flush",
          sessionId: host.sessionId,
          status: "accepted",
        };
      }
      return originalSend(command, ticket);
    };

    await host.send({ type: "set_follow_up_queue", items: ["flush 载荷"] });
    await waitFor(() => flushing, "flush 未进入投递在途");

    const external = await host.send({
      type: "prompt",
      message: "外部并发 prompt",
      submissionId: "external-during-flush",
    });
    assert.equal(external.status, "rejected", "flush 在途的外部 prompt 必须被回绝");
    assert.equal(external.reason, "busy");
    releaseInternal();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});

test("#42 预检前后清队：被清掉的条目不得被旧批次投递", async () => {
  await withHost(async ({ host, persistedQueue }) => {
    const delivered = [];
    const originalSend = host.send.bind(host);
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    host.send = async (command, ticket) => {
      if (command.type === "prompt" && ticket) {
        delivered.push(command.message);
        if (delivered.length === 1) await firstGate;
        return {
          submissionId: command.submissionId ?? `flush-${delivered.length}`,
          sessionId: host.sessionId,
          status: "accepted",
        };
      }
      return originalSend(command, ticket);
    };

    await host.send({ type: "set_follow_up_queue", items: ["A 在途", "B 待发"] });
    await waitFor(() => delivered.length === 1, "第一个单元未开始投递");
    assert.equal(delivered[0], "A 在途");
    // A 在途期间用户清队：只影响未投递内容，在途载荷不能被当成「取消成功」
    const cleared = await host.send({ type: "set_follow_up_queue", items: [] });
    assert.equal(cleared.ok, true);
    assert.deepEqual(cleared.items, [], "未投递条目已被清掉");
    assert.deepEqual(cleared.inFlight, ["A 在途"], "在途载荷必须仍然可见（不能被当成取消成功）");
    assert.deepEqual(
      persistedQueue().map((item) => [item.text, item.state]),
      [["A 在途", "claimed"]],
      "在途载荷必须仍在磁盘队列上，清队不得把它删掉",
    );
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(delivered, ["A 在途"], `被清掉的条目仍被投递：${JSON.stringify(delivered)}`);
  });
});

test("#42 认领落盘失败：fail-closed，不自动重试同一失败", async () => {
  await withHost(async ({ host }) => {
    const errors = [];
    host.onEvent((event) => {
      if (event.type === "follow_up_flush_error") errors.push(event.errorMessage);
    });
    const originalSend = host.send.bind(host);
    let internalCalls = 0;
    host.send = async (command, ticket) => {
      if (command.type === "prompt" && ticket) {
        internalCalls += 1;
        return { submissionId: command.submissionId ?? "flush", sessionId: host.sessionId, status: "accepted" };
      }
      return originalSend(command, ticket);
    };
    const originalCommit = host.commitFollowUpQueue.bind(host);
    let claimFailures = 0;
    host.commitFollowUpQueue = (items, reason) => {
      if (reason === "claim") {
        claimFailures += 1;
        return false;
      }
      return originalCommit(items, reason);
    };

    await host.send({ type: "set_follow_up_queue", items: ["磁盘写不进去"] });
    await waitFor(() => claimFailures >= 1, "认领未尝试");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(internalCalls, 0, "认领失败后仍投递了内容（发出去但没记录）");
    assert.equal(claimFailures, 1, `认领失败被自动重试 ${claimFailures} 次（应 fail-closed）`);
    assert.ok(
      errors.some((message) => String(message).includes("before delivery")),
      `缺少可见的失败事件：${JSON.stringify(errors)}`,
    );
  });
});

test("#42 已投递但删除落盘失败：条目保持 claimed（不重投也不当 waiting）", async () => {
  await withHost(async ({ host, persistedQueue }) => {
    const originalSend = host.send.bind(host);
    host.send = async (command, ticket) => {
      if (command.type === "prompt" && ticket) {
        return { submissionId: command.submissionId ?? "flush", sessionId: host.sessionId, status: "accepted" };
      }
      return originalSend(command, ticket);
    };
    const originalCommit = host.commitFollowUpQueue.bind(host);
    host.commitFollowUpQueue = (items, reason) => {
      if (reason === "deliver") return false;
      return originalCommit(items, reason);
    };

    await host.send({ type: "set_follow_up_queue", items: ["已送达但没记上"] });
    await waitFor(() => persistedQueue().length === 1 && persistedQueue()[0].state === "claimed", "条目未停在 claimed");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      persistedQueue()[0].state,
      "claimed",
      "已送达的内容被标回 waiting 会在下次 flush 重投",
    );
  });
});

test("#42 手动压缩中整队转引导：不得谎报已投递（载荷留在队列）", async () => {
  await withHost(async ({ host, hold, persistedQueue }) => {
    hold();
    await host.send({ type: "set_follow_up_queue", items: ["等压缩结束再发"] });
    // compact-only：没有可消费的 active run（session.isStreaming 为 false），
    // 旧实现会走 prompt → 服务端因压缩中重新入队 → 又按 id 删掉原条目。
    const originalSend = host.send.bind(host);
    host.send = async (command, ticket) => {
      if (command.type === "prompt" && ticket) {
        // 模拟契约：真实 hosting 在压缩中会先把载荷重新可靠入队（enqueueTexts），
        // 再回 status=queued。回 queued 而没入队是违约，不是被测行为。
        await originalSend({ type: "set_follow_up_queue", items: [command.message] }, ticket);
        return {
          submissionId: command.submissionId ?? "compacting",
          sessionId: host.sessionId,
          status: "queued",
          action: "queued",
          reason: "compacting",
          queue: { items: [], revision: 0, inFlight: [] },
        };
      }
      return originalSend(command, ticket);
    };
    const receipt = await host.send({
      type: "dispatch_follow_up_queue",
      expectedRevision: null,
      submissionId: "dispatch-compacting",
    });
    assert.equal(receipt.ok, true);
    assert.equal(receipt.action, "queued", "实际只重新入队，不能报成 prompt/steer 已投递");
    assert.deepEqual(
      persistedQueue().map((item) => item.text),
      ["等压缩结束再发"],
      "载荷必须恰好保留一份（重新入队的副本取代被认领的那份，不能既算已派发又留在队列，也不能两头都没有）",
    );
  });
});

test("#42 投递前会话不可运行（shell 占用）：拒绝且不投递，载荷留在队列", async () => {
  await withHost(async ({ host, persistedQueue }) => {
    const originalSend = host.send.bind(host);
    let promptCalls = 0;
    host.send = async (command, ticket) => {
      if (command.type === "prompt") {
        promptCalls += 1;
        return { submissionId: command.submissionId ?? "flush", sessionId: host.sessionId, status: "accepted" };
      }
      return originalSend(command, ticket);
    };
    host.bashRunning = true;
    await host.send({ type: "set_follow_up_queue", items: ["等 shell 结束再发"] });
    const receipt = await host.send({
      type: "dispatch_follow_up_queue",
      expectedRevision: null,
      submissionId: "dispatch-bash",
    });
    assert.equal(receipt.ok, false, "不可运行时不得回 ok（客户端会当成已发送）");
    assert.equal(receipt.reason, "bash");
    assert.deepEqual(
      receipt.items.map((item) => [item.text, item.state]),
      [["等 shell 结束再发", "waiting"]],
      "载荷必须留在队列等待重试",
    );
    assert.equal(promptCalls, 0, "不可运行时不得发起投递");
    assert.deepEqual(
      persistedQueue().map((item) => [item.text, item.state]),
      [["等 shell 结束再发", "waiting"]],
      "落盘状态不得变成 claimed（那会让 UI 永久显示在途）",
    );
  });
});

// ---------------------------------------------------------------------------
// 图片入队（issue #42 / A11）
// ---------------------------------------------------------------------------

/** 1x1 PNG。只用于验证字节往返，不参与渲染断言。 */
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";

const dataImage = (data = PNG_1X1) => ({
  source: "data",
  data,
  mimeType: "image/png",
});

test("#42 带图入队：字节落到会话 outbox，投递时原样带回", async () => {
  await withHost(async ({ host, hold, agentDir, persistedQueue }) => {
    hold();
    const receipt = await host.send({
      type: "set_follow_up_queue",
      items: [{ text: "看图", images: [dataImage()] }],
    });
    assert.equal(receipt.ok, true);
    const ref = receipt.items[0].images?.[0];
    assert.ok(ref?.path, "回执必须带上图片引用（否则客户端无从取回）");
    assert.ok(
      ref.path.startsWith(`${agentDir}/pidance-attachments/queue-outbox/${host.sessionId}/`),
      "图片必须落在本会话的 outbox 里",
    );
    assert.equal(readFileSync(ref.path).toString("base64"), PNG_1X1, "文件内容必须是原字节");
    assert.deepEqual(
      persistedQueue()[0].images?.map((image) => image.path),
      [ref.path],
      "队列落盘必须带上图片引用（否则重启后图片彻底丢失）",
    );

    // 投递：由 Host 从 outbox 回读字节交给 SDK（客户端不再持有这份图）。
    const originalSend = host.send.bind(host);
    let delivered;
    host.send = async (command, ticket) => {
      if (command.type === "prompt") {
        delivered = command;
        return { submissionId: command.submissionId ?? "flush", sessionId: host.sessionId, status: "accepted" };
      }
      return originalSend(command, ticket);
    };
    await host.send({ type: "update_prefs" }).catch(() => undefined);
    const dispatched = await host.send({
      type: "dispatch_follow_up_queue",
      expectedRevision: null,
      submissionId: "dispatch-images",
    });
    assert.equal(dispatched.ok, true);
    assert.deepEqual(delivered?.images, [{ type: "image", data: PNG_1X1, mimeType: "image/png" }]);
  });
});

test("#42 图片 outbox：文件缺失只降级为纯文本，不阻塞投递", async () => {
  await withHost(async ({ host, hold }) => {
    hold();
    const receipt = await host.send({
      type: "set_follow_up_queue",
      items: [{ text: "图片丢了也要发", images: [dataImage()] }],
    });
    rmSync(receipt.items[0].images[0].path);
    const originalSend = host.send.bind(host);
    let delivered;
    host.send = async (command, ticket) => {
      if (command.type === "prompt") {
        delivered = command;
        return { submissionId: command.submissionId ?? "flush", sessionId: host.sessionId, status: "accepted" };
      }
      return originalSend(command, ticket);
    };
    const dispatched = await host.send({
      type: "dispatch_follow_up_queue",
      expectedRevision: null,
      submissionId: "dispatch-missing-image",
    });
    assert.equal(dispatched.ok, true);
    assert.equal(delivered?.images, undefined, "缺文件时按纯文本投递");
    assert.match(delivered?.message ?? "", /图片丢了也要发/);
  });
});

test("#42 清队即回收 outbox 图片（不与队列一起泄漏）", async () => {
  await withHost(async ({ host, hold }) => {
    hold();
    const receipt = await host.send({
      type: "set_follow_up_queue",
      items: [{ text: "会被清掉", images: [dataImage()] }],
    });
    const path = receipt.items[0].images[0].path;
    assert.ok(readFileSync(path), "写入后文件存在");
    await host.send({ type: "set_follow_up_queue", items: [] });
    assert.equal(existsSync(path), false, "条目离开队列后图片必须删除");
  });
});

test("#42 只接受本会话 outbox 内的图片引用（拒绝任意路径读取）", async () => {
  await withHost(async ({ host, hold, persistedQueue }) => {
    hold();
    await host.send({ type: "set_follow_up_queue", items: ["先占位"] });
    const receipt = await host.send({
      type: "set_follow_up_queue",
      items: [{
        text: "偷文件",
        images: [{ source: "ref", id: "leak", path: "/etc/passwd", mimeType: "image/png" }],
      }],
    });
    assert.equal(receipt.ok, false, "越界引用必须拒绝");
    assert.equal(receipt.persist, true, "拒绝时不得改动磁盘队列");
    assert.deepEqual(persistedQueue().map((item) => item.text), ["先占位"]);
  });
});

test("#42 单条消息的图片数量有上限（拒绝而不是静默截断）", async () => {
  await withHost(async ({ host, hold, persistedQueue }) => {
    hold();
    const receipt = await host.send({
      type: "set_follow_up_queue",
      items: [{ text: "太多图", images: Array.from({ length: 17 }, () => dataImage()) }],
    });
    assert.equal(receipt.ok, false);
    assert.equal(receipt.persist, true);
    assert.deepEqual(persistedQueue(), [], "拒绝的写入不得留下半个队列");
  });
});
