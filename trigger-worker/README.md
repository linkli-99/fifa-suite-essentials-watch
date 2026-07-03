# Reliable 2-minute trigger (Cloudflare Worker)

GitHub's own `schedule:` cron is best-effort, heavily throttled, and capped at a
5-minute minimum — high-frequency crons are mostly dropped under load, so the watcher
actually fires every **~80–90 min**. This Worker fires on time every **2 minutes** via a
**Cloudflare Cron Trigger** and calls GitHub's `workflow_dispatch` API to run `watch.yml`.

Keep the `schedule:` block in `../.github/workflows/watch.yml` too — it's a free
fallback, and the workflow's `concurrency` group makes duplicate triggers harmless.

## What you need
- A Cloudflare account (free plan includes Cron Triggers).
- A **fine-grained** GitHub Personal Access Token (steps below).

## 1. Create the GitHub token
1. https://github.com/settings/personal-access-tokens/new
2. **Resource owner:** `linkli-99` · **Repository access → Only select repositories →**
   `fifa-suite-essentials-watch`.
3. **Permissions → Repository permissions → Actions → Read and write.**
4. Generate and copy the token (starts with `github_pat_…`).

## 2. Deploy the Worker
From this `trigger-worker/` folder:

```bash
npm install                       # installs wrangler locally (or use npx below)
npx wrangler login                # opens browser; authorize your Cloudflare account
npx wrangler secret put GH_TOKEN  # paste the PAT from step 1
npx wrangler deploy               # deploy the Worker + 2-min cron trigger
```

That's it — the Worker now dispatches the workflow every 2 minutes.

## 3. Verify
```bash
npx wrangler tail                 # live logs; you'll see an invocation every 2 min
```
- Health check: open the Worker URL (printed by `deploy`) — it returns
  `suite-watch-trigger: ok` and does **not** trigger a run.
- Test the cron logic immediately, without waiting 2 min:
  ```bash
  npm run test-cron               # then visit the printed http://localhost:8787/__scheduled
  ```
- Confirm runs in GitHub: **Actions → Suite Essentials Watch** — new runs appear with
  the `workflow_dispatch` trigger every ~2 min.

## Configuration
Repo/owner/workflow/branch live in `wrangler.toml` under `[vars]`. Only `GH_TOKEN`
is a secret (set via `wrangler secret put`, never committed).

| Var | Value |
|---|---|
| `GH_OWNER` | `linkli-99` |
| `GH_REPO` | `fifa-suite-essentials-watch` |
| `GH_WORKFLOW` | `watch.yml` |
| `GH_REF` | `master` |
| `GH_TOKEN` *(secret)* | fine-grained PAT, Actions: Read and write |
