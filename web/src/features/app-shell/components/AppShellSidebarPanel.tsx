import motion from "./sidebarMotion.module.css";
import { cn } from "@/src/utils/tailwind";
import { SidebarVersionButton } from "./SidebarVersionButton";
import { useRouter } from "next/router";
import { type RouteGroup } from "@/src/components/layouts/routes";
import { type NavigationItem } from "@/src/components/layouts/utilities/routes";
import {
  SidebarNotifications,
  getActiveSidebarNotifications,
} from "@/src/components/nav/SidebarNotifications";
import { type UserNavigationItem } from "@/src/components/nav/UserMenuItems";
import { SidebarVersionMenu } from "./SidebarVersionMenu";
import { useSidebarNotificationState } from "@/src/components/nav/useSidebarNotificationState";
import { useSidebarVersionState } from "@/src/components/nav/useSidebarVersionState";
import { env } from "@/src/env.mjs";
import { SidebarAccountButton } from "@/src/features/app-shell/components/SidebarAccountButton";
import { SidebarDemoNotice } from "@/src/features/app-shell/components/SidebarDemoNotice";
import { SidebarNavigation } from "@/src/features/app-shell/components/SidebarNavigation";
import { SidebarPanel } from "@/src/features/app-shell/components/SidebarPanel";
import { SidebarOrganizationHeader } from "@/src/features/app-shell/components/SidebarOrganizationHeader";
import {
  SidebarUserMenu,
  type SidebarUser,
} from "@/src/features/app-shell/components/SidebarUserMenu";
import { useSidebarSurface } from "@/src/features/app-shell/contexts/SidebarSurfaceProvider";
import { useV4UpgradeUiEnabled } from "@/src/features/v4-migration/useV4UpgradeUiEnabled";
import { NotificationCenter } from "@/src/features/notification-center/NotificationCenter";
import { useConfuseDesktopAvailability } from "@/src/features/notification-center/bridge";
import { Bell } from "@langfuse/icons";

type GroupedNavigationItems = {
  ungrouped: NavigationItem[];
  grouped: Partial<Record<RouteGroup, NavigationItem[]>> | null;
};

/** The app sidebar's content: organization, navigation, and account. */
export function AppShellSidebarPanel({
  mainNavigation,
  secondaryNavigation,
  user,
  userMenuItems,
  isLangfuseCloud,
}: {
  mainNavigation: GroupedNavigationItems;
  secondaryNavigation: GroupedNavigationItems;
  user: SidebarUser;
  userMenuItems: UserNavigationItem[];
  isLangfuseCloud: boolean;
}) {
  const surface = useSidebarSurface();
  const isCollapsed = surface === "collapsed";
  const router = useRouter();
  const routerProjectId =
    typeof router.query.projectId === "string"
      ? router.query.projectId
      : undefined;
  const versionState = useSidebarVersionState({ isLangfuseCloud });
  const notificationState = useSidebarNotificationState();
  const v4UpgradeUiEnabled = useV4UpgradeUiEnabled(routerProjectId);
  const activeNotifications = v4UpgradeUiEnabled
    ? []
    : getActiveSidebarNotifications(notificationState.dismissedIds);
  const isConfuseDesktop = useConfuseDesktopAvailability();
  const isDemoProject = Boolean(
    isLangfuseCloud &&
    env.NEXT_PUBLIC_DEMO_ORG_ID &&
    env.NEXT_PUBLIC_DEMO_PROJECT_ID &&
    routerProjectId === env.NEXT_PUBLIC_DEMO_PROJECT_ID,
  );

  return (
    <SidebarPanel>
      <SidebarOrganizationHeader />
      {isDemoProject && (
        <div
          className={motion.expandedSection}
          data-collapsed={isCollapsed}
          data-sidebar-expanded-only=""
          inert={isCollapsed}
        >
          <div className={cn(motion.sectionContent, motion.label)}>
            <SidebarPanel.Section>
              <SidebarDemoNotice />
            </SidebarPanel.Section>
          </div>
        </div>
      )}
      <SidebarPanel.Body>
        <SidebarNavigation label="Main" items={mainNavigation} />
        <SidebarPanel.Spacer />
        {activeNotifications.length > 0 && (
          <div
            className={motion.expandedSection}
            data-collapsed={isCollapsed}
            data-sidebar-expanded-only=""
            inert={isCollapsed}
          >
            <div className={cn(motion.sectionContent, motion.label)}>
              <div className="px-2">
                <SidebarNotifications
                  state={notificationState}
                  activeNotifications={activeNotifications}
                />
              </div>
            </div>
          </div>
        )}
        <SidebarNavigation label="More" items={secondaryNavigation} />
      </SidebarPanel.Body>
      <SidebarPanel.Footer>
        {isConfuseDesktop && (
          <NotificationCenter>
            {({ unreadCount, Trigger }) => (
              <Trigger asChild>
                <button
                  type="button"
                  aria-label={
                    unreadCount > 0
                      ? `Notifications, ${unreadCount} unread`
                      : "Notifications"
                  }
                  className={cn(
                    "text-muted-foreground hover:bg-sidebar-accent focus-visible:ring-sidebar-ring rounded-md text-xs outline-hidden focus-visible:ring-2",
                    motion.version,
                  )}
                >
                  <span className={motion.iconLane}>
                    <Bell size="base" />
                    {unreadCount > 0 && (
                      <span className="bg-destructive text-destructive-foreground absolute -top-1 -right-1 rounded-full px-1 text-[10px]">
                        {unreadCount > 99 ? "99+" : unreadCount}
                      </span>
                    )}
                  </span>
                  <span
                    className={cn(motion.identity, motion.label)}
                    data-surface={surface}
                  >
                    Notifications
                  </span>
                </button>
              </Trigger>
            )}
          </NotificationCenter>
        )}
        <SidebarVersionMenu state={versionState}>
          {({ Trigger, triggerProps }) => (
            <Trigger asChild>
              <SidebarVersionButton state={versionState} {...triggerProps} />
            </Trigger>
          )}
        </SidebarVersionMenu>
        <SidebarUserMenu
          user={user}
          items={userMenuItems}
          side={surface === "mobile" ? "top" : "right"}
        >
          {({ Trigger }) => (
            <Trigger asChild>
              <SidebarAccountButton user={user} />
            </Trigger>
          )}
        </SidebarUserMenu>
      </SidebarPanel.Footer>
    </SidebarPanel>
  );
}
