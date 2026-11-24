import { useEffect, useState } from "react";
import { CircleAlert, RefreshCw } from "@langfuse/icons";
import { Button } from "@/src/components/design-system/Button/Button";
import { Checkbox } from "@/src/components/design-system/Checkbox/Checkbox";
import { Spinner } from "@/src/components/design-system/Spinner/Spinner";
import {
  AGENT_KINDS,
  AGENT_LABELS,
} from "@/src/features/notification-center/bridge";
import { desktopStore } from "@/src/features/notification-center/desktopStore";

const CONNECTION_STATE_LABELS: Record<AgentConnectionState, string> = {
  "not-connected": "Not connected",
  "waiting-for-review": "Waiting for review",
  connecting: "Connecting",
  connected: "Connected",
  unsupported: "Not compatible",
  error: "Needs attention",
};

type SelectionState = Record<
  AgentKind,
  { selected: boolean; importHistory: boolean }
>;

type ScanState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; agents: AgentInfo[] };

function completeAgentScan(agents: AgentInfo[]): AgentInfo[] {
  return AGENT_KINDS.map((kind) => {
    const discovered = agents.find((agent) => agent.kind === kind);
    return (
      discovered ??
      ({
        kind,
        displayName: AGENT_LABELS[kind],
        installed: false,
        connectionState: "not-connected",
        liveCaptureSupported: false,
        historySupported: false,
        message: "No compatible installation was found.",
      } satisfies AgentInfo)
    );
  });
}

function createInitialSelections(agents: AgentInfo[]): SelectionState {
  return Object.fromEntries(
    agents.map((agent) => [
      agent.kind,
      {
        selected: agent.installed && agent.liveCaptureSupported,
        importHistory: false,
      },
    ]),
  ) as SelectionState;
}

function buildSelections(
  agents: AgentInfo[],
  selectionState: SelectionState,
): ConnectAgentSelection[] {
  return agents.flatMap((agent) => {
    const selection = selectionState[agent.kind];
    if (!selection.selected) return [];
    return [
      {
        kind: agent.kind,
        configPath: agent.configPath,
        importHistory: selection.importHistory,
      },
    ];
  });
}

async function loadHistoryPreview(
  bridge: ConfuseBridge,
  selections: ConnectAgentSelection[],
) {
  const kinds = selections
    .filter((selection) => selection.importHistory)
    .map((selection) => selection.kind);
  return kinds.length > 0
    ? bridge.invoke("history.preview", { kinds })
    : Promise.resolve([]);
}

async function startOnboarding(
  bridge: ConfuseBridge,
  selections: ConnectAgentSelection[],
) {
  await bridge.invoke("desktop.complete-onboarding", { selections });
  desktopStore.refresh();
}

function agentSupportMessage(agent: AgentInfo): string {
  if (!agent.installed) return "Not installed";
  if (!agent.liveCaptureSupported) {
    return "Live capture is not supported by this installation.";
  }
  return "Local lifecycle events";
}

function AgentRow({
  agent,
  selection,
  onSelectionChange,
}: {
  agent: AgentInfo;
  selection: SelectionState[AgentKind];
  onSelectionChange: (selection: SelectionState[AgentKind]) => void;
}) {
  const canConnect = agent.installed && agent.liveCaptureSupported;
  const connectId = `connect-${agent.kind}`;
  const historyId = `history-${agent.kind}`;

  return (
    <li className="rounded-md border p-3">
      <div className="flex items-start gap-3">
        <Checkbox
          id={connectId}
          aria-label={`Connect ${agent.displayName}`}
          checked={selection.selected}
          disabled={!canConnect}
          onCheckedChange={(checked) =>
            onSelectionChange({
              selected: checked === true,
              importHistory: checked === true ? selection.importHistory : false,
            })
          }
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={connectId} className="text-sm font-medium">
              {agent.displayName}
            </label>
            <span className="text-muted-foreground text-xs">
              {CONNECTION_STATE_LABELS[agent.connectionState]}
            </span>
            {agent.version && (
              <span className="text-muted-foreground text-xs">
                {agent.version}
              </span>
            )}
          </div>
          <p className="text-muted-foreground mt-1 text-xs">
            {agentSupportMessage(agent)}
          </p>
          {agent.message && (
            <p className="text-muted-foreground mt-1 text-xs">
              {agent.message}
            </p>
          )}
        </div>
      </div>
      <div className="mt-3 flex items-start gap-3 border-t pt-3">
        <Checkbox
          id={historyId}
          aria-label={`Import history from ${agent.displayName}`}
          checked={selection.importHistory}
          disabled={!selection.selected || !agent.historySupported}
          onCheckedChange={(checked) =>
            onSelectionChange({
              ...selection,
              importHistory: checked === true,
            })
          }
        />
        <div>
          <label htmlFor={historyId} className="text-xs font-medium">
            Import existing sessions
          </label>
          <p className="text-muted-foreground mt-0.5 text-xs">
            Off by default. History is read only when selected.
          </p>
        </div>
      </div>
    </li>
  );
}

function SelectionStep({
  agents,
  selectionState,
  onSelectionChange,
  onReview,
  isPreviewing,
  error,
}: {
  agents: AgentInfo[];
  selectionState: SelectionState;
  onSelectionChange: (
    kind: AgentKind,
    selection: SelectionState[AgentKind],
  ) => void;
  onReview: () => void;
  isPreviewing: boolean;
  error: string | null;
}) {
  return (
    <>
      <div>
        <h3 className="text-sm font-bold">1. Choose agents</h3>
        <p className="text-muted-foreground mt-1 text-sm">
          Select each local agent Confuse may connect. Discovery does not read
          session content or credentials.
        </p>
      </div>
      <ul className="flex flex-col gap-2">
        {agents.map((agent) => (
          <AgentRow
            key={agent.kind}
            agent={agent}
            selection={selectionState[agent.kind]}
            onSelectionChange={(selection) =>
              onSelectionChange(agent.kind, selection)
            }
          />
        ))}
      </ul>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <div className="flex justify-end">
        <Button text="Review setup" loading={isPreviewing} onClick={onReview} />
      </div>
    </>
  );
}

function HistoryPreviewDetails({ preview }: { preview: HistoryPreview }) {
  return (
    <div className="text-muted-foreground mt-1 flex flex-col gap-1 text-xs">
      <p>
        {preview.sessionCount}{" "}
        {preview.sessionCount === 1 ? "session" : "sessions"}
      </p>
      {preview.oldestAt && preview.newestAt && (
        <p>
          {new Date(preview.oldestAt).toLocaleDateString()} –{" "}
          {new Date(preview.newestAt).toLocaleDateString()}
        </p>
      )}
      {preview.includes.length > 0 && <p>{preview.includes.join(", ")}</p>}
      {preview.warnings.map((warning) => (
        <p key={warning} className="text-yellow-600 dark:text-yellow-500">
          {warning}
        </p>
      ))}
    </div>
  );
}

function ReviewStep({
  agents,
  selections,
  previews,
  privacyAccepted,
  isStarting,
  error,
  onPrivacyAcceptedChange,
  onBack,
  onStart,
}: {
  agents: AgentInfo[];
  selections: ConnectAgentSelection[];
  previews: HistoryPreview[];
  privacyAccepted: boolean;
  isStarting: boolean;
  error: string | null;
  onPrivacyAcceptedChange: (accepted: boolean) => void;
  onBack: () => void;
  onStart: () => void;
}) {
  return (
    <>
      <div>
        <h3 className="text-sm font-bold">2. Review and confirm</h3>
        <p className="text-muted-foreground mt-1 text-sm">
          Review the local changes and optional history access before starting
          background tasks.
        </p>
      </div>

      {selections.length === 0 ? (
        <p className="rounded-md border p-3 text-sm">
          No agents selected. You can finish now and connect them later.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {selections.map((selection) => {
            const agent = agents.find(
              (candidate) => candidate.kind === selection.kind,
            );
            const preview = previews.find(
              (candidate) => candidate.kind === selection.kind,
            );
            return (
              <li key={selection.kind} className="rounded-md border p-3">
                <p className="text-sm font-medium">
                  {agent?.displayName ?? AGENT_LABELS[selection.kind]}
                </p>
                <p className="text-muted-foreground mt-1 text-xs">
                  Add Confuse lifecycle hooks while preserving and backing up
                  existing settings.
                </p>
                {selection.kind === "chatgpt-codex" && (
                  <p className="text-muted-foreground mt-1 text-xs">
                    Complete ChatGPT&apos;s Review hooks trust step before live
                    capture starts.
                  </p>
                )}
                {agent?.configPath && (
                  <p className="ph-no-capture text-muted-foreground mt-1 text-xs break-all">
                    {agent.configPath}
                  </p>
                )}
                <p className="mt-2 text-xs font-medium">
                  {selection.importHistory
                    ? "History import enabled"
                    : "New events only; history remains off"}
                </p>
                {preview && <HistoryPreviewDetails preview={preview} />}
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex items-start gap-3 rounded-md border p-3">
        <Checkbox
          id="desktop-privacy-confirmation"
          checked={privacyAccepted}
          onCheckedChange={(checked) =>
            onPrivacyAcceptedChange(checked === true)
          }
        />
        <label
          htmlFor="desktop-privacy-confirmation"
          className="text-xs leading-relaxed"
        >
          I authorize the selected local configuration changes and history
          imports. Confuse will not read history for unselected agents.
        </label>
      </div>

      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <div className="flex justify-between gap-2">
        <Button text="Back" variant="ghost" onClick={onBack} />
        <Button
          text="Start in background"
          disabled={!privacyAccepted}
          loading={isStarting}
          onClick={onStart}
        />
      </div>
    </>
  );
}

function DesktopOnboardingForm({
  bridge,
  initialAgents,
  onFinished,
}: {
  bridge: ConfuseBridge;
  initialAgents: AgentInfo[];
  onFinished: () => void;
}) {
  const [selectionState, setSelectionState] = useState<SelectionState>(() =>
    createInitialSelections(initialAgents),
  );
  const [step, setStep] = useState<"select" | "review">("select");
  const [previews, setPreviews] = useState<HistoryPreview[]>([]);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selections = buildSelections(initialAgents, selectionState);

  async function review() {
    setIsPreviewing(true);
    setError(null);
    try {
      const nextPreviews = await loadHistoryPreview(bridge, selections);
      setPreviews(nextPreviews);
      setStep("review");
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : "Could not preview history. Try again.",
      );
    } finally {
      setIsPreviewing(false);
    }
  }

  async function start() {
    setIsStarting(true);
    setError(null);
    try {
      await startOnboarding(bridge, selections);
      onFinished();
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : "Could not start desktop setup. Try again.",
      );
    } finally {
      setIsStarting(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {step === "select" ? (
        <SelectionStep
          agents={initialAgents}
          selectionState={selectionState}
          isPreviewing={isPreviewing}
          error={error}
          onSelectionChange={(kind, selection) =>
            setSelectionState((current) => ({
              ...current,
              [kind]: selection,
            }))
          }
          onReview={() => review()}
        />
      ) : (
        <ReviewStep
          agents={initialAgents}
          selections={selections}
          previews={previews}
          privacyAccepted={privacyAccepted}
          isStarting={isStarting}
          error={error}
          onPrivacyAcceptedChange={setPrivacyAccepted}
          onBack={() => {
            setStep("select");
            setError(null);
          }}
          onStart={() => start()}
        />
      )}
    </div>
  );
}

export function DesktopOnboardingWizard({
  bridge,
  onFinished,
}: {
  bridge: ConfuseBridge;
  onFinished: () => void;
}) {
  const [scanAttempt, setScanAttempt] = useState(0);
  const [scanState, setScanState] = useState<ScanState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    bridge
      .invoke("agents.scan", undefined)
      .then((agents) => {
        if (active) {
          setScanState({
            status: "ready",
            agents: completeAgentScan(agents),
          });
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setScanState({
            status: "error",
            message:
              error instanceof Error && error.message
                ? error.message
                : "Could not scan for local agents.",
          });
        }
      });
    return () => {
      active = false;
    };
  }, [bridge, scanAttempt]);

  if (scanState.status === "loading") {
    return (
      <div
        role="status"
        className="flex min-h-48 flex-col items-center justify-center gap-3"
      >
        <Spinner size="lg" />
        <p className="text-muted-foreground text-sm">
          Scanning for Kimi Code, ChatGPT Codex, Claude Code, and DeepSeek
          Harness…
        </p>
      </div>
    );
  }

  if (scanState.status === "error") {
    return (
      <div className="flex min-h-48 flex-col items-start justify-center gap-3">
        <div className="text-destructive flex items-center gap-2 text-sm font-medium">
          <CircleAlert size="base" color="destructive" aria-hidden />
          Agent discovery failed
        </div>
        <p className="text-muted-foreground text-sm">{scanState.message}</p>
        <Button
          text="Scan again"
          icon={RefreshCw}
          variant="outline"
          onClick={() => {
            setScanState({ status: "loading" });
            setScanAttempt((attempt) => attempt + 1);
          }}
        />
      </div>
    );
  }

  return (
    <DesktopOnboardingForm
      bridge={bridge}
      initialAgents={scanState.agents}
      onFinished={onFinished}
    />
  );
}
