import { describe, test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  RESOURCE_ROUTE_PERMISSIONS,
  RESOURCE_PERMISSIONS,
  permits,
  permissionRank,
  resourceRoutePermission,
} from "@/storagebase/resources/permissions";
import type { ResourcePermission } from "@/storagebase/resources/types";

/**
 * The permission vocabulary the fork's seeded connections grant (ported from
 * the legacy access model's enforcement cases): what a `read` grant may run,
 * what each route needs, and that the table and the fork route tree name
 * exactly the same routes.
 */

describe("permission ranks", () => {
  test("rank order is read < write < admin", () => {
    expect(RESOURCE_PERMISSIONS.map(permissionRank)).toEqual([0, 1, 2]);
  });

  test("permits is exactly rank(granted) >= rank(required) for all nine pairs", () => {
    for (const granted of RESOURCE_PERMISSIONS) {
      for (const required of RESOURCE_PERMISSIONS) {
        expect(permits(granted, required)).toBe(permissionRank(granted) >= permissionRank(required));
      }
    }
    expect(permits("read", "write")).toBe(false);
    expect(permits("admin", "read")).toBe(true);
  });

  test("every permission level against each class of route, through the table the routes read", () => {
    const cases: Array<[ResourcePermission, string, boolean]> = [
      ["read", "api/sb/resources/tree", true],
      ["read", "api/sb/vault/secret/save", false],
      ["write", "api/sb/vault/secret/save", true],
      ["write", "api/sb/vault/deleted/purge", false],
      ["admin", "api/sb/vault/deleted/purge", true],
      ["write", "api/sb/resources/unmapped", false],
    ];
    for (const [granted, route, allowed] of cases) {
      expect(permits(granted, resourceRoutePermission(route))).toBe(allowed);
    }
  });

  test("an unmapped route needs admin: a new route is closed until someone classifies it", () => {
    expect(resourceRoutePermission("api/sb/resources/something-new")).toBe("admin");
    expect(resourceRoutePermission("api/sb/resources/blob/download")).toBe("admin");
    expect(resourceRoutePermission("api/sb/resources/tree")).toBe("read");
    expect(resourceRoutePermission("api/sb/vault/secret/save")).toBe("write");
    expect(resourceRoutePermission("api/sb/vault/deleted/purge")).toBe("admin");
  });
});

describe("the table and the fork route tree name exactly the same routes", () => {
  const root = join(import.meta.dir, "..", "..", "..", "..", "src", "app", "api", "sb");
  // Tolerant of a wrapped request argument (the multipart route passes a
  // Proxy around `req`): match up to the route-name string whatever sits
  // between the call's parens.
  const routeNamePattern = /handleResourceRequest\([\s\S]{0,160}?,\s*"(api\/sb\/[^"]+)"/;
  const declared: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === "route.ts" && existsSync(full)) {
        const match = readFileSync(full, "utf8").match(routeNamePattern);
        if (match) declared.push(match[1]);
      }
    }
  };
  walk(root);

  test("every handleResourceRequest caller is classified, and every row names one", () => {
    expect(declared.length).toBeGreaterThanOrEqual(4);
    expect([...declared].sort()).toEqual([...Object.keys(RESOURCE_ROUTE_PERMISSIONS)].sort());
  });
});
