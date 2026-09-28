import LoginForm from "./login-form";
import { loginProviders } from "@/lib/access/auth-settings";

// Force dynamic rendering so env vars are read at runtime, not build time.
// This is critical for Docker deployments where NEXT_PUBLIC_AUTH_PROVIDER
// is set as a runtime env var (not available during docker build).
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const authProvider = process.env.NEXT_PUBLIC_AUTH_PROVIDER || "local";
  // StorageBase fork: which sign-in methods to offer, from the runtime sign-in switch.
  return <LoginForm authProvider={authProvider} providers={await loginProviders()} />;
}
