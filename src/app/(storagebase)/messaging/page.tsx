import { SectionShell } from "@/components/storagebase/sections/SectionShell";
import {
  renderSectionPage,
  sectionMetadata,
  type SectionSearchParams,
} from "@/components/storagebase/sections/section-route";

export const metadata = sectionMetadata("messaging");

export default async function MessagingPage({ searchParams }: { searchParams: SectionSearchParams }) {
  return <SectionShell>{await renderSectionPage("messaging", searchParams)}</SectionShell>;
}
