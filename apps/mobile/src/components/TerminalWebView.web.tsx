// The browser build's terminal surface (Task 13): the same xterm page as
// native, but as a static file — /terminal.html with an external, hashed
// script (scripts/emit-terminal-web.mjs writes both at export time), so
// neither it nor the app needs an inline <script> in any CSP. It loads in
// a sandboxed iframe (`allow-scripts` only — an opaque origin: no
// same-origin access to this app, no storage, no navigation, no popups,
// no forms). The page's URL is relative to wherever the app itself was
// served; nothing here reads the host or port. It speaks the same
// terminal-protocol.ts messages as the native WebView:
//
// - page → app: `parseFrameMessage` drops every `message` event whose
//   `source` is not this iframe's own `contentWindow`, then parses the
//   rest field by field — nothing unparsed is ever forwarded.
// - app → page: `postMessage(text, "*")`. The `"*"` target is unavoidable:
//   without `allow-same-origin` the frame's origin is opaque ("null"),
//   and a postMessage target origin can never match an opaque origin —
//   naming the server's origin would drop every message. The recipient is
//   pinned by the `contentWindow` reference itself, and the page accepts
//   messages only from its parent.
//
// Attach/replay behaviour mirrors TerminalWebView.tsx: writes before the
// page's first `ready` are buffered (bounded by ATTACH_BUFFER_MAX_CHARS,
// overflow asks for a replay), then flushed through the same write
// batcher. The iframe's document is never reloaded (no navigation is
// possible inside the sandbox), so the ready gate is armed exactly once.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { realClock } from "@/lib/clock";
import { ATTACH_BUFFER_MAX_CHARS } from "@/lib/session-stream";
import type { NativeMessage } from "@/lib/terminal-protocol";
import { encodeNativeMessage, parseFrameMessage } from "@/lib/terminal-protocol";
import { createTerminalReadyGate } from "@/lib/terminal-ready";
import { createWriteBatcher } from "@/lib/write-batcher";
import type { TerminalWebViewHandle, TerminalWebViewProps } from "./TerminalWebView";

export type { TerminalModes, TerminalWebViewHandle, TerminalWebViewProps } from "./TerminalWebView";

export const TerminalWebView = forwardRef<TerminalWebViewHandle, TerminalWebViewProps>(
  function TerminalWebView({ onReady, onResize, onModes, onNeedsReplay, onWheel, fixedSize }, ref) {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const readyRef = useRef(false);
    const attachBufferRef = useRef("");
    const attachOverflowedRef = useRef(false);
    const fixedSizeRef = useRef<{ cols: number; rows: number } | undefined>(fixedSize);
    fixedSizeRef.current = fixedSize;
    const readyGateRef = useRef<ReturnType<typeof createTerminalReadyGate> | null>(null);
    if (readyGateRef.current === null) {
      readyGateRef.current = createTerminalReadyGate();
      readyGateRef.current.arm();
    }
    const droppedMessageCountRef = useRef(0);

    const postToPage = useCallback((message: NativeMessage) => {
      // Opaque-origin sandboxed frame: "*" is the only target that can match
      // (see the file header); the contentWindow reference pins the recipient.
      iframeRef.current?.contentWindow?.postMessage(encodeNativeMessage(message), "*");
    }, []);

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

    useEffect(() => {
      return () => {
        batcherRef.current?.dispose();
      };
    }, []);

    const write = useCallback(
      (data: string) => {
        if (readyRef.current) {
          getBatcher().write(data);
          return;
        }
        if (attachOverflowedRef.current) return;
        const next = attachBufferRef.current + data;
        if (next.length > ATTACH_BUFFER_MAX_CHARS) {
          attachOverflowedRef.current = true;
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
      attachBufferRef.current = "";
      attachOverflowedRef.current = false;
      postToPage({ t: "reset" });
    }, [postToPage, getBatcher]);

    const postFit = useCallback(() => {
      postToPage({ t: "fit" });
    }, [postToPage]);

    useImperativeHandle(ref, () => ({ write, reset, fit: postFit }), [write, reset, postFit]);

    useEffect(() => {
      function handleMessage(event: MessageEvent): void {
        const frameWindow = iframeRef.current?.contentWindow;
        // The one gate: source must be our iframe, then a field-by-field parse.
        const message = parseFrameMessage(event, frameWindow);
        if (message === undefined) {
          // Another window's message is none of our business — only our
          // own page's malformed ones are counted.
          if (frameWindow === null || frameWindow === undefined || event.source !== frameWindow) {
            return;
          }
          droppedMessageCountRef.current += 1;
          console.log(
            "[terminal] dropped an unparseable page message, total:",
            droppedMessageCountRef.current,
          );
          return;
        }
        switch (message.t) {
          case "ready": {
            if (readyGateRef.current?.accept() === "duplicate") {
              console.log(
                "[terminal] dropped a duplicate ready, total:",
                readyGateRef.current?.dropped(),
              );
              return;
            }
            readyRef.current = true;
            const buffered = attachBufferRef.current;
            const overflowed = attachOverflowedRef.current;
            attachBufferRef.current = "";
            attachOverflowedRef.current = false;
            if (buffered.length > 0 && !overflowed) getBatcher().write(buffered);
            onReady({ cols: message.cols, rows: message.rows });
            if (fixedSizeRef.current !== undefined) {
              postToPage({
                t: "size",
                cols: fixedSizeRef.current.cols,
                rows: fixedSizeRef.current.rows,
              });
            }
            if (overflowed) {
              console.log("[terminal] requesting a replay after attach buffer overflow");
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
          case "wheel":
            onWheel(message.direction);
            return;
        }
      }
      window.addEventListener("message", handleMessage);
      return () => {
        window.removeEventListener("message", handleMessage);
      };
    }, [onReady, onResize, onModes, onNeedsReplay, onWheel, postToPage, getBatcher]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on fixedSize's own cols/rows, deliberately not the object itself — a new object with the same values must not re-post.
    useEffect(() => {
      if (!readyRef.current || fixedSize === undefined) return;
      postToPage({ t: "size", cols: fixedSize.cols, rows: fixedSize.rows });
    }, [fixedSize?.cols, fixedSize?.rows, postToPage]);

    return (
      <View style={styles.container} onLayout={postFit}>
        <iframe
          ref={iframeRef}
          title="terminal"
          src={TERMINAL_PAGE_URL}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          style={IFRAME_STYLE}
        />
      </View>
    );
  },
);

/** Written into the export by scripts/emit-terminal-web.mjs. */
const TERMINAL_PAGE_URL = "/terminal.html";

const IFRAME_STYLE = { border: "none", width: "100%", height: "100%", display: "block" } as const;

const styles = StyleSheet.create({
  // ruling 12: the terminal container is always LTR, in both app languages.
  container: {
    flex: 1,
    direction: "ltr",
  },
});
