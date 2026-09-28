import { describe, expect, test } from "bun:test";
import {
  compileKeyMatcher,
  escapeGlob,
  flatRows,
  formatBytes,
  formatTtl,
  globToRegExpSource,
  groupRows,
  highlightSegments,
  PREFIX_DELIMITER,
  readerCommand,
  renderCommand,
  serverPattern,
} from "@/components/redis/key-filter";

function matcher(query: string, mode: "substring" | "glob" | "regex", caseSensitive = false) {
  const compiled = compileKeyMatcher(query, mode, caseSensitive);
  if (!compiled.ok) throw new Error(compiled.error);
  return compiled;
}

describe("compileKeyMatcher", () => {
  test("an empty query matches everything and highlights nothing", () => {
    const m = matcher("", "regex");
    expect(m.empty).toBe(true);
    expect(m.test("anything")).toBe(true);
    expect(m.ranges("anything")).toEqual([]);
  });

  test("substring is case-insensitive by default and highlights every occurrence", () => {
    const m = matcher("ab", "substring");
    expect(m.test("xABy")).toBe(true);
    expect(m.test("xy")).toBe(false);
    expect(m.ranges("abXab")).toEqual([
      [0, 2],
      [3, 5],
    ]);
    expect(matcher("ab", "substring", true).test("xABy")).toBe(false);
  });

  test("glob matches the whole key, as Redis MATCH does", () => {
    const m = matcher("user:*:s?ssion", "glob");
    expect(m.test("user:42:session")).toBe(true);
    expect(m.test("xuser:42:session")).toBe(false);
    expect(m.ranges("user:1:session")).toEqual([[0, 14]]);
    expect(matcher("USER:*", "glob").test("user:1")).toBe(true);
    expect(matcher("USER:*", "glob", true).test("user:1")).toBe(false);
  });

  test("regex is unanchored, validated, and highlights each match", () => {
    const m = matcher("\\d+", "regex");
    expect(m.test("order:12:line:3")).toBe(true);
    expect(m.ranges("order:12:line:3")).toEqual([
      [6, 8],
      [14, 15],
    ]);
    // A zero-width match advances rather than looping forever.
    expect(matcher("x*", "regex").ranges("ab")).toEqual([]);
    const invalid = compileKeyMatcher("(unclosed", "regex", false);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error).toStartWith("Invalid pattern");
  });
});

describe("globToRegExpSource", () => {
  test("classes, negated classes, escapes and an unclosed bracket", () => {
    expect(new RegExp(globToRegExpSource("h[ae]llo")).test("hallo")).toBe(true);
    expect(new RegExp(globToRegExpSource("h[^e]llo")).test("hello")).toBe(false);
    expect(new RegExp(globToRegExpSource("h[^e]llo")).test("hallo")).toBe(true);
    expect(new RegExp(globToRegExpSource("a\\*b")).test("a*b")).toBe(true);
    expect(new RegExp(globToRegExpSource("a\\*b")).test("axb")).toBe(false);
    expect(new RegExp(globToRegExpSource("a[b")).test("a[b")).toBe(true);
    expect(new RegExp(globToRegExpSource("a.b\\")).test("a.b\\")).toBe(true);
    expect(new RegExp(globToRegExpSource("[]]x")).test("]x")).toBe(true);
  });
});

describe("highlightSegments", () => {
  test("splits a key into plain and highlighted runs", () => {
    expect(highlightSegments("abcabc", [[1, 2]])).toEqual([
      { text: "a", hit: false },
      { text: "b", hit: true },
      { text: "cabc", hit: false },
    ]);
    expect(highlightSegments("ab", [[0, 2]])).toEqual([{ text: "ab", hit: true }]);
    expect(highlightSegments("", [])).toEqual([{ text: "", hit: false }]);
  });
});

describe("groupRows and flatRows", () => {
  const keys = ["user:2:name", "user:1:name", "user:1:mail", "counter", "session:x"];

  test("closed groups show their counts; top-level keys sort after groups", () => {
    expect(groupRows(keys, new Set()).map((row) => row.id)).toEqual(["g:session:", "g:user:", "k:counter"]);
    const user = groupRows(keys, new Set()).find((row) => row.id === "g:user:");
    expect(user).toMatchObject({ kind: "group", count: 3, open: false, depth: 0 });
  });

  test("an open group nests its prefixes and keys, labelled without the prefix", () => {
    const rows = groupRows(keys, new Set(["user:", "user:1:"]));
    expect(rows.map((row) => row.id)).toEqual([
      "g:session:",
      "g:user:",
      "g:user:1:",
      "k:user:1:mail",
      "k:user:1:name",
      "g:user:2:",
      "k:counter",
    ]);
    expect(rows.find((row) => row.id === "k:user:1:mail")).toMatchObject({ label: "mail", depth: 2 });
  });

  test('"all" opens every group', () => {
    expect(groupRows(["a:b:c"], "all").map((row) => row.id)).toEqual(["g:a:", "g:a:b:", "k:a:b:c"]);
  });

  test("groups split on the exported prefix delimiter", () => {
    const key = `a${PREFIX_DELIMITER}b`;
    expect(groupRows([key], "all").map((row) => row.id)).toEqual([`g:a${PREFIX_DELIMITER}`, `k:${key}`]);
  });

  test("flat rows are every key, sorted, labelled in full", () => {
    expect(flatRows(["b", "a:1"]).map((row) => (row.kind === "key" ? row.label : ""))).toEqual(["a:1", "b"]);
  });
});

describe("readerCommand", () => {
  test.each([
    ["string", "GET k"],
    ["hash", "HGETALL k"],
    ["list", "LRANGE k 0 99"],
    ["set", "SSCAN k 0 COUNT 100"],
    ["zset", "ZRANGE k 0 99 WITHSCORES"],
    ["stream", "XRANGE k - + COUNT 100"],
    ["none", "TYPE k"],
    [undefined, "TYPE k"],
  ])("%s reads with %s", (type, command) => {
    expect(readerCommand("k", type)).toBe(command);
  });

  test("a key the plain tokenizer cannot round-trip switches to the JSON form", () => {
    expect(readerCommand('say"hi', "string")).toBe('{"command":"GET","args":["say\\"hi"]}');
    expect(renderCommand(["GET", "a b"])).toBe('GET "a b"');
    expect(renderCommand(["GET", ""])).toBe('GET ""');
  });
});

describe("serverPattern", () => {
  test("text escapes into a contains-glob, glob passes through, regex has no server form", () => {
    expect(serverPattern("a*b", "substring")).toBe("*a\\*b*");
    expect(serverPattern("user:*", "glob")).toBe("user:*");
    expect(serverPattern("\\d", "regex")).toBeNull();
    expect(serverPattern("", "glob")).toBeNull();
    expect(escapeGlob("[x]?^\\")).toBe("\\[x\\]\\?\\^\\\\");
  });
});

describe("formatting", () => {
  test("bytes", () => {
    expect(formatBytes(12)).toBe("12 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(3 * 1024 ** 4)).toBe("3072.0 GB");
  });

  test("ttl", () => {
    expect(formatTtl(null)).toBe("");
    expect(formatTtl(-1)).toBe("no expiry");
    expect(formatTtl(-2)).toBe("gone");
    expect(formatTtl(30)).toBe("30s");
    expect(formatTtl(120)).toBe("2m");
    expect(formatTtl(7200)).toBe("2h");
    expect(formatTtl(3 * 86_400)).toBe("3d");
  });
});
