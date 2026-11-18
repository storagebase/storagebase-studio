import { SectionShell } from "@/components/storagebase/sections/SectionShell";
import {
  renderSectionPage,
  sectionMetadata,
  type SectionSearchParams,
} from "@/components/storagebase/sections/section-route";

export const metadata = sectionMetadata("vault");

export default async function VaultsPage({ searchParams }: { searchParams: SectionSearchParams }) {
  return <SectionShell>{await renderSectionPage("vault", searchParams)}</SectionShell>;
}
