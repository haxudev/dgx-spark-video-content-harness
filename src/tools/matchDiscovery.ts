/**
 * Match self-discovery.
 *
 * Single source of truth for "which matches exist on a given day". Queries the
 * Supabase `envelopes` index for the set of match ids and turns each into a
 * football.haxu.net report URL. Both the standalone `harness discover` CLI and
 * the containerized MAF agent's self-discovery tool call this, so no hard-coded
 * match list ever enters the pipeline — the agent discovers the day's fixtures
 * at run time and feeds the REAL report URLs into `run --url`.
 *
 * All endpoints/keys are env-overridable; the defaults match the project's
 * existing `scripts/daily-today.sh`.
 */

const DEFAULT_SUPABASE_URL = "https://ftvabvfqdrhgfhcejngc.supabase.co";
const DEFAULT_SUPABASE_KEY = "sb_publishable_l4KGCygNyrlBVN63KXX7vg_S772r5bx";
const DEFAULT_MATCH_BASE = "https://football.haxu.net/match";

/** Only ids shaped like `20260702-3080` map to football.haxu.net/match/<id>/. */
const NUMERIC_ID = /^\d{8}-\d+$/;

export interface DiscoveredMatch {
  matchId: string;
  url: string;
}

export interface DiscoverResult {
  /** Normalized target date, YYYYMMDD. */
  date: string;
  count: number;
  matches: DiscoveredMatch[];
  /** Supabase endpoint used (for diagnostics). */
  source: string;
}

/** Current date in Beijing time (UTC+8), shifted by `offsetDays`, as YYYYMMDD. */
export function beijingDate(offsetDays = 0): string {
  const ms = Date.now() + 8 * 3_600_000 + offsetDays * 86_400_000;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${mo}${da}`;
}

/**
 * Resolve a user/agent date expression to YYYYMMDD.
 * Accepts: `YYYY-MM-DD`, `YYYYMMDD`, `today`/`t0`, `tomorrow`/`t+1`/`next`,
 * `yesterday`. Empty/undefined defaults to **tomorrow (T+1 Beijing)** — the
 * established daily convention (a run today publishes T+1 fixtures).
 */
export function normalizeDate(input?: string): string {
  const raw = (input ?? "").trim().toLowerCase();
  if (!raw || raw === "tomorrow" || raw === "t+1" || raw === "next") return beijingDate(1);
  if (raw === "today" || raw === "t0" || raw === "now") return beijingDate(0);
  if (raw === "yesterday") return beijingDate(-1);
  const digits = raw.replace(/-/g, "");
  if (/^\d{8}$/.test(digits)) return digits;
  throw new Error(
    `unrecognized date: ${JSON.stringify(input)} (use YYYY-MM-DD, YYYYMMDD, today, or tomorrow)`,
  );
}

/**
 * Discover the day's matches from the Supabase envelopes index.
 *
 * @throws when the Supabase query fails (network / auth / bad status) so the
 * caller can surface a real error instead of silently producing zero matches.
 */
export async function discoverMatches(opts: { date?: string } = {}): Promise<DiscoverResult> {
  const date = normalizeDate(opts.date);
  const base = (process.env.HARNESS_DISCOVER_SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/+$/, "");
  const key = process.env.HARNESS_DISCOVER_SUPABASE_KEY || DEFAULT_SUPABASE_KEY;
  const matchBase = (process.env.HARNESS_DISCOVER_MATCH_BASE || DEFAULT_MATCH_BASE).replace(/\/+$/, "");
  const limit = parseInt(process.env.HARNESS_DISCOVER_LIMIT || "200", 10);

  const endpoint = `${base}/rest/v1/envelopes?select=match_id&order=match_id.desc&limit=${limit}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let rows: Array<{ match_id?: string }>;
  try {
    const res = await fetch(endpoint, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Supabase query failed: HTTP ${res.status}`);
    rows = (await res.json()) as Array<{ match_id?: string }>;
  } finally {
    clearTimeout(timer);
  }

  const seen = new Set<string>();
  const matches: DiscoveredMatch[] = [];
  for (const r of rows) {
    const id = (r.match_id || "").trim();
    if (!id || seen.has(id)) continue;
    if (!NUMERIC_ID.test(id)) continue; // skip team-vs-team style ids without a /match page
    if (!id.startsWith(date)) continue;
    seen.add(id);
    matches.push({ matchId: id, url: `${matchBase}/${id}/` });
  }
  matches.sort((a, b) => a.matchId.localeCompare(b.matchId));

  return { date, count: matches.length, matches, source: base };
}
