import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  config,
  context,
  loadContext,
  Generator,
  Budget,
  artPrompt,
} from "../core.mjs";
import { createApp } from "../server.mjs";
function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ns-ai-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { ...config({}), ledger: join(dir, "budget.json"), ...overrides };
}
const request = {
  kind: "text",
  style: "humor",
  artStyle: "watercolor",
  question: "Narrate this",
  engine: "external",
  model: "test-model",
  consent: true,
};
const response = (text) =>
  new Response(JSON.stringify({ choices: [{ message: { content: text } }] }));
test("synthetic mode never fetches health data", async () => {
  const c = config({});
  const ctx = await loadContext(c, "demo", Date.now(), () => {
    throw Error("network forbidden");
  });
  assert.ok(ctx.readings >= 36);
  assert.equal(ctx.mode, "demo");
  assert.equal(ctx.events, 2);
});
test("filters window, invalid glucose, duplicates, identifiers and notes; sorts events", () => {
  const now = Date.parse("2026-10-17T12:00:00Z");
  const ctx = context(
    [
      { date: now, sgv: 150, device: "secret" },
      { date: now, sgv: 151 },
      { date: now - 120000, sgv: 120 },
      { date: now + 1, sgv: 140 },
      { date: now - 10800001, sgv: 150 },
      { date: now - 5, sgv: 0 },
    ],
    [
      {
        created_at: new Date(now - 60000).toISOString(),
        eventType: "Note",
        notes: "secret",
        enteredBy: "Chad",
        insulin: 2,
      },
    ],
    now,
    "real",
  );
  assert.equal(ctx.readings, 2);
  assert.equal(ctx.timeline[1].event, "Note");
  assert.equal(ctx.timeline[2].glucose, 151);
  assert.ok(!JSON.stringify(ctx).includes("secret"));
  assert.ok(!JSON.stringify(ctx).includes("Chad"));
});
test("real mode requires server opt-in; source query/auth and bounds are correct", async () => {
  const now = Date.now();
  await assert.rejects(loadContext(config({}), "real", now), /not enabled/);
  const urls = [];
  const c = {
    ...config({}),
    real: true,
    ns: "https://example.test",
    nsToken: "private-token",
  };
  const ctx = await loadContext(c, "real", now, async (u, o) => {
    urls.push(u);
    assert.equal(o.headers["api-secret"], "private-token");
    assert.equal(o.redirect, "error");
    return new Response(
      JSON.stringify(
        u.pathname.includes("entries") ? [{ date: now, sgv: 111 }] : [],
      ),
    );
  });
  assert.equal(ctx.readings, 1);
  assert.equal(
    urls[0].searchParams.get("find[date][$gte]"),
    String(now - 10800000),
  );
  assert.equal(
    urls[1].searchParams.get("find[created_at][$lte]"),
    new Date(now).toISOString(),
  );
  assert.ok(!String(urls[0]).includes("private-token"));
});
test("fails closed on upstream partial failure or truncated window", async () => {
  const c = {
    ...config({}),
    real: true,
    ns: "https://example.test",
    nsToken: "x",
  };
  await assert.rejects(
    loadContext(
      c,
      "real",
      Date.now(),
      async () => new Response("no", { status: 403 }),
    ),
  );
  await assert.rejects(
    loadContext(
      c,
      "real",
      Date.now(),
      async () => new Response(JSON.stringify(Array(1000).fill({}))),
    ),
    /record limit/,
  );
});
test("consent and model validation happen before outbound requests or budget charges", async (t) => {
  const c = fixture(t, {
    base: "https://ai.test",
    key: "secret",
    models: ["test-model"],
  });
  let calls = 0;
  const g = new Generator(c, async () => {
    calls++;
    return response("Hello");
  });
  const ctx = await loadContext(c, "demo");
  await assert.rejects(g.run(ctx, { ...request, consent: false }), /consent/);
  await assert.rejects(
    g.run(ctx, { ...request, model: "expensive" }),
    /not configured/,
  );
  assert.equal(calls, 0);
});
test("text request includes context, question and constraints; cache prevents duplicate billing", async (t) => {
  const c = fixture(t, {
    base: "https://ai.test",
    key: "secret",
    models: ["test-model"],
  });
  let calls = 0;
  const g = new Generator(c, async (u, o) => {
    calls++;
    const b = JSON.parse(o.body);
    assert.equal(b.max_tokens, 500);
    assert.match(b.messages[0].content, /Never recommend insulin/);
    const user = JSON.parse(b.messages[1].content);
    assert.equal(user.question, request.question);
    assert.equal(user.context.mode, "demo");
    assert.equal(o.headers.authorization, "Bearer secret");
    return response("A tiny mountain.");
  });
  const ctx = await loadContext(c, "demo");
  assert.equal((await g.run(ctx, request)).text, "A tiny mountain.");
  assert.equal((await g.run(ctx, request)).cached, true);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(readFileSync(c.ledger)).requests, 1);
});
test("budget persists across instances, rejects over-limit, and rolls over UTC day", (t) => {
  const c = fixture(t, { daily: 0.2, textCost: 0.1 });
  const at = Date.parse("2026-10-17T12:00:00Z");
  new Budget(c).reserve("text", at);
  new Budget(c).reserve("text", at);
  assert.throws(() => new Budget(c).reserve("text", at), /limit/);
  assert.equal(new Budget(c).reserve("text", at + 86400000).requests, 1);
  assert.throws(() => new Budget(c).reserve("text", at), /backwards/);
});
test("corrupt ledger and invalid numeric config fail closed", (t) => {
  const c = fixture(t);
  writeFileSync(c.ledger, "{}");
  assert.throws(() => new Budget(c).reserve("text"), /Invalid budget/);
  for (const value of ["NaN", "-1", "Infinity"])
    assert.throws(() => config({ DAILY_BUDGET_USD: value }));
  assert.throws(() => config({ TEXT_REQUEST_RESERVE_USD: "0" }));
  assert.throws(() => config({ AI_BASE_URL: "http://remote.example" }));
});
test("failed calls retain reservation and are not cached or retried", async (t) => {
  const c = fixture(t, {
    base: "https://ai.test",
    key: "secret",
    models: ["test-model"],
    maxRequests: 1,
  });
  let calls = 0;
  const g = new Generator(c, async () => {
    calls++;
    return new Response("secret upstream detail", { status: 500 });
  });
  const ctx = await loadContext(c, "demo");
  await assert.rejects(g.run(ctx, request), /Upstream/);
  await assert.rejects(g.run(ctx, request), /limit/);
  assert.equal(calls, 1);
});
test("concurrent duplicate requests cannot double-charge", async (t) => {
  const c = fixture(t, {
    base: "https://ai.test",
    key: "secret",
    models: ["test-model"],
  });
  let finish;
  const gate = new Promise((r) => (finish = r));
  const g = new Generator(c, async () => {
    await gate;
    return response("Done");
  });
  const ctx = await loadContext(c, "demo");
  const first = g.run(ctx, request);
  await assert.rejects(g.run(ctx, request), /in progress/);
  finish();
  await first;
  assert.equal(JSON.parse(readFileSync(c.ledger)).requests, 1);
});
test("art sends numeric contour only; caches and explicitly regenerates; no external image URLs", async (t) => {
  const c = fixture(t, {
    imageBase: "https://images.test",
    imageKey: "image-secret",
    imageModel: "image-model",
  });
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  let calls = 0;
  const g = new Generator(c, async (u, o) => {
    calls++;
    const p = JSON.parse(o.body);
    assert.equal(p.model, "image-model");
    assert.ok(!p.prompt.includes("insulin"));
    assert.ok(!p.prompt.includes("2026"));
    assert.equal(p.output_format, "png");
    assert.equal(p.response_format, undefined);
    return new Response(JSON.stringify({ data: [{ b64_json: png }] }));
  });
  const ctx = await loadContext(c, "demo");
  const b = { ...request, kind: "art" };
  assert.match((await g.run(ctx, b)).image, /^data:image\/png/);
  assert.equal((await g.run(ctx, b)).cached, true);
  await g.run(ctx, { ...b, regenerate: true });
  assert.equal(calls, 2);
  const bad = new Generator(
    c,
    async () =>
      new Response(
        JSON.stringify({ data: [{ url: "https://tracker.test/image" }] }),
      ),
  );
  await assert.rejects(bad.run(ctx, b), /base64/);
});
test("offline previews require no key or consent and do not write budget", async (t) => {
  const c = fixture(t);
  const g = new Generator(c, () => {
    throw Error("network forbidden");
  });
  const ctx = await loadContext(c, "demo");
  assert.equal(
    (await g.run(ctx, { ...request, engine: "offline", consent: false }))
      .offline,
    true,
  );
  assert.ok(
    (await g.run(ctx, { ...request, engine: "offline", kind: "art" })).points
      .length,
  );
  await assert.rejects(
    g.run({ ...ctx, mode: "real" }, { ...request, engine: "offline" }),
    /synthetic/,
  );
});
test("HTTP end to end: auth, request protections, snapshots, real opt-in and no secret exposure", async (t) => {
  const c = fixture(t, { token: "long-random-dashboard-token-123" });
  const app = createApp(c);
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => app.close(r)));
  const base = `http://127.0.0.1:${app.address().port}`;
  const post = (path, b, headers = {}) =>
    fetch(base + "/api/" + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-dashboard-request": "1",
        authorization: "Bearer " + c.token,
        ...headers,
      },
      body: JSON.stringify(b),
    });
  assert.equal((await post("config", {}, { authorization: "" })).status, 401);
  assert.equal(
    (await post("config", {}, { "x-dashboard-request": "" })).status,
    403,
  );
  const conf = await (await post("config", {})).json();
  assert.ok(!JSON.stringify(conf).includes(c.token));
  assert.equal((await post("context", { mode: "real" })).status, 400);
  const snap = await (await post("context", { mode: "demo" })).json();
  assert.ok(snap.id);
  const out = await (
    await post("generate", { ...request, id: snap.id, engine: "offline" })
  ).json();
  assert.equal(out.offline, true);
  assert.equal(
    (await post("generate", { ...request, id: "fake" })).status,
    400,
  );
  const page = await fetch(base);
  assert.match(await page.text(), /After Hours/);
  assert.match(
    page.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  assert.equal((await fetch(base + "/.env")).status, 404);
});
test("server refuses sensitive operation without strong dashboard token", (t) => {
  const c = fixture(t);
  assert.throws(() => createApp({ ...c, real: true }), /DASHBOARD_TOKEN/);
  assert.throws(() => createApp({ ...c, key: "secret" }), /DASHBOARD_TOKEN/);
  assert.throws(() => createApp({ ...c, host: "0.0.0.0" }), /DASHBOARD_TOKEN/);
});
