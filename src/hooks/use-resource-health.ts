"use client";

import { useEffect, useState } from "react";
import { appFetch } from "@/lib/config/base-path";
import { resourceConnectionBody } from "@/lib/resources/connection-body";
import type { ResourceConnection, ResourceHealth } from "@/lib/resources/types";

/** A health answer, or the probe still in flight. */
export type ResourceHealthState = ResourceHealth | { status: "checking" };

/**
 * The active connection's status for a section header: one probe of
 * `POST /api/resources/health` per connection shown (a saved edit is a new
 * connection object, so it probes again). A refused or failed probe is an
 * `error` carrying the server's sentence rather than a thrown render.
 *
 * Answers null without a connection. The answer is kept beside the
 * connection it belongs to, so switching connections shows "checking" at
 * once instead of the previous connection's status.
 */
export function useResourceHealth(connection: ResourceConnection | null): ResourceHealthState | null {
  const [answer, setAnswer] = useState<{ connection: ResourceConnection; health: ResourceHealth } | null>(null);

  useEffect(() => {
    if (connection === null) return;
    let cancelled = false;
    probe(connection).then((health) => {
      if (!cancelled) setAnswer({ connection, health });
    });
    return () => {
      cancelled = true;
    };
  }, [connection]);

  if (connection === null) return null;
  return answer?.connection === connection ? answer.health : { status: "checking" };
}

async function probe(connection: ResourceConnection): Promise<ResourceHealth> {
  try {
    const response = await appFetch("/api/resources/health", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(resourceConnectionBody(connection)),
    });
    const body = (await response.json().catch(() => null)) as (ResourceHealth & { error?: string }) | null;
    if (!response.ok || body === null) {
      return { status: "error", message: body?.error ?? `Health check failed (${response.status})` };
    }
    return body;
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}
