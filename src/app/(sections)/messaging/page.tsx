import { renderSectionPage, sectionMetadata, type SectionSearchParams } from "@/components/sections/section-route";

export const metadata = sectionMetadata("messaging");

export default function MessagingPage({ searchParams }: { searchParams: SectionSearchParams }) {
  return renderSectionPage("messaging", searchParams);
}
