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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
// 附件引用（issue #42 / A11 → 附件引用模型）
// ---------------------------------------------------------------------------

/** 1x1 PNG。只用于验证字节往返，不参与渲染断言。 */
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";
const PNG_BYTES = Buffer.from(PNG_1X1, "base64");

/** 附件目录（Host 校验引用时使用的授权根）。 */
function attachDir(agentDir) {
  const dir = join(agentDir, "pidance-attachments");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 把一张图放进附件目录，返回路径（模拟「附件进输入框即上传」）。 */
function putImage(agentDir, name = "pic.png") {
  const path = join(attachDir(agentDir), name);
  writeFileSync(path, PNG_BYTES);
  return path;
}

/** 模型副本引用：SDK prompt 里的内联图片由 Host 从这个文件回读。 */
const modelRef = (path, name = "pic.png") => ({
  role: "model",
  path,
  name,
  mimeType: "image/png",
  size: PNG_BYTES.length,
});

/** 原图引用：决定历史消息里的二进制卡片（与模型副本是两个独立文件）。 */
const originalRef = (path, name = "pic.png", previewPath) => ({
  role: "original",
  path,
  name,
  mimeType: "image/png",
  size: PNG_BYTES.length,
  ...(previewPath ? { previewPath } : {}),
});

/** 捕获 flush/派发实际发给 SDK 的 prompt。 */
function capturePrompts(host) {
  const originalSend = host.send.bind(host);
  const prompts = [];
  host.send = async (command, ticket) => {
    if (command.type === "prompt") {
      prompts.push(command);
      return { submissionId: command.submissionId ?? "flush", sessionId: host.sessionId, status: "accepted" };
    }
    return originalSend(command, ticket);
  };
  return prompts;
}

test("#42 附件引用入队：prefs 只存引用，投递时回读内联图片与原图卡片", async () => {
  await withHost(async ({ host, hold, agentDir, persistedQueue }) => {
    hold();
    const model = putImage(agentDir, "pic.model.png");
    const original = putImage(agentDir, "pic.png");
    const receipt = await host.send({
      type: "set_follow_up_queue",
      items: [{ text: "看图", media: [modelRef(model, "pic.model.png"), originalRef(original)] }],
    });
    assert.equal(receipt.ok, true);
    assert.deepEqual(
      persistedQueue()[0].media.map((ref) => [ref.role, ref.path]),
      [["model", model], ["original", original]],
      "队列落盘必须只带引用（字节留在附件目录里）",
    );
    assert.equal(
      readFileSync(join(agentDir, "pidance-preferences.json"), "utf8").includes(PNG_1X1),
      false,
      "prefs 里不得出现内联字节（否则队列文件随图片一起膨胀）",
    );

    const prompts = capturePrompts(host);
    const dispatched = await host.send({
      type: "dispatch_follow_up_queue",
      expectedRevision: null,
      submissionId: "dispatch-refs",
    });
    assert.equal(dispatched.ok, true);
    assert.deepEqual(prompts[0]?.images, [{ type: "image", data: PNG_1X1, mimeType: "image/png" }]);
    assert.deepEqual(
      prompts[0]?.binaryBlocks?.map((block) => block.name),
      ["pic.png"],
      "原图卡片必须随投递一起带上（历史里才能下载原图）",
    );
    assert.equal(existsSync(model), false, "已投递后模型副本不再被任何人引用，应回收");
    assert.equal(existsSync(original), true, "原图不得回收：历史的下载卡片仍指向它");
  });
});

test("#42 引用文件缺失：fail-closed（不投递、不丢文本、条目留在队列）", async () => {
  await withHost(async ({ host, hold, agentDir, persistedQueue }) => {
    hold();
    const model = putImage(agentDir, "pic.model.png");
    await host.send({
      type: "set_follow_up_queue",
      items: [{ text: "图片丢了也要发", media: [modelRef(model, "pic.model.png")] }],
    });
    rmSync(model);
    const prompts = capturePrompts(host);
    // 手动派发：认领之前就要发现图不在，否则只会留下一个永远发不出去的 claimed 条目。
    const dispatched = await host.send({
      type: "dispatch_follow_up_queue",
      expectedRevision: null,
      submissionId: "dispatch-missing-ref",
    });
    assert.equal(dispatched.ok, false, "图读不出来不得当作已派发");
    assert.equal(dispatched.reason, "media");
    assert.deepEqual(prompts, [], "缺图时不得调用 SDK（不得把正文单独发出去）");
    assert.deepEqual(
      persistedQueue().map((item) => [item.text, item.state]),
      [["图片丢了也要发", "waiting"]],
      "载荷必须留在队列（正文与引用都在）",
    );
  });
});

test("#42 自动投递：缺图时停在队列，不静默发纯文本", async () => {
  await withHost(async ({ host, hold, agentDir, persistedQueue }) => {
    hold();
    const model = putImage(agentDir, "auto.model.png");
    const receipt = await host.send({
      type: "set_follow_up_queue",
      items: [{ text: "自动投递的图", media: [modelRef(model, "auto.model.png")] }],
    });
    rmSync(model);
    const prompts = capturePrompts(host);
    await host.deliverFollowUpUnit({ ids: [receipt.items[0].id] });
    assert.deepEqual(prompts, [], "缺图时不得调用 SDK");
    assert.deepEqual(
      persistedQueue().map((item) => [item.text, item.state]),
      [["自动投递的图", "waiting"]],
      "载荷仍在队列（正文与引用都没丢）",
    );
  });
});

test("#42 派发时不得把 unknown 条目（及其媒体引用）一并删掉", async () => {
  await withHost(async ({ host, hold, agentDir }) => {
    hold();
    const unknownModel = putImage(agentDir, "unknown.model.png");
    const receipt = await host.send({
      type: "set_follow_up_queue",
      items: [
        { text: "结果未知的消息", media: [modelRef(unknownModel, "unknown.model.png")] },
        { text: "这批要派发" },
      ],
    });
    const unknownId = receipt.items[0].id;
    // 模拟「上次投递后进程被杀」：磁盘上是 claimed，hydrate 后只能变成 unknown。
    const prefsFile = join(agentDir, "pidance-preferences.json");
    const prefs = JSON.parse(readFileSync(prefsFile, "utf8"));
    prefs.sessionQueue[host.sessionId].items[0].state = "claimed";
    writeFileSync(prefsFile, JSON.stringify(prefs));
    host.followUpQueueHydrated = false;
    host.hydrateFollowUpQueue();
    const state = await host.send({ type: "get_state" });
    assert.deepEqual(
      state.queuedMessages.followUpItems.map((item) => [item.text, item.state]),
      [["结果未知的消息", "unknown"], ["这批要派发", "waiting"]],
      "重启后 claimed 必须变成 unknown（既不自动重投也不静默删除）",
    );

    const prompts = capturePrompts(host);
    const dispatched = await host.send({
      type: "dispatch_follow_up_queue",
      expectedRevision: null,
      submissionId: "dispatch-keep-unknown",
    });
    assert.equal(dispatched.ok, true);
    assert.equal(prompts[0]?.message, "这批要派发", "只投递 waiting 的那批");
    const kept = dispatched.items.find((item) => item.id === unknownId);
    assert.deepEqual(
      [kept?.text, kept?.state],
      ["结果未知的消息", "unknown"],
      "unknown 条目必须原样保留（它是用户唯一能取回那条消息的地方）",
    );
    assert.equal(existsSync(unknownModel), true, "unknown 条目的媒体文件不得被回收");
  });
});

test("#42 纯图条目：可入队、可恢复、可投递", async () => {
  await withHost(async ({ host, hold, agentDir }) => {
    hold();
    const model = putImage(agentDir, "only.model.png");
    const receipt = await host.send({
      type: "set_follow_up_queue",
      items: [{ text: "", media: [modelRef(model, "only.model.png")] }],
    });
    assert.equal(receipt.ok, true, "纯图消息（无正文）必须能入队");
    assert.deepEqual(receipt.items.map((item) => [item.text, item.state]), [["", "waiting"]]);
    assert.equal(receipt.items[0].media.length, 1);
    // 刷新/重启路径：从 prefs 重新解码，纯图条目不得被丢掉（丢掉就等于丢掉图）。
    host.hydrateFollowUpQueue();
    const state = await host.send({ type: "get_state" });
    assert.deepEqual(
      state.queuedMessages.followUpItems.map((item) => [item.text, item.media.length]),
      [["", 1]],
      "纯图条目必须能重新解码（空正文 + 引用）",
    );

    const prompts = capturePrompts(host);
    await host.send({
      type: "dispatch_follow_up_queue",
      expectedRevision: null,
      submissionId: "dispatch-image-only",
    });
    assert.deepEqual(prompts[0]?.images, [{ type: "image", data: PNG_1X1, mimeType: "image/png" }]);
    assert.equal(prompts[0]?.message, "", "纯图消息就是空正文 + 图片");
  });
});

test("#42 单条消息的引用数量有上限（拒绝而不是静默截断）", async () => {
  await withHost(async ({ host, hold, agentDir, persistedQueue }) => {
    hold();
    const model = putImage(agentDir, "many.model.png");
    // 超限在命令解码阶段就被驳回（畸形命令不该被当成一次「队列写入」）。
    await assert.rejects(
      host.send({
        type: "set_follow_up_queue",
        items: [{ text: "太多图", media: Array.from({ length: 33 }, () => modelRef(model, "many.model.png")) }],
      }),
      /too many refs/,
    );
    assert.deepEqual(persistedQueue(), [], "拒绝的写入不得留下半个队列");
  });
});

test("#42 只接受附件目录内的引用（拒绝任意路径读取）", async () => {
  await withHost(async ({ host, hold, persistedQueue }) => {
    hold();
    await host.send({ type: "set_follow_up_queue", items: ["先占位"] });
    const receipt = await host.send({
      type: "set_follow_up_queue",
      items: [{ text: "偷文件", media: [modelRef("/etc/passwd", "passwd")] }],
    });
    assert.equal(receipt.ok, false, "越界引用必须拒绝");
    assert.equal(receipt.persist, true, "拒绝时不得改动磁盘队列");
    assert.deepEqual(persistedQueue().map((item) => item.text), ["先占位"]);
  });
});

test("#42 清队不删引用文件：回收归 GC，草稿/历史引用同一文件时不能删", async () => {
  await withHost(async ({ host, hold, agentDir }) => {
    hold();
    const model = putImage(agentDir, "draft.model.png");
    await host.send({
      type: "set_follow_up_queue",
      items: [{ text: "会被清掉", media: [modelRef(model, "draft.model.png")] }],
    });
    await host.send({ type: "set_follow_up_queue", items: [] });
    assert.equal(
      existsSync(model),
      true,
      "清队不等于删除附件：同一份文件可能还被输入框草稿或历史消息引用（仅由 GC 在无人引用后回收）",
    );
  });
});
