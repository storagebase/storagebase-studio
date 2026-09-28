/**
 * A resource route's refusal as a sentence to show. The routes answer
 * `{ error }` (`handleResourceRequest`, `createErrorResponse`); `message` is
 * the older shape, still read so nothing that speaks it goes quiet. A body
 * that is not JSON falls back to the caller's own words.
 */
export async function routeRefusal(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown; message?: unknown } | null;
  if (typeof body?.error === "string") return body.error;
  if (typeof body?.message === "string") return body.message;
  return fallback;
}
