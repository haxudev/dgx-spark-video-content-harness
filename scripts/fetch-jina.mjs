#!/usr/bin/env node
/**
 * fetch-jina.mjs — Fetch any URL via Jina Reader and save as HTML or Markdown.
 *
 * Usage:
 *   node scripts/fetch-jina.mjs <url> [options]
 *
 * Examples:
 *   # Basic fetch → markdown in inputs/<date>/
 *   node scripts/fetch-jina.mjs https://example.com
 *
 *   # Save as rendered HTML, target a specific element
 *   node scripts/fetch-jina.mjs https://example.com --as html --selector article.content
 *
 *   # SPA with hash route (POST)
 *   node scripts/fetch-jina.mjs "https://app.example.com/#/match/42" --post
 *
 *   # Force browser engine, wait for dynamic content
 *   node scripts/fetch-jina.mjs https://example.com --engine browser --timeout 30
 *
 *   # Limit output tokens, save to custom path
 *   node scripts/fetch-jina.mjs https://example.com --max-tokens 4000 --out ./my-file.md
 *
 *   # Use self-hosted Jina Reader
 *   JINA_READER_BASE_URL=http://localhost:3000 node scripts/fetch-jina.mjs https://example.com
 *
 *   # Search mode (returns top 5 results as markdown)
 *   node scripts/fetch-jina.mjs "football prediction 2026" --search
 */

import { createWriteStream, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exit } from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL   = 'https://r.jina.ai';
const DEFAULT_DATE_DIR   = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const OUTPUT_DIR         = 'inputs';

// ── Argument parsing ────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    url: null,
    outputFormat: 'markdown',   // markdown | html | text | frontmatter
    engine: null,               // browser | curl | auto
    timeout: null,
    waitForSelector: null,
    targetSelector: null,
    maxTokens: null,
    tokenBudget: null,
    cacheTolerance: null,
    noCache: false,
    proxy: null,
    proxyUrl: null,
    detachInvisibles: false,
    retainImages: null,         // all | none | alt
    retainLinks: null,          // all | none | text | gpt-oss
    withGeneratedAlt: false,
    withLinksSummary: false,
    withImagesSummary: false,
    retainMedia: null,          // link | none | text | image | html
    mdLinkStyle: null,
    preset: null,               // reader | index | research | agent | spider
    chunking: null,             // true | h1..h5 | structured | s1..s5
    post: false,
    search: false,
    as: null,                   // alias for --output-format
    out: null,                  // custom output path
  };

  let i = 0;
  while (i < argv.length) {
    const a = argv[i];

    if (a.startsWith('-')) {
      switch (a) {
        case '--format': case '--as':
          args.outputFormat = argv[++i]; break;
        case '--engine':
          args.engine = argv[++i]; break;
        case '--timeout':
          args.timeout = parseInt(argv[++i], 10); break;
        case '--wait-for': case '--wait-for-selector':
          args.waitForSelector = argv[++i]; break;
        case '--target': case '--target-selector':
          args.targetSelector = argv[++i]; break;
        case '--max-tokens':
          args.maxTokens = parseInt(argv[++i], 10); break;
        case '--token-budget':
          args.tokenBudget = parseInt(argv[++i], 10); break;
        case '--cache-tolerance':
          args.cacheTolerance = argv[++i]; break;
        case '--no-cache':
          args.noCache = true; break;
        case '--proxy':
          args.proxy = argv[++i]; break;
        case '--proxy-url':
          args.proxyUrl = argv[++i]; break;
        case '--detach-invisibles':
          args.detachInvisibles = true; break;
        case '--retain-images':
          args.retainImages = argv[++i]; break;
        case '--retain-links':
          args.retainLinks = argv[++i]; break;
        case '--with-generated-alt':
          args.withGeneratedAlt = true; break;
        case '--with-links-summary':
          args.withLinksSummary = true; break;
        case '--with-images-summary':
          args.withImagesSummary = true; break;
        case '--retain-media':
          args.retainMedia = argv[++i]; break;
        case '--md-link-style':
          args.mdLinkStyle = argv[++i]; break;
        case '--preset':
          args.preset = argv[++i]; break;
        case '--chunking':
          args.chunking = argv[++i]; break;
        case '--post':
          args.post = true; break;
        case '--search':
          args.search = true; break;
        case '--out':
          args.out = argv[++i]; break;
        case '--help': case '-h':
          printUsage(); exit(0);
        default:
          console.error(`Unknown flag: ${a}`); printUsage(); exit(1);
      }
    } else if (!args.url) {
      args.url = a;
    }
    i++;
  }

  return args;
}

function printUsage() {
  console.log(`
fetch-jina.mjs — Fetch any URL via Jina Reader API

Usage: node scripts/fetch-jina.mjs <url> [options]

Positionals:
  url            URL to fetch (or search query when --search)

Output format:
  --format, --as <type>   Output type: markdown | html | text | frontmatter (default: markdown)
  --out <path>            Custom output file path

Fetching:
  --post                  Use POST body (required for SPA hash routes)
  --search                Treat url as search query (uses s.jina.ai)
  --engine <browser|curl|auto>   Force fetching engine
  --timeout <seconds>     Max wait time (default: auto)
  --wait-for-selector     CSS selector to wait for before returning
  --target-selector       CSS selector to extract content from
  --cache-tolerance <s>   Accept cached content up to N seconds old
  --no-cache              Bypass cache entirely
  --proxy <auto|us|cn>    Use Jina proxy (key required)
  --proxy-url <url>       Custom proxy URL

Content control:
  --max-tokens <n>        Trim response to ≤ N tokens
  --token-budget <n>      Reject if response exceeds N tokens
  --retain-images <all|none|alt>
  --retain-links <all|none|text|gpt-oss>
  --with-generated-alt    Caption images with VLM
  --with-links-summary    Append link list to output
  --with-images-summary   Append image list to output
  --retain-media <link|none|text|image|html>
  --detach-invisibles     Detach display:none elements
  --preset <reader|index|research|agent|spider>
  --chunking <h1..h5|s1..s5|structured>

Environment:
  JINA_READER_BASE_URL   Custom endpoint (default: https://r.jina.ai)
  JINA_READER_API_KEY    API key (optional, boosts quota)
`);
}

// ── Core fetch logic ────────────────────────────────────────────────────────

/**
 * Build headers from args → Jina Reader header mapping.
 */
function buildHeaders(args) {
  const headers = {};

  if (args.outputFormat === 'markdown')      headers['X-Respond-With'] = 'markdown';
  else if (args.outputFormat === 'html')     headers['X-Respond-With'] = 'html';
  else if (args.outputFormat === 'text')     headers['X-Respond-With'] = 'text';
  else if (args.outputFormat === 'frontmatter') headers['X-Respond-With'] = 'frontmatter';

  if (args.engine)           headers['X-Engine'] = args.engine;
  if (args.timeout)          headers['X-Timeout'] = String(args.timeout);
  if (args.waitForSelector)  headers['X-Wait-For-Selector'] = args.waitForSelector;
  if (args.targetSelector)   headers['X-Target-Selector'] = args.targetSelector;
  if (args.cacheTolerance !== null)  headers['X-Cache-Tolerance'] = args.cacheTolerance;
  if (args.noCache)          headers['X-No-Cache'] = 'true';
  if (args.proxy)            headers['X-Proxy'] = args.proxy;
  if (args.proxyUrl)         headers['X-Proxy-Url'] = args.proxyUrl;
  if (args.maxTokens)        headers['X-Max-Tokens'] = String(args.maxTokens);
  if (args.tokenBudget)      headers['X-Token-Budget'] = String(args.tokenBudget);
  if (args.detachInvisibles) headers['X-Detach-Invisibles'] = 'true';
  if (args.retainImages)     headers['X-Retain-Images'] = args.retainImages;
  if (args.retainLinks)      headers['retain-links'] = args.retainLinks;
  if (args.withGeneratedAlt) headers['X-With-Generated-Alt'] = 'true';
  if (args.withLinksSummary) headers['X-With-Links-Summary'] = 'true';
  if (args.withImagesSummary) headers['X-With-Images-Summary'] = 'true';
  if (args.retainMedia)      headers['X-Retain-Media'] = args.retainMedia;
  if (args.mdLinkStyle)      headers['X-Md-Link-Style'] = args.mdLinkStyle;
  if (args.preset)           headers['X-Preset'] = args.preset;
  if (args.chunking)         headers['X-Markdown-Chunking'] = args.chunking;

  const apiKey = process.env.JINA_READER_API_KEY;
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  return headers;
}

/**
 * Resolve output file path.
 */
function resolveOutPath(args, content) {
  if (args.out) {
    return resolve(args.out);
  }

  const extMap = {
    markdown: '.md',
    html: '.html',
    text: '.txt',
    frontmatter: '.md',
  };
  const ext = extMap[args.outputFormat] || '.md';

  // Derive a filename from the URL
  let name = 'fetched';
  try {
    const u = new URL(args.url);
    name = u.hostname.replace(/\./g, '-');
    const pathParts = u.pathname.split('/').filter(Boolean);
    if (pathParts.length) name += '-' + pathParts[pathParts.length - 1];
  } catch {
    name = 'query-' + args.url.slice(0, 30).replace(/[^a-zA-Z0-9]/g, '-');
  }

  // Avoid .md extensions causing confusion — always use explicit ext
  name = name.replace(/\.\w+$/, '') + ext;

  const dateDir = resolve(ROOT, OUTPUT_DIR, DEFAULT_DATE_DIR);
  const outPath = resolve(dateDir, name);

  // Handle duplicates
  if (existsSync(outPath)) {
    const counter = 2;
    const base = outPath.replace(ext, '');
    const candidate = `${base}-${counter}${ext}`;
    while (existsSync(candidate)) {
      counter++;
    }
    return candidate;
  }

  return outPath;
}

/**
 * Fetch from Jina Reader and write to file.
 */
async function fetchAndSave(args) {
  const baseUrl = process.env.JINA_READER_BASE_URL || DEFAULT_BASE_URL;
  const headers = buildHeaders(args);

  let apiUrl, requestBody;

  if (args.search) {
    // Search mode: uses s.jina.ai
    apiUrl = `${process.env.JINA_SEARCH_BASE_URL || 'https://s.jina.ai'}/${encodeURIComponent(args.url)}`;
  } else {
    apiUrl = `${baseUrl}/${args.url}`;
  }

  console.log(`[${args.search ? 'SEARCH' : 'FETCH'}] ${apiUrl}`);
  console.log(`  Format: ${args.outputFormat}`);
  if (args.engine)       console.log(`  Engine: ${args.engine}`);
  if (args.timeout)      console.log(`  Timeout: ${args.timeout}s`);
  if (args.targetSelector) console.log(`  Target: ${args.targetSelector}`);
  console.log();

  const body = args.post && !args.search ? { url: args.url } : undefined;
  const method = body ? 'POST' : 'GET';

  const res = await fetch(apiUrl, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '(no body)');
    console.error(`HTTP ${res.status}: ${errBody.slice(0, 500)}`);
    exit(1);
  }

  const content = await res.text();

  if (content.length === 0) {
    console.error('Response is empty.');
    exit(1);
  }

  // Auto-detect content type from headers or fall back to args
  let contentType = args.outputFormat;
  if (res.headers.get('content-type')?.includes('json')) {
    contentType = 'json';
  }

  const outPath = resolveOutPath(args, content);
  mkdirSync(resolve(outPath, '..'), { recursive: true });

  createWriteStream(outPath).end(content, 'utf8');

  console.log(`✅ Saved ${content.length.toLocaleString()} bytes → ${outPath}`);

  // Quick preview
  const preview = content.slice(0, 600);
  console.log(`\n--- Preview ---`);
  console.log(preview + (content.length > 600 ? '…' : ''));
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.url) {
    console.error('Error: URL or search query is required.');
    printUsage();
    exit(1);
  }

  if (args.search && args.outputFormat !== 'markdown') {
    console.warn('Warning: --format is ignored in search mode (always returns markdown).');
    args.outputFormat = 'markdown';
  }

  await fetchAndSave(args);
}

main().catch(err => {
  console.error('❌', err.message);
  exit(1);
});
