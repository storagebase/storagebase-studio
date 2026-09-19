import { describe, test, expect } from "bun:test";
import {
  asBlobOperations,
  asMessagingOperations,
  asVaultOperations,
  type BlobOperations,
  type MessagingOperations,
  type VaultOperations,
} from "@/lib/resources/operations";

describe("family operation narrowing", () => {
  // Partial shapes stand in for full providers: the narrowing helpers read one
  // marker method and nothing else, so a two-method stand-in is the honest
  // fixture rather than a full fake whose other eight methods are decoration.
  const blob = {
    listBuckets: async () => ({ nodes: [], truncated: false }),
    listObjects: async () => ({ nodes: [], truncated: false }),
  } as unknown as BlobOperations;
  const messaging = {
    listDestinations: async () => ({ nodes: [], truncated: false }),
  } as unknown as MessagingOperations;
  const vault = {
    listMounts: async () => ({ nodes: [], truncated: false }),
  } as unknown as VaultOperations;

  test("each marker method narrows its own family and no other", () => {
    expect(asBlobOperations(blob)).toBe(blob);
    expect(asBlobOperations(messaging)).toBeNull();
    expect(asBlobOperations({})).toBeNull();
    expect(asMessagingOperations(messaging)).toBe(messaging);
    expect(asMessagingOperations(vault)).toBeNull();
    expect(asVaultOperations(vault)).toBe(vault);
    expect(asVaultOperations(blob)).toBeNull();
  });
});
