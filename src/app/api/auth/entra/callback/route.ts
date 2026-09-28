import { completeEntraSignIn } from "@/lib/entra/flow";

export const dynamic = "force-dynamic";

/** The Entra redirect URI (StorageBase fork): completes the exchange that creates the session. See docs/ENTRA.md. */
export async function GET(request: Request) {
  return completeEntraSignIn(request);
}
