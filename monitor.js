#!/usr/bin/env node
// FIFA World Cup 2026 - hospitality availability watcher.
//
// Polls the public hospitality JSON API and pushes a just-in-time phone alert via
// ntfy.sh when a watched hospitality product becomes available on a knockout match:
//   * "Suite Essentials" (id "MEL") on any watched knockout match - alert on any availability.
//   * "Supporters Club" (id "SC") on R16/QTR/SMF/FNL - alert only when an available
//     seat category is priced under SC_MAX_USD (default $2000 USD).
//   * Sharp focus (FOCUS_MATCHES, default #94) - alert on ANY product with an available
//     tier under FOCUS_MAX_USD (default $2000); supersedes the per-product rules there.
//
// Design notes:
//   * One GET per storefront (us, ca) -> ~220 KB JSON. No browser, no auth, no token.
//   * A product === the Prices[] entry whose Id matches; its PriceCategories[] carry the
//     per-seat Amount (host-country currency) and an IsAvailable flag.
//   * Stage filter uses OriginalStage codes: GST=group (excluded), R32/R16/QTR/SMF/BRZ/FNL.
//   * Venue filter uses the match CountryCode (US / CA), dropping Mexico matches.
//   * SMF/FNL are US-hosted, so Supporters Club Amounts are USD (no FX conversion needed).
//   * State (state.json) dedupes alerts per match+product and drives the re-alert cadence.
//
// Zero dependencies - requires Node 18+ for the global fetch API.

import { readFile, writeFile } from 'node:fs/promises';

const API =
  'https://fifaworldcup26.hospitality.fifa.com/next-api/matches-all?productCode=26FWC&productType=5';

const cfg = {
  storefronts: splitEnv(process.env.STOREFRONTS, 'us,ca'),
  stages: new Set(splitEnv(process.env.STAGES, 'R32,R16,QTR,SMF,BRZ,FNL')),
  ntfyServer: (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, ''),
  // Private alert topic, acting as a shared secret. Never hardcoded: supplied via the
  // NTFY_TOPIC env var (a GitHub Actions secret in CI, or .env for local runs).
  ntfyTopic: process.env.NTFY_TOPIC || '',
  realertHours: Number(process.env.REALERT_HOURS || 6),
  stateFile: process.env.STATE_FILE || new URL('./state.json', import.meta.url).pathname,
  dryRun: process.env.DRY_RUN === '1',
  userAgent:
    process.env.USER_AGENT ||
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
};

const STAGE_LABELS = {
  R32: 'Round of 32',
  R16: 'Round of 16',
  QTR: 'Quarter-final',
  SMF: 'Semi-final',
  BRZ: 'Third-place Final',
  FNL: 'Final',
};

// Hospitality products to watch. Each match (after stage/storefront filtering) is
// evaluated against every product whose `stages` includes that match's stage
// (`stages: null` = every watched knockout stage).
//   * maxUsd === null   -> alert on ANY availability (Suite Essentials).
//   * maxUsd === number -> alert only when an AVAILABLE seat category is priced
//     strictly under that USD amount (Supporters Club; default <$2000 on R16/QTR/SMF/FNL).
const watchProducts = [
  { productId: 'MEL', label: 'Suite Essentials', stages: null, maxUsd: null },
  {
    productId: 'SC',
    label: 'Supporters Club',
    stages: new Set(splitEnv(process.env.SC_STAGES, 'R16,QTR,SMF,FNL')),
    maxUsd: Number(process.env.SC_MAX_USD || 2000),
  },
];

// Sharp-focus matches: specific match numbers where we alert on ANY hospitality product
// that has an AVAILABLE seat category under FOCUS_MAX_USD (default $2000). This SUPERSEDES
// the per-product rules above for those matches (it is a superset: any product under the
// cap, not just Suite Essentials / Supporters Club) and bypasses the stage filter.
// NOTE: the feed exposes no seat-count, so a quantity requirement (FOCUS_MIN_SEATS seats)
// cannot be filtered - it is surfaced in the alert as a checkout reminder only.
const focusMatchNumbers = new Set(
  splitEnv(process.env.FOCUS_MATCHES, '94')
    .map((n) => Number(n))
    .filter((n) => !Number.isNaN(n)),
);
const focusMaxUsd = Number(process.env.FOCUS_MAX_USD || 2000);
const focusMinSeats = Number(process.env.FOCUS_MIN_SEATS || 2);

// Per-storefront targeting. A match is only relevant on the site where it can be bought:
//   * US-hosted matches are sold on the US site  -> watch any US-venue knockout match.
//   * Canada-hosted matches are sold ONLY on the CA site -> watch BC Place (Vancouver) only.
// Venue codes: BC Place Vancouver = NN_VAN; Toronto = NN_TOR (excluded by default).
// A rule with `countries` matches on CountryCode; a rule with `venueCodes` matches on Venue.Code.
const storefrontRules = {
  us: { countries: new Set(splitEnv(process.env.US_COUNTRIES, 'US')) },
  ca: { venueCodes: new Set(splitEnv(process.env.CA_VENUE_CODES, 'NN_VAN')) },
};

/** Whether a match should be watched on a given storefront, per storefrontRules. */
function passesStorefront(match, store) {
  const rule = storefrontRules[store];
  if (!rule) return false;
  if (rule.countries && !rule.countries.has(match.CountryCode)) return false;
  if (rule.venueCodes && !rule.venueCodes.has((match.Venue || {}).Code)) return false;
  return true;
}

function splitEnv(value, fallback) {
  return (value || fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Team / venue ExternalName can be a plain string or a {Translations:[...]} object. */
function localizedText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value.Translations)) {
    const t = value.Translations.find((x) => x.LocaleType === 0) || value.Translations[0];
    return t ? t.Value : '';
  }
  return String(value);
}

function productEntry(match, productId) {
  return (match.Prices || []).find((p) => p.Id === productId);
}

function usd(n) {
  return '$' + Number(n).toLocaleString('en-US');
}

/** Ascending list of numeric Amounts for the given price categories. */
function sortedAmounts(categories) {
  return (categories || [])
    .map((c) => c.Amount)
    .filter((a) => typeof a === 'number')
    .sort((a, b) => a - b);
}

/**
 * Decide whether a product entry qualifies for an alert. A product may expose any
 * number of seat categories (Cat 1/2/3/4...); we evaluate them all and return the
 * full list of qualifying prices, or null when nothing qualifies (incl. not offered).
 *   * maxUsd == null   -> any availability (HasAvailableSeats, or any IsAvailable category).
 *   * maxUsd == number -> every AVAILABLE category priced strictly under maxUsd.
 * Returns { amounts: number[] (ascending), minAmount: number|null }.
 */
function qualifyingHit(priceEntry, maxUsd) {
  if (!priceEntry) return null;
  const categories = priceEntry.PriceCategories || [];
  if (maxUsd == null) {
    const availableCats = categories.filter((c) => c.IsAvailable === true);
    if (priceEntry.HasAvailableSeats === true || availableCats.length > 0) {
      const amounts = sortedAmounts(availableCats);
      return { amounts, minAmount: amounts.length ? amounts[0] : null };
    }
    return null;
  }
  const under = categories.filter(
    (c) => c.IsAvailable === true && typeof c.Amount === 'number' && c.Amount < maxUsd,
  );
  if (under.length === 0) return null;
  const amounts = sortedAmounts(under);
  return { amounts, minAmount: amounts[0] };
}

async function fetchStorefront(country, attempt = 1) {
  try {
    const res = await fetch(API, {
      headers: {
        'country-tag': country,
        'language-tag': 'en',
        accept: 'application/json',
        'user-agent': cfg.userAgent,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('unexpected payload shape');
    return data;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (attempt < 3) {
      await sleep(1500 * attempt);
      return fetchStorefront(country, attempt + 1);
    }
    throw new Error(`fetch '${country}' failed after ${attempt} tries: ${reason}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Match a single storefront payload against the filters and return raw hits. */
function rawHits(matches, store) {
  const out = [];
  for (const m of matches) {
    const stage = m.OriginalStage;
    if (stage === 'GST') continue; // never group stage
    if (!passesStorefront(m, store)) continue; // storefront-specific venue/country targeting
    const isFocus = focusMatchNumbers.has(Number(m.MatchNumber));
    if (!isFocus && !cfg.stages.has(stage)) continue; // stage gate (focus matches bypass it)

    const base = {
      store,
      performanceId: m.PerformanceId,
      stage,
      stageLabel: STAGE_LABELS[stage] || m.Stage || stage,
      home: localizedText(m.HostTeam?.ExternalName) || localizedText(m.HostTeam?.Code) || 'TBD',
      away:
        localizedText(m.OpposingTeam?.ExternalName) ||
        localizedText(m.OpposingTeam?.Code) ||
        'TBD',
      venue: localizedText(m.Venue?.Name),
      country: m.CountryCode,
      date: (m.StringDate || '').split(' ')[0],
      time: m.MatchTimeWithTimezone || '',
    };

    if (isFocus) {
      // Sharp focus: alert on ANY product with an available tier under the focus cap.
      // Supersedes the per-product rules below for this match.
      for (const p of m.Prices || []) {
        const hit = qualifyingHit(p, focusMaxUsd);
        if (!hit) continue;
        out.push({
          ...base,
          productId: p.Id,
          label: localizedText(p.Name) || p.Id,
          maxUsd: focusMaxUsd,
          minAmount: hit.minAmount,
          amounts: hit.amounts,
          focus: true,
        });
      }
      continue;
    }

    for (const wp of watchProducts) {
      if (wp.stages && !wp.stages.has(stage)) continue; // product limited to certain stages
      const hit = qualifyingHit(productEntry(m, wp.productId), wp.maxUsd);
      if (!hit) continue;
      out.push({
        ...base,
        productId: wp.productId,
        label: wp.label,
        maxUsd: wp.maxUsd,
        minAmount: hit.minAmount,
        amounts: hit.amounts,
        focus: false,
      });
    }
  }
  return out;
}

function deepLink(store, performanceId, productId) {
  return `https://fifaworldcup26.hospitality.fifa.com/${store}/en/choose-matches?hospitality=${productId}&performanceId=${performanceId}`;
}

/** Collapse the same match+product seen on multiple storefronts into one alert. */
function groupByMatch(allHits) {
  const byKey = new Map();
  for (const h of allHits) {
    const key = `${h.productId}:perf:${h.performanceId}`;
    const existing = byKey.get(key);
    if (existing) existing.stores.add(h.store);
    else byKey.set(key, { ...h, stores: new Set([h.store]) });
  }
  return [...byKey.values()].map((g) => {
    const stores = [...g.stores].sort();
    const preferred = stores.includes('us') ? 'us' : stores[0];
    return {
      ...g,
      stores,
      key: `${g.productId}:perf:${g.performanceId}`,
      link: deepLink(preferred, g.performanceId, g.productId),
      links: stores.map((s) => `${s.toUpperCase()}: ${deepLink(s, g.performanceId, g.productId)}`),
    };
  });
}

async function loadState() {
  try {
    const parsed = JSON.parse(await readFile(cfg.stateFile, 'utf8'));
    const state = parsed && typeof parsed === 'object' ? parsed : { alerts: {} };
    state.alerts = state.alerts || {};
    // Migrate legacy keys ("perf:<id>", implicitly Suite Essentials) to the
    // product-namespaced form ("MEL:perf:<id>") so existing alerts aren't re-fired.
    for (const k of Object.keys(state.alerts)) {
      if (k.startsWith('perf:')) {
        const nk = `MEL:${k}`;
        if (!state.alerts[nk]) state.alerts[nk] = state.alerts[k];
        delete state.alerts[k];
      }
    }
    return state;
  } catch {
    return { alerts: {} };
  }
}

async function saveState(state) {
  await writeFile(cfg.stateFile, JSON.stringify(state, null, 2) + '\n');
}

async function sendNtfy({ title, message, priority, tags, click }) {
  if (!cfg.ntfyTopic) throw new Error('NTFY_TOPIC is not set');
  const payload = {
    topic: cfg.ntfyTopic,
    title,
    message,
    priority,
    tags,
    click,
    actions: [{ action: 'view', label: 'Open checkout', url: click }],
  };
  if (cfg.dryRun) {
    console.log('[dry-run] would POST ntfy:', JSON.stringify(payload));
    return;
  }
  const res = await fetch(cfg.ntfyServer, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`ntfy HTTP ${res.status} ${detail}`.trim());
  }
}

async function alertMatch(hit, isReminder) {
  const cap = hit.maxUsd != null ? ` under ${usd(hit.maxUsd)}` : '';
  const marker = hit.focus ? 'FOCUS ' : '';
  const title = `${marker}${hit.label} ${isReminder ? '(still available)' : 'AVAILABLE'}${cap} - ${hit.stageLabel}`;
  const lines = [
    `${hit.home} vs ${hit.away}`,
    `${hit.venue} (${hit.country})`,
    `${hit.date} ${hit.time}`.trim(),
  ];
  if (hit.maxUsd != null) {
    // Price-capped: list every qualifying tier (Cat 1/2/3/4...).
    if (hit.amounts && hit.amounts.length) {
      const tiers = hit.amounts.map(usd).join(', ');
      const n = hit.amounts.length;
      lines.push(`Under ${usd(hit.maxUsd)}: ${tiers} (${n} categor${n === 1 ? 'y' : 'ies'})`);
    }
  } else if (hit.minAmount != null) {
    lines.push(`From ${usd(hit.minAmount)}`);
  }
  if (hit.focus && focusMinSeats > 1) {
    lines.push(`You want ${focusMinSeats} seats - confirm quantity at checkout (not in the feed).`);
  }
  lines.push(`Buy via: ${hit.stores.map((s) => s.toUpperCase()).join(' & ')}`);
  if (hit.stores.length > 1) lines.push(...hit.links);
  await sendNtfy({
    title,
    message: lines.join('\n'),
    priority: isReminder && !hit.focus ? 4 : 5,
    tags: hit.focus ? ['star', 'soccer'] : ['soccer', 'stadium'],
    click: hit.link,
  });
}

async function runTestAlert() {
  await sendNtfy({
    title: 'FIFA Suite watcher - test alert',
    message: 'If you can read this on your phone, your alerts are wired up correctly.',
    priority: 4,
    tags: ['white_check_mark'],
    click: 'https://fifaworldcup26.hospitality.fifa.com/us/en/choose-matches?hospitality=MEL',
  });
  console.log(`Test alert sent to topic '${cfg.ntfyTopic}' on ${cfg.ntfyServer}.`);
}

async function main() {
  if (!cfg.ntfyTopic) {
    console.error(
      'NTFY_TOPIC is not set. In CI set it as a repository secret; locally put it in .env ' +
        '(copy .env.example). Refusing to run without an alert destination.',
    );
    process.exit(1);
  }

  if (process.env.SEND_TEST === '1') {
    await runTestAlert();
    return;
  }

  const state = await loadState();
  state.alerts = state.alerts || {};
  const now = Date.now();

  let scanned = 0;
  const collected = [];
  for (const store of cfg.storefronts) {
    const matches = await fetchStorefront(store);
    scanned += matches.length;
    collected.push(...rawHits(matches, store));
  }

  const hits = groupByMatch(collected);
  const currentKeys = new Set(hits.map((h) => h.key));
  const graceMs = cfg.realertHours * 3600000;

  const pending = [];
  for (const hit of hits) {
    const prev = state.alerts[hit.key];
    if (!prev) {
      pending.push({ hit, isReminder: false });
    } else if (now - new Date(prev.lastAlerted).getTime() >= graceMs) {
      pending.push({ hit, isReminder: true });
    } else {
      // Still available but inside the quiet window: refresh lastSeen so the
      // anti-flicker timer below tracks current availability without alerting.
      prev.lastSeen = new Date(now).toISOString();
    }
  }

  // Anti-flicker pruning: only forget a match once it has been UNAVAILABLE for a
  // full re-alert window. This stops available -> gone -> available bouncing from
  // spamming fresh "new" alerts, while still re-alerting a genuine later return.
  for (const [key, rec] of Object.entries(state.alerts)) {
    if (currentKeys.has(key)) continue;
    const lastSeen = new Date(rec.lastSeen || rec.lastAlerted).getTime();
    if (now - lastSeen >= graceMs) delete state.alerts[key];
  }

  let sent = 0;
  for (const { hit, isReminder } of pending) {
    try {
      await alertMatch(hit, isReminder);
      const prev = state.alerts[hit.key];
      state.alerts[hit.key] = {
        firstSeen: prev?.firstSeen || new Date(now).toISOString(),
        lastAlerted: new Date(now).toISOString(),
        lastSeen: new Date(now).toISOString(),
        match: `${hit.label}: ${hit.home} vs ${hit.away} (${hit.stageLabel}, ${hit.country})`,
        stores: hit.stores,
      };
      sent += 1;
      console.log(
        `ALERT ${isReminder ? '(reminder)' : '(new)'}: ${hit.focus ? '[FOCUS] ' : ''}${hit.label} - ${hit.home} vs ${hit.away} ` +
          `[${hit.stageLabel}, ${hit.country}]${hit.minAmount != null ? ` from ${usd(hit.minAmount)}` : ''} ` +
          `via ${hit.stores.join('+')}`,
      );
    } catch (err) {
      console.error(`Failed to alert ${hit.key}:`, err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  }

  await saveState(state);
  console.log(
    `[${new Date().toISOString()}] scanned ${scanned} rows across [${cfg.storefronts.join(', ')}] ` +
      `-> ${hits.length} hit(s), ${sent} alert(s) sent, tracking ${Object.keys(state.alerts).length}.`,
  );
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
