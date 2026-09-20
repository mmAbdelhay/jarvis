// The display-only terminal surface (Task 6, task-6-brief.md rule 8). Loads
// the generated, CSP-hashed xterm page once from an inline HTML string —
// never a URL — and never lets it navigate anywhere else. Layout and
// wiring only: every decision (what counts as a valid page message, how
// writes are batched, which WebView props harden it) lives in plain,
// tested modules under src/lib — this file just connects them.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import WebView, { type WebViewMessageEvent } from "react-native-webview";
import { realClock } from "@/lib/clock";
import type { NativeMessage } from "@/lib/terminal-protocol";
import { encodeNativeMessage, parsePageMessage } from "@/lib/terminal-protocol";
import { ATTACH_BUFFER_MAX_CHARS } from "@/lib/session-stream";
import { createTerminalReadyGate } from "@/lib/terminal-ready";
import { allowTerminalNavigation, TERMINAL_WEBVIEW_PROPS } from "@/lib/terminal-webview-config";
import { createWriteBatcher } from "@/lib/write-batcher";
import { TERMINAL_HTML } from "@/terminal/terminal-html.generated";

export type TerminalModes = { applicationCursor: boolean };

export type TerminalWebViewHandle = {
  write(data: string): void;
  reset(): void;
  fit(): void;
};

export type TerminalWebViewProps = {
  onReady(size: { cols: number; rows: number }): void;
  onResize(size: { cols: number; rows: number }): void;
  onModes(modes: TerminalModes): void;
  onNeedsReplay(): void;
};

export const TerminalWebView = forwardRef<TerminalWebViewHandle, TerminalWebViewProps>(
  function TerminalWebView({ onReady, onResize, onModes, onNeedsReplay }, ref) {
    const webViewRef = useRef<WebView>(null);
    const [remountKey, setRemountKey] = useState(0);

    // Mutable, render-independent state for the attach/replay protocol —
    // none of it drives a re-render, it only decides what to post next.
    const readyRef = useRef(false);
    const attachBufferRef = useRef("");
    const attachOverflowedRef = useRef(false);
    const attachDroppedCharsRef = useRef(0);
    const readyGateRef = useRef<ReturnType<typeof createTerminalReadyGate> | null>(null);
    if (readyGateRef.current === null) readyGateRef.current = createTerminalReadyGate();
    const droppedMessageCountRef = useRef(0);

    const postToPage = useCallback((message: NativeMessage) => {
      webViewRef.current?.postMessage(encodeNativeMessage(message));
    }, []);

    // Fix round 1, M4: `useRef(createWriteBatcher(...))` evaluates its
    // argument on *every* render (only the first result is kept, the rest
    // are discarded) — the lazy-ref pattern below avoids that by
    // constructing the batcher on demand, the first time anything needs
    // it, instead of inside the `useRef()` call itself.
    const batcherRef = useRef<ReturnType<typeof createWriteBatcher> | null>(null);
    const getBatcher = useCallback((): ReturnType<typeof createWriteBatcher> => {
      if (batcherRef.current === null) {
        batcherRef.current = createWriteBatcher({
          clock: realClock,
          flush: (data) => postToPage({ t: "write", data }),
        });
      }
      return batcherRef.current;
    }, [postToPage]);

    // Fix round 1, M4: dispose the batcher's timer on unmount. Harmless
    // today (the flush callback goes through `webViewRef.current?.`), but
    // a timer firing after unmount is still a timer that shouldn't exist.
    useEffect(() => {
      return () => {
        batcherRef.current?.dispose();
      };
    }, []);

    const resetAttachState = useCallback(() => {
      attachBufferRef.current = "";
      attachOverflowedRef.current = false;
      attachDroppedCharsRef.current = 0;
    }, []);

    const remount = useCallback(() => {
      // A crash: the page and everything it held is gone. Remount with a
      // fresh key, and treat the next `ready` as an attach that needs a
      // full replay from the host (Task 8's SessionStream.restart).
      console.log("[terminal] WebView process gone, remounting");
      readyRef.current = false;
      batcherRef.current?.dispose();
      // Left null, not eagerly rebuilt: getBatcher() lazily makes a fresh
      // one the next time anything actually needs it (the same laziness
      // as the initial construction).
      batcherRef.current = null;
      resetAttachState();
      readyGateRef.current?.arm();
      setRemountKey((key) => key + 1);
    }, [resetAttachState]);

    const write = useCallback(
      (data: string) => {
        if (readyRef.current) {
          getBatcher().write(data);
          return;
        }
        if (attachOverflowedRef.current) {
          attachDroppedCharsRef.current += data.length;
          return;
        }
        const next = attachBufferRef.current + data;
        if (next.length > ATTACH_BUFFER_MAX_CHARS) {
          attachOverflowedRef.current = true;
          attachDroppedCharsRef.current = next.length;
          attachBufferRef.current = "";
          console.log("[terminal] attach buffer overflow, chars dropped:", next.length);
          return;
        }
        attachBufferRef.current = next;
      },
      [getBatcher],
    );

    const reset = useCallback(() => {
      getBatcher().clear();
      // Final review M3: clear the pre-ready attach buffer too, so a
      // reset that lands on a not-yet-ready page doesn't leave stale
      // buffered writes to flush later against a page that was told to
      // reset.
      resetAttachState();
      postToPage({ t: "reset" });
    }, [postToPage, getBatcher, resetAttachState]);

    // Named `postFit`, not `fit`: a bare call to an identifier named `fit`
    // reads to biome's linter as Jasmine/Jest's focused-test `fit(...)`, so
    // it's exposed on the handle as `fit` (the interface name) without
    // ever being *called* under that bare name.
    const postFit = useCallback(() => {
      postToPage({ t: "fit" });
    }, [postToPage]);

    useImperativeHandle(ref, () => ({ write, reset, fit: postFit }), [write, reset, postFit]);

    const handleMessage = useCallback(
      (event: WebViewMessageEvent) => {
        const message = parsePageMessage(event.nativeEvent.data);
        if (message === undefined) {
          droppedMessageCountRef.current += 1;
          console.log(
            "[terminal] dropped an unparseable page message, total:",
            droppedMessageCountRef.current,
          );
          return;
        }
        switch (message.t) {
          case "ready": {
            const disposition = readyGateRef.current?.accept();
            if (disposition === "duplicate") {
              // Fix round 3, N-r2-2: log like the unparseable-message path
              // does, and read the gate's own counter instead of keeping a
              // second one for the same event.
              console.log(
                "[terminal] dropped a duplicate ready, total:",
                readyGateRef.current?.dropped(),
              );
              return;
            }
            readyRef.current = true;
            const buffered = attachBufferRef.current;
            const overflowed = attachOverflowedRef.current;
            const droppedChars = attachDroppedCharsRef.current;
            const isReattach = disposition === "replay";
            resetAttachState();
            // Final review I1: only a genuine initial ready flushes the
            // pre-ready buffer straight into the fresh page. A "replay"
            // disposition means onNeedsReplay() below drives
            // SessionStream.restart(sink), which re-snapshots from offset
            // 0 — that snapshot already covers everything buffered here,
            // so flushing it first would write the same tail twice. An
            // overflow already dropped the buffer's contents; there is
            // nothing coherent left to flush either way.
            if (buffered.length > 0 && !isReattach && !overflowed) {
              getBatcher().write(buffered);
            }
            onReady({ cols: message.cols, rows: message.rows });
            if (overflowed || isReattach) {
              if (overflowed) {
                console.log(
                  "[terminal] requesting a replay after attach buffer overflow, chars dropped:",
                  droppedChars,
                );
              }
              if (isReattach) {
                console.log("[terminal] requesting a replay after a re-attach (ready seen again)");
              }
              onNeedsReplay();
            }
            return;
          }
          case "resize":
            onResize({ cols: message.cols, rows: message.rows });
            return;
          case "modes":
            onModes({ applicationCursor: message.applicationCursor });
            return;
        }
      },
      [onReady, onResize, onModes, onNeedsReplay, resetAttachState, getBatcher],
    );

    const handleLayout = useCallback(
      (_event: LayoutChangeEvent) => {
        postFit();
      },
      [postFit],
    );

    return (
      <View style={styles.container} onLayout={handleLayout}>
        <WebView
          key={remountKey}
          ref={webViewRef}
          {...TERMINAL_WEBVIEW_PROPS}
          source={{ html: TERMINAL_HTML, baseUrl: "about:blank" }}
          webviewDebuggingEnabled={__DEV__}
          onShouldStartLoadWithRequest={(request) => allowTerminalNavigation(request.url)}
          onLoadStart={() => {
            // Fix round 3, N-r2-1: every native load-start arms the ready
            // gate, but only a *reattach* (a reload, or a crash remount's
            // own load — the second or later load this gate has ever
            // seen) also clears the pre-ready attach buffer. On the very
            // first load ("initial"), this event can reach JS after the
            // host has already started calling write() — clearing here
            // would silently drop those writes before they ever get a
            // chance to flush on the first `ready`. A reattach's stale
            // buffer is safe to drop because the `ready` that follows is
            // dispositioned "replay", which drives onNeedsReplay() and a
            // full host resnapshot instead.
            const loadKind = readyGateRef.current?.arm();
            readyRef.current = false;
            if (loadKind === "reattach") {
              batcherRef.current?.clear();
              resetAttachState();
            }
          }}
          onMessage={handleMessage}
          onContentProcessDidTerminate={remount}
          onRenderProcessGone={remount}
          style={styles.webview}
        />
      </View>
    );
  },
);

const styles = StyleSheet.create({
  // ruling 12: the terminal container is always LTR, in both app languages.
  container: {
    flex: 1,
    direction: "ltr",
  },
  webview: {
    flex: 1,
  },
});
