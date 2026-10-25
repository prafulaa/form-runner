# Form Runner

A local web dashboard that auto-fills **Google Forms** for testing — paste a form
link, it parses every question automatically, then a pool of parallel workers
submits responses at the pace you choose.

Zero dependencies. One Node process. Runs on `localhost` only.

```
node form-ui.mjs          # → http://localhost:8787
```

## What it does

1. **Load** — paste any public Google Forms link. Form Runner fetches the page,
   reads the embedded `FB_PUBLIC_LOAD_DATA_` structure and lists every question
   with its type, choices, and required flag (choice, dropdown, multi-select,
   1–N scale, text, date). Closed / sign-in-only forms are detected and reported.
2. **Configure** — pick how many **responses** you want and how many **workers**
   submit them in parallel (1–16). Each question defaults to *random per
   response* so submissions vary; set any question to a fixed answer to pin it.
3. **Run** — choose a speed profile (human-like → no delay) and watch live
   progress: per-worker status chips, a log, ETA, and a stop button.

## How it works

Google Forms exposes a plain `POST …/formResponse` endpoint. Form Runner:

- fetches `viewform` and extracts a fresh `fbzx` session token per submission,
- submits all answers in a single POST (`fvv=1&pageHistory=0&fbzx=…&submit=Submit`),
- detects success by the confirmation screen's structure — Google embeds its form
  data blob on *every* page, but only the confirmation screen has an **empty**
  question list; a rejected submit re-serves the full form.

Values must byte-match the form's choice labels (watch for en/em dashes — a
mismatched label is silently dropped and, if the question is required, the whole
submission is rejected).

## Files

| File | Purpose |
|------|---------|
| `form-ui.mjs` | HTTP server, form parser, worker-pool runner, JSON API |
| `form-ui.html` | Single-page dashboard (vanilla JS, no build step) |
| `mock-form.mjs` | A local mock Google Form for dry-run testing |
| `local/` | Optional: survey-specific CLI bot kept out of the repo |

Dry-run the whole pipeline without touching Google:

```bash
node mock-form.mjs        # mock form on :8788
node form-ui.mjs          # dashboard on :8787
# then Load form → http://localhost:8788/viewform
```

## API

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/parse` | POST `{url}` | Parse a form into questions/choices |
| `/api/run` | POST `{url, count, workers, speed, answers?}` | Start a run |
| `/api/stop` | POST | Ask workers to stop after the current response |
| `/api/progress` | GET | Live counters, per-worker status, log tail |

## Requirements

- Node 18+ (built-in `fetch`)
- The target form must be public (no sign-in) and accept responses

## Fair use

This is a testing tool. Only use it on forms you own or have explicit
permission to test. Google rate-limits and logs automated submissions, and
responses you submit land in the form owner's live dataset — keep volumes
proportionate and delete test rows when you're done.

## License

[MIT](LICENSE)
