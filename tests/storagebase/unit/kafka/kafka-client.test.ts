import { describe, expect, test } from "bun:test";
import {
  createKafkaWire,
  forkKafkaBrokers,
  forkKafkaConnectionOptions,
  loadForkKafka,
} from "@/storagebase/resources/providers/messaging/kafka-client";
import { ResourceConfigError } from "@/storagebase/resources/errors";
import { fakeLibrary, fakeWire, fakeWireState } from "./fake-wire";

describe("forkKafkaBrokers", () => {
  test("splits a multi-broker bootstrap list and keeps default ports", () => {
    expect(forkKafkaBrokers({ endpoint: "b1:9092, b2:9093, b3" })).toEqual([
      { host: "b1", port: 9092 },
      { host: "b2", port: 9093 },
      { host: "b3", port: 9092 },
    ]);
  });

  test("accepts bracketed IPv6 and host + port", () => {
    expect(forkKafkaBrokers({ endpoint: "[::1]:9092" })).toEqual([{ host: "::1", port: 9092 }]);
    expect(forkKafkaBrokers({ host: "localhost", port: 9093 })).toEqual([{ host: "localhost", port: 9093 }]);
    expect(forkKafkaBrokers({ host: "localhost" })).toEqual([{ host: "localhost", port: 9092 }]);
  });

  test("refuses empty, malformed and wrongly typed addresses", () => {
    expect(() => forkKafkaBrokers({ endpoint: " " })).toThrow(ResourceConfigError);
    expect(() => forkKafkaBrokers({ endpoint: "b1:bad" })).toThrow(ResourceConfigError);
    expect(() => forkKafkaBrokers({ endpoint: "[::1]:70000" })).toThrow(ResourceConfigError);
    expect(() => forkKafkaBrokers({ endpoint: "a:b:c" })).toThrow(ResourceConfigError);
    expect(() => forkKafkaBrokers({ endpoint: ":9092" })).toThrow(ResourceConfigError);
    expect(() => forkKafkaBrokers({ host: "", port: 9092 })).toThrow(ResourceConfigError);
    expect(() => forkKafkaBrokers({ host: "b", port: "9092" as unknown as number })).toThrow(ResourceConfigError);
    expect(() => forkKafkaBrokers({ host: 9 as unknown as string })).toThrow(ResourceConfigError);
  });
});

describe("forkKafkaConnectionOptions", () => {
  test("maps TLS modes and a CA/cert/key panel", () => {
    expect(forkKafkaConnectionOptions({ host: "b", ssl: { mode: "disable" } }).tls).toBeUndefined();
    const opts = forkKafkaConnectionOptions({
      host: "b",
      ssl: { mode: "verify-full", caCert: "ca", clientCert: "cert", clientKey: "key", rejectUnauthorized: false },
    });
    expect(opts.tls).toEqual({ ca: "ca", cert: "cert", key: "key", rejectUnauthorized: false });
    expect(forkKafkaConnectionOptions({ host: "b", ssl: { mode: "require" } }).tls?.rejectUnauthorized).toBe(false);
    expect(forkKafkaConnectionOptions({ host: "b", ssl: {} as never }).tls?.rejectUnauthorized).toBe(true);
  });

  test("maps PLAIN, SCRAM and OAUTHBEARER over TLS", () => {
    for (const mechanism of ["PLAIN", "SCRAM-SHA-256", "SCRAM-SHA-512", "OAUTHBEARER"] as const) {
      const opts = forkKafkaConnectionOptions({
        host: "b",
        ssl: { mode: "require" },
        saslMechanism: mechanism,
        user: "u",
        password: "p",
      });
      expect(opts.sasl).toEqual({ mechanism, username: "u", password: "p" });
    }
    const token = forkKafkaConnectionOptions({
      host: "b",
      ssl: { mode: "require" },
      saslMechanism: "OAUTHBEARER",
      token: "jwt",
    });
    expect(token.sasl?.password).toBe("jwt");
  });

  test("refuses SASL without TLS, unknown mechanisms, credential line breaks and bare credentials", () => {
    expect(() => forkKafkaConnectionOptions({ host: "b", saslMechanism: "PLAIN", user: "u", password: "p" })).toThrow(
      "requires TLS",
    );
    expect(() => forkKafkaConnectionOptions({ host: "b", ssl: { mode: "require" }, saslMechanism: "MD5" })).toThrow(
      "SASL mechanism",
    );
    expect(() =>
      forkKafkaConnectionOptions({
        host: "b",
        ssl: { mode: "require" },
        saslMechanism: "PLAIN",
        user: "a\nb",
        password: "p",
      }),
    ).toThrow("line break");
    expect(() => forkKafkaConnectionOptions({ host: "b", user: "u" })).toThrow("needs a SASL mechanism");
    expect(() => forkKafkaConnectionOptions({ host: "b", ssl: { mode: "other" } as never })).toThrow("ssl.mode");
    expect(() => forkKafkaConnectionOptions({ host: "b", ssl: [] as never })).toThrow(ResourceConfigError);
    expect(() => forkKafkaConnectionOptions({ host: "b", ssl: { rejectUnauthorized: "yes" } as never })).toThrow(
      ResourceConfigError,
    );
    expect(() => forkKafkaConnectionOptions({ host: "b", ssl: { caCert: 1 } as never })).toThrow(ResourceConfigError);
    expect(() =>
      forkKafkaConnectionOptions({ host: "b", saslMechanism: 1 as never, ssl: { mode: "require" } }),
    ).toThrow(ResourceConfigError);
  });

  test("carries client id and timeout through", () => {
    const opts = forkKafkaConnectionOptions({ endpoint: "b:9092" }, 1234);
    expect(opts.clientId).toBe("storagebase-studio");
    expect(opts.timeoutMs).toBe(1234);
  });
});

describe("loadForkKafka", () => {
  test("uses an injected loader and the real default loader", async () => {
    const fake = fakeLibrary(fakeWireState());
    expect(await loadForkKafka(async () => fake)).toBe(fake);
    // The default branch imports the real package (no socket) and mutes its protocol log.
    const real = await loadForkKafka();
    expect(typeof real.Admin).toBe("function");
    expect(typeof real.Producer).toBe("function");
    expect(typeof real.Consumer).toBe("function");
  });
});

describe("createKafkaWire", () => {
  test("builds writable clients with TLS/SNI, SASL and timeouts", async () => {
    let seen: object[] = [];
    const state = fakeWireState();
    const { admin, producer, consumer } = fakeWire(state);
    const lib = {
      Admin: class {
        constructor(o: object) {
          seen.push(o);
          return admin;
        }
      },
      Producer: class {
        constructor(o: object) {
          seen.push(o);
          return producer;
        }
      },
      Consumer: class {
        constructor(o: object) {
          seen.push(o);
          return consumer;
        }
      },
    };
    const wire = createKafkaWire(
      forkKafkaConnectionOptions(
        {
          endpoint: "b1:9092,b2:9093",
          ssl: { mode: "require" },
          saslMechanism: "PLAIN",
          user: "u",
          password: "p",
        },
        999,
      ),
      lib as never,
    );
    expect(wire.admin).toBe(admin);
    expect(seen[0]).toMatchObject({
      clientId: "storagebase-studio",
      bootstrapBrokers: [
        { host: "b1", port: 9092 },
        { host: "b2", port: 9093 },
      ],
      connectTimeout: 999,
      tlsServerName: true,
    });
    expect((seen[0] as { sasl: object }).sasl).toBeDefined();
    const peek = wire.newConsumer("peek");
    expect(peek).toBeDefined();
    expect(seen[2]).toMatchObject({ groupId: "peek", autocommit: false });
    await wire.close();
  });

  test("omits TLS and SASL options when neither is configured", async () => {
    const { admin, producer, consumer } = fakeWire(fakeWireState());
    let seen: object = {};
    const wire = createKafkaWire(forkKafkaConnectionOptions({ host: "b" }), {
      Admin: class {
        constructor(o: object) {
          seen = o;
          return admin;
        }
      } as never,
      Producer: class {
        constructor() {
          return producer;
        }
      } as never,
      Consumer: class {
        constructor() {
          return consumer;
        }
      } as never,
    });
    expect(seen).not.toHaveProperty("tls");
    expect(seen).not.toHaveProperty("sasl");
    await wire.close();
  });
});
