"use client";

import { appFetch } from "@/lib/config/base-path";
import { Fragment, useEffect, useMemo, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Wrench,
  Search as SearchIcon,
  ChartColumn,
  CircleCheck,
  CircleX,
  RefreshCw,
  Clock,
  Activity,
  Download,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import type { AuditEvent } from "@/lib/audit";
import { storage } from "@/lib/storage";
import type { QueryHistoryItem } from "@/lib/types";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { format, subDays, startOfDay } from "date-fns";
import { useEffectiveTheme } from "@/hooks/use-effective-theme";
import { chartTooltipStyle } from "@/lib/charts/palette";
import { csvRow } from "@/lib/export/csv";
import { jsonText } from "@/lib/export/json";
import { queryHistoryText } from "@/lib/export/query-history";
import { downloadText } from "@/lib/export/download";

interface AuditExportProps {
  disabled: boolean;
  onExport: (format: "csv" | "json") => void;
}

function AuditExport({ disabled, onExport }: AuditExportProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 text-xs gap-2" disabled={disabled}>
          <Download className="w-3 h-3" /> Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onExport("csv")}>Export as CSV</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onExport("json")}>Export as JSON</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AuditTab() {
  return (
    <div className="space-y-6">
      <Tabs defaultValue="operations">
        <TabsList className="bg-transparent border-b border-hairline rounded-none p-0 h-10 w-full justify-start">
          <TabsTrigger
            value="operations"
            className="gap-2 rounded-none border-b-2 border-transparent data-[state=active]:border-brand data-[state=active]:bg-transparent data-[state=active]:text-brand text-fg-muted text-xs px-4"
          >
            <Wrench className="h-3.5 w-3.5" />
            Operations
          </TabsTrigger>
          <TabsTrigger
            value="queries"
            className="gap-2 rounded-none border-b-2 border-transparent data-[state=active]:border-brand data-[state=active]:bg-transparent data-[state=active]:text-brand text-fg-muted text-xs px-4"
          >
            <SearchIcon className="h-3.5 w-3.5" />
            Queries
          </TabsTrigger>
          <TabsTrigger
            value="stats"
            className="gap-2 rounded-none border-b-2 border-transparent data-[state=active]:border-brand data-[state=active]:bg-transparent data-[state=active]:text-brand text-fg-muted text-xs px-4"
          >
            <ChartColumn className="h-3.5 w-3.5" />
            Stats
          </TabsTrigger>
        </TabsList>

        <TabsContent value="operations" className="mt-4">
          <OperationsAudit />
        </TabsContent>
        <TabsContent value="queries" className="mt-4">
          <QueryAudit />
        </TabsContent>
        <TabsContent value="stats" className="mt-4">
          <AuditStats />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** The event types the filter offers, in the order it lists them. */
const EVENT_TYPE_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ["query_execution", "Query Execution"],
  ["maintenance", "Maintenance"],
  ["kill_session", "Kill Session"],
  ["masking_config", "Masking"],
  ["threshold_config", "Thresholds"],
  ["connection_test", "Connection Test"],
  ["managed_connection", "Managed Connection"],
  ["agent_operation", "Agent Operation"],
  ["object_edit", "Object Edit"],
  ["resource_connection_test", "Resource Test"],
  ["resource_operation", "Resource Operation"],
  ["login_success", "Login Success"],
  ["login_failure", "Login Failure"],
  ["logout", "Logout"],
  ["permission_denied", "Permission Denied"],
  ["rate_limit_exceeded", "Rate Limited"],
];

/** The text a free-text search reads: everything an operator could be looking for by content. */
function searchableText(event: AuditEvent): string {
  return [event.action, event.target, event.connectionName, event.statement, event.error, event.details, event.engine]
    .filter((part): part is string => typeof part === "string")
    .join("\n")
    .toLowerCase();
}

/** The label/value pairs of an event's detail panel, only for the fields it carries. */
function detailRows(event: AuditEvent): Array<[string, string]> {
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
  ];
  return rows
    .filter((row): row is [string, string | number] => row[1] !== undefined && row[1] !== "")
    .map(([label, value]) => [label, String(value)]);
}

function AuditEventDetail({ event }: { event: AuditEvent }) {
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

/**
 * The audit read, kept free of state writes so the Effect below can stay in the
 * shape react.dev prescribes for fetching. A failed request reads as "no events"
 * — the same thing the old catch branch put on screen.
 */
async function loadAuditEvents(type: string): Promise<AuditEvent[]> {
  try {
    // The whole server buffer (1000 events), so the filters below search all of it rather than
    // the most recent slice.
    const params = new URLSearchParams({ limit: "1000" });
    if (type !== "all") params.set("type", type);
    const res = await appFetch(`/api/admin/audit?${params}`);
    const data = await res.json();
    return data.events || [];
  } catch {
    return [];
  }
}

function OperationsAudit() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [refreshCount, setRefreshCount] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [resultFilter, setResultFilter] = useState<string>("all");
  const [userQuery, setUserQuery] = useState("");
  const [ipQuery, setIpQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const toggleExpanded = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // The descriptor bundles which events to ask for with which request this is, so the
  // Effect below stays the ONLY writer of `events`. A refresh that fetched on its own
  // would be a second, unguarded writer: one still in flight when the filter changed
  // would land last and repopulate the table with the previous filter's rows.
  // (Bundling matters: a bare refresh token is never read inside the Effect, so it
  // cannot honestly be a dependency — inside the descriptor it is the value the Effect
  // synchronizes against. Same shape as OverviewTab's fleet health.)
  const auditRequest = useMemo(() => ({ typeFilter, refreshCount }), [typeFilter, refreshCount]);

  useEffect(() => {
    const { typeFilter: requestedType } = auditRequest;
    let ignore = false;
    async function run() {
      const next = await loadAuditEvents(requestedType);
      // A response that lost the race (unmount, a newer filter, or a newer refresh)
      // must not win.
      if (ignore) return;
      setEvents(next);
      setLoading(false);
    }
    run();
    return () => {
      ignore = true;
    };
  }, [auditRequest]);

  // The spinner turns on because the user acted, so it belongs to the event that
  // caused it rather than to the Effect that follows. Both handlers only ask for a
  // new synchronization; neither touches `events`.
  const handleTypeChange = (value: string) => {
    setLoading(true);
    setTypeFilter(value);
  };

  const handleRefresh = () => {
    setLoading(true);
    setRefreshCount((c) => c + 1);
  };

  const filteredEvents = useMemo(() => {
    const q = searchQuery.toLowerCase();
    const userNeedle = userQuery.toLowerCase();
    const ipNeedle = ipQuery.toLowerCase();
    return events.filter(
      (e) =>
        (resultFilter === "all" || e.result === resultFilter) &&
        (!userNeedle || e.user.toLowerCase().includes(userNeedle)) &&
        (!ipNeedle || `${e.ip ?? ""}\n${e.forwardedFor ?? ""}`.toLowerCase().includes(ipNeedle)) &&
        (!q || searchableText(e).includes(q)),
    );
  }, [events, searchQuery, resultFilter, userQuery, ipQuery]);

  const exportEvents = (format: "csv" | "json") => {
    let content: string;
    if (format === "csv") {
      const headers = [
        "Timestamp",
        "Type",
        "Action",
        "Target",
        "Connection",
        "User",
        "Result",
        "Duration (ms)",
        "Details",
        "IP",
        "Reason",
        "Bucket",
        "Correlation ID",
        "Role",
        "User Agent",
        "Forwarded For",
        "Connection ID",
        "Engine",
        "Host",
        "Database",
        "Statement Kind",
        "Statement",
        "Statement Truncated",
        "Rows Returned",
        "Rows Affected",
        "Error",
        "Query ID",
        "ID",
      ];
      const rows = filteredEvents.map((event) =>
        csvRow([
          event.timestamp,
          event.type,
          event.action,
          event.target,
          event.connectionName,
          event.user,
          event.result,
          event.duration,
          event.details,
          event.ip,
          event.reason,
          event.bucket,
          event.correlationId,
          event.role,
          event.userAgent,
          event.forwardedFor,
          event.connectionId,
          event.engine,
          event.host,
          event.database,
          event.statementKind,
          event.statement,
          event.statementTruncated,
          event.rowsReturned,
          event.rowsAffected,
          event.error,
          event.queryId,
          event.id,
        ]),
      );
      content = [csvRow(headers), ...rows].join("\n");
    } else {
      content = jsonText(filteredEvents, 2);
    }
    downloadText(
      content,
      format === "csv" ? "text/csv" : "application/json",
      `audit_operations_${Date.now()}.${format}`,
    );
  };

  const successCount = events.filter((e) => e.result === "success").length;
  const successRate = events.length > 0 ? Math.round((successCount / events.length) * 100) : 0;

  return (
    <div className="space-y-4">
      {/* Filter Bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <Select value={typeFilter} onValueChange={handleTypeChange}>
          <SelectTrigger aria-label="Event type" className="w-[160px] h-8 text-xs bg-panel border-hairline-strong">
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
        <Input
          placeholder="Search..."
          aria-label="Search action, target, connection or statement"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-[180px] h-8 text-xs bg-panel border-hairline-strong"
        />
        <Input
          placeholder="User..."
          aria-label="Filter by user"
          value={userQuery}
          onChange={(e) => setUserQuery(e.target.value)}
          className="w-[120px] h-8 text-xs bg-panel border-hairline-strong"
        />
        <Input
          placeholder="IP..."
          aria-label="Filter by IP"
          value={ipQuery}
          onChange={(e) => setIpQuery(e.target.value)}
          className="w-[120px] h-8 text-xs bg-panel border-hairline-strong"
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
        <AuditExport disabled={loading || filteredEvents.length === 0} onExport={exportEvents} />
      </div>

      {/* Stats Summary */}
      <div className="flex items-center gap-4 text-xs text-fg-muted">
        <span>
          Total: <span className="font-bold text-fg-secondary">{events.length}</span> ops
        </span>
        <span>
          Success: <span className="font-bold text-success">{successRate}%</span>
        </span>
      </div>

      {/* Events Table */}
      <div className="rounded-xl border border-hairline bg-panel overflow-hidden">
        {loading && events.length === 0 ? (
          <div className="p-4 space-y-2">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-10 w-full bg-overlay" />
            ))}
          </div>
        ) : filteredEvents.length === 0 ? (
          <div className="p-8 text-center text-fg-subtle text-sm">
            <Wrench className="h-8 w-8 mx-auto mb-2 opacity-30" />
            <p>No audit events found.</p>
            <p className="text-xs mt-1 text-fg-faint">Operations will appear here when maintenance tasks are run.</p>
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
    </div>
  );
}

function QueryAudit() {
  // Read once, at mount: the initializer runs only on the initial render, so the
  // localStorage hit does not repeat and `history`'s identity stays stable.
  const [history] = useState<QueryHistoryItem[]>(() => storage.getHistory());
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const filteredHistory = useMemo(() => {
    let items = history;
    if (statusFilter !== "all") {
      items = items.filter((h) => h.status === statusFilter);
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      items = items.filter(
        (h) => h.query.toLowerCase().includes(q) || (h.connectionName || "").toLowerCase().includes(q),
      );
    }
    return items;
  }, [history, searchQuery, statusFilter]);

  const exportHistory = (format: "csv" | "json") => {
    downloadText(
      queryHistoryText(filteredHistory, format),
      format === "csv" ? "text/csv" : "application/json",
      `query_history_${Date.now()}.${format}`,
    );
  };

  const successCount = history.filter((h) => h.status === "success").length;
  const successRate = history.length > 0 ? Math.round((successCount / history.length) * 100) : 0;

  return (
    <div className="space-y-4">
      {/* Filter Bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[120px] h-8 text-xs bg-panel border-hairline-strong">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="success">Success</SelectItem>
            <SelectItem value="error">Error</SelectItem>
          </SelectContent>
        </Select>
        <Input
          placeholder="Search query..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-[200px] h-8 text-xs bg-panel border-hairline-strong"
        />
        <div className="text-xs text-fg-muted ml-auto">
          <span className="font-bold text-fg-secondary">{history.length}</span> queries
          <span className="mx-2">&middot;</span>
          <span className="text-success font-bold">{successRate}%</span> success
        </div>
        <AuditExport disabled={filteredHistory.length === 0} onExport={exportHistory} />
      </div>

      {/* Query History Table */}
      <div className="rounded-xl border border-hairline bg-panel overflow-hidden">
        {filteredHistory.length === 0 ? (
          <div className="p-8 text-center text-fg-subtle text-sm">
            <SearchIcon className="h-8 w-8 mx-auto mb-2 opacity-30" />
            <p>No query history found.</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="border-hairline hover:bg-transparent">
                <TableHead className="text-xs text-fg-muted font-bold uppercase w-[30px]" />
                <TableHead className="text-xs text-fg-muted font-bold uppercase">Time</TableHead>
                <TableHead className="text-xs text-fg-muted font-bold uppercase">Query</TableHead>
                <TableHead className="text-xs text-fg-muted font-bold uppercase hidden md:table-cell">
                  Connection
                </TableHead>
                <TableHead className="text-right text-xs text-fg-muted font-bold uppercase">Duration</TableHead>
                <TableHead className="text-right text-xs text-fg-muted font-bold uppercase hidden sm:table-cell">
                  Rows
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredHistory.slice(0, 200).map((item, idx) => (
                <TableRow key={idx} className="border-hairline hover:bg-fill">
                  <TableCell className="py-2">
                    {item.status === "success" ? (
                      <CircleCheck className="w-3.5 h-3.5 text-success" />
                    ) : (
                      <CircleX className="w-3.5 h-3.5 text-danger" />
                    )}
                  </TableCell>
                  <TableCell className="py-2 font-mono text-xs text-fg-muted whitespace-nowrap">
                    {new Date(item.executedAt).toLocaleString([], {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </TableCell>
                  <TableCell className="py-2">
                    <div className="font-mono text-xs text-fg-tertiary truncate max-w-[250px] lg:max-w-[400px]">
                      {item.query}
                    </div>
                  </TableCell>
                  <TableCell className="py-2 text-xs text-fg-muted hidden md:table-cell truncate max-w-[100px]">
                    {item.connectionName || "-"}
                  </TableCell>
                  <TableCell className="py-2 text-right font-mono text-xs text-fg-muted">
                    {item.executionTime}ms
                  </TableCell>
                  <TableCell className="py-2 text-right font-mono text-xs text-fg-muted hidden sm:table-cell">
                    {item.rowCount ?? "-"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

function AuditStats() {
  // Read once, at mount — see QueryAudit above.
  const [history] = useState<QueryHistoryItem[]>(() => storage.getHistory());
  const tooltipStyle = chartTooltipStyle(useEffectiveTheme());

  const stats = useMemo(() => {
    const total = history.length;
    const successful = history.filter((h) => h.status === "success").length;
    const successRate = total > 0 ? Math.round((successful / total) * 100) : 0;
    const avgTime = total > 0 ? Math.round(history.reduce((sum, h) => sum + h.executionTime, 0) / total) : 0;

    const now = new Date();
    const byDay: { day: string; count: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const dayStart = startOfDay(subDays(now, i));
      const dayEnd = startOfDay(subDays(now, i - 1));
      const count = history.filter((h) => {
        const t = new Date(h.executedAt).getTime();
        return t >= dayStart.getTime() && t < dayEnd.getTime();
      }).length;
      byDay.push({ day: format(dayStart, "EEE"), count });
    }

    // Most active connections
    const freq: Record<string, { name: string; count: number }> = {};
    for (const h of history) {
      const key = h.connectionId;
      if (!freq[key]) {
        freq[key] = { name: h.connectionName || key.slice(0, 8), count: 0 };
      }
      freq[key].count++;
    }
    const topConnections = Object.values(freq)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return { total, successful, successRate, avgTime, byDay, topConnections };
  }, [history]);

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="rounded-xl border border-hairline bg-panel p-4">
          <div className="text-xs text-fg-muted mb-1">Total Queries</div>
          <div className="text-2xl font-bold text-fg tabular-nums">{stats.total}</div>
        </div>
        <div className="rounded-xl border border-hairline bg-panel p-4">
          <div className="text-xs text-fg-muted mb-1">Success Rate</div>
          <div className="text-2xl font-bold text-success tabular-nums">{stats.successRate}%</div>
          <Progress value={stats.successRate} className="h-1 mt-2" />
        </div>
        <div className="rounded-xl border border-hairline bg-panel p-4">
          <div className="text-xs text-fg-muted mb-1">Avg Duration</div>
          <div className="text-2xl font-bold text-fg tabular-nums">
            {stats.avgTime}
            <span className="text-sm text-fg-muted ml-1">ms</span>
          </div>
        </div>
        <div className="rounded-xl border border-hairline bg-panel p-4">
          <div className="text-xs text-fg-muted mb-1">Failed</div>
          <div className="text-2xl font-bold text-danger tabular-nums">{stats.total - stats.successful}</div>
        </div>
      </div>

      {/* Query Activity Chart */}
      <div className="grid gap-6 md:grid-cols-2">
        <div className="rounded-xl border border-hairline bg-panel p-5">
          <h3 className="text-sm font-bold text-fg-secondary mb-4 flex items-center gap-2">
            <Activity className="h-4 w-4 text-brand" />
            Query Activity (7 days)
          </h3>
          {stats.total === 0 ? (
            <div className="flex items-center justify-center py-8 text-sm text-fg-subtle">No query history yet.</div>
          ) : (
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stats.byDay}>
                  <XAxis dataKey="day" tick={{ fontSize: 11, fill: "#71717a" }} axisLine={false} tickLine={false} />
                  <YAxis
                    allowDecimals={false}
                    tick={{ fontSize: 11, fill: "#71717a" }}
                    axisLine={false}
                    tickLine={false}
                    width={30}
                  />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="count" name="Queries" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Most Active Connections */}
        <div className="rounded-xl border border-hairline bg-panel p-5">
          <h3 className="text-sm font-bold text-fg-secondary mb-4 flex items-center gap-2">
            <Clock className="h-4 w-4 text-brand" />
            Most Active Connections
          </h3>
          {stats.topConnections.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-sm text-fg-subtle">No data yet.</div>
          ) : (
            <div className="space-y-3">
              {stats.topConnections.map((tc) => {
                const pct = stats.total > 0 ? Math.round((tc.count / stats.total) * 100) : 0;
                return (
                  <div key={tc.name} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="truncate max-w-[160px] text-fg-tertiary">{tc.name}</span>
                      <span className="text-fg-muted">
                        {tc.count} ({pct}%)
                      </span>
                    </div>
                    <Progress value={pct} className="h-1" />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
