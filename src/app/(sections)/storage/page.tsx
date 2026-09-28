import { renderSectionPage, sectionMetadata, type SectionSearchParams } from "@/components/sections/section-route";

export const metadata = sectionMetadata("blob");

export default function StoragePage({ searchParams }: { searchParams: SectionSearchParams }) {
  return renderSectionPage("blob", searchParams);
}
