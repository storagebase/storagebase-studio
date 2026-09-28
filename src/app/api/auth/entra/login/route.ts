import { startEntraSignIn } from "@/lib/entra/flow";

export const dynamic = "force-dynamic";

/** Starts "Sign in with Microsoft" (StorageBase fork); `?test=1` is an administrator's test sign-in. See docs/ENTRA.md. */
export async function GET(request: Request) {
  return startEntraSignIn(request);
}
