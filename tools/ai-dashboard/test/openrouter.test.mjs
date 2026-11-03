import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config, loadContext, Generator, artPrompt } from "../core.mjs";
import { createApp } from "../server.mjs";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const pngURL = `data:image/png;base64,${png}`;
const part = (url = pngURL) => ({ type: "image_url", image_url: { url } });
const chat = (message = { images: [part()] }) => ({ choices: [{ message }] });
const reply = (body) => new Response(JSON.stringify(body));
const request = {
  kind: "art",
  style: "humor",
  artStyle: "watercolor",
  question: "PRIVATE QUESTION",
  engine: "external",
  consent: true,
  model: "browser-cannot-select-art-model",
};
function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ns-ai-chat-image-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    ...config({
      IMAGE_PROVIDER: "openrouter",
      IMAGE_BASE_URL: "https://openrouter.test/api/v1",
      IMAGE_API_KEY: "server-image-secret",
      IMAGE_MODEL: "mock/image-model",
    }),
    ledger: join(dir, "budget.json"),
    ...overrides,
  };
}
const ledger = (c) => JSON.parse(readFileSync(c.ledger, "utf8"));

test("image adapter config preserves defaults and validates provider, modalities and token cap", () => {
  assert.equal(config({}).imageProvider, "openai");
  assert.deepEqual(config({}).imageModalities, ["image", "text"]);
  assert.deepEqual(config({ IMAGE_MODALITIES: "image" }).imageModalities, [
    "image",
  ]);
  for (const value of ["typo", "chat", "OPENROUTER"])
    assert.throws(() => config({ IMAGE_PROVIDER: value }), /IMAGE_PROVIDER/);
  for (const value of ["text", "image,audio", "image,image", "image,"])
    assert.throws(
      () => config({ IMAGE_MODALITIES: value }),
      /IMAGE_MODALITIES/,
    );
  for (const value of ["0", "1.5", "32769", "NaN"])
    assert.throws(
      () => config({ IMAGE_MAX_TOKENS: value }),
      /IMAGE_MAX_TOKENS/,
    );
});

test("OpenRouter sends only previewed art prompt; cache, style and regeneration retain reservations", async (t) => {
  const c = fixture(t);
  const ctx = await loadContext(c, "demo", Date.parse("2026-10-25T12:00:00Z"));
  ctx.timeline.push({
    at: ctx.to,
    event: "PRIVATE TREATMENT",
    insulin: 41,
    carbs: 999,
  });
  let calls = 0;
  const g = new Generator(c, async (url, options) => {
    calls++;
    assert.equal(url, c.imageBase + "/chat/completions");
    assert.equal(options.headers.authorization, "Bearer server-image-secret");
    assert.equal(options.redirect, "error");
    const p = JSON.parse(options.body);
    assert.deepEqual(Object.keys(p).sort(), [
      "max_tokens",
      "messages",
      "modalities",
      "model",
      "stream",
    ]);
    assert.equal(p.model, c.imageModel);
    assert.deepEqual(p.modalities, ["image", "text"]);
    assert.equal(p.max_tokens, 8192);
    assert.equal(p.stream, false);
    assert.equal(p.messages.length, 1);
    assert.equal(p.messages[0].role, "user");
    assert.ok(
      !/PRIVATE|insulin|carbs|2026|server-image-secret/.test(options.body),
    );
    return reply(
      chat({
        content: "IGNORE THIS PROVIDER TEXT",
        images: [part(), part("https://tracker.test/ignored")],
      }),
    );
  });
  const first = await g.run(ctx, request);
  assert.equal(first.image, pngURL);
  assert.equal(first.caption, "AI-generated decorative fiction");
  assert.equal(first.text, undefined);
  assert.equal(first.cached, false);
  assert.equal((await g.run(ctx, request)).cached, true);
  await assert.rejects(g.run(ctx, { ...request, consent: false }), /consent/);
  await g.run(ctx, { ...request, regenerate: true });
  await g.run(ctx, { ...request, artStyle: "cosmic" });
  assert.equal(calls, 3);
  assert.deepEqual(ledger(c), {
    day: new Date().toISOString().slice(0, 10),
    requests: 3,
    spent: 0.75,
  });
});

test("chat image content parts and image-only models are supported", async (t) => {
  const c = fixture(t, { imageModalities: ["image"], imageMaxTokens: 1024 });
  const g = new Generator(c, async (url, options) => {
    const p = JSON.parse(options.body);
    assert.deepEqual(p.modalities, ["image"]);
    assert.equal(p.max_tokens, 1024);
    return reply(
      chat({ content: [{ type: "text", text: "not rendered" }, part()] }),
    );
  });
  assert.equal(
    (await g.run(await loadContext(c, "demo"), request)).image,
    pngURL,
  );
});

// Tiny raster files made from synthetic pixels; no patient data or external fixtures.
const jpeg =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDlaKKK9Y8M/9k=";
const webp =
  "UklGRjYAAABXRUJQVlA4ICoAAACQAQCdASoBAAEAAUAmJaACdLoAA5gA/vDEC/V2J8KEE/+LQ60OtDOkAAA=";
for (const [mime, image] of [
  ["image/jpeg", jpeg],
  ["image/webp", webp],
]) {
  test(`chat accepts inline ${mime} with matching signature`, async (t) => {
    const c = fixture(t);
    const url = `data:${mime};base64,${image}`;
    const g = new Generator(c, async () =>
      reply(chat({ images: [part(url)] })),
    );
    assert.equal(
      (await g.run(await loadContext(c, "demo"), request)).image,
      url,
    );
  });
}

const invalid = [
  ["null response", null],
  ["empty choices", { choices: [] }],
  ["null message", chat(null)],
  [
    "unsupported text-only model",
    chat({ content: "I cannot generate images" }),
  ],
  ["refusal", chat({ refusal: "blocked" })],
  ["empty images", chat({ images: [] })],
  ["malformed images object", chat({ images: { 0: part() } })],
  ["null image", chat({ images: [null] })],
  ["missing image_url", chat({ images: [{}] })],
  ["non-string URL", chat({ images: [part(123)] })],
  ["external URL", chat({ images: [part("https://tracker.test/image.png")] })],
  ["loopback URL", chat({ images: [part("http://127.0.0.1/private")] })],
  [
    "SVG data URL",
    chat({ images: [part("data:image/svg+xml;base64,PHN2Zy8+")] }),
  ],
  [
    "MIME/signature mismatch",
    chat({ images: [part(`data:image/jpeg;base64,${png}`)] }),
  ],
  ["invalid base64", chat({ images: [part("data:image/png;base64,!!!!")] })],
  [
    "invalid base64 length",
    chat({ images: [part("data:image/png;base64,A")] }),
  ],
  [
    "bad image signature",
    chat({ images: [part("data:image/png;base64,aGVsbG8=")] }),
  ],
  ["empty data URL", chat({ images: [part("data:image/png;base64,")] })],
  [
    "error with otherwise valid image",
    { ...chat(), error: { message: "SECRET PROVIDER DETAIL" } },
  ],
  [
    "choice error",
    {
      choices: [
        { message: { images: [part()] }, error: { message: "SECRET" } },
      ],
    },
  ],
  [
    "failed finish reason",
    { choices: [{ message: { images: [part()] }, finish_reason: "error" }] },
  ],
];
for (const [label, body] of invalid) {
  test(`chat rejects ${label} without fetching URLs, caching or refunding attempt`, async (t) => {
    const c = fixture(t, { maxRequests: 1 });
    let calls = 0;
    const g = new Generator(c, async () => {
      calls++;
      return reply(body);
    });
    const ctx = await loadContext(c, "demo");
    await assert.rejects(
      g.run(ctx, request),
      /^(Error: )?(Provider must|Invalid provider|Image provider)/,
    );
    await assert.rejects(g.run(ctx, request), /limit/);
    assert.equal(g.cache.size, 0);
    assert.equal(calls, 1);
    assert.equal(ledger(c).spent, c.imageCost);
    assert.equal(g.pending.size, 0);
  });
}

for (const status of [400, 401, 404, 429, 500]) {
  test(`chat provider HTTP ${status} errors are not retried or exposed`, async (t) => {
    const c = fixture(t, { maxRequests: 1 });
    let calls = 0;
    const g = new Generator(c, async () => {
      calls++;
      return new Response("SECRET upstream body", { status });
    });
    const ctx = await loadContext(c, "demo");
    await assert.rejects(
      g.run(ctx, request),
      /^Error: Upstream request failed$/,
    );
    await assert.rejects(g.run(ctx, request), /limit/);
    assert.equal(calls, 1);
    assert.equal(ledger(c).requests, 1);
  });
}

test("chat consent, missing model and budget block before dispatch; restart retains image spend", async (t) => {
  const c = fixture(t, { daily: 0.25 });
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return reply(chat());
  };
  const ctx = await loadContext(c, "demo");
  const g = new Generator(c, fetcher);
  await assert.rejects(g.run(ctx, { ...request, consent: false }), /consent/);
  await assert.rejects(
    new Generator({ ...c, imageModel: "" }, fetcher).run(ctx, request),
    /not configured/,
  );
  assert.equal(calls, 0);
  assert.equal(existsSync(c.ledger), false);
  await g.run(ctx, request);
  await assert.rejects(g.run(ctx, { ...request, regenerate: true }), /limit/);
  await assert.rejects(new Generator(c, fetcher).run(ctx, request), /limit/);
  assert.equal((await g.run(ctx, request)).cached, true);
  assert.equal(calls, 1);
});

test("chat duplicate in-flight image request cannot double reserve", async (t) => {
  const c = fixture(t);
  let finish;
  const gate = new Promise((r) => {
    finish = r;
  });
  const g = new Generator(c, async () => {
    await gate;
    return reply(chat());
  });
  const ctx = await loadContext(c, "demo");
  const first = g.run(ctx, request);
  await assert.rejects(g.run(ctx, request), /in progress/);
  finish();
  await first;
  assert.equal(ledger(c).requests, 1);
});

test("legacy images/generations adapter retains its endpoint and payload", async (t) => {
  const c = fixture(t, { imageProvider: "openai", legacyImageFormat: true });
  const ctx = await loadContext(c, "demo");
  const g = new Generator(c, async (url, options) => {
    assert.equal(url, c.imageBase + "/images/generations");
    assert.deepEqual(JSON.parse(options.body), {
      model: c.imageModel,
      prompt: artPrompt(ctx, request.artStyle),
      n: 1,
      size: "1024x1024",
      response_format: "b64_json",
    });
    return reply({ data: [{ b64_json: png }] });
  });
  assert.equal((await g.run(ctx, request)).image, pngURL);
});

test("HTTP chat art uses stored synthetic preview, ignores injected context/settings, hides secrets", async (t) => {
  const c = fixture(t, {
    token: "synthetic-dashboard-token-for-test",
    maxRequests: 2,
  });
  let calls = 0,
    sentPrompt;
  const app = createApp(c, async (url, options) => {
    calls++;
    assert.equal(url, c.imageBase + "/chat/completions");
    sentPrompt = JSON.parse(options.body).messages[0].content;
    return calls === 1
      ? reply(chat())
      : reply({ error: { message: "SECRET upstream detail" } });
  });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => app.close(r)));
  const base = `http://127.0.0.1:${app.address().port}`;
  const post = (path, body) =>
    fetch(base + "/api/" + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-dashboard-request": "1",
        authorization: `Bearer ${c.token}`,
      },
      body: JSON.stringify(body),
    });
  const settings = await (await post("config", {})).json();
  assert.equal(settings.imageAdapter, "openrouter");
  assert.ok(!JSON.stringify(settings).includes(c.imageKey));
  const snap = await (await post("context", { mode: "demo" })).json();
  const preview = await (
    await post("art-preview", { id: snap.id, artStyle: request.artStyle })
  ).json();
  const b = {
    ...request,
    id: snap.id,
    context: { timeline: [{ glucose: "PRIVATE" }] },
    imageProvider: "openai",
    imageBase: "https://attacker.test",
  };
  assert.equal((await post("generate", { ...b, consent: false })).status, 400);
  assert.equal(calls, 0);
  assert.equal((await post("generate", { ...b, id: "expired" })).status, 400);
  const out = await (await post("generate", b)).json();
  assert.equal(sentPrompt, preview.prompt);
  assert.equal(out.image, pngURL);
  assert.ok(!JSON.stringify(out).includes(c.imageKey));
  assert.equal((await (await post("generate", b)).json()).cached, true);
  const error = await post("generate", { ...b, regenerate: true });
  assert.equal(error.status, 400);
  assert.ok(!(await error.text()).includes("SECRET"));
  assert.equal(
    (await post("generate", { ...b, regenerate: true })).status,
    400,
  );
  assert.equal(calls, 2);
  assert.match(
    (await fetch(base)).headers.get("content-security-policy"),
    /img-src 'self' data:/,
  );
});

for (const [label, fetcher] of [
  ["malformed JSON", async () => new Response('{"choices":')],
  [
    "oversized JSON",
    async () => new Response(" ".repeat(12 * 1024 * 1024 + 1)),
  ],
  [
    "network timeout",
    async () => {
      throw new DOMException("timed out", "TimeoutError");
    },
  ],
]) {
  test(`chat ${label} retains reservation and permits no automatic retry`, async (t) => {
    const c = fixture(t, { maxRequests: 1 });
    let calls = 0;
    const g = new Generator(c, async (...args) => {
      calls++;
      return fetcher(...args);
    });
    const ctx = await loadContext(c, "demo");
    await assert.rejects(g.run(ctx, request));
    await assert.rejects(g.run(ctx, request), /limit/);
    assert.equal(calls, 1);
    assert.equal(ledger(c).spent, c.imageCost);
    assert.equal(g.cache.size, 0);
    assert.equal(g.pending.size, 0);
  });
}

test("chat cache identity includes endpoint and output configuration", async (t) => {
  const c = fixture(t);
  let calls = 0;
  const g = new Generator(c, async () => {
    calls++;
    return reply(chat());
  });
  const ctx = await loadContext(c, "demo");
  await g.run(ctx, request);
  c.imageBase = "https://second-provider.test/api/v1";
  assert.equal((await g.run(ctx, request)).cached, false);
  c.imageModalities = ["image"];
  assert.equal((await g.run(ctx, request)).cached, false);
  assert.equal(calls, 3);
});
