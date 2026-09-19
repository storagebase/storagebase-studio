"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CircleCheck, CircleX, TriangleAlert } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/utils";
import type { ConnectionEnvironment } from "@/lib/types";
import { ENVIRONMENT_COLORS, ENVIRONMENT_LABELS } from "@/lib/types";
import { useResourceConnectionForm, type TestOutcome } from "@/hooks/use-resource-connection-form";
import { RESOURCE_CATEGORY_LABELS, RESOURCE_UI_CONFIG, type ResourceConnectionField } from "@/lib/resources/ui-config";
import type { ResourceCategory, ResourceConnection, ResourceType } from "@/lib/resources/types";

/**
 * The resource half of the connection dialog — the parallel of the database
 * form inside `ConnectionModal`, held to the same contract: the inputs rendered
 * are exactly `RESOURCE_UI_CONFIG[type].connectionFields`, so a box exists
 * exactly where a value is written.
 *
 * A type appears in the picker only when its provider module is REGISTERED
 * (`selectableResourceTypes`); otherwise the category shows an empty state
 * rather than a connectable-looking tile that would answer 501.
 */

interface FieldMeta {
  label: string;
  placeholder: string;
  /** Rendered as a password input; never logged, never rendered back. */
  secret?: boolean;
  mono?: boolean;
}

/** Exhaustive: a connection field without copy here fails typecheck. */
const FIELD_META: Record<ResourceConnectionField, FieldMeta> = {
  endpoint: { label: "Endpoint", placeholder: "Service address" },
  region: { label: "Region", placeholder: "us-east-1" },
  accessKeyId: { label: "Access Key ID", placeholder: "AKIA…", mono: true },
  secretAccessKey: { label: "Secret Access Key", placeholder: "***", secret: true },
  sessionToken: { label: "Session Token (optional)", placeholder: "***", secret: true },
  connectionString: {
    label: "Connection String",
    placeholder: "amqp://user:pass@host:5672/vhost",
    secret: true,
    mono: true,
  },
  token: { label: "Token", placeholder: "***", secret: true },
  tenantId: { label: "Tenant ID", placeholder: "00000000-0000-0000-0000-000000000000", mono: true },
  clientId: { label: "Client ID", placeholder: "00000000-0000-0000-0000-000000000000", mono: true },
  clientSecret: { label: "Client Secret", placeholder: "***", secret: true },
  accountKey: { label: "Account Key (or Entra ID above)", placeholder: "***", secret: true },
  vaultName: { label: "Vault Name", placeholder: "my-vault" },
  namespace: { label: "Namespace (optional)", placeholder: "ns1" },
};

/** Endpoint examples are addressing facts from the M1 type contracts, not guesses. */
const ENDPOINT_PLACEHOLDERS: Partial<Record<ResourceType, string>> = {
  s3: "https://s3.amazonaws.com  or  http://localhost:9000",
  "azure-blob": "https://myaccount.blob.core.windows.net",
  kafka: "broker1:9092,broker2:9092",
  rabbitmq: "amqp://user:pass@host:5672/vhost",
  sqs: "https://sqs.us-east-1.amazonaws.com",
  "hashicorp-vault": "https://vault.example.com:8200",
  openbao: "https://openbao.example.com:8200",
};

interface ResourceConnectionFormProps {
  category: ResourceCategory;
  isOpen: boolean;
  onClose: () => void;
  onConnect: (conn: ResourceConnection) => void;
  editConnection?: ResourceConnection | null;
  onTestConnection?: (connection: ResourceConnection) => Promise<TestOutcome>;
}

export function ResourceConnectionForm({
  category,
  isOpen,
  onClose,
  onConnect,
  editConnection,
  onTestConnection,
}: ResourceConnectionFormProps) {
  const form = useResourceConnectionForm({
    isOpen,
    onClose,
    onConnect,
    editConnection,
    onTestConnection,
    category,
  });
  const selectable = form.selectableTypes(category);

  if (selectable.length === 0) {
    return (
      <div className="p-4 rounded-lg border border-hairline bg-panel space-y-2">
        <p className="text-xs font-medium text-fg-secondary">No {RESOURCE_CATEGORY_LABELS[category]} providers yet</p>
        <p className="text-xs text-fg-muted">
          This build has no registered {RESOURCE_CATEGORY_LABELS[category].toLowerCase()} provider module, so there is
          nothing to connect to. Provider modules arrive with the family milestones.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 md:space-y-6">
      {/* Connection Name - always visible */}
      <div className="space-y-2">
        <Label htmlFor="resource-name" className="text-xs font-mediumr text-fg-muted">
          Connection Name
        </Label>
        <Input
          id="resource-name"
          value={form.name}
          onChange={(e) => form.setName(e.target.value)}
          placeholder="My Resource"
          className="h-10 bg-panel border-hairline focus:border-brand-tint/50 transition-all text-xs"
        />
      </div>

      {/* Environment Selector */}
      <div className="space-y-2">
        <Label className="text-xs font-mediumr text-fg-muted">Environment</Label>
        <div className="flex flex-wrap items-center gap-2">
          {(Object.keys(ENVIRONMENT_COLORS) as ConnectionEnvironment[]).map((env) => (
            <button
              key={env}
              onClick={() => form.setEnvironment(env)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-mediumr transition-all border",
                form.environment === env
                  ? "border-edge bg-fill text-fg"
                  : "border-transparent text-fg-muted hover:text-fg-secondary hover:bg-fill",
              )}
            >
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: ENVIRONMENT_COLORS[env] }} />
              {env === "other" ? "Other" : ENVIRONMENT_LABELS[env]}
            </button>
          ))}
        </div>
      </div>

      {/* Resource Type Selector */}
      <div className="grid grid-cols-2 gap-3">
        {selectable.map((resourceType) => {
          const cfg = RESOURCE_UI_CONFIG[resourceType];
          const selected = form.type === resourceType;
          return (
            <button
              key={resourceType}
              onClick={() => {
                form.setType(resourceType);
                form.setTestResult(null);
              }}
              disabled={form.isEditMode}
              className={cn(
                "flex flex-col items-center justify-center p-3 md:p-4 rounded-xl border transition-all duration-200 gap-2 group",
                selected
                  ? "bg-brand-solid/10 border-brand-tint/50 shadow-[0_0_20px_rgba(59,130,246,0.1)]"
                  : "bg-panel border-hairline hover:border-hairline-strong hover:bg-raised",
                form.isEditMode && !selected && "opacity-30 cursor-not-allowed",
              )}
            >
              <cfg.icon
                className={cn(
                  "w-6 h-6 mb-1 transition-transform group-hover:scale-110",
                  selected ? cfg.color : "text-fg-subtle",
                )}
              />
              <span className={cn("text-xs font-medium", selected ? "text-fg" : "text-fg-muted")}>{cfg.label}</span>
            </button>
          );
        })}
      </div>

      {/* Per-type fields */}
      <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
        {form.fieldsForType.map((field) => {
          const meta = FIELD_META[field];
          const fieldId = `resource-${field}`;
          const placeholder =
            field === "endpoint" && ENDPOINT_PLACEHOLDERS[form.type]
              ? ENDPOINT_PLACEHOLDERS[form.type]
              : meta.placeholder;
          return (
            <div key={field} className="space-y-2">
              <Label htmlFor={fieldId} className="text-xs font-mediumr text-fg-muted">
                {meta.label}
              </Label>
              <Input
                id={fieldId}
                type={meta.secret ? "password" : undefined}
                value={form.fieldValues[field]}
                onChange={(e) => form.setFieldValue(field, e.target.value)}
                placeholder={placeholder}
                autoComplete={meta.secret ? "new-password" : "off"}
                className={cn(
                  "h-10 bg-panel border-hairline focus:border-brand-tint/50 transition-all text-xs",
                  meta.mono && "font-mono",
                )}
              />
            </div>
          );
        })}
      </div>

      {/* Test Result */}
      <AnimatePresence>
        {form.testResult && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div
              data-testid="resource-connection-test-result"
              data-tone={form.testResult.tone}
              className={cn(
                "flex items-center gap-2 p-3 rounded-lg border text-xs",
                form.testResult.tone === "success"
                  ? "bg-success-tint/5 border-success-tint/20 text-success"
                  : form.testResult.tone === "warning"
                    ? "bg-warning-tint/5 border-warning-tint/20 text-warning"
                    : "bg-danger-tint/5 border-danger-tint/20 text-danger",
              )}
            >
              {form.testResult.tone === "success" ? (
                <CircleCheck strokeWidth={1.5} className="w-3.5 h-3.5 shrink-0" />
              ) : form.testResult.tone === "warning" ? (
                <TriangleAlert strokeWidth={1.5} className="w-3.5 h-3.5 shrink-0" />
              ) : (
                <CircleX strokeWidth={1.5} className="w-3.5 h-3.5 shrink-0" />
              )}
              <span className="leading-relaxed">{form.testResult.message}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Footer */}
      <div className="flex flex-col-reverse gap-3 md:flex-row md:items-center md:justify-between">
        <Button
          variant="ghost"
          onClick={onClose}
          className="w-full md:w-auto text-fg-muted hover:text-fg hover:bg-fill text-xs font-medium"
        >
          Cancel
        </Button>
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-2">
          <Button
            variant="outline"
            onClick={form.handleTestConnection}
            disabled={form.isTesting}
            className="w-full md:w-auto border-hairline-strong text-fg-tertiary hover:text-fg-bright hover:bg-fill text-xs font-medium h-10 px-4"
          >
            {form.isTesting ? (
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 border-2 border-fg-tertiary/30 border-t-fg-tertiary rounded-full animate-spin" />
                Testing...
              </div>
            ) : (
              "Test Connection"
            )}
          </Button>
          <Button
            onClick={form.handleConnect}
            disabled={form.isTesting}
            className="w-full md:w-auto bg-brand-solid hover:bg-brand-solid-hover text-white h-10 px-4 text-xs font-medium"
          >
            {form.isEditMode ? "Save Changes" : "Establish Connection"}
          </Button>
        </div>
      </div>
    </div>
  );
}
