// A tapped notification may be for any machine, so what hears it lives above the
// keyed tree: one subscription for the app's life, and one set of handled ids,
// or `lastResponse()` would replay the last tap on every machine switched to.
// Every decision is `handleNotificationTap`'s (push-context-support.ts).
import { useRouter } from "expo-router";
import { useEffect, useMemo, useRef } from "react";
import { dialogs } from "./dialog";
import { t } from "./i18n";
import { useLanguage } from "./language-context";
import { useMachineSessions, useNavigatorGate } from "./machine-context";
import { machineStore } from "./machine-store-instance";
import { NOTIFICATION_NAV_WAIT_MS } from "./notification-tap";
import type { NotificationResponse, NotificationsAdapter } from "./notifications";
import { gateTapRouter, handleNotificationTap, waitForOpen } from "./push-context-support";

export function NotificationTapHost(props: { adapter: NotificationsAdapter }): null {
  const { adapter } = props;
  const sessions = useMachineSessions();
  const gate = useNavigatorGate();
  const language = useLanguage();
  const router = useRouter();
  const handledIds = useRef(new Set<string>()).current;
  const tapRouter = useMemo(
    () => gateTapRouter(gate, sessions, (route) => router.push(route)),
    [gate, sessions, router],
  );

  useEffect(() => {
    const handle = (response: NotificationResponse): void => {
      handleNotificationTap(
        {
          sessions,
          findByDeviceId: machineStore.findByDeviceId,
          router: tapRouter,
          handledIds,
          waitForOpen: (client) => waitForOpen(client, NOTIFICATION_NAV_WAIT_MS),
          notice: () => dialogs.notice(t(language, "machines.tapGone")),
        },
        response,
      ).catch(() => console.warn("notifications: handling a tap failed"));
    };
    const unsubscribe = adapter.onResponse(handle);

    let cancelled = false;
    adapter
      .lastResponse()
      .then((response) => {
        if (!cancelled && response !== undefined) handle(response);
      })
      .catch(() => console.warn("notifications: reading the last tap failed"));

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [adapter, sessions, tapRouter, handledIds, language]);

  return null;
}
