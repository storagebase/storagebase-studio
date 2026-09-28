import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { appFetch } from "@/lib/config/base-path";

/**
 * The admin access API from the browser (StorageBase fork): one JSON call that answers the parsed
 * body, or throws the server's own sentence. Every route under /api/admin/access answers failures
 * as `{ error }` (src/lib/api/errors.ts), so that sentence is what the toast shows.
 */
export async function accessRequest<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await appFetch(path, {
    method: init.method ?? "GET",
    ...(init.body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.body) }),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/** The sentence an unknown rejection is shown as. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A select, styled like the product's inputs; native so it is keyboard- and test-friendly. */
export const SELECT_CLASS =
  "h-9 w-full rounded-md border border-hairline-strong bg-transparent px-3 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40";

export const PANEL_CLASS = "rounded-xl border border-hairline bg-panel p-5 space-y-4";

/**
 * One admin access GET, read on mount and again on `reload()`. A reload is an event that asks for
 * a new synchronization (the OverviewTab pattern): the path and the refresh count travel together
 * as the value the effect synchronizes against, and a response that lost the race is dropped.
 */
export function useAccessData<T>(path: string): { data: T | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [refreshCount, setRefreshCount] = useState(0);
  const request = useMemo(() => ({ path, refreshCount }), [path, refreshCount]);

  useEffect(() => {
    let ignore = false;
    async function run() {
      try {
        const next = await accessRequest<T>(request.path);
        if (!ignore) setData(next);
      } catch (error) {
        if (!ignore) toast.error(errorText(error));
      }
    }
    void run();
    return () => {
      ignore = true;
    };
  }, [request]);

  const reload = useCallback(() => setRefreshCount((count) => count + 1), []);
  return { data, reload };
}
