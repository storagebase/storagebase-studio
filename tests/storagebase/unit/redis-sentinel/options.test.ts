/**
 * The S4 interim's contract, pinned: the grammar `parseSentinelConnectionString` accepts and
 * refuses, the `{}` the seam depends on for everything that is not a Sentinel string, and the
 * options `storagebaseSentinelOptions` hands the upstream redis provider.
 *
 * The behavioural spec is the old fork's Sentinel suite (legacy/0.16-main,
 * tests/integration/db/redis-provider.test.ts), ported to the string that carries the settings
 * here: the node parsing rules (default port, bracketed IPv6, a bad port refused rather than
 * defaulted), the one-secret defaulting of `sentinelPassword`, the bounded retry strategy
 * (200/400/600 ms then give up), and the TLS-covers-both-hops rule. What that suite needed a
 * live Sentinel for — the sentinels naming a master, a failover landing on the promoted
 * replica, the `end` event after the bounded retries run out — is NOT unit-testable and waits
 * for the live fixture in deploy/storagebase/compose.yml.
 *
 * Coverage is a hard gate on this file's subject (STORAGEBASE.md): every refusal line in
 * options.ts is a branch a malformed string can take, and each has a test that takes it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseConnection } from "@/lib/types";
import {
  parseSentinelConnectionString,
  storagebaseSentinelOptions,
  type SentinelConnection,
} from "@/storagebase/redis-sentinel/options";

/** A redis connection with nothing but the required fields, everything else per test. */
function connection(fields: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return { id: "redis-ha", name: "Cache (HA)", type: "redis", createdAt: new Date(), ...fields };
}

describe("parseSentinelConnectionString", () => {
  describe("the grammar", () => {
    test("a full string parses into every part, both passwords kept apart", () => {
      const parsed = parseSentinelConnectionString(
        "redis-sentinel://:redispw@sentinel-0:26379,sentinel-1:26380/2?name=mymaster&sentinelPassword=sentinelpw",
      );
      expect(parsed).toEqual({
        masterName: "mymaster",
        sentinels: [
          { host: "sentinel-0", port: 26379 },
          { host: "sentinel-1", port: 26380 },
        ],
        database: 2,
        password: "redispw",
        sentinelPassword: "sentinelpw",
        tls: false,
      } satisfies SentinelConnection);
    });

    test("the minimum is one node and a master name: the port and both passwords are optional", () => {
      expect(parseSentinelConnectionString("redis-sentinel://sentinel-0?name=mymaster")).toEqual({
        masterName: "mymaster",
        sentinels: [{ host: "sentinel-0", port: 26379 }],
        tls: false,
      });
    });

    test("a node listed without a port takes Sentinel's own default 26379", () => {
      const parsed = parseSentinelConnectionString("redis-sentinel://s0,s1:26380,s2?name=m");
      expect(parsed?.sentinels).toEqual([
        { host: "s0", port: 26379 },
        { host: "s1", port: 26380 },
        { host: "s2", port: 26379 },
      ]);
    });

    test("blank entries and surrounding spaces are tolerated, as the old fork's node list was", () => {
      const parsed = parseSentinelConnectionString("redis-sentinel:// s0:26379 , , s1 ,?name=m");
      expect(parsed?.sentinels).toEqual([
        { host: "s0", port: 26379 },
        { host: "s1", port: 26379 },
      ]);
    });

    test("a bracketed IPv6 node is a host, with or without a port", () => {
      const parsed = parseSentinelConnectionString("redis-sentinel://[::1]:26380,[fe80::1]?name=m");
      expect(parsed?.sentinels).toEqual([
        { host: "::1", port: 26380 },
        { host: "fe80::1", port: 26379 },
      ]);
    });

    test("the whole string is trimmed, and the scheme matches in any letter case", () => {
      for (const text of [
        "  redis-sentinel://s0?name=m  ",
        "Redis-Sentinel://s0?name=m",
        "REDISS-SENTINEL://s0?name=m",
      ]) {
        expect(parseSentinelConnectionString(text)?.masterName).toBe("m");
      }
    });

    test("the secure spelling alone means TLS, checked after the scheme match", () => {
      expect(parseSentinelConnectionString("rediss-sentinel://s0?name=m")?.tls).toBe(true);
      expect(parseSentinelConnectionString("redis-sentinel://s0?name=m")?.tls).toBe(false);
    });

    test("percent-encoded passwords and master names decode, a broken escape stays verbatim", () => {
      const parsed = parseSentinelConnectionString(
        "redis-sentinel://:p%40ss@s0?name=master%20one&sentinelPassword=sp%40x",
      );
      expect(parsed?.password).toBe("p@ss");
      expect(parsed?.masterName).toBe("master one");
      expect(parsed?.sentinelPassword).toBe("sp@x");
      expect(parseSentinelConnectionString("redis-sentinel://:p%zz@ s0 ?name=m")?.password).toBe("p%zz");
    });

    test("the master name is trimmed before use, and /0 is a database like any other", () => {
      expect(parseSentinelConnectionString("redis-sentinel://s0?name=%20m%20")?.masterName).toBe("m");
      expect(parseSentinelConnectionString("redis-sentinel://s0/0?name=m")?.database).toBe(0);
    });

    test("an empty :password@ is no password at all, not an empty one", () => {
      const parsed = parseSentinelConnectionString("redis-sentinel://:@s0?name=m");
      expect(parsed?.password).toBeUndefined();
    });

    test("parameter names match case-insensitively; a duplicate takes the last spelling", () => {
      expect(parseSentinelConnectionString("redis-sentinel://s0?NAME=m&SentinelPassword=sp")).toEqual({
        masterName: "m",
        sentinels: [{ host: "s0", port: 26379 }],
        sentinelPassword: "sp",
        tls: false,
      });
      expect(parseSentinelConnectionString("redis-sentinel://s0?name=a&name=b")?.masterName).toBe("b");
    });
  });

  describe("what is refused", () => {
    test("every other scheme, and nothing at all", () => {
      for (const text of [
        "",
        "   ",
        "redis://s0:6379",
        "rediss://s0:6379",
        "sentinel://s0:26379",
        "redis+sentinel://s0?name=m",
        "redis-sentinel:/s0?name=m",
        "mongodb://s0",
        "://",
      ]) {
        expect(parseSentinelConnectionString(text)).toBeNull();
      }
    });

    test("a fragment, a bare ?, a parameter without =, and a trailing &", () => {
      for (const text of [
        "redis-sentinel://s0?name=m#frag",
        "redis-sentinel://s0?",
        "redis-sentinel://s0?name",
        "redis-sentinel://s0?name=m&",
      ]) {
        expect(parseSentinelConnectionString(text)).toBeNull();
      }
    });

    test("no master name, or one that is empty once trimmed", () => {
      for (const text of [
        "redis-sentinel://s0:26379",
        "redis-sentinel://s0:26379/2",
        "redis-sentinel://s0?sentinelPassword=sp",
        "redis-sentinel://s0?name=",
        "redis-sentinel://s0?name=%20",
      ]) {
        expect(parseSentinelConnectionString(text)).toBeNull();
      }
    });

    test("a query parameter the grammar does not know", () => {
      for (const text of [
        "redis-sentinel://s0?name=m&ssl=true",
        "redis-sentinel://s0?name=m&sentinels=s1",
        "redis-sentinel://s0?master=m",
      ]) {
        expect(parseSentinelConnectionString(text)).toBeNull();
      }
    });

    test("a path that is not a database number", () => {
      for (const text of [
        "redis-sentinel://s0/abc?name=m",
        "redis-sentinel://s0/2/x?name=m",
        "redis-sentinel://s0/2x?name=m",
        "redis-sentinel://s0/?name=m",
      ]) {
        expect(parseSentinelConnectionString(text)).toBeNull();
      }
    });

    test("a node whose port is not a TCP port, or whose host is not an address", () => {
      for (const text of [
        "redis-sentinel://s0:abc?name=m",
        "redis-sentinel://s0:?name=m",
        "redis-sentinel://s0:70000?name=m",
        "redis-sentinel://:26379?name=m",
        "redis-sentinel://::1?name=m",
        "redis-sentinel://s0:1,::1?name=m",
      ]) {
        expect(parseSentinelConnectionString(text)).toBeNull();
      }
    });

    test("a host list with no node at all", () => {
      for (const text of ["redis-sentinel://?name=m", "redis-sentinel:///2?name=m", "redis-sentinel://,,?name=m"]) {
        expect(parseSentinelConnectionString(text)).toBeNull();
      }
    });

    test("a userinfo that is not the :password@ form, or a second unescaped @", () => {
      for (const text of [
        "redis-sentinel://redispw@s0?name=m",
        "redis-sentinel://user:pw@s0?name=m",
        "redis-sentinel://@s0?name=m",
        "redis-sentinel://:a@b@s0?name=m",
      ]) {
        expect(parseSentinelConnectionString(text)).toBeNull();
      }
    });
  });
});

describe("storagebaseSentinelOptions", () => {
  test("a connection with no connectionString answers the empty options the seam needs", () => {
    expect(storagebaseSentinelOptions(connection())).toEqual({});
    expect(storagebaseSentinelOptions(connection({ connectionString: undefined }))).toEqual({});
    expect(storagebaseSentinelOptions(connection({ connectionString: "" }))).toEqual({});
    expect(storagebaseSentinelOptions(connection({ connectionString: "   " }))).toEqual({});
  });

  test("a non-sentinel connection string answers {} too: upstream behaviour stays bit-identical", () => {
    for (const connectionString of [
      "redis://s0:6379",
      "rediss://s0:6379",
      "redis-sentinel",
      "postgresql://user:pw@host/db",
    ]) {
      expect(storagebaseSentinelOptions(connection({ connectionString }))).toEqual({});
    }
  });

  test("a sentinel string answers ioredis's Sentinel options and nothing else", () => {
    const options = storagebaseSentinelOptions(
      connection({
        connectionString: "redis-sentinel://:redispw@s0:26379,s1/2?name=mymaster&sentinelPassword=sentinelpw",
      }),
    );
    expect(options).toMatchObject({
      sentinels: [
        { host: "s0", port: 26379 },
        { host: "s1", port: 26379 },
      ],
      name: "mymaster",
      db: 2,
      password: "redispw",
      sentinelPassword: "sentinelpw",
    });
    expect(typeof options.sentinelRetryStrategy).toBe("function");
    // The seam only adds the Sentinel keys; host and port stay upstream's own, and inert in
    // sentinel mode (ioredis picks its SentinelConnector on `sentinels` alone).
    expect(Object.keys(options).sort()).toEqual(
      ["db", "name", "password", "sentinelPassword", "sentinelRetryStrategy", "sentinels"].sort(),
    );
  });

  test("the sentinels authenticate with the string's password when none of their own is given", () => {
    expect(
      storagebaseSentinelOptions(connection({ connectionString: "redis-sentinel://:redispw@s0?name=m" }))
        .sentinelPassword,
    ).toBe("redispw");
    expect(
      storagebaseSentinelOptions(
        connection({ connectionString: "redis-sentinel://:redispw@s0?name=m&sentinelPassword=sp" }),
      ).sentinelPassword,
    ).toBe("sp");
  });

  test("with no password in the string, the connection's own password field is the one secret", () => {
    expect(
      storagebaseSentinelOptions(connection({ connectionString: "redis-sentinel://s0?name=m", password: "fieldpw" }))
        .sentinelPassword,
    ).toBe("fieldpw");
  });

  test("no password anywhere sends none: the key is absent, never an empty string", () => {
    const options = storagebaseSentinelOptions(connection({ connectionString: "redis-sentinel://s0?name=m" }));
    expect("sentinelPassword" in options).toBe(false);
    expect("password" in options).toBe(false);
  });

  test("a path selects the database at connect; no path leaves the field in charge", () => {
    expect(storagebaseSentinelOptions(connection({ connectionString: "redis-sentinel://s0/3?name=m" })).db).toBe(3);
    expect("db" in storagebaseSentinelOptions(connection({ connectionString: "redis-sentinel://s0?name=m" }))).toBe(
      false,
    );
  });

  test("an unreachable sentinel list is retried a bounded number of times, then given up", () => {
    const options = storagebaseSentinelOptions(connection({ connectionString: "redis-sentinel://s0?name=m" }));
    const strategy = options.sentinelRetryStrategy as (attempt: number) => number | null;
    expect([1, 2, 3].map(strategy)).toEqual([200, 400, 600]);
    expect(strategy(4)).toBeNull();
  });

  test("the secure spelling covers the sentinel hop and the master hop alike", () => {
    const options = storagebaseSentinelOptions(connection({ connectionString: "rediss-sentinel://s0?name=m" }));
    expect(options.tls).toEqual({ rejectUnauthorized: false });
    expect(options.sentinelTLS).toEqual({ rejectUnauthorized: false });
    expect(options.enableTLSForSentinelMode).toBe(true);
    // The same one object, the way the old fork shared one TLS setting across both hops.
    expect(options.tls).toBe(options.sentinelTLS);
  });

  test("the plaintext spelling carries no TLS option at all", () => {
    const options = storagebaseSentinelOptions(connection({ connectionString: "redis-sentinel://s0?name=m" }));
    expect("tls" in options).toBe(false);
    expect("sentinelTLS" in options).toBe(false);
    expect("enableTLSForSentinelMode" in options).toBe(false);
  });

  test("adversarial input never throws: a non-string connectionString answers {}", () => {
    // resolveConnection validates an inline connection's type and name, not this field, so a
    // JS caller can put a non-string here. The seam must answer for it, not the route.
    const forged = (connectionString: unknown) =>
      storagebaseSentinelOptions(connection({ connectionString: connectionString as string }));
    for (const value of [42, null, { length: 4 }, Symbol("sentinel"), ["redis-sentinel://s0?name=m"], new Date()]) {
      expect(forged(value)).toEqual({});
    }
    // Pathological strings parse or refuse, and either way answer an object.
    expect(
      storagebaseSentinelOptions(
        connection({
          connectionString: `redis-sentinel://${"a".repeat(10_000)}?name=${"?".repeat(1_000)}&%&`,
        }),
      ),
    ).toEqual({});
    expect(() =>
      storagebaseSentinelOptions(connection({ connectionString: "redis-sentinel://\u0000\u0007?name=m" })),
    ).not.toThrow();
  });
});

describe("the S4 seam", () => {
  const PROVIDER = join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "..",
    "src",
    "lib",
    "db",
    "providers",
    "keyvalue",
    "redis.ts",
  );

  test("the upstream provider carries the ledgered import and spread, and nothing else of the fork", () => {
    const provider = readFileSync(PROVIDER, "utf8");
    expect(provider).toContain('import { storagebaseSentinelOptions } from "@/storagebase/redis-sentinel/options";');
    expect(provider).toContain("...storagebaseSentinelOptions(this.config),");
    expect(provider.match(/storagebaseSentinelOptions/g)?.length).toBe(2);
  });
});
