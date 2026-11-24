import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Dialog } from "@/src/components/design-system/Dialog/Dialog";
import { DesktopOnboardingWizard } from "./DesktopOnboardingWizard";

export function DesktopOnboardingModal({
  bridge,
  onClose,
}: {
  bridge: ConfuseBridge;
  onClose: () => void;
}) {
  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog title="Set up your desktop agents" size="md" hideCloseButton>
        <Dialog.Body separators="both">
          <DesktopOnboardingWizard bridge={bridge} onFinished={onClose} />
        </Dialog.Body>
      </Dialog>
    </DialogPrimitive.Root>
  );
}
