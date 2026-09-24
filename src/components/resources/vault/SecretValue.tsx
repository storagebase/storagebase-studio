"use client";

import { useState } from "react";
import { Copy, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { ResourceConnection } from "@/lib/resources/types";
import type { VaultSecretReveal } from "@/lib/resources/operations";
import { errorText } from "../kafka/kafka-api";
import { ErrorLine } from "../kafka/parts";
import { postVault } from "./vault-api";

/**
 * A secret's value, masked until asked for. Nothing about the value is known
 * before Reveal — not its length, not its last characters — because nothing
 * about it has been fetched: Reveal is the one call to the reveal route, and
 * Hide drops the value from state rather than covering it. Copy exists only
 * while the value is revealed.
 */
export function SecretValue({
  connection,
  name,
  version,
}: {
  connection: ResourceConnection;
  name: string;
  version?: string;
}) {
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reveal = async () => {
    setBusy(true);
    setError(null);
    try {
      const revealed = await postVault<VaultSecretReveal>(connection, "secret/reveal", {
        name,
        ...(version === undefined ? {} : { version }),
      });
      setValue(revealed.value);
    } catch (revealError) {
      setError(errorText(revealError));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value as string);
      toast.success("Copied");
    } catch (copyError) {
      toast.error(`Could not copy: ${errorText(copyError)}`);
    }
  };

  return (
    <div data-testid="vault-secret-value" className="space-y-2">
      <div className="rounded-md border border-hairline bg-sunken px-3 py-2 min-h-9 font-mono text-xs break-all">
        {value === null ? <span className="text-fg-subtle italic">Value hidden</span> : value}
      </div>
      <div className="flex gap-2">
        {value === null ? (
          <Button variant="outline" size="sm" className="text-xs" disabled={busy} onClick={() => void reveal()}>
            <Eye strokeWidth={1.5} className="w-3.5 h-3.5 mr-1.5" />
            Reveal
          </Button>
        ) : (
          <>
            <Button variant="outline" size="sm" className="text-xs" onClick={() => setValue(null)}>
              <EyeOff strokeWidth={1.5} className="w-3.5 h-3.5 mr-1.5" />
              Hide
            </Button>
            <Button variant="outline" size="sm" className="text-xs" onClick={() => void copy()}>
              <Copy strokeWidth={1.5} className="w-3.5 h-3.5 mr-1.5" />
              Copy
            </Button>
          </>
        )}
      </div>
      <ErrorLine error={error} />
    </div>
  );
}
