"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import { KeyRound } from "lucide-react";
import type { ProviderCapabilities } from "@/lib/db/types";
import { resolveTabType } from "@/lib/editor/tab-language";
import { newLocalId } from "@/lib/ids";
import { sessionDatabase } from "@/lib/redis-keys/scan";
import type { DatabaseConnection, QueryTab } from "@/lib/types";
import { cn } from "@/lib/utils";
import { readerCommand } from "./key-filter";
import { RedisKeyBrowser } from "./RedisKeyBrowser";
import { useRedisKeyBrowser } from "./use-redis-key-browser";

/**
 * Where the key browser meets the studio (StorageBase fork): ONE additive line in
 * `src/components/Studio.tsx` mounts this, and it renders nothing unless the active connection
 * speaks the Redis dialect. A "Keys" toggle opens a panel over the left of the editor area; the
 * panel stays mounted once opened, so what was loaded and typed survives closing it.
 *
 * Opening a key does what a click on the object tree does (`handleTableClick`): a new tab holding
 * the key's read command, run at once through the ordinary query route, so the permission
 * checks, the read-only grant rule and the query audit all apply unchanged.
 */

export interface RedisKeyBrowserDockProps {
  readonly connection: DatabaseConnection | null;
  readonly capabilities?: ProviderCapabilities | null;
  readonly tabs: {
    readonly setTabs: Dispatch<SetStateAction<QueryTab[]>>;
    readonly setActiveTabId: (id: string) => void;
  };
  readonly runQuery: (query: string, tabId: string) => void;
}

export function RedisKeyBrowserDock({ connection, capabilities, tabs, runQuery }: RedisKeyBrowserDockProps) {
  if (connection === null || capabilities?.queryDialect !== "redis") return null;
  // Keyed on the connection, so switching connections starts from nothing.
  return (
    <DockForConnection
      key={connection.id}
      connection={connection}
      capabilities={capabilities}
      tabs={tabs}
      runQuery={runQuery}
    />
  );
}

function DockForConnection({
  connection,
  capabilities,
  tabs,
  runQuery,
}: RedisKeyBrowserDockProps & { readonly connection: DatabaseConnection }) {
  const state = useRedisKeyBrowser(connection);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  const toggle = () => {
    if (!mounted) {
      setMounted(true);
      void state.loadDatabases();
      void state.open({ database: sessionDatabase(connection.database) });
    }
    setOpen((current) => !current);
  };

  const openKey = async (key: string) => {
    const query = readerCommand(key, await state.typeOf(key));
    const id = newLocalId();
    tabs.setTabs((current) => [
      ...current,
      { id, name: key, query, result: null, isExecuting: false, type: resolveTabType(capabilities) },
    ]);
    tabs.setActiveTabId(id);
    // The same deferral `handleTableClick` uses: the new tab must exist before it is run.
    setTimeout(() => runQuery(query, id), 100);
  };

  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls="redis-key-browser-panel"
        onClick={toggle}
        className={cn(
          "absolute left-1/2 top-1.5 z-30 hidden h-7 -translate-x-1/2 items-center gap-1.5 rounded-md border border-hairline px-2.5 text-xs font-medium md:flex",
          open ? "bg-brand-solid text-white" : "bg-surface text-fg-muted hover:text-fg",
        )}
      >
        <KeyRound strokeWidth={1.5} className="h-3.5 w-3.5" aria-hidden="true" />
        Keys
      </button>
      {mounted && (
        <aside
          id="redis-key-browser-panel"
          aria-label="Redis key browser"
          className={cn(
            "absolute inset-y-0 left-0 z-30 w-[420px] max-w-full border-r border-hairline bg-background shadow-lg",
            !open && "hidden",
          )}
        >
          <RedisKeyBrowser state={state} onOpenKey={(key) => void openKey(key)} onClose={() => setOpen(false)} />
        </aside>
      )}
    </>
  );
}
