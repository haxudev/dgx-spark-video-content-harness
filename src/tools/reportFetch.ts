import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Fetch an HTML report from a URL into a local file.
 *
 * Football reports are typically SPA pages whose meaningful markup is rendered
 * client-side, so a plain HTTP GET returns an empty shell. We therefore render
 * with a headless Chromium (puppeteer) first and only fall back to a plain
 * `fetch` when a browser is unavailable.
 *
 * Chromium binary resolution order:
 *   1. PUPPETEER_EXECUTABLE_PATH (verified-working path on this host)
 *   2. puppeteer's bundled/cached download (executablePath())
 */
export interface FetchReportResult {
  url: string;
  outPath: string;
  bytes: number;
  via: "puppeteer" | "http";
}

// Fixed post-navigation pause. `networkidle2` often fires before a Next.js SPA
// finishes fetching + hydrating the match data, so we also actively wait for a
// content selector (below) and only fall back to this fixed settle. Default
// bumped to 8s because the report family hydrates slowly on cold loads — a 3s
// settle silently captured an empty shell (no .mr-* cards) on this host.
const SPA_SETTLE_MS = Number(process.env.HARNESS_FETCH_SETTLE_MS ?? "8000");
const NAV_TIMEOUT_MS = Number(process.env.HARNESS_FETCH_TIMEOUT_MS ?? "120000");
// Wait (up to this long) for the SPA to render real report markup before
// grabbing page.content(). Keyed off the Next.js report card classes.
const CONTENT_WAIT_MS = Number(process.env.HARNESS_FETCH_CONTENT_WAIT_MS ?? "30000");
// Selector that only appears once the match report has actually rendered.
const CONTENT_SELECTOR = process.env.HARNESS_FETCH_CONTENT_SELECTOR
  ?? ".mr-card, .mr-hero, .mr-team-name, .mr-section";

export async function fetchReport(url: string, outPath: string): Promise<FetchReportResult> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`fetchReport expects an http(s) URL, got: ${url}`);
  }
  const abs = path.resolve(outPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });

  let html: string | null = null;
  let via: FetchReportResult["via"] = "puppeteer";
  try {
    html = await renderWithPuppeteer(url);
  } catch (e: any) {
    // Browser unavailable or navigation failed — fall back to a plain GET so
    // static reports still work offline / in minimal environments.
    via = "http";
    html = await plainGet(url);
    if (!html) throw new Error(`fetchReport: puppeteer failed (${e?.message ?? e}) and plain GET returned no body`);
  }

  await fs.writeFile(abs, html, "utf8");
  return { url, outPath: abs, bytes: Buffer.byteLength(html, "utf8"), via };
}

async function renderWithPuppeteer(url: string): Promise<string> {
  const { default: puppeteer } = await import("puppeteer");
  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
  const browser = await puppeteer.launch({
    headless: true,
    ...(execPath ? { executablePath: execPath } : {}),
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(url, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS });
    // Actively wait for the SPA to render the report cards (networkidle2 fires
    // before hydration completes on this report family). Best-effort: if the
    // selector never appears we still fall through to the fixed settle + capture
    // whatever is there, so static/legacy reports keep working.
    if (CONTENT_WAIT_MS > 0 && CONTENT_SELECTOR) {
      try {
        await page.waitForSelector(CONTENT_SELECTOR, { timeout: CONTENT_WAIT_MS });
      } catch {
        /* selector never appeared — fall back to the fixed settle below */
      }
    }
    if (SPA_SETTLE_MS > 0) await new Promise((r) => setTimeout(r, SPA_SETTLE_MS));
    return await page.content();
  } finally {
    await browser.close().catch(() => {});
  }
}

async function plainGet(url: string): Promise<string | null> {
  const res = await fetch(url, {
    headers: { "user-agent": "podcast-football-harness/0.1 (+report-fetch)" },
    signal: AbortSignal.timeout(NAV_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const body = await res.text();
  return body.length > 0 ? body : null;
}

/**
 * Derive a stable, filesystem-safe `<bucket>/<slug>.html` location for a fetched
 * report URL, so buildRunContext's matchId (`<bucket>__<slug>`) stays meaningful.
 *
 *   https://football.haxu.net/match/20260529-4002/  ->  web/20260529-4002.html
 */
export function deriveReportPath(url: string, inputsRoot = "inputs", bucket?: string): string {
  let slug = "report";
  try {
    const u = new URL(url);
    const segs = u.pathname.split("/").filter(Boolean);
    slug = segs.length ? segs[segs.length - 1]! : u.hostname;
  } catch {
    /* keep default slug */
  }
  slug = sanitize(slug) || "report";
  const b = sanitize(bucket ?? process.env.HARNESS_URL_BUCKET ?? "web") || "web";
  return path.join(inputsRoot, b, `${slug}.html`);
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}
