"use client";

import { useCallback, useEffect, useState } from "react";
import { errorText } from "./kafka-api";

/**
 * One workbench read with its reload: the mount read writes state only after
 * the request settles (never synchronously in the effect body), and a read
 * superseded by a newer `read` — another topic, another connection — is
 * dropped rather than painted over the newer answer. A failed reload keeps
 * the last good data beside the error.
 */
export function useKafkaRead<T>(read: () => Promise<T>) {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({ data: null, error: null });

  useEffect(() => {
    let cancelled = false;
    read().then(
      (data) => {
        if (!cancelled) setState({ data, error: null });
      },
      (error: unknown) => {
        if (!cancelled) setState((prev) => ({ data: prev.data, error: errorText(error) }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [read]);

  const reload = useCallback(async () => {
    try {
      const data = await read();
      setState({ data, error: null });
    } catch (error) {
      setState((prev) => ({ data: prev.data, error: errorText(error) }));
    }
  }, [read]);

  return { data: state.data, error: state.error, reload };
}
