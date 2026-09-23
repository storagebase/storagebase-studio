import { appFetch } from "@/lib/config/base-path";
import type { ResourceConnection } from "@/lib/resources/types";

/**
 * The workbench's one door to its routes (`/api/resources/kafka/<route>`).
 * Every route takes `{ connection, ...args }` and answers JSON; a refusal
 * answers `{ error }`, which this turns into a thrown Error carrying the
 * server's sentence — the panels show that sentence, never a generic one.
 */
export async function postKafka<T>(
  connection: ResourceConnection,
  route: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const response = await appFetch(`/api/resources/kafka/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ connection, ...payload }),
  });
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status})`);
  return body as T;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Pretty-printed JSON when the text parses as an object or array; the text itself otherwise. */
export function formatPayload(text: string | null): string {
  if (text === null) return "";
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}

/** Epoch milliseconds (as Kafka reports them) to a UTC stamp, the same on every viewer's clock. */
export function formatTimestamp(timestamp: string): string {
  const millis = Number(timestamp);
  if (!Number.isFinite(millis) || millis < 0) return timestamp;
  return new Date(millis).toISOString().replace("T", " ").replace("Z", "");
}

/**
 * `name=value` per line to a map (blank lines skipped) — how the create-topic
 * configs and the produce headers are typed. Answers the first bad line's
 * sentence instead of a map when a line has no `=` or no name.
 */
export function parseKeyValueLines(text: string): Record<string, string> | string {
  const entries: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const separator = line.indexOf("=");
    const name = separator === -1 ? "" : line.slice(0, separator).trim();
    if (name === "") return `"${line.trim()}" is not name=value`;
    entries[name] = line.slice(separator + 1).trim();
  }
  return entries;
}
