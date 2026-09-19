"use client";

import { appFetch } from "@/lib/config/base-path";
import { useState, useCallback } from "react";
import type { ConnectionEnvironment } from "@/lib/types";
import { ENVIRONMENT_COLORS } from "@/lib/types";
import { newLocalId } from "@/lib/ids";
import {
  RESOURCE_UI_CONFIG,
  selectableResourceTypes,
  takesResourceConnectionField,
  type ResourceCategory,
} from "@/lib/resources/ui-config";
import type { ResourceConnection, ResourceConnectionField, ResourceType } from "@/lib/resources/types";

/**
 * Form state for a resource connection — the parallel of `useConnectionForm`,
 * minus what this surface does not need.
 *
 * Differences from the database form, each deliberate:
 * - The inputs rendered are exactly `RESOURCE_UI_CONFIG[type].connectionFields`;
 *   `buildConnection` writes from the same list, so a box exists exactly where a
 *   value is written (the `takesConnectionField` ruling, applied here).
 * - No SSL/TLS or SSH tunnel sections. The factory owns no tunnel rewrite (see
 *   src/lib/resources/factory.ts): endpoint-shaped addressing makes "which
 *   host:port would a tunnel forward to" family knowledge, and a generic section
 *   would collect values nothing reads. Families own that when they land.
 * - No paste-URL. There is no URI grammar for "a Kafka bootstrap list, a Vault
 *   address, an S3 endpoint override" the way there is for database schemes, so
 *   a parser would be a guess wearing a feature's clothes.
 * - No query timeout or skip-scan: database concepts with no resource meaning.
 *
 * What IS mirrored: the degraded two-click save (the test route answers the
 * same degraded-success story), the edit-mode populate/reset discipline
 * (credentials may not leak from one dialog into the next), and the
 * field-ownership record so a field added to `ResourceConnection` fails
 * typecheck until someone decides whether this form owns it.
 */
type FieldOwnership = "edited" | "preserved" | "conditional";

const FIELD_OWNERSHIP: Record<keyof ResourceConnection, FieldOwnership> = {
  id: "edited",
  name: "edited",
  type: "edited",
  createdAt: "edited",
  // Preserve a custom color while the environment is unchanged; otherwise use its palette.
  color: "conditional",
  environment: "edited",
  endpoint: "edited",
  region: "edited",
  accessKeyId: "edited",
  secretAccessKey: "edited",
  sessionToken: "edited",
  connectionString: "edited",
  token: "edited",
  tenantId: "edited",
  clientId: "edited",
  clientSecret: "edited",
  vaultName: "edited",
  namespace: "edited",
  // No input owns these yet: the group is assigned elsewhere (sidebar), and the
  // tunnel belongs to the families (see above). Carried, never cleared.
  group: "preserved",
  sshTunnel: "preserved",
};

/** What survives an edit untouched. Empty for a new connection, which has no past. */
function preservedFields<T extends object>(
  source: T | null | undefined,
  ownership: Record<keyof T, FieldOwnership>,
): Partial<T> {
  if (!source) return {};
  const carried: Partial<T> = {};
  for (const key of Object.keys(ownership) as (keyof T)[]) {
    if (ownership[key] !== "preserved") continue;
    const value = source[key];
    if (value !== undefined) carried[key] = value;
  }
  return carried;
}

interface UseResourceConnectionFormProps {
  isOpen: boolean;
  onClose: () => void;
  onConnect: (conn: ResourceConnection) => void;
  editConnection?: ResourceConnection | null;
  /**
   * Optional API adapter: when provided, bypasses the built-in
   * /api/resources/test fetch (the embedded workspace carries no routes).
   */
  onTestConnection?: (connection: ResourceConnection) => Promise<TestOutcome>;
}

/** What the test route answers, in the shape both call sites read. */
export interface TestOutcome {
  success: boolean;
  degraded?: boolean;
  message: string;
  latencyMs?: number;
}

/**
 * What to show for a connection that exists and answers no health data.
 *
 * The server's own sentence, because it is the only thing that says which
 * surface refused, and a house phrasing would replace it with less.
 */
function degradedSentence(result: TestOutcome): string {
  return result.message || "Connected, but this service answered no health data.";
}

type TestResultTone = "success" | "warning" | "error";

export function useResourceConnectionForm({
  isOpen,
  onConnect,
  editConnection,
  onTestConnection,
}: UseResourceConnectionFormProps) {
  const [type, setType] = useState<ResourceType>("s3");
  const [name, setName] = useState("");
  const [environment, setEnvironment] = useState<ConnectionEnvironment>("local");
  const [endpoint, setEndpoint] = useState("");
  const [region, setRegion] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const [connectionString, setConnectionString] = useState("");
  const [token, setToken] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [vaultName, setVaultName] = useState("");
  const [namespace, setNamespace] = useState("");
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ tone: TestResultTone; message: string; latencyMs?: number } | null>(
    null,
  );
  /** Whether the user has been shown, and clicked past, a connection with no health surface. */
  const [degradedSaveAcknowledged, setDegradedSaveAcknowledged] = useState(false);

  const isEditMode = !!editConnection;

  const fieldSetters: Record<ResourceConnectionField, (value: string) => void> = {
    endpoint: setEndpoint,
    region: setRegion,
    accessKeyId: setAccessKeyId,
    secretAccessKey: setSecretAccessKey,
    sessionToken: setSessionToken,
    connectionString: setConnectionString,
    token: setToken,
    tenantId: setTenantId,
    clientId: setClientId,
    clientSecret: setClientSecret,
    vaultName: setVaultName,
    namespace: setNamespace,
  };

  const fieldValues: Record<ResourceConnectionField, string> = {
    endpoint,
    region,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    connectionString,
    token,
    tenantId,
    clientId,
    clientSecret,
    vaultName,
    namespace,
  };

  // Populate the form when editing — adjusted while rendering rather than in an
  // effect, per React's "adjusting some state when a prop changes" (the database
  // form's block documents why: an effect commits a frame of defaults first).
  // Overwritten, never conditionally set: a connection without a value must show
  // an empty field, or the previously edited connection's value is saved on.
  const [appliedEdit, setAppliedEdit] = useState<{ conn: ResourceConnection | null | undefined } | null>(null);
  if (!appliedEdit || appliedEdit.conn !== editConnection) {
    setAppliedEdit({ conn: editConnection });
    if (editConnection) {
      setType(editConnection.type);
      setName(editConnection.name);
      setEnvironment(editConnection.environment || "local");
      setEndpoint(editConnection.endpoint || "");
      setRegion(editConnection.region || "");
      setAccessKeyId(editConnection.accessKeyId || "");
      setSecretAccessKey(editConnection.secretAccessKey || "");
      setSessionToken(editConnection.sessionToken || "");
      setConnectionString(editConnection.connectionString || "");
      setToken(editConnection.token || "");
      setTenantId(editConnection.tenantId || "");
      setClientId(editConnection.clientId || "");
      setClientSecret(editConnection.clientSecret || "");
      setVaultName(editConnection.vaultName || "");
      setNamespace(editConnection.namespace || "");
    }
  }

  // Reset the form when the dialog closes, AND when the edit target goes away
  // while it is already closed — the same credential-leak guard as the database
  // form: editing X then opening Add must not show X's secrets.
  const [lastReset, setLastReset] = useState({ isOpen, isEditMode });
  if (isOpen !== lastReset.isOpen || isEditMode !== lastReset.isEditMode) {
    setLastReset({ isOpen, isEditMode });
    if (!isOpen) {
      setTestResult(null);
      setDegradedSaveAcknowledged(false);
      if (!editConnection) {
        setName("");
        setEnvironment("local");
        setType("s3");
        for (const setter of Object.values(fieldSetters)) setter("");
      }
    }
  }

  const buildConnection = useCallback((): ResourceConnection => {
    // Write only the addressing fields this type actually takes — the same list
    // the form renders inputs from. An empty string writes nothing: an endpoint
    // override the user did not type must not be stored as "".
    const addressedFields = new Set<string>(RESOURCE_UI_CONFIG[type].connectionFields);
    const addressed = Object.fromEntries(
      (Object.keys(fieldValues) as ResourceConnectionField[])
        .filter((field) => addressedFields.has(field) && fieldValues[field] !== "")
        .map((field) => [field, fieldValues[field]]),
    );

    return {
      // First, so a form-owned field always wins.
      ...preservedFields(editConnection, FIELD_OWNERSHIP),
      id: editConnection?.id || newLocalId(),
      name: name || `${type}-connection`,
      type,
      createdAt: editConnection?.createdAt || new Date().toISOString(),
      environment,
      color:
        editConnection?.color && (editConnection.environment ?? "local") === environment
          ? editConnection.color
          : ENVIRONMENT_COLORS[environment],
      ...addressed,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    editConnection,
    name,
    type,
    environment,
    endpoint,
    region,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    connectionString,
    token,
    tenantId,
    clientId,
    clientSecret,
    vaultName,
    namespace,
  ]);

  /** The one place the connection is probed, for both buttons. */
  const probeConnection = useCallback(
    async (conn: ResourceConnection): Promise<TestOutcome> => {
      if (onTestConnection) return await onTestConnection(conn);

      const response = await appFetch("/api/resources/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(conn),
      });

      return (await response.json()) as TestOutcome;
    },
    [onTestConnection],
  );

  const handleTestConnection = useCallback(async () => {
    setIsTesting(true);
    setTestResult(null);

    try {
      const result = await probeConnection(buildConnection());

      setTestResult({
        tone: !result.success ? "error" : result.degraded ? "warning" : "success",
        message: result.success
          ? result.degraded
            ? degradedSentence(result)
            : `Connected successfully${result.latencyMs ? ` (${result.latencyMs}ms)` : ""}`
          : result.message || "Connection failed",
        latencyMs: result.latencyMs,
      });
    } catch {
      setTestResult({ tone: "error", message: "Network error - could not reach server" });
    } finally {
      setIsTesting(false);
    }
  }, [buildConnection, probeConnection]);

  const handleConnect = useCallback(async () => {
    setIsTesting(true);
    setTestResult(null);

    try {
      const conn = buildConnection();
      const result = await probeConnection(conn);

      if (!result.success) {
        setTestResult({ tone: "error", message: result.message || "Connection failed" });
        return;
      }

      // A service that connects but answers no health data is usable (browse may
      // still work), so the save does not depend on the health surface — but it
      // may not become silent either. The first click reports the refusal in the
      // server's own words and saves nothing; only a second click saves.
      if (result.degraded === true && !degradedSaveAcknowledged) {
        setDegradedSaveAcknowledged(true);
        setTestResult({
          tone: "warning",
          message: `${degradedSentence(result)} Click ${
            isEditMode ? "Save Changes" : "Establish Connection"
          } again to save it anyway.`,
        });
        return;
      }

      onConnect(conn);
      setName("");
      setEnvironment("local");
      for (const setter of Object.values(fieldSetters)) setter("");
      setTestResult(null);
    } catch {
      setTestResult({ tone: "error", message: "Network error - could not reach server" });
    } finally {
      setIsTesting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildConnection, degradedSaveAcknowledged, isEditMode, onConnect, probeConnection]);

  return {
    type,
    setType,
    name,
    setName,
    environment,
    setEnvironment,
    fieldValues,
    setFieldValue: (field: ResourceConnectionField, value: string) => fieldSetters[field](value),
    takesField: (field: ResourceConnectionField) => takesResourceConnectionField(type, field),
    fieldsForType: RESOURCE_UI_CONFIG[type].connectionFields,
    isTesting,
    testResult,
    setTestResult,
    isEditMode,
    handleTestConnection,
    handleConnect,
    /** Types the picker may offer, optionally narrowed to one category. */
    selectableTypes: (category?: ResourceCategory) => selectableResourceTypes(category),
  };
}
