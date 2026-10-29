import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatSession } from "../src/adapters/cloudflare/session.js";
import { loadConfig } from "../src/core/config.js";
import { buildDeps } from "../src/core/deps.js";
import { handleRequest } from "../src/core/handler.js";
import { scopeKey } from "../src/core/store.js";
import {
  createFetchMock,
  defaultResponse,
  groupUpdate,
  memoryStorage,
  NOW,
  postUpdate,
  testEnv,
  type RecordedCall,
} from "./helpers.js";

interface Reply { token: string; wake_id: string; chat_id: string; }

function app(env: Record<string, string>, handler?: (call: RecordedCall) => Response | undefined) {
  const mock = createFetchMock(async (call) => handler?.(call) ?? defaultResponse(call, mock.calls.length));
  const tasks: Promise<unknown>[] = [];
  const deps = buildDeps({
    env,
    fetchImpl: mock.fetchImpl,
    now: () => NOW,
    sleep: async () => undefined,
    waitUntil: (promise) => tasks.push(promise),
    typingMode: "once",
    log: () => undefined,
  });
  const calls = mock.calls;
  const telegram = (method: string) => calls.filter((call) => call.url.endsWith(`/${method}`));
  const wakes = () => calls.filter((call) => call.url.startsWith("https://grok.example/hook"))
    .map((call) => call.body as { addressed_how: string; reply: Reply });
  const send = (reply: Reply, body: Record<string, unknown>, path = "/send") => handleRequest(new Request(`https://bridge.example${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${reply.token}`, "content-type": "application/json" },
    body: JSON.stringify({ chat_id: reply.chat_id, ...body }),
  }), deps);
  return { deps, tasks, calls, telegram, wakes, send };
}

const ALL = testEnv({ GROUP_WAKE_MODE: "all", ALLOWED_BOT_IDS: "777" });

function fromBot(update: ReturnType<typeof groupUpdate>) {
  update.message!.from = { id: 777, is_bot: true, first_name: "Carl", username: "carlsbot" };
  return update;
}

describe("GROUP_WAKE_MODE=all", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is off by default: ordinary group chatter does not wake the bot", async () => {
    const bridge = app(testEnv());
    await postUpdate(bridge.deps, bridge.tasks, groupUpdate({ text: "what's for dinner?" }));
    expect(bridge.wakes()).toHaveLength(0);
  });

  it("wakes on every person's group message, quietly, and the assistant can answer or pass", async () => {
    const bridge = app(ALL);
    await postUpdate(bridge.deps, bridge.tasks, groupUpdate({ text: "what's for dinner?", updateId: 1 }));
    await postUpdate(bridge.deps, bridge.tasks, groupUpdate({ text: "never mind", updateId: 2 }));
    const [first, second] = bridge.wakes();
    expect(first?.addressed_how).toBe("ambient");
    expect(bridge.telegram("setMessageReaction")).toHaveLength(0);
    expect(bridge.telegram("sendChatAction")).toHaveLength(0);

    const answered = await bridge.send(first!.reply, { text: "Tacos!", final: true });
    expect(answered.status).toBe(200);
    expect(bridge.telegram("sendMessage")).toHaveLength(1);
    expect((await bridge.send(first!.reply, { text: "again", final: true })).status).toBe(200);
    expect(bridge.telegram("sendMessage")).toHaveLength(1);

    const passed = await bridge.send(second!.reply, {}, "/typing/stop");
    expect(passed.status).toBe(200);
    expect(bridge.telegram("setMessageReaction")).toHaveLength(0);
  });

  it("still shows 👀 and typing when the bot is addressed", async () => {
    const bridge = app(ALL);
    await postUpdate(bridge.deps, bridge.tasks, groupUpdate({ text: "@testbot hi" }));
    expect(bridge.wakes()[0]?.addressed_how).toBe("mention");
    expect(bridge.telegram("setMessageReaction")).toHaveLength(1);
  });

  it("never wakes on a bot's unaddressed message or a bot's reply, so bots cannot loop", async () => {
    const bridge = app(ALL);
    await postUpdate(bridge.deps, bridge.tasks, fromBot(groupUpdate({ text: "I think tacos", updateId: 1 })));
    await postUpdate(bridge.deps, bridge.tasks, fromBot(groupUpdate({
      text: "agreed",
      updateId: 2,
      replyTo: { message_id: 3, text: "x", chat: { id: -500, type: "supergroup" }, from: { id: 999, is_bot: true, username: "testbot" } },
    })));
    expect(bridge.wakes()).toHaveLength(0);
  });

  it("does not post a failure notice when an ambient wake is refused", async () => {
    const bridge = app(ALL, (call) => call.url.startsWith("https://grok.example/hook") ? new Response("no", { status: 403 }) : undefined);
    await postUpdate(bridge.deps, bridge.tasks, groupUpdate({ text: "hello all" }));
    expect(bridge.telegram("sendMessage")).toHaveLength(0);
  });

  it("only applies to groups the allowlist admits", async () => {
    const bridge = app(ALL);
    await postUpdate(bridge.deps, bridge.tasks, groupUpdate({ text: "hello", chatId: -900, userId: 100 }));
    expect(bridge.wakes()).toHaveLength(0);
  });

  it("finishing a quiet wake on the Durable Object is a harmless no-op", async () => {
    vi.stubGlobal("fetch", (async () => Response.json({ ok: true, result: true })) as typeof fetch);
    const session = new ChatSession({ storage: memoryStorage() }, testEnv());
    const response = await session.fetch(new Request("https://session.internal/op", {
      method: "POST",
      body: JSON.stringify({ op: "typing.stop", scopeKey: scopeKey("-500", null), wakeId: "never-started", now: NOW }),
    }));
    expect(response.status).toBe(200);
  });

  it("reads the setting and reports a bad value", () => {
    expect(loadConfig({ GROUP_WAKE_MODE: "ALL" }).groupWakeMode).toBe("all");
    expect(loadConfig({}).groupWakeMode).toBe("addressed");
    const bad = loadConfig({ GROUP_WAKE_MODE: "everything" });
    expect(bad.groupWakeMode).toBe("addressed");
    expect(bad.problems).toContain("GROUP_WAKE_MODE");
  });
});
