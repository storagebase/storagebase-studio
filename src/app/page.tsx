import { WorkspaceOwnerGate } from "@/components/auth/WorkspaceOwnerGate";
import { StorageBaseShell } from "@/components/storagebase/sections/StorageBaseShell";
import Studio from "@/components/Studio";

export default function Page() {
  return (
    <WorkspaceOwnerGate>
      <StorageBaseShell>
        <Studio />
      </StorageBaseShell>
    </WorkspaceOwnerGate>
  );
}
