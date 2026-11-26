import { useEffect, useState, type ReactElement } from "react";
import { Check, CircleAlert, RefreshCw, Settings2 } from "@langfuse/icons";
import { useRouter } from "next/router";
import { Button } from "@/src/components/design-system/Button/Button";
import { Progress } from "@/src/components/design-system/Progress/Progress";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/src/components/ui/sheet";
import { cn } from "@/src/utils/tailwind";
import { AGENT_LABELS } from "./bridge";
import {
  desktopStore,
  getUnreadCount,
  useDesktopStoreSnapshot,
} from "./desktopStore";

const JOB_STATE_LABELS: Record<JobState, string> = {
  queued: "Queued",
  running: "Running",
  "waiting-for-review": "Waiting for review",
  succeeded: "Complete",
  "partially-succeeded": "Partially complete",
  failed: "Failed",
  cancelled: "Cancelled",
};

const PROJECT_SESSIONS_ROUTE = /^\/project\/[a-z0-9-]+\/sessions$/;

const SEVERITY_STYLES: Record<DesktopNotification["severity"], string> = {
  info: "bg-primary",
  success: "bg-dark-green",
  warning: "bg-yellow-500",
  error: "bg-destructive",
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function jobTitle(job: DesktopJob) {
  const agentName = job.agentKind ? AGENT_LABELS[job.agentKind] : "Confuse";
  switch (job.kind) {
    case "connect":
      return `Connect ${agentName}`;
    case "history-import":
      return `Import ${agentName} history`;
    case "runtime":
      return "Desktop runtime";
  }
}

function canRetry(job: DesktopJob) {
  return (
    Boolean(job.agentKind) &&
    (job.kind === "connect" || job.kind === "history-import") &&
    (job.state === "failed" ||
      job.state === "cancelled" ||
      job.state === "partially-succeeded")
  );
}

function JobRow({ job, isPending }: { job: DesktopJob; isPending: boolean }) {
  const showProgress = job.state === "queued" || job.state === "running";
  const progress = Math.min(100, Math.max(0, job.progress * 100));

  return (
    <li className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{jobTitle(job)}</p>
          <p className="text-muted-foreground text-xs">
            {JOB_STATE_LABELS[job.state]}
          </p>
        </div>
        {canRetry(job) && (
          <Button
            text="Retry"
            icon={RefreshCw}
            variant="outline"
            size="sm"
            loading={isPending}
            onClick={() => desktopStore.retryJob(job)}
          />
        )}
      </div>
      {showProgress && (
        <div className="flex items-center gap-2">
          <Progress value={progress} />
          <span className="text-muted-foreground w-9 shrink-0 text-right text-xs">
            {Math.round(progress)}%
          </span>
        </div>
      )}
      <p className="text-muted-foreground text-xs break-words">{job.message}</p>
    </li>
  );
}

function NotificationRow({
  notification,
  onOpenSessions,
}: {
  notification: DesktopNotification;
  onOpenSessions?: () => void;
}) {
  const isUnread = !notification.readAt;
  return (
    <li className="flex gap-3 border-b py-3 last:border-b-0">
      <span
        className={cn(
          "mt-1.5 size-2 shrink-0 rounded-full",
          SEVERITY_STYLES[notification.severity],
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className={cn("min-w-0 flex-1 text-sm", isUnread && "font-bold")}>
            {notification.title}
          </p>
          {isUnread && <span className="sr-only">Unread</span>}
        </div>
        <p className="text-muted-foreground mt-1 text-xs break-words">
          {notification.body}
        </p>
        <p className="text-muted-foreground mt-1 text-xs">
          {formatDate(notification.createdAt)}
        </p>
        {onOpenSessions && (
          <Button
            text="Open project sessions"
            variant="ghost"
            size="sm"
            onClick={onOpenSessions}
          />
        )}
      </div>
    </li>
  );
}

export function NotificationCenter({
  children,
}: {
  children: (props: {
    unreadCount: number;
    Trigger: typeof SheetTrigger;
  }) => ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const snapshot = useDesktopStoreSnapshot();
  const unreadCount = getUnreadCount(snapshot);
  const router = useRouter();
  const notificationCenterQuery = router.query.notificationCenter;
  useEffect(() => {
    if (router.isReady && notificationCenterQuery === "open") setOpen(true);
  }, [router.isReady, notificationCenterQuery]);
  const jobs = [...(snapshot.state?.jobs ?? [])].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      {children({ unreadCount, Trigger: SheetTrigger })}
      <SheetContent
        side="left"
        className="ph-no-capture flex w-full flex-col gap-0 p-0 sm:max-w-md"
      >
        <SheetHeader className="shrink-0 border-b px-4 py-4 text-left">
          <SheetTitle>Notifications</SheetTitle>
          <SheetDescription>
            Desktop setup, imports, and background activity
          </SheetDescription>
          <div className="flex items-center gap-2 pt-1">
            <Button
              text="Mark all as read"
              icon={Check}
              variant="outline"
              size="sm"
              disabled={unreadCount === 0}
              loading={snapshot.isMarkingAllRead}
              onClick={() => desktopStore.markAllRead()}
            />
            <Button
              text="Desktop setup"
              icon={Settings2}
              variant="ghost"
              size="sm"
              onClick={() => {
                setOpen(false);
                router.push("/desktop-onboarding");
              }}
            />
          </div>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {snapshot.actionError && (
            <div
              role="alert"
              className="border-destructive text-destructive mb-4 flex items-start gap-2 rounded-md border p-3 text-sm"
            >
              <CircleAlert size="base" color="destructive" aria-hidden />
              <p>{snapshot.actionError}</p>
            </div>
          )}

          {snapshot.status === "error" ? (
            <div className="flex flex-col items-start gap-3 rounded-md border p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <CircleAlert size="base" color="destructive" aria-hidden />
                Desktop activity is unavailable
              </div>
              <p className="text-muted-foreground text-sm">{snapshot.error}</p>
              <Button
                text="Reconnect"
                icon={RefreshCw}
                variant="outline"
                size="sm"
                onClick={() => desktopStore.refresh()}
              />
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              <section>
                <h3 className="mb-2 text-sm font-bold">Background tasks</h3>
                {jobs.length > 0 ? (
                  <ul className="flex flex-col gap-2">
                    {jobs.map((job) => (
                      <JobRow
                        key={job.id}
                        job={job}
                        isPending={snapshot.pendingJobIds[job.id] === true}
                      />
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground text-sm">
                    No background tasks yet.
                  </p>
                )}
              </section>

              <section>
                <h3 className="mb-2 text-sm font-bold">Recent activity</h3>
                {snapshot.notifications.length > 0 ? (
                  <ul>
                    {snapshot.notifications.map((notification) => {
                      const route = notification.actionRoute;
                      const canOpenSessions =
                        route && PROJECT_SESSIONS_ROUTE.test(route);
                      return (
                        <NotificationRow
                          key={notification.id}
                          notification={notification}
                          onOpenSessions={
                            canOpenSessions
                              ? () => {
                                  setOpen(false);
                                  router.push(route);
                                }
                              : undefined
                          }
                        />
                      );
                    })}
                  </ul>
                ) : (
                  <p className="text-muted-foreground text-sm">
                    No notifications yet.
                  </p>
                )}
              </section>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
