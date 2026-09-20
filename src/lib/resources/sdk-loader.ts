import { ResourceConfigError } from "./errors";

/**
 * The one dynamic-import shape every resource provider uses, with the two
 * properties the sqlite loader precedent established: results cache by
 * specifier (an SDK loads once per process), and a loader that cannot load
 * maps to `ResourceConfigError` carrying its install hint.
 *
 * The importer is injectable so the failure arm is a property of a unit test
 * rather than of whichever environment runs it (the `loadSQLiteDriver`
 * ruling): ten provider-local try/catch copies would each need an
 * uninstall-the-SDK test, which is one file per SDK and proves nothing about
 * the other nine.
 *
 * The default importer carries the bundler-ignore comments: providers resolve
 * inside client graphs through Studio's registration, and node-only SDKs
 * (kafkajs, amqplib) must never enter the browser bundle. Server resolution
 * is untouched — `serverExternalPackages` keeps the runtime require.
 */
const sdkCache = new Map<string, unknown>();

export async function loadResourceSdk<T>(
  specifier: string,
  label: string,
  installHint: string,
  importer: () => Promise<T> = () =>
    import(/* turbopackIgnore: true */ /* webpackIgnore: true */ specifier) as Promise<T>,
): Promise<T> {
  const cached = sdkCache.get(specifier);
  if (cached !== undefined) return cached as T;
  try {
    const loaded = await importer();
    sdkCache.set(specifier, loaded);
    return loaded;
  } catch {
    throw new ResourceConfigError(`${label} is not available in this environment. Install it with: ${installHint}`);
  }
}
