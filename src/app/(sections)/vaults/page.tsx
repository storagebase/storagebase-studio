import { renderSectionPage, sectionMetadata, type SectionSearchParams } from "@/components/sections/section-route";

export const metadata = sectionMetadata("vault");

export default function VaultsPage({ searchParams }: { searchParams: SectionSearchParams }) {
  return renderSectionPage("vault", searchParams);
}
