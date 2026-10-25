// Form Runner — local web UI for auto-filling Google Forms.
//
//   node form-ui.mjs            → http://localhost:8787
//   node form-ui.mjs --no-open  → don't auto-open the browser
//
// Paste a Google Forms link, it parses the questions, you pick the number of
// responses, how many parallel workers submit them, and a speed profile.
// Only use this on forms you own or have permission to test.

import { createServer } from "node:http";
import { exec } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const SPEEDS = {
  slow: [4000, 9000], // human-ish pacing
  normal: [1500, 4000],
  fast: [400, 1200],
  max: [0, 150],
};

const TEXT_POOL = [
  "More frequent hands-on phishing simulations with realistic AI-generated examples.",
  "Short monthly micro-trainings instead of one long annual session.",
  "Give immediate feedback when someone clicks a simulated phishing link.",
  "Tailor training examples to the tools each team actually uses day to day.",
  "Make it easy to report suspicious messages and recognize people who do.",
  "Leadership should set time aside for security training, not just mandate it.",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- form parsing ----------

function formEndpoints(rawUrl) {
  let m = rawUrl.match(/docs\.google\.com\/forms\/d\/e\/([\w-]+)/);
  if (m) {
    const id = m[1];
    return {
      view: `https://docs.google.com/forms/d/e/${id}/viewform`,
      post: `https://docs.google.com/forms/d/e/${id}/formResponse`,
    };
  }
  m = rawUrl.match(/docs\.google\.com\/forms\/d\/([\w-]+)/);
  if (m) {
    const id = m[1];
    return {
      view: `https://docs.google.com/forms/d/${id}/viewform`,
      post: `https://docs.google.com/forms/d/${id}/formResponse`,
    };
  }
  // non-Google URL: use it directly (e.g. a local mock for dry-run testing)
  if (/^https?:\/\//.test(rawUrl) && rawUrl.includes("viewform")) {
    return { view: rawUrl, post: rawUrl.replace(/viewform.*$/, "formResponse") };
  }
  return null;
}

const isItemLike = (x) =>
  Array.isArray(x) &&
  x.length > 3 &&
  Number.isInteger(x[0]) &&
  (typeof x[1] === "string" || x[1] === null) &&
  Number.isInteger(x[3]) &&
  x[3] >= 0 &&
  x[3] <= 20;

function findItemsArray(node) {
  let best = [];
  const visit = (n) => {
    if (Array.isArray(n)) {
      const items = n.filter(isItemLike);
      if (n.length > 0 && items.length / n.length > 0.5 && n.length > best.length) best = n;
      for (const child of n) visit(child);
    } else if (n && typeof n === "object") {
      for (const child of Object.values(n)) visit(child);
    }
  };
  visit(node);
  return best;
}

function processItem(item, idx) {
  // entry blocks are nested: item[4] = [[entryId, choices, required, …]] — an item
  // can carry several blocks (grids); questions here use the first numeric one.
  const blocks = Array.isArray(item[4]) ? item[4] : [];
  const entry = blocks.find((b) => Array.isArray(b) && Number.isInteger(b[0]));
  if (!entry) return null;
  const rawType = item[3];
  const title = typeof item[1] === "string" ? item[1] : `Question ${idx}`;
  const required = !!entry[2];
  const q = { idx, entryId: String(entry[0]), kind: null, title, required, choices: [], hasOther: false, scale: null };

  if (rawType === 0 || rawType === 1) q.kind = "text";
  else if (rawType === 2) q.kind = "radio";
  else if (rawType === 3) q.kind = "dropdown";
  else if (rawType === 4) q.kind = "checkbox";
  else if (rawType === 9 || rawType === 11) q.kind = "date";
  else if (rawType === 5) {
    q.kind = "scale";
    const low = Number.isInteger(entry[4]) ? entry[4] : 1;
    const high = Number.isInteger(entry[5]) ? entry[5] : 5;
    q.scale = { low, high };
    q.choices = Array.from({ length: high - low + 1 }, (_, i) => String(low + i));
  } else return null; // grid / time / file upload / image: skipped

  if (q.kind === "radio" || q.kind === "dropdown" || q.kind === "checkbox") {
    const cs = Array.isArray(entry[1]) ? entry[1] : [];
    for (const c of cs) {
      if (Array.isArray(c)) {
        if (c[0] === "") q.hasOther = true; // "Other…" option, filled as free text — skipped
        else q.choices.push(String(c[0]));
      } else if (typeof c === "string") q.choices.push(c);
    }
    if (q.choices.length === 0) return null;
  }
  return q;
}

async function fetchText(url, init) {
  const res = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow", ...init });
  return { status: res.status, text: await res.text() };
}

async function parseForm(rawUrl) {
  const eps = formEndpoints(rawUrl);
  if (!eps) throw new Error("That doesn't look like a Google Forms link.");
  const { status, text } = await fetchText(eps.view);
  if (status !== 200) throw new Error(`Google returned HTTP ${status} for this form.`);
  if (text.includes("no longer accepting")) {
    throw new Error("This form is closed — it is no longer accepting responses.");
  }
  const m = text.match(/FB_PUBLIC_LOAD_DATA_\s*=\s*(.*?);\s*<\/script>/s);
  if (!m) throw new Error("Form data not found — the form may require sign-in or isn't public.");
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch {
    throw new Error("Couldn't parse the form's embedded data.");
  }
  const title = typeof data[3] === "string" && data[3] ? data[3] : "Untitled form";
  const description = typeof data[1]?.[0] === "string" ? data[1][0] : "";
  const items = findItemsArray(data);
  const questions = [];
  let skipped = 0;
  items.forEach((item, i) => {
    const q = processItem(item, questions.length + 1);
    if (q) questions.push(q);
    else if (Array.isArray(item?.[4])) skipped++; // had an entry but unsupported kind (grid, time, file…)
  });
  if (questions.length === 0) throw new Error("No fillable questions found in this form.");
  return { ...eps, title, description, questions, skipped };
}

// ---------- answering + submitting ----------

function resolveValues(q, spec, rng) {
  const mode = spec?.mode === "fixed" ? "fixed" : "random";
  switch (q.kind) {
    case "radio":
    case "dropdown": {
      if (mode === "fixed") {
        if (!q.choices.includes(spec.value)) throw new Error(`Q${q.idx}: "${spec.value}" is not a valid choice`);
        return [spec.value];
      }
      return [q.choices[Math.floor(rng() * q.choices.length)]];
    }
    case "checkbox": {
      if (mode === "fixed" && Array.isArray(spec.value) && spec.value.length) {
        for (const v of spec.value) if (!q.choices.includes(v)) throw new Error(`Q${q.idx}: "${v}" is not a valid choice`);
        return spec.value;
      }
      const picked = q.choices.filter(() => rng() < 0.5);
      return picked.length ? picked : [q.choices[0]];
    }
    case "scale": {
      const { low, high } = q.scale;
      const v =
        mode === "fixed" && Number.isInteger(Number(spec.value)) && +spec.value >= low && +spec.value <= high
          ? +spec.value
          : low + Math.floor(rng() * (high - low + 1));
      return [String(v)];
    }
    case "text": {
      if (mode === "fixed" && String(spec.value ?? "").trim()) return [String(spec.value).trim()];
      if (q.required || rng() < 0.8) return [TEXT_POOL[Math.floor(rng() * TEXT_POOL.length)]];
      return [];
    }
    case "date": {
      if (mode === "fixed" && /^\d{4}-\d{2}-\d{2}$/.test(String(spec.value ?? ""))) return [spec.value];
      const d = new Date(Date.now() - Math.floor(rng() * 365) * 864e5);
      return [d.toISOString().slice(0, 10)];
    }
    default:
      return [];
  }
}

async function submitOnce(form, answers) {
  const { status, text } = await fetchText(form.view);
  const fb = text.match(/fbzx[^-\d]{0,30}(-?\d{10,})/);
  if (!fb) return { ok: false, why: "no session token (form may be closed or private)" };
  const body = new URLSearchParams({ fvv: "1", pageHistory: "0", fbzx: fb[1], submit: "Submit" });
  for (const q of form.questions) {
    const spec = answers?.[q.idx];
    for (const v of resolveValues(q, spec, Math.random)) body.append(`entry.${q.entryId}`, v);
  }
  const res = await fetchText(form.post, {
    method: "POST",
    headers: { "user-agent": UA, "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (res.status !== 200) return { ok: false, why: `http ${res.status}` };
  if (res.text.includes("Something went wrong")) return { ok: false, why: "rejected by Google" };
  if (res.text.includes("no longer accepting")) return { ok: false, why: "form is closed" };
  // success = confirmation screen: embedded form data exists but with an EMPTY
  // items array; a validation failure re-serves the form with its questions.
  const m = res.text.match(/FB_PUBLIC_LOAD_DATA_\s*=\s*(.*?);\s*<\/script>/s);
  if (m) {
    try {
      const d = JSON.parse(m[1]);
      if (Array.isArray(d[1]) && d[1].length > 0) return { ok: false, why: "validation failed" };
    } catch {
      return { ok: false, why: "unparseable response" };
    }
  }
  return { ok: true, why: "" };
}

// ---------- run engine ----------

let state = { running: false };

function pushLog(line) {
  state.logs.push(`${new Date().toLocaleTimeString()}  ${line}`);
  if (state.logs.length > 400) state.logs.splice(0, state.logs.length - 400);
}

async function startRun(cfg) {
  const count = Math.max(1, Math.min(1000, Number(cfg.count) || 1));
  const nWorkers = Math.max(1, Math.min(16, Number(cfg.workers) || 1));
  const speed = SPEEDS[cfg.speed] ? cfg.speed : "normal";
  const form = await parseForm(cfg.url);
  // fail fast on invalid fixed answers before firing anything
  for (const q of form.questions) resolveValues(q, cfg.answers?.[q.idx], Math.random);

  state = {
    running: true,
    stop: false,
    total: count,
    done: 0,
    failed: 0,
    speed,
    formTitle: form.title,
    logs: [],
    workers: Array.from({ length: nWorkers }, (_, i) => ({ id: i + 1, submitted: 0, failed: 0, status: "starting" })),
    startedAt: Date.now(),
    finishedAt: 0,
  };
  pushLog(`loaded "${form.title}" — ${form.questions.length} questions, ${count} responses, ${nWorkers} workers, speed=${speed}`);

  let next = 1;
  const take = () => (state.stop || next > count ? null : next++);
  const [lo, hi] = SPEEDS[speed];

  const workerLoop = async (w) => {
    for (;;) {
      const slot = take();
      if (slot === null) {
        w.status = "done";
        return;
      }
      w.status = `responding #${slot}`;
      try {
        const r = await submitOnce(form, cfg.answers);
        if (r.ok) {
          state.done++;
          w.submitted++;
          w.status = `responding #${slot} ✓`;
        } else {
          state.failed++;
          w.failed++;
          w.status = `responding #${slot} ✗`;
          pushLog(`w${w.id} response #${slot} FAILED: ${r.why}`);
        }
      } catch (e) {
        state.failed++;
        w.failed++;
        pushLog(`w${w.id} response #${slot} ERROR: ${e.message}`);
        await sleep(1500);
      }
      if (state.stop || next > count) continue;
      await sleep(lo + Math.random() * (hi - lo));
    }
  };

  Promise.all(Array.from({ length: nWorkers }, (_, i) => workerLoop(state.workers[i])))
    .then(() => {
      state.running = false;
      state.finishedAt = Date.now();
      pushLog(
        state.stop
          ? `stopped by user — ${state.done} recorded, ${state.failed} failed`
          : `finished — ${state.done} recorded, ${state.failed} failed`
      );
    })
    .catch((e) => {
      state.running = false;
      state.finishedAt = Date.now();
      pushLog(`runner crashed: ${e.message}`);
    });
}

// ---------- http server ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 1e6) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

let htmlCache = "";
const html = () => (htmlCache ||= readFileSync(join(ROOT, "form-ui.html"), "utf8"));

const server = createServer(async (req, res) => {
  const send = (code, body, type = "application/json") => {
    res.writeHead(code, { "content-type": type });
    res.end(body);
  };
  const sendJson = (code, obj) => send(code, JSON.stringify(obj));

  try {
    if (req.method === "GET" && (req.url === "/" || req.url.startsWith("/index"))) {
      return send(200, html(), "text/html; charset=utf-8");
    }

    if (req.method === "POST" && req.url === "/api/parse") {
      const { url } = JSON.parse(await readBody(req));
      const form = await parseForm(String(url || ""));
      const { view, post, ...pub } = form;
      return sendJson(200, pub);
    }

    if (req.method === "POST" && req.url === "/api/run") {
      if (state.running) return sendJson(409, { error: "a run is already in progress" });
      const cfg = JSON.parse(await readBody(req));
      startRun(cfg).catch((e) => {
        pushLog(`could not start: ${e.message}`);
        state.running = false;
        state.error = e.message;
      });
      return sendJson(202, { started: true });
    }

    if (req.method === "POST" && req.url === "/api/stop") {
      if (state.running) {
        state.stop = true;
        pushLog("stop requested — workers will finish current response and halt");
      }
      return sendJson(200, { ok: true });
    }

    if (req.method === "GET" && req.url === "/api/progress") {
      const { stop, ...pub } = state;
      return sendJson(200, pub);
    }

    send(404, '{"error":"not found"}');
  } catch (e) {
    sendJson(400, { error: e.message });
  }
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Form Runner running at ${url}`);
  if (!process.argv.includes("--no-open")) {
    const open = process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
    exec(open, () => {});
  }
});
