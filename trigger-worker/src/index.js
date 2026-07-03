// Cloudflare Worker — reliable 2-minute trigger for the GitHub Actions
// "Suite Essentials Watch" workflow.
//
// Why this exists: GitHub's own `schedule:` (cron) trigger is best-effort and
// heavily throttled — high-frequency crons like */5 are mostly dropped under
// load, so the workflow actually fires every ~80-90 min instead of every 5.
// Cloudflare's Cron Trigger fires on time, then calls GitHub's
// workflow_dispatch REST endpoint to run the workflow.
//
// Required secret:  GH_TOKEN  — a fine-grained PAT scoped to this repo only,
//                               with "Actions: Read and write" permission.
//   Set it with:    npx wrangler secret put GH_TOKEN
//
// Config (owner/repo/workflow/ref) lives in wrangler.toml [vars].

async function dispatch(env) {
  const url = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/actions/workflows/${env.GH_WORKFLOW}/dispatches`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      // GitHub rejects API requests that have no User-Agent header.
      "User-Agent": "cf-worker-suite-watch",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: env.GH_REF }),
  });

  // A successful workflow_dispatch returns 204 No Content.
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`workflow_dispatch failed: ${res.status} ${body}`);
  }
}

export default {
  // Cron Trigger entrypoint (runs on the schedule in wrangler.toml).
  async scheduled(event, env, ctx) {
    await dispatch(env);
  },

  // Optional health check: visiting the Worker URL returns 200 and does NOT
  // trigger the workflow. Handy to confirm the Worker is deployed.
  async fetch(request, env, ctx) {
    return new Response("suite-watch-trigger: ok\n", {
      headers: { "content-type": "text/plain" },
    });
  },
};
