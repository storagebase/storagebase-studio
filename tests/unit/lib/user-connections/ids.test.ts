import { describe, expect, test } from "bun:test";
import {
  isServerHeld,
  parseUserConnectionId,
  userConnectionId,
  USER_CONNECTION_PREFIX,
} from "@/lib/user-connections/ids";

describe("user connection ids", () => {
  test("round-trip, and only the user prefix parses", () => {
    expect(userConnectionId("abc")).toBe(`${USER_CONNECTION_PREFIX}abc`);
    expect(parseUserConnectionId(`${USER_CONNECTION_PREFIX}abc`)).toBe("abc");
    expect(parseUserConnectionId(USER_CONNECTION_PREFIX)).toBeNull();
    expect(parseUserConnectionId("seed:abc")).toBeNull();
    expect(parseUserConnectionId(42)).toBeNull();
  });

  test("a connection is server-held exactly when it carries the savedSecrets list", () => {
    expect(isServerHeld({ savedSecrets: [] })).toBe(true);
    expect(isServerHeld({ savedSecrets: ["password"] })).toBe(true);
    expect(isServerHeld({})).toBe(false);
    expect(isServerHeld({ savedSecrets: "password" })).toBe(false);
  });
});
