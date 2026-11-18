"use client";

import { appFetch } from "@/lib/config/base-path";
import { downloadText } from "@/lib/export/download";
import { jsonText } from "@/lib/export/json";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChevronDown, ChevronRight, CircleCheck, CircleX, Download, RefreshCw, Wrench } from "lucide-react";
import type { StoragebaseAuditEvent } from "@/storagebase/audit/types";

/**
 * The fork's admin audit page (StorageBase fork): a port of the old fork's AuditTab extensions —
 * the filters, the detail drawer, the cursor paging, the export and the source line — as a
 * standalone page reading POST /api/sb/admin/audit. The shell around them is new
 * (`@/components/ui/*` primitives), and only the operations view is ported: the old tab's
 * Queries/Stats panels read the browser's query history, which is upstream's own surface, not the
 * fork's.
 *
 * One writer of `events`: the Effect below, keyed by the request descriptor (the settled server
 * filters plus a refresh counter), so a response that lost the race to a newer filter is dropped
 * rather than repopulating the table with the previous filter's rows. Typed filters reach the
 * server once they settle; the rows on screen are re-filtered on every keystroke meanwhile.
 */

/** The event types the filter offers, in the order it lists them: the fork schema's own vocabulary. */
const EVENT_TYPE_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ["query_execution", "Query Execution"],
  ["maintenance", "Maintenance"],
  ["kill_session", "Kill Session"],
  ["masking_config", "Masking"],
  ["threshold_config", "Thresholds"],
  ["connection_test", "Connection Test"],
  ["managed_connection", "Managed Connection"],
  ["agent_operation", "Agent Operation"],
  ["mcp_operation", "MCP Operation"],
  ["object_edit", "Object Edit"],
  ["resource_operation", "Resource Operation"],
  ["login_success", "Login Success"],
  ["login_failure", "Login Failure"],
  ["logout", "Logout"],
  ["permission_denied", "Permission Denied"],
  ["rate_limit_exceeded", "Rate Limited"],
  ["account", "Account"],
];

/**
 * The resource actions the action filter offers: the fork's `resource_operation` vocabulary, in
 * the order an operator scans for them. Phase 2's routes emit them.
 */
const RESOURCE_ACTION_OPTIONS: readonly string[] = [
  "tree.list",
  "resource.health",
  "resource.meta",
  "blob.preview",
  "blob.download",
  "blob.meta",
  "blob.upload",
  "blob.delete",
  "message.browse",
  "message.publish",
  "message.purge",
  "secret.read",
  "secret.write",
  "secret.delete",
  "kafka.cluster.read",
  "kafka.topics.list",
  "kafka.topic.read",
  "kafka.messages.read",
  "kafka.groups.list",
  "kafka.group.read",
  "kafka.topic.create",
  "kafka.topic.delete",
  "kafka.topic.config",
  "kafka.topic.partitions",
  "kafka.produce",
  "kafka.group.delete",
  "kafka.group.reset-offsets",
];

/** One page on screen; "Load more" asks for the next. */
const AUDIT_PAGE_SIZE = 200;
/** How long a typed filter waits for the next keystroke before it asks the server. */
const FILTER_DEBOUNCE_MS = 300;

/** The text a free-text search reads: everything an operator could be looking for by content. */
function searchableText(event: StoragebaseAuditEvent): string {
  return [event.action, event.target, event.connectionName, event.statement, event.error, event.details, event.engine]
    .filter((part): part is string => typeof part === "string")
    .join("\n")
    .toLowerCase();
}

/** The label/value pairs of an event's detail drawer, only for the fields it carries. */
function detailRows(event: StoragebaseAuditEvent): Array<[string, string]> {
  const rows: Array<[string, string | number | undefined]> = [
    ["Type", event.type],
    ["Timestamp", event.timestamp],
    ["Result", event.reason ? `${event.result} (${event.reason})` : event.result],
    ["User", event.role ? `${event.user} (${event.role})` : event.user],
    ["IP", event.ip],
    ["Forwarded For", event.forwardedFor],
    ["User Agent", event.userAgent],
    ["Connection", event.connectionName],
    ["Connection ID", event.connectionId],
    ["Engine", event.engine],
    ["Host", event.host],
    ["Database", event.database],
    ["Statement Kind", event.statementKind],
    ["Rows Returned", event.rowsReturned],
    ["Rows Affected", event.rowsAffected],
    ["Duration", event.duration === undefined ? undefined : `${event.duration}ms`],
    ["Error", event.error],
    ["Details", event.details],
    ["Query ID", event.queryId],
    ["Correlation ID", event.correlationId],
    // The fork's identity and grant vocabulary: unfilled until the phases that emit it.
    ["Sign-in", event.authProvider],
    ["Subject", event.subject],
    ["App Roles", event.appRoles],
    ["Permission", event.permission],
    ["Granted By", event.grantedBy],
    ["Access Groups", event.accessGroups],
  ];
  return rows
    .filter((row): row is [string, string | number] => row[1] !== undefined && row[1] !== "")
    .map(([label, value]) => [label, String(value)]);
}

function AuditEventDetail({ event }: { event: StoragebaseAuditEvent }) {
  return (
    <div className="space-y-3 py-2" data-testid="audit-event-detail">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
        {detailRows(event).map(([label, value]) => (
          <Fragment key={label}>
            <dt className="text-fg-muted">{label}</dt>
            <dd className="text-fg-secondary break-all">{value}</dd>
          </Fragment>
        ))}
      </dl>
      {event.statement !== undefined && (
        <div>
          <div className="text-xs text-fg-muted mb-1">
            Statement (literals masked){event.statementTruncated ? " — truncated" : ""}
          </div>
          <pre className="font-mono text-xs text-fg-tertiary bg-overlay rounded-md p-2 whitespace-pre-wrap break-all max-h-64 overflow-auto">
            {event.statement}
          </pre>
        </div>
      )}
    </div>
  );
}

/** What the operator asked for. Every field is also applied to the rows on screen. */
interface AuditFilters {
  type: string;
  result: string;
  action: string;
  engine: string;
  user: string;
  ip: string;
  text: string;
  /** ISO-8601, or "" for unbounded. */
  from: string;
  to: string;
}

interface AuditPage {
  events: StoragebaseAuditEvent[];
  nextCursor: string | null;
  source: "store" | "buffer" | null;
}

/** A `datetime-local` value as the ISO instant it names in the viewer's zone; "" when unset or unreadable. */
function isoFromLocal(value: string): string {
  if (!value) return "";
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? "" : new Date(time).toISOString();
}

/** The request body one read of the trail sends. */
function auditBody(filters: AuditFilters, limit: number, cursor: string | null, exportAll: boolean): string {
  const body: Record<string, unknown> = { limit };
  for (const [name, value] of Object.entries(filters)) {
    if (value && value !== "all") body[name] = value;
  }
  if (cursor) body.cursor = cursor;
  if (exportAll) body.export = true;
  return JSON.stringify(body);
}

/**
 * The audit read, kept free of state writes so the Effect below can stay in the shape react.dev
 * prescribes for fetching. A failed request reads as "no events" — the same thing a lost race
 * leaves on screen.
 */
async function loadAuditPage(
  filters: AuditFilters,
  cursor: string | null,
  limit = AUDIT_PAGE_SIZE,
): Promise<AuditPage> {
  try {
    const res = await appFetch("/api/sb/admin/audit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: auditBody(filters, limit, cursor, false),
    });
    const data = await res.json();
    return { events: data.events || [], nextCursor: data.nextCursor ?? null, source: data.source ?? null };
  } catch {
    return { events: [], nextCursor: null, source: null };
  }
}

/** The same filters, applied to rows already loaded: the server's answer, re-read on screen. */
function matchesFilters(event: StoragebaseAuditEvent, filters: AuditFilters): boolean {
  const contains = (haystack: string, needle: string) => !needle || haystack.includes(needle.toLowerCase());
  return (
    (filters.result === "all" || event.result === filters.result) &&
    (filters.action === "all" || event.action === filters.action) &&
    (!filters.engine || (event.engine ?? "") === filters.engine) &&
    (!filters.from || event.timestamp >= filters.from) &&
    (!filters.to || event.timestamp <= filters.to) &&
    contains(event.user.toLowerCase(), filters.user) &&
    contains(`${event.ip ?? ""}\n${event.forwardedFor ?? ""}`.toLowerCase(), filters.ip) &&
    contains(searchableText(event), filters.text)
  );
}

/** `value`, once it has stopped changing for `delayMs`. */
function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

export function AuditPage() {
  const [events, setEvents] = useState<StoragebaseAuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [refreshCount, setRefreshCount] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [resultFilter, setResultFilter] = useState<string>("all");
  const [userQuery, setUserQuery] = useState("");
  const [ipQuery, setIpQuery] = useState("");
  const [actionFilter, setActionFilter] = useState<string>("all");
  const [engineQuery, setEngineQuery] = useState("");
  const [fromValue, setFromValue] = useState("");
  const [toValue, setToValue] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [source, setSource] = useState<AuditPage["source"]>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const toggleExpanded = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // The descriptor bundles which events to ask for with which request this is, so the Effect below
  // stays the ONLY writer of `events`. A refresh that fetched on its own would be a second,
  // unguarded writer: one still in flight when the filter changed would land last and repopulate
  // the table with the previous filter's rows.
  const typed = useDebounced(
    useMemo(
      () => ({ user: userQuery, ip: ipQuery, text: searchQuery, engine: engineQuery }),
      [userQuery, ipQuery, searchQuery, engineQuery],
    ),
    FILTER_DEBOUNCE_MS,
  );
  const filters: AuditFilters = useMemo(
    () => ({
      type: typeFilter,
      result: resultFilter,
      action: actionFilter,
      engine: engineQuery.trim(),
      user: userQuery.trim(),
      ip: ipQuery.trim(),
      text: searchQuery.trim(),
      from: isoFromLocal(fromValue),
      to: isoFromLocal(toValue),
    }),
    [typeFilter, resultFilter, actionFilter, engineQuery, userQuery, ipQuery, searchQuery, fromValue, toValue],
  );
  const serverFilters: AuditFilters = useMemo(
    () => ({
      type: typeFilter,
      result: resultFilter,
      action: actionFilter,
      engine: typed.engine.trim(),
      user: typed.user.trim(),
      ip: typed.ip.trim(),
      text: typed.text.trim(),
      from: isoFromLocal(fromValue),
      to: isoFromLocal(toValue),
    }),
    [typeFilter, resultFilter, actionFilter, typed, fromValue, toValue],
  );
  const auditRequest = useMemo(() => ({ serverFilters, refreshCount }), [serverFilters, refreshCount]);
  // The request the rows on screen belong to, so a "Load more" that lands after the filters
  // changed is dropped instead of appending another query's rows.
  const currentRequest = useRef(auditRequest);

  useEffect(() => {
    currentRequest.current = auditRequest;
    let ignore = false;
    async function run() {
      const page = await loadAuditPage(auditRequest.serverFilters, null);
      // A response that lost the race (unmount, a newer filter, or a newer refresh) must not win.
      if (ignore) return;
      setEvents(page.events);
      setNextCursor(page.nextCursor);
      setSource(page.source);
      setLoading(false);
    }
    run();
    return () => {
      ignore = true;
    };
  }, [auditRequest]);

  // The spinner turns on because the user acted, so it belongs to the event that caused it rather
  // than to the Effect that follows. Both handlers only ask for a new synchronization; neither
  // touches `events`.
  const handleTypeChange = (value: string) => {
    setLoading(true);
    setTypeFilter(value);
  };

  const handleRefresh = () => {
    setLoading(true);
    setRefreshCount((count) => count + 1);
  };

  const handleLoadMore = async () => {
    if (!nextCursor) return;
    const request = auditRequest;
    setLoadingMore(true);
    const page = await loadAuditPage(request.serverFilters, nextCursor);
    setLoadingMore(false);
    if (currentRequest.current !== request) return;
    setEvents((current) => [...current, ...page.events]);
    setNextCursor(page.nextCursor);
  };

  /**
   * Every matching event, not just the loaded pages: the route pages through the source with the
   * current filters, bounded at its own export limit, and answers one JSON document.
   */
  const exportEvents = async () => {
    setExporting(true);
    try {
      const res = await appFetch("/api/sb/admin/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: auditBody(filters, AUDIT_PAGE_SIZE, null, true),
      });
      const data = await res.json();
      const exported: StoragebaseAuditEvent[] = Array.isArray(data.events) ? data.events : [];
      downloadText(jsonText(exported, 2), "application/json", `audit_operations_${Date.now()}.json`);
    } catch {
      // A failed export is the route's to report; the page keeps its rows and its state.
    } finally {
      setExporting(false);
    }
  };

  const filteredEvents = useMemo(() => events.filter((event) => matchesFilters(event, filters)), [events, filters]);

  const successCount = events.filter((event) => event.result === "success").length;
  const successRate = events.length > 0 ? Math.round((successCount / events.length) * 100) : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <Select value={typeFilter} onValueChange={handleTypeChange}>
          <SelectTrigger aria-label="Event type" className="w-[170px] h-8 text-xs bg-panel border-hairline-strong">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            {EVENT_TYPE_OPTIONS.map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={resultFilter} onValueChange={setResultFilter}>
          <SelectTrigger aria-label="Result" className="w-[120px] h-8 text-xs bg-panel border-hairline-strong">
            <SelectValue placeholder="Result" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Results</SelectItem>
            <SelectItem value="success">Success</SelectItem>
            <SelectItem value="failure">Failure</SelectItem>
          </SelectContent>
        </Select>
        <Select value={actionFilter} onValueChange={setActionFilter}>
          <SelectTrigger aria-label="Action" className="w-[170px] h-8 text-xs bg-panel border-hairline-strong">
            <SelectValue placeholder="Action" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Actions</SelectItem>
            {RESOURCE_ACTION_OPTIONS.map((action) => (
              <SelectItem key={action} value={action}>
                {action}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          placeholder="Search..."
          aria-label="Search action, target, connection or statement"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          className="w-[180px] h-8 text-xs bg-panel border-hairline-strong"
        />
        <Input
          placeholder="User..."
          aria-label="Filter by user"
          value={userQuery}
          onChange={(event) => setUserQuery(event.target.value)}
          className="w-[120px] h-8 text-xs bg-panel border-hairline-strong"
        />
        <Input
          placeholder="IP..."
          aria-label="Filter by IP"
          value={ipQuery}
          onChange={(event) => setIpQuery(event.target.value)}
          className="w-[120px] h-8 text-xs bg-panel border-hairline-strong"
        />
        <Input
          placeholder="Connection type..."
          aria-label="Filter by connection type"
          value={engineQuery}
          onChange={(event) => setEngineQuery(event.target.value)}
          className="w-[140px] h-8 text-xs bg-panel border-hairline-strong"
        />
        <Input
          type="datetime-local"
          aria-label="From"
          value={fromValue}
          onChange={(event) => setFromValue(event.target.value)}
          className="w-[190px] h-8 text-xs bg-panel border-hairline-strong"
        />
        <Input
          type="datetime-local"
          aria-label="To"
          value={toValue}
          onChange={(event) => setToValue(event.target.value)}
          className="w-[190px] h-8 text-xs bg-panel border-hairline-strong"
        />
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-fg-muted hover:text-fg-secondary ml-auto"
          onClick={handleRefresh}
          disabled={loading}
        >
          <RefreshCw className={`w-3 h-3 mr-1.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-xs gap-2"
          disabled={loading || exporting || filteredEvents.length === 0}
          onClick={exportEvents}
        >
          <Download className="w-3 h-3" /> Export JSON
        </Button>
      </div>

      <div className="flex items-center gap-4 text-xs text-fg-muted">
        <span>
          Total: <span className="font-bold text-fg-secondary">{events.length}</span> events
        </span>
        <span>
          Success: <span className="font-bold text-success">{successRate}%</span>
        </span>
        {source !== null && (
          <span data-testid="audit-source" className="ml-auto">
            {source === "store"
              ? "Durable store — kept across restarts"
              : "In-memory buffer — recent events, lost on restart"}
          </span>
        )}
      </div>

      <div className="rounded-xl border border-hairline bg-panel overflow-hidden">
        {loading && events.length === 0 ? (
          <div className="p-4 space-y-2">
            {[...Array(5)].map((_, index) => (
              <Skeleton key={index} className="h-10 w-full bg-overlay" />
            ))}
          </div>
        ) : filteredEvents.length === 0 ? (
          <div className="p-8 text-center text-fg-subtle text-sm">
            <Wrench className="h-8 w-8 mx-auto mb-2 opacity-30" />
            <p>No audit events found.</p>
            <p className="text-xs mt-1 text-fg-faint">
              Events appear here when statements run, sign-ins happen or resource actions are taken.
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="border-hairline hover:bg-transparent">
                <TableHead className="text-xs text-fg-muted font-bold uppercase w-[30px]" />
                <TableHead className="text-xs text-fg-muted font-bold uppercase">Time</TableHead>
                <TableHead className="text-xs text-fg-muted font-bold uppercase">Action</TableHead>
                <TableHead className="text-xs text-fg-muted font-bold uppercase">Target</TableHead>
                <TableHead className="text-xs text-fg-muted font-bold uppercase hidden md:table-cell">
                  Connection
                </TableHead>
                <TableHead className="text-xs text-fg-muted font-bold uppercase hidden lg:table-cell">User</TableHead>
                <TableHead className="text-xs text-fg-muted font-bold uppercase hidden lg:table-cell">IP</TableHead>
                <TableHead className="text-xs text-fg-muted font-bold uppercase hidden md:table-cell">Kind</TableHead>
                <TableHead className="text-right text-xs text-fg-muted font-bold uppercase hidden sm:table-cell">
                  Rows
                </TableHead>
                <TableHead className="text-right text-xs text-fg-muted font-bold uppercase">Duration</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredEvents.map((event) => (
                <Fragment key={event.id}>
                  <TableRow className="border-hairline hover:bg-fill">
                    <TableCell className="py-2">
                      <button
                        type="button"
                        className="flex items-center gap-1"
                        aria-expanded={expanded.has(event.id)}
                        aria-label={expanded.has(event.id) ? "Hide details" : "Show details"}
                        onClick={() => toggleExpanded(event.id)}
                      >
                        {expanded.has(event.id) ? (
                          <ChevronDown className="w-3 h-3 text-fg-muted" />
                        ) : (
                          <ChevronRight className="w-3 h-3 text-fg-muted" />
                        )}
                        {event.result === "success" ? (
                          <CircleCheck className="w-3.5 h-3.5 text-success" />
                        ) : (
                          <CircleX className="w-3.5 h-3.5 text-danger" />
                        )}
                      </button>
                    </TableCell>
                    <TableCell className="py-2 font-mono text-xs text-fg-muted">
                      {new Date(event.timestamp).toLocaleString([], {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </TableCell>
                    <TableCell className="py-2">
                      <Badge variant="outline" className="text-[0.625rem] font-bold border-hairline-strong">
                        {event.action}
                      </Badge>
                    </TableCell>
                    <TableCell className="py-2 font-mono text-xs text-fg-tertiary truncate max-w-[120px]">
                      {event.target}
                    </TableCell>
                    <TableCell className="py-2 text-xs text-fg-muted hidden md:table-cell truncate max-w-[100px]">
                      {event.connectionName || "-"}
                    </TableCell>
                    <TableCell className="py-2 text-xs text-fg-muted hidden lg:table-cell">{event.user}</TableCell>
                    <TableCell className="py-2 font-mono text-xs text-fg-muted hidden lg:table-cell">
                      {event.ip || "-"}
                    </TableCell>
                    <TableCell className="py-2 text-xs text-fg-muted hidden md:table-cell">
                      {event.statementKind || "-"}
                    </TableCell>
                    <TableCell className="py-2 text-right font-mono text-xs text-fg-muted hidden sm:table-cell">
                      {event.rowsAffected ?? event.rowsReturned ?? "-"}
                    </TableCell>
                    <TableCell className="py-2 text-right font-mono text-xs text-fg-muted">
                      {event.duration ? `${event.duration}ms` : "-"}
                    </TableCell>
                  </TableRow>
                  {expanded.has(event.id) && (
                    <TableRow className="border-hairline bg-fill hover:bg-fill">
                      <TableCell colSpan={10} className="py-2">
                        <AuditEventDetail event={event} />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      {nextCursor !== null && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={handleLoadMore} disabled={loadingMore}>
            {loadingMore ? "Loading..." : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}
