/**
 * The Redis key browser's client-side search and shaping (StorageBase fork). Pure functions, so
 * the component stays a view and 50,000 keys filter in one pass per keystroke.
 */

export type FilterMode = "substring" | "glob" | "regex";

export type KeyMatcher =
  | {
      readonly ok: true;
      readonly empty: boolean;
      readonly test: (key: string) => boolean;
      readonly ranges: (key: string) => Array<[number, number]>;
    }
  | { readonly ok: false; readonly error: string };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A Redis-style glob as a regular expression: `*` any run, `?` one character, `[...]` a class
 * (`[^...]` negated), `\x` a literal x. Anchored, as Redis anchors MATCH.
 */
export function globToRegExpSource(glob: string): string {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else if (char === "\\" && index + 1 < glob.length) {
      index += 1;
      source += escapeRegExp(glob[index]);
    } else if (char === "[") {
      const close = glob.indexOf("]", index + 2);
      if (close === -1) {
        source += "\\[";
        continue;
      }
      let body = glob.slice(index + 1, close);
      const negated = body.startsWith("^");
      if (negated) body = body.slice(1);
      source += `[${negated ? "^" : ""}${body.replace(/[\\\]]/g, "\\$&")}]`;
      index = close;
    } else source += escapeRegExp(char);
  }
  return `^${source}$`;
}

function everyMatch(regex: RegExp, key: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  regex.lastIndex = 0;
  let found = regex.exec(key);
  while (found !== null) {
    if (found[0].length === 0) {
      regex.lastIndex += 1;
    } else {
      ranges.push([found.index, found.index + found[0].length]);
    }
    found = regex.exec(key);
  }
  return ranges;
}

/**
 * Compiles the search box into a matcher. Substring is the default; glob matches the whole key the
 * way Redis MATCH does; regex is unanchored and validated here, so an invalid pattern is reported
 * rather than thrown. Case-insensitive unless asked otherwise.
 */
export function compileKeyMatcher(query: string, mode: FilterMode, caseSensitive: boolean): KeyMatcher {
  const flags = caseSensitive ? "" : "i";
  if (query === "") return { ok: true, empty: true, test: () => true, ranges: () => [] };

  if (mode === "substring") {
    const needle = caseSensitive ? query : query.toLowerCase();
    const fold = (key: string) => (caseSensitive ? key : key.toLowerCase());
    return {
      ok: true,
      empty: false,
      test: (key) => fold(key).includes(needle),
      ranges: (key) => {
        const haystack = fold(key);
        const ranges: Array<[number, number]> = [];
        let at = haystack.indexOf(needle);
        while (at !== -1) {
          ranges.push([at, at + needle.length]);
          at = haystack.indexOf(needle, at + needle.length);
        }
        return ranges;
      },
    };
  }

  let source: string;
  if (mode === "glob") source = globToRegExpSource(query);
  else source = query;

  let regex: RegExp;
  try {
    regex = new RegExp(source, flags);
  } catch (error) {
    return { ok: false, error: `Invalid pattern: ${(error as Error).message}` };
  }
  const global = new RegExp(source, `${flags}g`);
  return {
    ok: true,
    empty: false,
    test: (key) => regex.test(key),
    // A glob matches the whole key, so the whole key is its highlight.
    ranges: (key) => (mode === "glob" ? [[0, key.length]] : everyMatch(global, key)),
  };
}

/** A key split into plain and highlighted runs, for rendering. */
export function highlightSegments(
  key: string,
  ranges: ReadonlyArray<[number, number]>,
): Array<{ text: string; hit: boolean }> {
  const segments: Array<{ text: string; hit: boolean }> = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) segments.push({ text: key.slice(at, start), hit: false });
    segments.push({ text: key.slice(start, end), hit: true });
    at = end;
  }
  if (at < key.length || segments.length === 0) segments.push({ text: key.slice(at), hit: false });
  return segments;
}

export const PREFIX_DELIMITER = ":";

export type BrowserRow =
  | {
      readonly kind: "group";
      readonly id: string;
      readonly prefix: string;
      readonly count: number;
      readonly depth: number;
      readonly open: boolean;
    }
  | { readonly kind: "key"; readonly id: string; readonly key: string; readonly label: string; readonly depth: number };

interface PrefixNode {
  readonly children: Map<string, PrefixNode>;
  readonly keys: string[];
  count: number;
}

function newNode(): PrefixNode {
  return { children: new Map(), keys: [], count: 0 };
}

/**
 * Keys as a tree of `:`-delimited prefixes, flattened to the rows the open groups show. A key
 * `user:1:name` sits under `user:` then `user:1:`; a key with no delimiter sits at the top. Group
 * ids are the prefix itself, so the open set survives new keys arriving. `"all"` opens every group,
 * which is what a search wants: a match inside a closed group would otherwise be invisible.
 */
export function groupRows(keys: readonly string[], open: ReadonlySet<string> | "all"): BrowserRow[] {
  const root = newNode();
  for (const key of keys) {
    const parts = key.split(PREFIX_DELIMITER);
    let node = root;
    for (let depth = 0; depth < parts.length - 1; depth += 1) {
      const name = parts[depth];
      let child = node.children.get(name);
      if (child === undefined) {
        child = newNode();
        node.children.set(name, child);
      }
      child.count += 1;
      node = child;
    }
    node.keys.push(key);
  }

  const rows: BrowserRow[] = [];
  const walk = (node: PrefixNode, prefix: string, depth: number) => {
    const names = [...node.children.keys()].sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const child = node.children.get(name) as PrefixNode;
      const childPrefix = `${prefix}${name}${PREFIX_DELIMITER}`;
      const isOpen = open === "all" || open.has(childPrefix);
      rows.push({
        kind: "group",
        id: `g:${childPrefix}`,
        prefix: childPrefix,
        count: child.count,
        depth,
        open: isOpen,
      });
      if (isOpen) walk(child, childPrefix, depth + 1);
    }
    const sorted = [...node.keys].sort((a, b) => a.localeCompare(b));
    for (const key of sorted) {
      rows.push({ kind: "key", id: `k:${key}`, key, label: key.slice(prefix.length), depth });
    }
  };
  walk(root, "", 0);
  return rows;
}

/** Keys as a flat, sorted list of rows. */
export function flatRows(keys: readonly string[]): BrowserRow[] {
  return [...keys]
    .sort((a, b) => a.localeCompare(b))
    .map((key) => ({ kind: "key", id: `k:${key}`, key, label: key, depth: 0 }));
}

/** Whether an argument survives the provider's plain-command tokenizer (redis.md §5.3). */
function plainSafe(value: string): boolean {
  return !/["'\\\n]/.test(value);
}

/** One command in the plain form when it round-trips, otherwise the lossless JSON form. */
export function renderCommand(parts: readonly string[]): string {
  if (parts.every(plainSafe))
    return parts.map((part) => (/\s/.test(part) || part === "" ? `"${part}"` : part)).join(" ");
  return JSON.stringify({ command: parts[0], args: parts.slice(1) });
}

/**
 * The read command a click runs for a key of this type. BOUNDED where the tree's readers are not
 * (redis.md §5.3 reads a whole list or set): a key found by search can be arbitrarily large, so a
 * list, set, sorted set or stream reads its first 100 members. A hash keeps HGETALL, whose reply
 * the grid shapes as field/value rows. An unknown type asks TYPE rather than guessing a reader,
 * which would answer WRONGTYPE.
 */
export function readerCommand(key: string, type: string | undefined): string {
  switch (type) {
    case "string":
      return renderCommand(["GET", key]);
    case "hash":
      return renderCommand(["HGETALL", key]);
    case "list":
      return renderCommand(["LRANGE", key, "0", "99"]);
    case "set":
      return renderCommand(["SSCAN", key, "0", "COUNT", "100"]);
    case "zset":
      return renderCommand(["ZRANGE", key, "0", "99", "WITHSCORES"]);
    case "stream":
      return renderCommand(["XRANGE", key, "-", "+", "COUNT", "100"]);
    default:
      return renderCommand(["TYPE", key]);
  }
}

/** Glob metacharacters escaped, for a server-side MATCH that must find this text literally. */
export function escapeGlob(value: string): string {
  return value.replace(/[\\*?[\]^]/g, "\\$&");
}

/** The MATCH pattern "Search on server" sends for what is in the search box. */
export function serverPattern(query: string, mode: FilterMode): string | null {
  if (query === "") return null;
  if (mode === "glob") return query;
  if (mode === "substring") return `*${escapeGlob(query)}*`;
  // A regular expression has no MATCH equivalent; the server walk is unfiltered and the regex
  // then filters what comes back.
  return null;
}

/** "1.2 KB" style byte count. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** TTL as the browser shows it. */
export function formatTtl(ttl: number | null): string {
  if (ttl === null) return "";
  if (ttl === -1) return "no expiry";
  if (ttl === -2) return "gone";
  if (ttl < 60) return `${ttl}s`;
  if (ttl < 3600) return `${Math.floor(ttl / 60)}m`;
  if (ttl < 86_400) return `${Math.floor(ttl / 3600)}h`;
  return `${Math.floor(ttl / 86_400)}d`;
}
