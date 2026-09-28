import type React from "react";
import { SectionShell } from "@/components/sections/SectionShell";

/**
 * The resource management pages (StorageBase fork) share one shell, so the
 * section rail stays mounted while you move between them. The Databases page
 * at `/` wraps itself in the same shell (src/app/page.tsx).
 */
export default function SectionsLayout({ children }: { children: React.ReactNode }) {
  return <SectionShell>{children}</SectionShell>;
}
