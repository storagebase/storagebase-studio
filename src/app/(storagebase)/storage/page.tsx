import { SectionShell } from "@/components/storagebase/sections/SectionShell";
import {
  renderSectionPage,
  sectionMetadata,
  type SectionSearchParams,
} from "@/components/storagebase/sections/section-route";

export const metadata = sectionMetadata("blob");

export default async function StoragePage({ searchParams }: { searchParams: SectionSearchParams }) {
  return <SectionShell>{await renderSectionPage("blob", searchParams)}</SectionShell>;
}
