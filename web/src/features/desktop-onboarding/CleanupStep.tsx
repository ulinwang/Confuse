import { Button } from "@/src/components/design-system/Button/Button";

export function CleanupStep({
  isRemoving,
  error,
  onBack,
  onRemove,
}: {
  isRemoving: boolean;
  error: string | null;
  onBack: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-sm font-bold">Remove Confuse integrations</h3>
        <p className="text-muted-foreground mt-1 text-sm">
          Remove only what Confuse added, while preserving your other Agent
          settings and history.
        </p>
      </div>
      <ul className="text-muted-foreground flex list-disc flex-col gap-2 pl-5 text-sm">
        <li>Remove Confuse-managed hooks and forwarding scripts.</li>
        <li>Revoke per-Agent project keys and remove the desktop token.</li>
        <li>Stop the supervised services and remove the LaunchAgent.</li>
        <li>
          Preserve projects, historical telemetry, Docker volumes, and local
          database keys.
        </li>
        <li>Leave ChatGPT&apos;s inert old trust record unchanged.</li>
      </ul>
      <p className="rounded-md border p-3 text-sm">
        Run this cleanup before deleting Confuse.app. Dragging the app to the
        Trash alone cannot remove Agent hooks or the LaunchAgent.
      </p>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <div className="flex justify-between gap-2">
        <Button text="Back" variant="ghost" onClick={onBack} />
        <Button
          text="Remove integrations and quit"
          variant="outline"
          loading={isRemoving}
          onClick={onRemove}
        />
      </div>
    </div>
  );
}
