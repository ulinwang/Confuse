import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LayerProvider } from "@/src/context/LayerContext/LayerContext";
import { NotificationCenter } from "./NotificationCenter";

const router = vi.hoisted(() => ({
  isReady: true,
  query: { notificationCenter: "open" },
  push: vi.fn(),
}));

vi.mock("next/router", () => ({ useRouter: () => router }));

describe("NotificationCenter", () => {
  afterEach(() => {
    delete window.confuse;
  });

  it("opens from the notificationCenter query and displays fractional progress as a percentage", async () => {
    const job: DesktopJob = {
      id: "running-job",
      kind: "history-import",
      agentKind: "kimi-code",
      state: "running",
      progress: 0.42,
      message: "Importing sessions",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const bridge: ConfuseBridge = {
      invoke: vi.fn(async (channel: DesktopChannel) => {
        if (channel === "desktop.get-state") {
          return {
            version: 1,
            firstRunComplete: true,
            runtime: "ready",
            webUrl: "http://127.0.0.1:3000",
            jobs: [job],
          };
        }
        if (channel === "notifications.list") return [];
        throw new Error(`Unexpected channel: ${channel}`);
      }) as ConfuseBridge["invoke"],
      subscribe: vi.fn(() => () => undefined),
    };
    window.confuse = bridge;

    const view = render(
      <NotificationCenter>
        {({ unreadCount }) => <button>Notifications ({unreadCount})</button>}
      </NotificationCenter>,
      { wrapper: LayerProvider },
    );

    expect(
      await screen.findByRole("dialog", { name: "Notifications" }),
    ).toBeVisible();
    expect(await screen.findByText("42%")).toBeVisible();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "42",
    );
    view.unmount();
  });
});
