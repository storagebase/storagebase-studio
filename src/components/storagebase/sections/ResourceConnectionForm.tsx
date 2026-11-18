"use client";

import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  RESOURCE_CATEGORY_LABELS,
  RESOURCE_UI_CONFIG,
  SECRET_RESOURCE_FIELDS,
  type ResourceConnectionField,
} from "@/storagebase/resources/ui-config";
import type { ResourceCategory, ResourceConnection } from "@/storagebase/resources/types";
import { ENVIRONMENT_LABELS, type ConnectionEnvironment } from "@/lib/types";
import { useResourceConnectionForm } from "./use-resource-connection-form";

/**
 * The section page's connection form (StorageBase fork): the ported form hook
 * rendered against the fork's field vocabulary. `category` pins the picker —
 * a section never offers another family's types — and every input exists
 * exactly where `buildConnection` writes a value.
 *
 * Credentials are inputs like any other field but are never echoed back: an
 * edit starts from the row's non-secret fields, and leaving a secret blank
 * keeps the server's sealed copy instead of clearing it.
 */
export function ResourceConnectionForm({
  category,
  isOpen,
  onClose,
  onConnect,
  editConnection,
}: {
  category: ResourceCategory;
  isOpen: boolean;
  onClose: () => void;
  onConnect: (conn: ResourceConnection) => Promise<unknown> | unknown;
  editConnection?: ResourceConnection | null;
}) {
  const form = useResourceConnectionForm({ category, isOpen, onClose, onConnect, editConnection });
  const fields = form.fieldsForType;

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleConnect();
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="sb-resource-type">Type</Label>
        <Select value={form.type} onValueChange={(value) => form.setType(value as ResourceConnection["type"])}>
          <SelectTrigger id="sb-resource-type" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {form.selectableTypes(category).map((type) => (
              <SelectItem key={type} value={type}>
                {RESOURCE_UI_CONFIG[type].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="sb-resource-name">Name</Label>
        <Input
          id="sb-resource-name"
          value={form.name}
          placeholder={`${form.type}-connection`}
          onChange={(event) => form.setName(event.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="sb-resource-environment">Environment</Label>
        <Select value={form.environment} onValueChange={(value) => form.setEnvironment(value as ConnectionEnvironment)}>
          <SelectTrigger id="sb-resource-environment" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(ENVIRONMENT_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {fields.map((field: ResourceConnectionField) => (
        <div key={field} className="space-y-1.5">
          <Label htmlFor={`sb-resource-${field}`}>{field}</Label>
          <Input
            id={`sb-resource-${field}`}
            type={SECRET_RESOURCE_FIELDS.has(field) ? "password" : "text"}
            autoComplete="off"
            value={form.fieldValues[field]}
            onChange={(event) => form.setFieldValue(field, event.target.value)}
          />
        </div>
      ))}
      {form.testResult && (
        <output data-tone={form.testResult.tone} className="block text-xs text-fg-muted break-words">
          {form.testResult.message}
        </output>
      )}
      <div className="flex items-center gap-2 pt-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={form.isTesting}
          onClick={() => void form.handleTestConnection()}
        >
          {form.isTesting && <LoaderCircle strokeWidth={1.5} className="w-3 h-3 mr-1.5 animate-spin" />}
          Test Connection
        </Button>
        <Button type="submit" size="sm" disabled={form.isTesting}>
          {form.isEditMode ? "Save Changes" : "Establish Connection"}
        </Button>
        <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={onClose}>
          Cancel
        </Button>
      </div>
      <p className="text-xs text-fg-subtle">
        Connections in {RESOURCE_CATEGORY_LABELS[category]} are stored server-side; credentials are sealed before they
        reach the store and never echoed back here.
      </p>
    </form>
  );
}
