import { NextResponse } from "next/server";
import { loginProviders } from "@/lib/access/auth-settings";

export const dynamic = "force-dynamic";

/**
 * Which sign-in methods the login page offers (StorageBase fork), decided at request time from the
 * sign-in switch rather than the build-time NEXT_PUBLIC_AUTH_PROVIDER. Public: the login page asks
 * before anyone is signed in, and the answer is four booleans that name no account and no tenant.
 */
export async function GET() {
  return NextResponse.json(await loginProviders());
}
