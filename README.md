# FIFA World Cup 2026 — Suite Essentials Watcher

Polls the FIFA / On Location hospitality API every 5 minutes and sends a **phone
push alert** the moment a watched hospitality package becomes available for a
**knockout-stage** match (Round of 32 → Final) hosted in the **USA or Canada**:

- **Suite Essentials** — on any watched knockout match; alert on any availability.
- **Supporters Club** — on the **Round of 16, quarter-finals, semi-finals + final**;
  alert **only** when an available seat category is priced **under $2,000 USD** (it
  otherwise runs ~$4k–$17k). The product can expose multiple categories (Cat 1/2/3/4…).
- **Sharp focus (M94)** — for the match you care about most (**#94 USA vs Belgium,
  Seattle R16**), alert on **any** hospitality product with an available tier **under
  $2,000** (configurable via `FOCUS_*`).

Lightweight by design: one JSON `GET` per storefront (~220 KB), **no browser, no
login, no dependencies**. Runs in GitHub Actions (cloud, always-on) and/or locally.

---

## How it works

| Concern | Implementation |
|---|---|
| Data source | `GET https://fifaworldcup26.hospitality.fifa.com/next-api/matches-all?productCode=26FWC&productType=5` |
| US vs Canada | Same endpoint; the storefront is chosen by the **`country-tag: us` / `ca`** request header. Each match is only purchasable on its own site, so targeting is per-site (below). |
| "Suite Essentials" | The `Prices[]` entry with `Id === "MEL"`. Available when `HasAvailableSeats === true`. |
| "Supporters Club" | The `Prices[]` entry with `Id === "SC"`, watched on **R16/QTR/SMF/FNL**. Alerts when **any** available `PriceCategories[]` tier (Cat 1/2/3/4…) has `Amount < SC_MAX_USD` (default `2000`, USD; these rounds are US-hosted so no FX). |
| Sharp focus | `FOCUS_MATCHES` (default `94`): for those match numbers, alert on **any** `Prices[]` product with an available tier under `FOCUS_MAX_USD` (default `2000`) — supersedes the per-product rules and ignores the stage filter. `FOCUS_MIN_SEATS` (default `2`) is a checkout reminder only (the feed carries no seat-count). |
| Stage filter | `OriginalStage`: `GST` (group) excluded; `R32 R16 QTR SMF BRZ FNL` watched. |
| Location targeting | **US site →** any US-venue knockout match (sold on the US site). **CA site →** **BC Place Vancouver only** (`NN_VAN`); Canadian matches are sold only on the CA site, and Toronto (`NN_TOR`) is excluded. |
| Alert | `ntfy.sh` push notification with a one-tap deep link to the checkout page. |
| De-dup / re-alert | `state.json` — alerts once on first sight, then reminds every `REALERT_HOURS` (default 6) while still available; forgets a match when it sells out so it re-alerts if it returns. |

The alert deep-links straight to:
`…/{us|ca}/en/choose-matches?hospitality=MEL&performanceId={id}`

---

## 1. Set up the phone alert (ntfy — free, 2 minutes)

1. Install the **ntfy** app ([iOS](https://apps.apple.com/app/ntfy/id1625396347) / [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy)).
2. Tap **+ Subscribe to topic** and enter a **private topic name** you choose — make it
   hard to guess (anyone who knows the topic can read/post to it), e.g.
   `fifa-suite-<random-hex>`.
3. Use that exact topic as the `NTFY_TOPIC` secret (cloud) / `.env` value (local). The
   topic is **never committed** to this repo.
4. Done. The watcher publishes to that topic; your phone receives it.

> iOS note: you must grant the ntfy app **Notification permission** (Settings →
> Notifications → ntfy → Allow). Without it the app receives nothing.

> Prefer Telegram / Pushover instead? Swap the `sendNtfy()` function in `monitor.js` — the rest is unchanged.

---

## 2A. Run in the cloud (GitHub Actions — recommended)

Always-on, no machine required. Use a **public** repo so Actions minutes are free and
unlimited (the code and `state.json` aren't sensitive; your topic stays a secret).

1. Push this folder to your GitHub repo.
2. Add your topic as a secret: repo **Settings → Secrets and variables → Actions → New secret** → name `NTFY_TOPIC`, value = your private topic. (Required — the script refuses to run without it.)
3. **Actions** tab → enable workflows. It then runs every ~5 min on `cron`.
4. Test it now: **Actions → Suite Essentials Watch → Run workflow → "Send a test alert" = true**.

The job commits `state.json` back to the repo to remember what it already alerted.

> GitHub notes: scheduled runs can be delayed/batched under load; schedules pause after
> 60 days of repo inactivity (the state commits keep it active). On a **private** repo,
> Actions minutes are limited (≈2,000/month free) and 5-min polling would exhaust them
> mid-tournament — hence the public-repo recommendation.

## 2B. Run locally (macOS launchd)

Polls while your Mac is awake.

```bash
cd fifa-suite-essentials-watch
cp .env.example .env            # edit if you changed the topic
node monitor.js                 # one manual run
```

Schedule every 5 min:

```bash
# edit the __PLACEHOLDER__ path inside the plist first
cp local/com.fifa.suitewatch.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.fifa.suitewatch.plist
tail -f /tmp/fifa-suitewatch.log
```

## 2C. Reliable 5-minute trigger (Cloudflare Worker — optional)

GitHub's `schedule:` cron is best-effort and throttled, so `*/5` actually fires every
**~80–90 min** under load. For dependable 5-minute polling, deploy the small Cloudflare
Worker in [`trigger-worker/`](trigger-worker/README.md): a Cloudflare Cron Trigger fires
on time and calls GitHub's `workflow_dispatch` API to run `watch.yml`. Keep the
`schedule:` block as a free fallback — the workflow's `concurrency` group makes duplicate
triggers harmless. Setup is ~5 minutes; see [`trigger-worker/README.md`](trigger-worker/README.md).

---

## Commands

```bash
node monitor.js                 # one scan + alerts
SEND_TEST=1 node monitor.js     # send a single test push to your phone
DRY_RUN=1 node monitor.js       # scan + print would-be alerts, send nothing
```

## Configuration (env vars)

| Var | Default | Meaning |
|---|---|---|
| `NTFY_TOPIC` | _(required)_ | Your private ntfy topic (set via secret / `.env`; never committed) |
| `NTFY_SERVER` | `https://ntfy.sh` | Self-host ntfy by changing this |
| `STOREFRONTS` | `us,ca` | Sales channels to poll |
| `STAGES` | `R32,R16,QTR,SMF,BRZ,FNL` | Knockout stages to watch |
| `US_COUNTRIES` | `US` | US site: host-country filter (US venues) |
| `CA_VENUE_CODES` | `NN_VAN` | CA site: venue allow-list (BC Place only; `NN_TOR`=Toronto) |
| `REALERT_HOURS` | `6` | Reminder cadence while still available |
| `SC_STAGES` | `R16,QTR,SMF,FNL` | Stages on which to watch Supporters Club |
| `SC_MAX_USD` | `2000` | Alert on Supporters Club only when an available tier is strictly under this (USD) |
| `FOCUS_MATCHES` | `94` | Sharp-focus match numbers: alert on ANY product with an available tier under the focus cap |
| `FOCUS_MAX_USD` | `2000` | Focus price cap (USD) |
| `FOCUS_MIN_SEATS` | `2` | Seats you want — checkout reminder only (not filterable; feed has no seat-count) |

---

## Create the repo

```bash
gh repo create linkli-99/fifa-suite-essentials-watch --public --source . --remote origin --push
gh secret set NTFY_TOPIC --repo linkli-99/fifa-suite-essentials-watch   # paste your topic
```

## Disclaimer

For personal, low-volume monitoring of a public endpoint. Be a good citizen: keep the
polling interval at GitHub's 5-minute floor (the endpoint is CDN-cached, so this is
negligible load). Buying still happens manually by you on the official site.
