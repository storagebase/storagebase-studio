"use client";

import { useDeferredValue, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight, Copy, KeyRound, LoaderCircle, RefreshCw, Search, X } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { REDIS_KEY_TYPES, type RedisKeyTypeFilter } from "@/lib/redis-keys/scan";
import {
  compileKeyMatcher,
  flatRows,
  formatBytes,
  formatTtl,
  groupRows,
  highlightSegments,
  serverPattern,
  type BrowserRow,
  type FilterMode,
} from "./key-filter";
import { MAX_LOADED_KEYS, type RedisKeyBrowserState } from "./use-redis-key-browser";

/**
 * The Redis key browser (StorageBase fork; docs/providers/redis.md "Key browser").
 *
 * Search is CLIENT-SIDE over the names already loaded: substring by default, a Redis-style glob,
 * or a validated regular expression, case-insensitive unless asked. The server is asked only to
 * list names (a bounded SCAN) and to describe the keys on screen; "Search on server" re-scans
 * with MATCH when the keyspace is larger than what is loaded. Values are never read here: opening
 * a key hands its read command to the editor, which runs it through the ordinary query route.
 */

const ROW_HEIGHT = 28;

const selectClass =
  "h-7 rounded-md border border-hairline bg-surface px-2 text-xs text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40";

const MODES: ReadonlyArray<{ id: FilterMode; label: string; title: string }> = [
  { id: "substring", label: "Text", title: "Match a substring anywhere in the key" },
  { id: "glob", label: "Glob", title: "Match the whole key with * ? and [...], as Redis MATCH does" },
  { id: "regex", label: "Regex", title: "Match a regular expression anywhere in the key" },
];

function Highlighted({ text, ranges }: { text: string; ranges: ReadonlyArray<[number, number]> }) {
  return (
    <>
      {highlightSegments(text, ranges).map((segment, index) =>
        segment.hit ? (
          <mark key={index} className="rounded-sm bg-warning-tint/40 text-fg">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

export interface RedisKeyBrowserProps {
  readonly state: RedisKeyBrowserState;
  /** Opens a key in the editor. Called only for keys in the session database. */
  readonly onOpenKey: (key: string) => void;
  readonly onClose?: () => void;
}

export function RedisKeyBrowser({ state, onOpenKey, onClose }: RedisKeyBrowserProps) {
  const { set, busy, error, databases } = state;
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<FilterMode>("substring");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [view, setView] = useState<"tree" | "flat">("tree");
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set());
  const [active, setActive] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);

  const deferredQuery = useDeferredValue(query);
  const matcher = useMemo(
    () => compileKeyMatcher(deferredQuery, mode, caseSensitive),
    [deferredQuery, mode, caseSensitive],
  );

  const loaded = set?.keys ?? [];
  const matched = useMemo(
    () => (matcher.ok && !matcher.empty ? loaded.filter(matcher.test) : loaded),
    [loaded, matcher],
  );
  const rows = useMemo<BrowserRow[]>(() => {
    if (view === "flat") return flatRows(matched);
    return groupRows(matched, matcher.ok && !matcher.empty ? "all" : openGroups);
  }, [matched, view, matcher, openGroups]);

  // react(incompatible-library) is a property of @tanstack/react-virtual (its returned functions
  // cannot be memoized by the compiler), the ResultsGrid ruling; scoped to this call.
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });
  const items = virtualizer.getVirtualItems();

  const visibleKeys = items
    .map((item) => rows[item.index])
    .filter((row): row is Extract<BrowserRow, { kind: "key" }> => row?.kind === "key")
    .map((row) => row.key);
  const visibleSignature = visibleKeys.join("\u0000");
  const { wantMeta } = state;
  useEffect(() => {
    if (visibleSignature !== "") wantMeta(visibleSignature.split("\u0000"));
  }, [visibleSignature, wantMeta]);

  const database = set?.database ?? databases?.sessionDatabase ?? 0;
  const openable = databases !== null && database === databases.sessionDatabase;
  const activeIndex = Math.min(active, Math.max(rows.length - 1, 0));

  const scope = { database, match: set?.match, type: set?.type };
  const pattern = serverPattern(query, mode);

  const toggleGroup = (prefix: string) => {
    setOpenGroups((current) => {
      const next = new Set(current);
      if (next.has(prefix)) next.delete(prefix);
      else next.add(prefix);
      return next;
    });
  };

  const copy = (key: string) => {
    void navigator.clipboard?.writeText(key).then(
      () => setCopied(key),
      () => setCopied(null),
    );
  };

  const activate = (row: BrowserRow) => {
    if (row.kind === "group") toggleGroup(row.prefix);
    else if (openable) onOpenKey(row.key);
  };

  const move = (index: number) => {
    const next = Math.max(0, Math.min(index, rows.length - 1));
    setActive(next);
    virtualizer.scrollToIndex(next);
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const row = rows[activeIndex];
    if (row === undefined) return;
    const handled = (() => {
      switch (event.key) {
        case "ArrowDown":
          move(activeIndex + 1);
          return true;
        case "ArrowUp":
          move(activeIndex - 1);
          return true;
        case "Home":
          move(0);
          return true;
        case "End":
          move(rows.length - 1);
          return true;
        case "Enter":
          activate(row);
          return true;
        case "ArrowRight":
          if (row.kind === "group" && !row.open) toggleGroup(row.prefix);
          return true;
        case "ArrowLeft":
          if (row.kind === "group" && row.open) toggleGroup(row.prefix);
          return true;
        case "c":
          if ((event.metaKey || event.ctrlKey) && row.kind === "key") {
            copy(row.key);
            return true;
          }
          return false;
        default:
          return false;
      }
    })();
    if (handled) event.preventDefault();
  };

  const status = (() => {
    if (set === null) return busy !== null ? "Scanning..." : "No keys loaded yet.";
    const more = set.complete
      ? "every key"
      : set.deadlineHit
        ? "more on the server (time budget reached)"
        : "more on the server";
    return `${matched.length.toLocaleString()} of ${loaded.length.toLocaleString()} loaded - ${more}`;
  })();
  const atCap = loaded.length >= MAX_LOADED_KEYS;

  return (
    <div data-testid="redis-key-browser" className="flex h-full min-h-0 flex-col gap-2 p-3 text-xs">
      <div className="flex items-center gap-2">
        <KeyRound strokeWidth={1.5} className="h-4 w-4 text-brand" aria-hidden="true" />
        <h2 className="text-sm font-medium text-fg">Keys</h2>
        <label className="ml-2 flex items-center gap-1 text-fg-muted">
          Database
          <select
            aria-label="Database"
            className={selectClass}
            value={database}
            onChange={(event) => void state.open({ database: Number(event.target.value), type: set?.type })}
          >
            {(databases?.databases ?? [database]).map((number) => (
              <option key={number} value={number}>
                {number}
                {databases?.sessionDatabase === number ? " (session)" : ""}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-7 px-2"
          aria-label="Rescan"
          title="Scan this database again"
          disabled={busy !== null}
          onClick={() => void state.open(scope)}
        >
          <RefreshCw strokeWidth={1.5} className="h-3.5 w-3.5" />
        </Button>
        {onClose && (
          <Button variant="ghost" size="sm" className="h-7 px-2" aria-label="Close key browser" onClick={onClose}>
            <X strokeWidth={1.5} className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <div className="relative">
        <Search
          strokeWidth={1.5}
          className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-muted"
          aria-hidden="true"
        />
        <Input
          aria-label="Search keys"
          placeholder={
            mode === "regex" ? "Regular expression" : mode === "glob" ? "user:*:session" : "Search loaded keys"
          }
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          aria-invalid={!matcher.ok}
          className="h-8 pl-7 text-xs"
        />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <div role="toolbar" aria-label="Search mode" className="flex rounded-md border border-hairline">
          {MODES.map((option) => (
            <button
              key={option.id}
              type="button"
              title={option.title}
              aria-pressed={mode === option.id}
              onClick={() => setMode(option.id)}
              className={cn(
                "px-2 py-1 text-xs first:rounded-l-md last:rounded-r-md",
                mode === option.id ? "bg-brand-solid text-white" : "text-fg-muted hover:bg-fill",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-pressed={caseSensitive}
          title="Match case"
          aria-label="Match case"
          onClick={() => setCaseSensitive((current) => !current)}
          className={cn(
            "rounded-md border border-hairline px-2 py-1 font-mono text-xs",
            caseSensitive ? "bg-brand-solid text-white" : "text-fg-muted hover:bg-fill",
          )}
        >
          Aa
        </button>
        <div role="toolbar" aria-label="Layout" className="flex rounded-md border border-hairline">
          {(["tree", "flat"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={view === option}
              onClick={() => setView(option)}
              className={cn(
                "px-2 py-1 text-xs capitalize first:rounded-l-md last:rounded-r-md",
                view === option ? "bg-brand-solid text-white" : "text-fg-muted hover:bg-fill",
              )}
            >
              {option === "tree" ? "Grouped" : "Flat"}
            </button>
          ))}
        </div>
        <select
          aria-label="Key type"
          className={selectClass}
          value={set?.type ?? ""}
          onChange={(event) =>
            void state.open({
              database,
              match: set?.match,
              ...(event.target.value !== "" ? { type: event.target.value as RedisKeyTypeFilter } : {}),
            })
          }
        >
          <option value="">All types</option>
          {REDIS_KEY_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </div>

      {!matcher.ok && (
        <p role="alert" className="text-danger">
          {matcher.error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <span data-testid="redis-key-status" className="text-fg-muted" aria-live="polite">
          {status}
        </span>
        {set?.match !== undefined && (
          <span className="rounded bg-fill px-1.5 py-0.5 font-mono">
            MATCH {set.match}
            <button
              type="button"
              aria-label="Clear server search"
              className="ml-1 text-fg-muted hover:text-fg"
              onClick={() => void state.open({ database, type: set.type })}
            >
              <X strokeWidth={1.5} className="inline h-3 w-3" />
            </button>
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {busy !== null ? (
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={state.stop}>
            <LoaderCircle strokeWidth={1.5} className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Stop
          </Button>
        ) : (
          <>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={set === null || set.complete || atCap}
              onClick={() => void state.loadMore()}
            >
              Load more
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              title={`Keep scanning until every key is loaded or ${MAX_LOADED_KEYS.toLocaleString()} are`}
              disabled={set === null || set.complete || atCap}
              onClick={() => void state.scanAll()}
            >
              Scan all (bounded)
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              title={
                mode === "regex"
                  ? "A regular expression has no server-side equivalent; switch to Text or Glob"
                  : "Scan the database with MATCH for this search"
              }
              disabled={pattern === null}
              onClick={() => pattern !== null && void state.open({ database, match: pattern, type: set?.type })}
            >
              Search on server
            </Button>
          </>
        )}
      </div>

      {error !== null && (
        <p role="alert" className="text-danger break-words">
          {error}
        </p>
      )}
      {databases?.error !== undefined && (
        <p className="text-fg-muted break-words">Only the session database is offered: {databases.error}</p>
      )}
      {databases !== null && !openable && (
        <p
          data-testid="redis-key-other-database"
          className="rounded-md border border-hairline bg-fill/50 p-2 text-fg-muted"
        >
          The editor runs against database {databases.sessionDatabase}. Keys in database {database} can be searched and
          copied here; open them by pointing a connection at this database.
        </p>
      )}

      {rows.length === 0 ? (
        <p className="py-4 text-fg-muted">
          {set === null ? "" : loaded.length === 0 ? "No keys." : "No loaded keys match."}
        </p>
      ) : (
        // A virtualized listbox: the container owns focus and every keystroke
        // (arrows/Home/End/Enter, aria-activedescendant), so rows are never
        // individually tabbable — Tab must not walk thousands of rows. A native
        // select/datalist cannot virtualize or carry per-row actions, so the
        // listbox/option roles below are the correct ARIA, not a shortcut.
        /* oxlint-disable jsx-a11y/prefer-tag-over-role -- virtualized keyboard-navigated list; select/datalist cannot virtualize */
        <div
          ref={setScrollElement}
          role="listbox"
          aria-label="Redis keys"
          aria-activedescendant={rows[activeIndex] ? `redis-key-row-${activeIndex}` : undefined}
          tabIndex={0}
          onKeyDown={onListKeyDown}
          data-testid="redis-key-scroll"
          className="min-h-0 flex-1 overflow-auto rounded-md border border-hairline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {items.map((item) => {
              const row = rows[item.index];
              const isActive = item.index === activeIndex;
              const style = {
                position: "absolute" as const,
                top: 0,
                left: 0,
                right: 0,
                height: ROW_HEIGHT,
                transform: `translateY(${item.start}px)`,
              };
              const indent = { paddingLeft: 8 + row.depth * 14 };
              if (row.kind === "group") {
                return (
                  // Keyboard handled by the listbox container (ArrowRight/Left
                  // toggle the group); the row itself stays unfocusable.
                  // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role, jsx-a11y/click-events-have-key-events, jsx-a11y/interactive-supports-focus -- rows of the virtualized listbox above; keyboard and focus live on its container
                  <div
                    key={row.id}
                    id={`redis-key-row-${item.index}`}
                    role="option"
                    aria-selected={isActive}
                    data-testid="redis-key-group"
                    style={{ ...style, ...indent }}
                    className={cn("flex cursor-pointer items-center gap-1 pr-2 hover:bg-fill", isActive && "bg-fill")}
                    onClick={() => {
                      setActive(item.index);
                      toggleGroup(row.prefix);
                    }}
                  >
                    {row.open ? (
                      <ChevronDown strokeWidth={1.5} className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    ) : (
                      <ChevronRight strokeWidth={1.5} className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    )}
                    <span className="truncate font-mono">{row.prefix}</span>
                    <span className="ml-auto text-fg-muted">{row.count.toLocaleString()}</span>
                  </div>
                );
              }
              const meta = state.metaFor(row.key);
              const offset = row.key.length - row.label.length;
              const ranges = matcher.ok
                ? matcher
                    .ranges(row.key)
                    .map(([start, end]): [number, number] => [Math.max(start - offset, 0), end - offset])
                    .filter(([, end]) => end > 0)
                : [];
              return (
                // Keyboard handled by the listbox container (Enter opens the
                // key); the row itself stays unfocusable.
                // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role, jsx-a11y/click-events-have-key-events, jsx-a11y/interactive-supports-focus -- rows of the virtualized listbox above; keyboard and focus live on its container
                <div
                  key={row.id}
                  id={`redis-key-row-${item.index}`}
                  role="option"
                  aria-selected={isActive}
                  data-testid="redis-key-row"
                  title={row.key}
                  style={{ ...style, ...indent }}
                  className={cn(
                    "group flex items-center gap-1.5 pr-1",
                    openable ? "cursor-pointer hover:bg-fill" : "cursor-default",
                    isActive && "bg-fill",
                  )}
                  onClick={() => {
                    setActive(item.index);
                    if (openable) onOpenKey(row.key);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate font-mono">
                    <Highlighted text={row.label} ranges={ranges} />
                  </span>
                  {meta !== undefined && (
                    <span data-testid="redis-key-meta" className="shrink-0 text-fg-muted">
                      <span className="rounded bg-fill px-1">{meta.type}</span>
                      {meta.ttl !== null && meta.ttl !== -1 && <span className="ml-1">{formatTtl(meta.ttl)}</span>}
                      {meta.memory !== null && <span className="ml-1">{formatBytes(meta.memory)}</span>}
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label={`Copy key name ${row.key}`}
                    title={copied === row.key ? "Copied" : "Copy key name"}
                    className="shrink-0 rounded p-0.5 text-fg-muted opacity-0 hover:text-fg focus:opacity-100 group-hover:opacity-100"
                    onClick={(event) => {
                      event.stopPropagation();
                      copy(row.key);
                    }}
                  >
                    <Copy strokeWidth={1.5} className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
        /* oxlint-enable jsx-a11y/prefer-tag-over-role */
      )}
    </div>
  );
}
