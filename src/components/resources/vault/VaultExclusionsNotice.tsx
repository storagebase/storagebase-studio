"use client";

import { useCallback } from "react";
import Link from "next/link";
import { ShieldOff } from "lucide-react";
import { resourceConnectionBody } from "@/lib/resources/connection-body";
import type { ResourceConnection } from "@/lib/resources/types";
import { ErrorLine } from "../kafka/parts";
import { useKafkaRead } from "../kafka/use-kafka-read";
import { sendJson } from "./vault-api";

/**
 * Admin-only, read-only: how many exclusion rules apply to this vault. The
 * server decides it from the connection it resolves (never an address this
 * browser computes), and the rules themselves are managed in Admin > Access >
 * Vault exclusions.
 */
export function VaultExclusionsNotice({ connection }: { connection: ResourceConnection }) {
  const read = useCallback(
    () =>
      sendJson<{ applicableRules: number }>(
        "/api/resources/admin/vault-exclusions/applicable",
        "POST",
        resourceConnectionBody(connection),
      ),
    [connection],
  );
  const { data, error } = useKafkaRead(read);
  if (error !== null) return <ErrorLine error={error} />;
  if (data === null) return null;
  const count = data.applicableRules;
  return (
    <p data-testid="vault-exclusions-notice" className="flex items-center gap-1.5 text-xs text-fg-subtle">
      <ShieldOff strokeWidth={1.5} className="w-3.5 h-3.5" />
      {count === 0
        ? "No exclusion rules apply"
        : count === 1
          ? "1 exclusion rule applies"
          : `${count} exclusion rules apply`}{" "}
      to this vault — manage them in{" "}
      <Link href="/admin/access?tab=vault-exclusions" className="underline hover:text-fg">
        Admin › Access
      </Link>
      .
    </p>
  );
}
