import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

export interface GlossaryTerm {
  term: string;
  aliases: string[];
  simpleZh: string;
}
export interface BannedConfig { banned: string[]; }
export interface CompliancePhrase {
  id: string;
  text: string;
  placement: "opening" | "closing" | "always-on";
  strictExact?: boolean;
  keywords?: string[];
}
export interface ComplianceConfig { phrases: CompliancePhrase[]; }
export interface GlossaryConfig { terms: GlossaryTerm[]; }

const DEFAULT_ROOT = path.resolve(process.cwd(), "config");

function load<T>(file: string, root = DEFAULT_ROOT): T {
  const p = path.join(root, file);
  const raw = fs.readFileSync(p, "utf8");
  return parseYaml(raw) as T;
}

let cache: {
  glossary?: GlossaryConfig;
  banned?: BannedConfig;
  compliance?: ComplianceConfig;
} = {};

export function loadGlossary(root?: string): GlossaryConfig {
  if (cache.glossary) return cache.glossary;
  cache.glossary = load<GlossaryConfig>("glossary.yaml", root);
  return cache.glossary;
}

export function loadBanned(root?: string): BannedConfig {
  if (cache.banned) return cache.banned;
  cache.banned = load<BannedConfig>("banned-terms.yaml", root);
  return cache.banned;
}

export function loadCompliance(root?: string): ComplianceConfig {
  if (cache.compliance) return cache.compliance;
  cache.compliance = load<ComplianceConfig>("compliance-phrases.yaml", root);
  return cache.compliance;
}

export function clearConfigCache(): void {
  cache = {};
}

// Lookup helpers
export function findTerm(input: string): GlossaryTerm | undefined {
  const g = loadGlossary();
  return g.terms.find(t =>
    t.term === input || t.aliases.includes(input),
  );
}

export function allBannedRegex(): RegExp {
  const b = loadBanned();
  const escaped = b.banned.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(${escaped.join("|")})`, "g");
}

export function compliancePhrasesByPlacement(
  placement: CompliancePhrase["placement"],
): CompliancePhrase[] {
  return loadCompliance().phrases.filter(p => p.placement === placement);
}
