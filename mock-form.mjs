// Minimal mock of a Google Form (viewform + formResponse) for dry-run testing
// Form Runner without touching Google. Run: node mock-form.mjs  (port 8788)
import { createServer } from "node:http";

const FBZX = "1234567890123456789";
let responses = 0;

const page = (data) => `<!doctype html><html><head><title>Mock Test Form</title></head>
<body>mock</body>
<script>window.fbzx='${FBZX}';FB_PUBLIC_LOAD_DATA_ = ${JSON.stringify(data)};</script></html>`;

const ITEMS = [
  [11, "1. Favorite color?", null, 2, [[111, [["Red"], ["Green"], ["Blue"]], 1]]],
  [12, "2. Rate this mock form", null, 2, [[222, [["1 — Meh"], ["2 — Fine"], ["3 — Great"]], 1]]],
  [13, "3. Any comments?", null, 1, [[333, null, 0]]],
];

createServer((req, res) => {
  if (req.url.startsWith("/viewform")) {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(page([null, ["Mock form for dry runs", ITEMS, ["Thanks!", 0]], null, "Mock Test Form"]));
  }
  if (req.url.startsWith("/formResponse")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const params = new URLSearchParams(body);
      // require the two "mandatory" entries — mirrors Google's validation
      const valid = params.get("entry.111") && params.get("entry.222");
      res.writeHead(200, { "content-type": "text/html" });
      if (valid) {
        responses++;
        // success = confirmation page: data blob present but EMPTY items
        return res.end(page([null, [], null, "Mock Test Form"]));
      }
      // failure = form re-served WITH its items
      res.end(page([null, ["Mock form for dry runs", ITEMS, ["Thanks!", 0]], null, "Mock Test Form"]));
    });
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(8788, () => console.log(`mock form at http://localhost:8788/viewform (accepted so far: hit /count)`));
