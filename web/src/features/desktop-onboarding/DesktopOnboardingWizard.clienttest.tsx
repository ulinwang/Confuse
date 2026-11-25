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

describe("DesktopOnboardingWizard", () => {
  it("keeps history opt-in and submits only the selected agents", async () => {
    const invoke = vi.fn((channel: DesktopChannel, _request: unknown) => {
      if (channel === "agents.scan") return Promise.resolve(agents);
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

    const kimiHistory = await screen.findByRole("checkbox", {
      name: "Import history from Kimi Code",
    });
    expect(
      screen.getByRole("checkbox", { name: "Connect ChatGPT Codex" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("checkbox", { name: "Connect DeepSeek Harness" }),
    ).toBeDisabled();
    expect(kimiHistory).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", {
        name: "Import history from Claude Code",
      }),
    ).not.toBeChecked();

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Connect Claude Code" }),
    );
    fireEvent.click(kimiHistory);
    fireEvent.click(screen.getByRole("button", { name: "Review setup" }));

    expect(await screen.findByText("12 sessions")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("history.preview", {
      kinds: ["kimi-code"],
    });

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
  });
});
