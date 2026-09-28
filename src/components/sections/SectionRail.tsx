"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType } from "react";
import { Settings } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { SECTIONS, sectionForPathname } from "./sections";

/**
 * The section rail: a narrow column of icon links on the far left that
 * switches between the four management pages, with Admin at the bottom for
 * admins. Below the breakpoint it becomes a strip across the top with a short
 * label under each icon, so it never competes with the Databases page's own
 * bottom tab bar.
 *
 * Every item is a real link (`aria-current="page"` on the one you are on), so
 * sections open in a new tab and survive a reload. Icon-only items carry
 * their label as the accessible name and as a tooltip.
 */
export function SectionRail() {
  const active = sectionForPathname(usePathname());
  const { isAdmin } = useAuth();

  return (
    <nav
      aria-label="Sections"
      data-testid="section-rail"
      className="shrink-0 flex items-center gap-1 px-2 h-14 border-b border-hairline bg-sunken md:h-full md:w-14 md:flex-col md:px-0 md:py-3 md:border-b-0 md:border-r"
    >
      {SECTIONS.map((section) => (
        <RailLink
          key={section.id}
          href={section.href}
          label={section.label}
          shortLabel={section.shortLabel}
          icon={section.icon}
          active={section.id === active}
        />
      ))}
      {isAdmin && (
        <RailLink
          href="/admin"
          label="Admin"
          shortLabel="Admin"
          icon={Settings}
          active={false}
          className="md:mt-auto"
        />
      )}
    </nav>
  );
}

function RailLink({
  href,
  label,
  shortLabel,
  icon: Icon,
  active,
  className,
}: {
  href: string;
  label: string;
  shortLabel: string;
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
  active: boolean;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={href}
          aria-label={label}
          aria-current={active ? "page" : undefined}
          data-testid="section-rail-link"
          className={cn(
            "flex flex-1 flex-col items-center justify-center gap-0.5 rounded-lg h-11 transition-colors md:flex-none md:w-10 md:h-10",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-tint/50",
            active ? "bg-brand-tint/15 text-brand" : "text-fg-muted hover:text-fg hover:bg-fill",
            className,
          )}
        >
          <Icon strokeWidth={1.5} className="w-5 h-5" />
          {/* The strip's visible label; the rail is icon-only and names itself through aria-label. */}
          <span aria-hidden="true" className="text-xs leading-none font-medium md:hidden">
            {shortLabel}
          </span>
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right" className="hidden md:block">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
