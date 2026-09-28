import type { Metadata } from "next";
import type { ResourceCategory } from "@/lib/resources/types";
import { ResourceSectionPage } from "./ResourceSectionPage";
import { sectionById } from "./sections";

/** What a section route's `searchParams` may carry: `?connection=<id>`, possibly repeated. */
export type SectionSearchParams = Promise<{ connection?: string | string[] }>;

/** The browser tab names the section, so four open sections are four tabs you can tell apart. */
export function sectionMetadata(category: ResourceCategory): Metadata {
  return { title: `${sectionById(category).label} | StorageBase Studio` };
}

/**
 * The body of every resource section route: the deep link read off the
 * request (the first value when repeated) and handed to the page, which
 * opens that connection once it has loaded.
 */
export async function renderSectionPage(category: ResourceCategory, searchParams: SectionSearchParams) {
  const { connection } = await searchParams;
  const initialConnectionId = (Array.isArray(connection) ? connection[0] : connection) ?? null;
  return <ResourceSectionPage category={category} initialConnectionId={initialConnectionId} />;
}
