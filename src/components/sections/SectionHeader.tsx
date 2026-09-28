"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Lock, LogOut, Pencil, Settings, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ThemeToggle } from "@/components/theme-toggle";
import type { ResourceHealthState } from "@/hooks/use-resource-health";
import { getResourceIcon, RESOURCE_UI_CONFIG } from "@/lib/resources/ui-config";
import { isManagedResourceConnection, type ResourceConnection } from "@/lib/resources/types";
import { cn } from "@/lib/utils";
import type { SectionDefinition } from "./sections";

const STATUS: Record<ResourceHealthState["status"], { label: string; dot: string }> = {
  checking: { label: "Checking…", dot: "bg-fg-subtle animate-pulse" },
  healthy: { label: "Online", dot: "bg-success-tint" },
  degraded: { label: "Degraded", dot: "bg-warning-tint" },
  error: { label: "Error", dot: "bg-danger-tint" },
};

/**
 * An endpoint as it is safe to print: user-info in a URL (`amqp://user:pass@host`)
 * is a credential, so it never reaches the header.
 */
export function displayEndpoint(endpoint: string): string {
  return endpoint.replace(/\/\/[^/@]*@/, "//");
}

interface SectionHeaderProps {
  section: SectionDefinition;
  /** The page's active connection — this section's only; the header never names another family's. */
  connection: ResourceConnection | null;
  health: ResourceHealthState | null;
  user: { role?: string } | null;
  isAdmin: boolean;
  onLogout: () => void;
  /** Present for a connection the viewer owns; a managed one is not theirs to edit. */
  onEdit?: (conn: ResourceConnection) => void;
  /** Below the breakpoint, while a connection's detail fills the page: back to the list. */
  onBack?: () => void;
}

/**
 * A resource section page's header: the section's active connection — name,
 * type, environment, status — and the viewer's menu. The parallel of
 * `StudioDesktopHeader` and `StudioMobileHeader` in one responsive bar,
 * fork-owned so the upstream headers keep showing databases only.
 */
export function SectionHeader({
  section,
  connection,
  health,
  user,
  isAdmin,
  onLogout,
  onEdit,
  onBack,
}: SectionHeaderProps) {
  const router = useRouter();
  const cfg = connection ? RESOURCE_UI_CONFIG[connection.type] : null;
  const managed = connection && isManagedResourceConnection(connection) ? connection : null;
  const status = health ? STATUS[health.status] : null;
  const endpoint = connection?.endpoint ? displayEndpoint(connection.endpoint) : null;

  return (
    <header
      data-testid="section-header"
      className="h-14 shrink-0 border-b border-hairline flex items-center gap-2 md:gap-3 px-3 md:px-4 bg-surface/80 backdrop-blur-xl"
    >
      {onBack && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 shrink-0"
          aria-label="Back to connections"
          onClick={onBack}
        >
          <ArrowLeft strokeWidth={1.5} className="w-4 h-4" />
        </Button>
      )}
      <div className="p-1.5 rounded-lg bg-brand-tint/10 border border-brand-tint/20 shrink-0">
        {React.createElement(connection ? getResourceIcon(connection.type) : section.icon, {
          className: cn("w-3.5 h-3.5", cfg ? cfg.color : "text-brand"),
        })}
      </div>
      <div className="min-w-0">
        <h1 className="text-xs font-medium text-fg truncate">{connection ? connection.name : section.label}</h1>
        <p className="text-xs text-fg-muted leading-none mt-0.5 truncate">
          {connection && cfg ? (
            <>
              <span className="font-mono uppercase">{cfg.label}</span>
              {connection.environment && connection.environment !== "other" && (
                <span className="ml-1 font-medium" style={{ color: connection.color || "#22c55e" }}>
                  • {connection.environment}
                </span>
              )}
              {endpoint && <span className="ml-1 font-mono hidden md:inline">• {endpoint}</span>}
            </>
          ) : (
            "No connection selected"
          )}
        </p>
      </div>

      <div className="ml-auto flex items-center gap-1 md:gap-2 shrink-0">
        {status && (
          <div
            data-testid="section-status"
            data-status={health?.status}
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-fill"
            title={health && "message" in health && health.message ? health.message : undefined}
          >
            <span className={cn("w-2 h-2 rounded-full", status.dot)} />
            <span className="text-xs font-medium text-fg-muted">{status.label}</span>
          </div>
        )}
        {managed && (
          <span
            data-testid="section-managed"
            className="hidden sm:inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-fill text-xs text-fg-muted"
          >
            <Lock strokeWidth={1.5} className="w-3 h-3" aria-hidden="true" />
            Managed{managed.permission === "read" ? " · read-only" : ""}
          </span>
        )}
        {connection && !managed && onEdit && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            aria-label="Edit connection"
            onClick={() => onEdit(connection)}
          >
            <Pencil strokeWidth={1.5} className="w-3.5 h-3.5" />
          </Button>
        )}
        {user && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 gap-2 hover:bg-fill px-2" aria-label="Account menu">
                <User strokeWidth={1.5} className="w-3 h-3 text-brand" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56 bg-raised border-hairline-strong text-fg-secondary">
              {isAdmin && (
                <DropdownMenuItem onClick={() => router.push("/admin")} className="cursor-pointer">
                  <Settings strokeWidth={1.5} className="w-3.5 h-3.5 mr-2" /> Admin Dashboard
                </DropdownMenuItem>
              )}
              {/* The bar has no room for the theme toggle on a phone, so it is a row here instead. */}
              <ThemeToggle showLabel className="w-full px-2 py-1.5 text-sm md:hidden" />
              <DropdownMenuItem onClick={onLogout} className="text-danger cursor-pointer">
                <LogOut strokeWidth={1.5} className="w-3.5 h-3.5 mr-2" /> Logout
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <ThemeToggle className="hidden md:flex" />
        <span className="hidden md:inline text-xs text-fg-muted font-mono">v{process.env.NEXT_PUBLIC_APP_VERSION}</span>
      </div>
    </header>
  );
}
