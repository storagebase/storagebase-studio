import { describe, test, expect } from "bun:test";
import { describeGrant, evaluateAccess, permissionRank, permits, roleKey } from "@/lib/access/permissions";
import { ACCESS_PERMISSIONS, isAccessPermission, isLocalLoginPolicy, type RoleBinding } from "@/lib/access/types";

/**
 * The evaluator's rules, exhaustively: every permission pair for `permits`, every binding shape
 * for the maximum, and the two ways to be refused (no group overlap, no role overlap). Role values
 * here are illustrative examples, never a real tenant's.
 */

function binding(appRoleValue: string, groupId: string, permission: RoleBinding["permission"]): RoleBinding {
  return { id: `${appRoleValue}-${groupId}`, appRoleValue, groupId, permission, createdAt: "t", createdBy: "admin" };
}

const NO_BYPASS = { adminBypass: false };

describe("permission ranks", () => {
  test("rank order is read < write < admin", () => {
    expect(ACCESS_PERMISSIONS.map(permissionRank)).toEqual([0, 1, 2]);
  });

  test("permits is exactly rank(granted) >= rank(required) for all nine pairs", () => {
    for (const granted of ACCESS_PERMISSIONS) {
      for (const required of ACCESS_PERMISSIONS) {
        expect(permits(granted, required)).toBe(permissionRank(granted) >= permissionRank(required));
      }
    }
    expect(permits("read", "write")).toBe(false);
    expect(permits("admin", "read")).toBe(true);
  });

  test("the type guards accept only the declared values", () => {
    expect(isAccessPermission("write")).toBe(true);
    expect(isAccessPermission("owner")).toBe(false);
    expect(isAccessPermission(1)).toBe(false);
    expect(isLocalLoginPolicy("admin-only")).toBe(true);
    expect(isLocalLoginPolicy("off")).toBe(false);
  });

  test("role keys are trimmed and case-folded", () => {
    expect(roleKey("  Team.Payments.Read ")).toBe("team.payments.read");
  });
});

describe("evaluateAccess", () => {
  const bindings = [
    binding("Team.Payments.Read", "payments", "read"),
    binding("Team.Payments.Write", "payments", "write"),
    binding("Team.Ops.Admin", "ops", "admin"),
    binding("Team.Ops.Read", "ops", "read"),
  ];

  test("a subject with no matching role gets nothing", () => {
    expect(evaluateAccess({ role: "user", appRoles: ["Team.Other.Read"] }, ["payments"], bindings, NO_BYPASS)).toBe(
      null,
    );
  });

  test("a matching role on a group the connection is not in gets nothing", () => {
    expect(evaluateAccess({ role: "user", appRoles: ["Team.Ops.Admin"] }, ["payments"], bindings, NO_BYPASS)).toBe(
      null,
    );
  });

  test("a connection in no group is visible to nobody but a bypassing admin", () => {
    expect(evaluateAccess({ role: "user", appRoles: ["Team.Payments.Read"] }, [], bindings, NO_BYPASS)).toBe(null);
    expect(evaluateAccess({ role: "admin", appRoles: [] }, [], bindings, { adminBypass: true })?.via).toBe(
      "admin-bypass",
    );
  });

  test("one matching binding grants its permission and names its role and group", () => {
    expect(
      evaluateAccess({ role: "user", appRoles: ["Team.Payments.Read"] }, ["payments"], bindings, NO_BYPASS),
    ).toEqual({ permission: "read", via: "binding", roles: ["Team.Payments.Read"], groupIds: ["payments"] });
  });

  test("the effective permission is the maximum over every matching binding", () => {
    const grant = evaluateAccess(
      { role: "user", appRoles: ["Team.Payments.Read", "Team.Payments.Write", "Team.Ops.Read"] },
      ["payments", "ops"],
      bindings,
      NO_BYPASS,
    );
    expect(grant).toEqual({
      permission: "write",
      via: "binding",
      roles: ["Team.Payments.Write"],
      groupIds: ["payments"],
    });
  });

  test("ties at the maximum report every winning role and group once", () => {
    const tied = [
      ...bindings,
      binding("Team.Ops.Admin", "payments", "admin"),
      binding("Team.Ops.Admin", "ops", "admin"),
    ];
    const grant = evaluateAccess({ role: "user", appRoles: ["Team.Ops.Admin"] }, ["payments", "ops"], tied, NO_BYPASS);
    expect(grant).toEqual({
      permission: "admin",
      via: "binding",
      roles: ["Team.Ops.Admin"],
      groupIds: ["ops", "payments"],
    });
  });

  test("role values match regardless of case and surrounding space", () => {
    const grant = evaluateAccess(
      { role: "user", appRoles: ["team.payments.read "] },
      ["payments"],
      bindings,
      NO_BYPASS,
    );
    expect(grant?.permission).toBe("read");
  });

  test("the Studio role itself is a bindable value", () => {
    const everyone = [binding("user", "payments", "read")];
    expect(evaluateAccess({ role: "user", appRoles: [] }, ["payments"], everyone, NO_BYPASS)?.permission).toBe("read");
  });

  test("without bypass an admin is evaluated like anyone else", () => {
    expect(evaluateAccess({ role: "admin", appRoles: [] }, ["payments"], bindings, NO_BYPASS)).toBe(null);
  });

  test("with bypass an admin gets admin even where a binding would grant less", () => {
    const grant = evaluateAccess({ role: "admin", appRoles: ["Team.Payments.Read"] }, ["payments"], bindings, {
      adminBypass: true,
    });
    expect(grant).toEqual({ permission: "admin", via: "admin-bypass", roles: [], groupIds: [] });
    expect(evaluateAccess({ role: "user", appRoles: [] }, ["payments"], bindings, { adminBypass: true })).toBe(null);
  });

  test("describeGrant names the bypass or the granting roles", () => {
    expect(describeGrant({ permission: "admin", via: "admin-bypass", roles: [], groupIds: [] })).toBe("admin-bypass");
    expect(describeGrant({ permission: "read", via: "binding", roles: ["A", "B"], groupIds: ["g"] })).toBe("A,B");
  });
});
