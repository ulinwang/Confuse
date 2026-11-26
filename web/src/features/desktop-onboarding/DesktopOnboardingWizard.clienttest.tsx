import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DesktopOnboardingWizard } from "./DesktopOnboardingWizard";

const agents: AgentInfo[] = [
  {
    kind: "kimi-code",
    displayName: "Kimi Code",
    installed: true,
    version: "1.0.0",
    configPath: "/tmp/kimi/config.toml",
    connectionState: "not-connected",
    liveCaptureSupported: true,
    historySupported: true,
  },
  {
    kind: "chatgpt-codex",
    displayName: "ChatGPT Codex",
    installed: false,
    connectionState: "not-connected",
    liveCaptureSupported: false,
    historySupported: false,
  },
  {
    kind: "claude-code",
    displayName: "Claude Code",
    installed: true,
    configPath: "/tmp/claude/settings.json",
    connectionState: "not-connected",
    liveCaptureSupported: true,
    historySupported: true,
  },
  {
    kind: "deepseek-harness",
    displayName: "DeepSeek Harness",
    installed: false,
    connectionState: "unsupported",
    liveCaptureSupported: false,
    historySupported: false,
  },
];

function state(organization?: DesktopOrganization): DesktopState {
  return {
    version: 1,
    firstRunComplete: false,
    runtime: "ready",
    webUrl: "http://127.0.0.1:3000",
    jobs: [],
    organization,
    migrationRequired: true,
  };
}

describe("DesktopOnboardingWizard", () => {
  it("creates the organization before selected Agent projects and keeps history opt-in", async () => {
    const invoke = vi.fn((channel: DesktopChannel, _request: unknown) => {
      if (channel === "agents.scan") return Promise.resolve(agents);
      if (channel === "desktop.get-state") return Promise.resolve(state());
      if (channel === "desktop.create-organization") {
        return Promise.resolve({
          id: "confuse-desktop",
          name: "My Organization",
        });
      }
      if (channel === "history.preview") {
        return Promise.resolve([
          {
            kind: "kimi-code",
            sessionCount: 12,
            includes: ["Messages", "Tool events"],
            warnings: [],
          },
        ]);
      }
      if (channel === "desktop.complete-onboarding") {
        return Promise.resolve({ jobIds: ["job-1"] });
      }
      return Promise.reject(new Error(`Unexpected channel: ${channel}`));
    });
    const bridge = {
      invoke,
      subscribe: vi.fn(() => () => undefined),
    } as unknown as ConfuseBridge;
    const onFinished = vi.fn();

    render(<DesktopOnboardingWizard bridge={bridge} onFinished={onFinished} />);

    fireEvent.change(await screen.findByLabelText("Organization name"), {
      target: { value: "My Organization" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create organization" }),
    );
    expect(invoke).toHaveBeenCalledWith("desktop.create-organization", {
      name: "My Organization",
    });

    const connectKimi = await screen.findByRole("checkbox", {
      name: "Connect Kimi Code",
    });
    expect(connectKimi).not.toBeChecked();
    fireEvent.click(connectKimi);
    const kimiHistory = screen.getByRole("checkbox", {
      name: "Import history from Kimi Code",
    });
    expect(kimiHistory).not.toBeChecked();
    fireEvent.click(kimiHistory);
    expect(
      screen.getByRole("checkbox", { name: "Connect Claude Code" }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Connect ChatGPT Codex" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Review setup" }));

    expect(await screen.findByText("12 sessions")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /I authorize the selected local configuration changes/,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Start in background" }),
    );

    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenCalledWith("desktop.complete-onboarding", {
      selections: [
        {
          kind: "kimi-code",
          configPath: "/tmp/kimi/config.toml",
          importHistory: true,
        },
      ],
    });
    const organizationCall = invoke.mock.calls.findIndex(
      ([channel]) => channel === "desktop.create-organization",
    );
    const connectCall = invoke.mock.calls.findIndex(
      ([channel]) => channel === "desktop.complete-onboarding",
    );
    expect(organizationCall).toBeLessThan(connectCall);
  });

  it("offers a distinct cleanup flow without starting a new connection", async () => {
    const invoke = vi.fn((channel: DesktopChannel) => {
      if (channel === "agents.scan") return Promise.resolve(agents);
      if (channel === "desktop.get-state") {
        return Promise.resolve(
          state({ id: "confuse-desktop", name: "Confuse" }),
        );
      }
      if (channel === "desktop.uninstall") {
        return Promise.resolve({ state: "succeeded", message: "Removed" });
      }
      return Promise.reject(new Error(`Unexpected channel: ${channel}`));
    });
    const bridge = {
      invoke,
      subscribe: vi.fn(() => () => undefined),
    } as unknown as ConfuseBridge;
    const onFinished = vi.fn();

    render(<DesktopOnboardingWizard bridge={bridge} onFinished={onFinished} />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Remove Confuse integrations",
      }),
    );
    expect(
      screen.getByText(/Dragging the app to the Trash alone/),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Remove integrations and quit" }),
    );

    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenCalledWith("desktop.uninstall", undefined);
    expect(invoke).not.toHaveBeenCalledWith("desktop.complete-onboarding", {
      selections: expect.any(Array),
    });
  });
});
