import type { ComponentType } from "react";
import { Database, HardDrive, KeyRound, MessagesSquare } from "lucide-react";
import type { ResourceCategory } from "@/lib/resources/types";

/**
 * The four management pages the section rail switches between (StorageBase
 * fork). Databases is the upstream studio at `/`; each resource category gets
 * its own page, connection list and header, so a page never shows another
 * family's active connection.
 */

export type SectionId = "databases" | ResourceCategory;

export interface SectionDefinition {
  id: SectionId;
  href: string;
  /** The rail tooltip, the page title and the accessible name. */
  label: string;
  /** What the mobile strip prints under the icon, where the full label does not fit. */
  shortLabel: string;
  /** How the page talks about its connections: "No messaging connections yet." */
  connectionNoun: string;
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
}

export const SECTIONS: readonly SectionDefinition[] = [
  {
    id: "databases",
    href: "/",
    label: "Databases",
    shortLabel: "DB",
    connectionNoun: "database",
    icon: Database,
  },
  {
    id: "blob",
    href: "/storage",
    label: "Blob storage",
    shortLabel: "Blob",
    connectionNoun: "blob storage",
    icon: HardDrive,
  },
  {
    id: "messaging",
    href: "/messaging",
    label: "Messaging",
    shortLabel: "MQ",
    connectionNoun: "messaging",
    icon: MessagesSquare,
  },
  {
    id: "vault",
    href: "/vaults",
    label: "Vaults",
    shortLabel: "Vaults",
    connectionNoun: "vault",
    icon: KeyRound,
  },
];

export function sectionById(id: SectionId): SectionDefinition {
  // Every SectionId has exactly one entry above, so the lookup cannot miss.
  return SECTIONS.find((section) => section.id === id) as SectionDefinition;
}

/**
 * Which section a path belongs to. `/storage/anything` is still Blob storage;
 * anything that is no section's (the root included) is Databases, the page
 * the rail falls back to.
 */
export function sectionForPathname(pathname: string | null): SectionId {
  const match = SECTIONS.find(
    (section) => section.href !== "/" && (pathname === section.href || pathname?.startsWith(`${section.href}/`)),
  );
  return match?.id ?? "databases";
}
