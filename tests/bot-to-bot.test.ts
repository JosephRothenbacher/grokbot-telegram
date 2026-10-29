import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { createTestApp, dmUpdate, groupUpdate, postUpdate, testEnv } from "./helpers.js";

const OTHER_BOT = 777;

function botGroupUpdate(text: string, updateId: number, extra: Parameters<typeof groupUpdate>[0] = { text }) {
  const update = groupUpdate({ ...extra, text, updateId, userId: OTHER_BOT });
  update.message!.from = { id: OTHER_BOT, is_bot: true, first_name: "Carl", username: "carlsbot" };
  return update;
}

function forwards(app: ReturnType<typeof createTestApp>) {
  return app.calls.filter((call) => call.url.startsWith("https://grok.example/hook"));
}

describe("bot-to-bot", () => {
  it("keeps ignoring every bot when ALLOWED_BOT_IDS is empty", async () => {
    const app = createTestApp();
    await postUpdate(app.deps, app.tasks, botGroupUpdate("/ask@testbot hi", 1));
    expect(forwards(app)).toHaveLength(0);
  });

  it("wakes on a command or mention from an allowed bot in an allowlisted group", async () => {
    const app = createTestApp({ env: testEnv({ ALLOWED_BOT_IDS: String(OTHER_BOT) }) });
    await postUpdate(app.deps, app.tasks, botGroupUpdate("/ask@testbot what do you think?", 1));
    await postUpdate(app.deps, app.tasks, botGroupUpdate("@testbot your turn", 2));
    const sent = forwards(app);
    expect(sent.map((call) => (call.body as { addressed_how: string }).addressed_how)).toEqual(["command", "mention"]);
    expect((sent[0]!.body as { from: { is_bot: boolean } }).from.is_bot).toBe(true);
  });

  it("does not wake on a bot's reply, but keeps it as context", async () => {
    const app = createTestApp({ env: testEnv({ ALLOWED_BOT_IDS: String(OTHER_BOT) }) });
    await postUpdate(app.deps, app.tasks, botGroupUpdate("here is my answer", 1, {
      text: "",
      replyTo: { message_id: 3, text: "earlier", chat: { id: -500, type: "supergroup" }, from: { id: 999, is_bot: true, username: "testbot" } },
    }));
    expect(forwards(app)).toHaveLength(0);
    await postUpdate(app.deps, app.tasks, groupUpdate({ text: "@testbot summarize", updateId: 2 }));
    const payload = forwards(app)[0]!.body as { short_term: { text: string }[] };
    expect(payload.short_term.map((item) => item.text)).toContain("here is my answer");
  });

  it("ignores unlisted bots, bots in groups that are not allowlisted, and bot DMs", async () => {
    const app = createTestApp({ env: testEnv({ ALLOWED_BOT_IDS: "555" }) });
    await postUpdate(app.deps, app.tasks, botGroupUpdate("/ask@testbot hi", 1));
    const allowed = createTestApp({ env: testEnv({ ALLOWED_BOT_IDS: String(OTHER_BOT) }) });
    await postUpdate(allowed.deps, allowed.tasks, botGroupUpdate("/ask@testbot hi", 2, { text: "", chatId: -900 }));
    const dm = dmUpdate("/ask hi", 3);
    dm.message!.from = { id: OTHER_BOT, is_bot: true, first_name: "Carl" };
    await postUpdate(allowed.deps, allowed.tasks, dm);
    expect(forwards(app)).toHaveLength(0);
    expect(forwards(allowed)).toHaveLength(0);
  });

  it("caps wakes from bots per chat, while people still get through", async () => {
    const app = createTestApp({ env: testEnv({ ALLOWED_BOT_IDS: String(OTHER_BOT), BOT_WAKE_MAX: "2" }) });
    for (let i = 1; i <= 4; i++) await postUpdate(app.deps, app.tasks, botGroupUpdate(`/ask@testbot round ${i}`, i));
    expect(forwards(app)).toHaveLength(2);
    await postUpdate(app.deps, app.tasks, groupUpdate({ text: "@testbot still there?", updateId: 9 }));
    expect(forwards(app)).toHaveLength(3);
  });

  it("parses the settings and reports bad ids", () => {
    const config = loadConfig({ ALLOWED_BOT_IDS: "1, 2, nope" });
    expect([...config.allowedBotIds]).toEqual(["1", "2"]);
    expect(config.problems).toContain("ALLOWED_BOT_IDS");
    expect(config.botWakeMax).toBe(3);
    expect(config.botWakeWindowMs).toBe(600_000);
  });
});
