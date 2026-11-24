import { useRouter } from "next/router";
import { Button } from "@/src/components/design-system/Button/Button";
import { useConfuseDesktopBridge } from "@/src/features/notification-center/bridge";
import { DesktopOnboardingWizard } from "./DesktopOnboardingWizard";

export default function DesktopOnboardingPage() {
  const bridge = useConfuseDesktopBridge();
  const router = useRouter();

  if (!bridge) {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col items-start justify-center gap-4 p-6">
        <h1 className="text-xl font-bold">Desktop setup</h1>
        <p className="text-muted-foreground text-sm">
          Agent discovery and history import are available in the Confuse macOS
          app. This browser session does not have access to the desktop bridge.
        </p>
        <Button text="Return home" href="/" />
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center p-6">
      <div className="mb-6">
        <h1 className="text-xl font-bold">Desktop setup</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Reconnect local agents or change their history import preferences.
        </p>
      </div>
      <div className="rounded-lg border p-5">
        <DesktopOnboardingWizard
          bridge={bridge}
          onFinished={() => router.push("/")}
        />
      </div>
    </main>
  );
}
