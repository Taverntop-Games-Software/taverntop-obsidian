/**
 * Minimal, dependency-free YAML frontmatter read/write.
 *
 * Obsidian ships js-yaml internally but does not export it, and we deliberately
 * avoid pulling a YAML dependency into the bundle. Our frontmatter is a flat map of
 * scalars and string arrays (that is all the vault model uses), so a small, honest
 * serializer/parser covers it. If the model ever needs nested YAML, swap this for a
 * real parser behind the same two functions.
 */

export type FrontmatterValue = string | number | boolean | null | string[];
export type Frontmatter = Record<string, FrontmatterValue>;

export interface ParsedNote {
  frontmatter: Frontmatter;
  body: string;
}

const FENCE = "---";

export function parseNote(content: string): ParsedNote {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith(FENCE + "\n")) {
    return { frontmatter: {}, body: content };
  }
  const end = normalized.indexOf("\n" + FENCE, FENCE.length);
  if (end === -1) return { frontmatter: {}, body: content };

  const yaml = normalized.slice(FENCE.length + 1, end);
  const body = normalized.slice(end + 1 + FENCE.length + 1); // skip closing fence + newline
  return { frontmatter: parseYaml(yaml), body: body.replace(/^\n/, "") };
}

export function serializeNote(frontmatter: Frontmatter, body: string): string {
  const yaml = serializeYaml(frontmatter);
  return `${FENCE}\n${yaml}${FENCE}\n\n${body.replace(/^\n+/, "")}`;
}

// --- tiny YAML (flat scalars + string arrays only) -------------------------

function parseYaml(yaml: string): Frontmatter {
  const out: Frontmatter = {};
  const lines = yaml.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;

    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const rawValue = line.slice(colon + 1).trim();

    if (rawValue === "") {
      // Could be a block list: subsequent `  - item` lines.
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
        items.push(unquote(lines[++i].replace(/^\s*-\s+/, "").trim()));
      }
      out[key] = items;
    } else if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      out[key] = parseFlowList(rawValue);
    } else {
      out[key] = coerceScalar(rawValue);
    }
  }
  return out;
}

function parseFlowList(raw: string): string[] {
  const inner = raw.slice(1, -1).trim();
  if (!inner) return [];
  // Split on commas not inside quotes.
  const parts = inner.match(/(?:[^,"]+|"[^"]*")+/g) ?? [];
  return parts.map((p) => unquote(p.trim()));
}

function coerceScalar(v: string): FrontmatterValue {
  const unq = unquote(v);
  if (unq !== v) return unq; // was quoted → always a string
  if (v === "null" || v === "~") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\"/g, '"');
  }
  return v;
}

function serializeYaml(fm: Frontmatter): string {
  let out = "";
  for (const [key, value] of Object.entries(fm)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        out += `${key}: []\n`;
      } else {
        out += `${key}:\n`;
        for (const item of value) out += `  - ${quoteIfNeeded(item)}\n`;
      }
    } else if (value === null) {
      out += `${key}: null\n`;
    } else if (typeof value === "string") {
      out += `${key}: ${quoteIfNeeded(value)}\n`;
    } else {
      out += `${key}: ${value}\n`;
    }
  }
  return out;
}

function quoteIfNeeded(v: string): string {
  // Quote when the string contains YAML-significant characters or would be
  // mis-coerced (e.g. "true", "123", a wikilink with brackets/colons).
  const needs =
    /[:#\[\]{}",]/.test(v) ||
    /^(true|false|null|~)$/.test(v) ||
    /^-?\d+(\.\d+)?$/.test(v) ||
    v.trim() !== v ||
    v === "";
  return needs ? `"${v.replace(/"/g, '\\"')}"` : v;
}
