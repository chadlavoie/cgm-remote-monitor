const $ = (id) => document.getElementById(id);
let snapshot, settings;
async function api(path, body) {
  const r = await fetch("/api/" + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-dashboard-request": "1",
      authorization: "Bearer " + $("token").value,
    },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error);
  return data;
}
function node(tag, attrs = {}, text) {
  const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text) n.textContent = text;
  return n;
}
function draw(ctx) {
  const svg = $("graph");
  svg.replaceChildren();
  const rows = ctx.timeline.filter((x) => "glucose" in x);
  if (!rows.length) {
    $("stats").textContent =
      "No valid readings in this window. Load another window before asking.";
    return;
  }
  const min = Math.min(70, ...rows.map((x) => x.glucose)) - 10,
    max = Math.max(180, ...rows.map((x) => x.glucose)) + 10;
  const x = (t) =>
      50 + ((Date.parse(t) - Date.parse(ctx.from)) / 10800000) * 825,
    y = (v) => 180 - ((v - min) / (max - min)) * 160;
  for (const v of [70, 120, 180]) {
    if (v > max) continue;
    svg.append(
      node("line", { x1: 50, y1: y(v), x2: 875, y2: y(v), stroke: "#41515a" }),
      node("text", { x: 10, y: y(v) + 4 }, String(v)),
    );
  }
  let segment = [];
  const flush = () => {
    svg.append(
      node("polyline", {
        points: segment.join(" "),
        fill: "none",
        stroke: "#c3dfad",
        "stroke-width": 3,
      }),
    );
    segment = [];
  };
  rows.forEach((r, i) => {
    if (i && Date.parse(r.at) - Date.parse(rows[i - 1].at) > 600000) flush();
    segment.push(`${x(r.at)},${y(r.glucose)}`);
    svg.append(
      node("circle", { cx: x(r.at), cy: y(r.glucose), r: 2, fill: "#c3dfad" }),
    );
  });
  flush();
  for (const [at, anchor] of [
    [ctx.from, "start"],
    [ctx.to, "end"],
  ])
    svg.append(
      node(
        "text",
        { x: x(at), y: 210, "text-anchor": anchor },
        new Date(at).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      ),
    );
  $("stats").textContent =
    `${ctx.readings} readings · ${ctx.events} recorded events · latest reading ${ctx.latestAgeMinutes} min before window end. ${ctx.latestAgeMinutes > 15 ? "STALE DATA — narration is historical." : ""}`;
}
async function artPreview() {
  if (snapshot)
    $("artPrompt").textContent = (
      await api("art-preview", {
        id: snapshot.id,
        artStyle: $("artStyle").value,
      })
    ).prompt;
}
async function load() {
  snapshot = null;
  $("consent").checked = false;
  $("answer").textContent = "The narrator is waiting in the wings.";
  $("art").replaceChildren();
  settings = await api("config", {});
  if ($("mode").value === "real" && !settings.realEnabled)
    throw new Error("Real data is disabled. Configure it on the server first.");
  snapshot = await api("context", { mode: $("mode").value });
  $("context").textContent = JSON.stringify(snapshot.context, null, 2);
  $("badge").textContent =
    snapshot.context.mode === "demo"
      ? "SYNTHETIC DEMO"
      : "PERSONAL HEALTH DATA";
  draw(snapshot.context);
  $("model").replaceChildren(
    ...settings.models.map((m) => {
      const o = document.createElement("option");
      o.value = m;
      o.textContent = m;
      return o;
    }),
  );
  $("provider").textContent =
    `Text: ${settings.textProvider || "not configured"}. Images: ${settings.imageProvider || "not configured"} (${settings.imageModel || "no model"}). Reservations: $${settings.textCost}/text, $${settings.imageCost}/image; $${settings.daily}/day limit.`;
  await artPreview();
  $("status").textContent =
    "Window loaded. Review the context before enabling external AI.";
}
async function generate(kind, regenerate = false) {
  if (!snapshot) throw new Error("Load a window first");
  const result = await api("generate", {
    id: snapshot.id,
    kind,
    question: $("question").value,
    style: $("style").value,
    artStyle: $("artStyle").value,
    engine: $("engine").value,
    model: $("model").value,
    consent: $("consent").checked,
    regenerate,
  });
  if (kind === "text") $("answer").textContent = result.text;
  else {
    const holder = $("art");
    holder.replaceChildren();
    if (result.image) {
      const img = document.createElement("img");
      img.src = result.image;
      img.alt =
        "AI-generated decorative landscape inspired by the glucose sequence";
      holder.append(img);
    } else {
      const svg = node("svg", { viewBox: "0 0 600 600" });
      const palette = {
        watercolor: ["#a8c9bf", "#e0cba6", "#4f7a76"],
        cosmic: ["#171d45", "#9a6ab8", "#59488c"],
        woodcut: ["#e8d6af", "#343c36", "#7d8964"],
      }[result.style];
      svg.append(
        node("rect", { width: 600, height: 600, fill: palette[0] }),
        node("circle", { cx: 440, cy: 160, r: 70, fill: palette[1] }),
      );
      for (let layer = 0; layer < 3; layer++) {
        const points = result.points
          .map(
            (v, i) =>
              `${(i / (result.points.length - 1)) * 600},${480 - v + layer * 60}`,
          )
          .join(" ");
        svg.append(
          node("polygon", {
            points: `0,600 ${points} 600,600`,
            fill: palette[(layer + 1) % 3],
          }),
        );
      }
      holder.append(svg);
    }
    $("caption").textContent = result.caption;
  }
  $("status").textContent = result.offline
    ? "Offline synthetic demonstration — no external call."
    : result.cached
      ? "Cached response — no new provider call."
      : `Generated. Reserved today: $${result.budget.spent.toFixed(2)} across ${result.budget.requests} requests.`;
}
async function action(fn) {
  for (const b of document.querySelectorAll("button, input, select, textarea"))
    b.disabled = true;
  try {
    await fn();
  } catch (e) {
    $("status").textContent = e.message;
  } finally {
    for (const b of document.querySelectorAll(
      "button, input, select, textarea",
    ))
      b.disabled = false;
  }
}
$("load").onclick = () => action(load);
$("ask").onclick = () => action(() => generate("text"));
$("artButton").onclick = () => action(() => generate("art"));
$("regenerate").onclick = () => action(() => generate("art", true));
$("artStyle").onchange = () => {
  $("consent").checked = false;
  action(artPreview);
};
for (const id of ["mode", "token"])
  $(id).addEventListener("change", () => {
    snapshot = null;
    $("consent").checked = false;
    $("context").textContent = "Load the selected window.";
    $("graph").replaceChildren();
    $("stats").textContent = "";
    $("answer").textContent = "";
    $("art").replaceChildren();
    $("artPrompt").textContent = "";
    $("status").textContent = "Selection changed; load a window to continue.";
  });
for (const id of ["engine", "model", "question", "style"])
  $(id).addEventListener("change", () => {
    $("consent").checked = false;
  });
