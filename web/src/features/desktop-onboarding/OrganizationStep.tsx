import { Button } from "@/src/components/design-system/Button/Button";

export function OrganizationStep({
  name,
  upgradeRequired,
  isCreating,
  error,
  onNameChange,
  onCreate,
}: {
  name: string;
  upgradeRequired: boolean;
  isCreating: boolean;
  error: string | null;
  onNameChange: (name: string) => void;
  onCreate: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-sm font-bold">1. Create your organization</h3>
        <p className="text-muted-foreground mt-1 text-sm">
          Agent projects are created only after your organization is ready.
        </p>
      </div>
      {upgradeRequired && (
        <p className="rounded-md border p-3 text-sm">
          Existing Confuse integrations were detected. Create an organization
          before changing Agent settings or importing more history. You can also
          remove the old integrations below.
        </p>
      )}
      <div className="flex flex-col gap-2">
        <label
          htmlFor="desktop-organization-name"
          className="text-sm font-medium"
        >
          Organization name
        </label>
        <input
          id="desktop-organization-name"
          value={name}
          maxLength={80}
          onChange={(event) => onNameChange(event.target.value)}
          className="bg-background w-full rounded-md border px-3 py-2 text-sm"
        />
      </div>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <div className="flex justify-end">
        <Button
          text="Create organization"
          loading={isCreating}
          disabled={!name.trim()}
          onClick={onCreate}
        />
      </div>
    </div>
  );
}
