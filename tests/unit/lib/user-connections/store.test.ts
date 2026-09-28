import { describe, expect, test } from "bun:test";
import { encryptSecret, readSecret } from "@/lib/storage/encryption";
import { openSecrets, sealSecrets, secretRecordKind } from "@/lib/user-connections/store";

describe("sealing", () => {
  test("seals plaintext, keeps what already opens, and omits-and-counts what does not", () => {
    const already = encryptSecret("kept");
    const sealed = sealSecrets({ password: "pw", token: already });
    expect(sealed.token).toBe(already);
    expect(readSecret(sealed.password)).toEqual({ kind: "decrypted", value: "pw" });
    const dead = "v1:AAAA:BBBB:CCCC"; // four segments: an envelope claim that cannot open
    const opened = openSecrets({ ...sealed, clientSecret: dead });
    expect(opened.secrets).toEqual({ password: "pw", token: "kept" });
    expect(opened.undecryptable).toBe(1);
  });

  test("the record kind names the family and a digest, never the user name", () => {
    const kind = secretRecordKind("alice@example.com", "resource");
    expect(kind).toMatch(/^user-secrets:resource:[0-9a-f]{40}$/);
    expect(kind).not.toContain("alice");
  });
});
