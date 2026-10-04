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
//
// Wide layout (Review Focus 4): with `onHardwareInput` set, a hardware
// keyboard types into the terminal. The page stays display-only (it never
// produces pty bytes), so the keys are read here instead, by a hidden
// textarea in the app's own document: a click on the terminal moves focus
// into the frame, and this takes it straight back. Every key it reads
// stops there, so nothing typed into the terminal reaches the shell's own
// handlers (terminal-keyboard.ts has the routing rules). A copy chord
// copies the page's last reported selection (its one content-bearing
// message, which only ever goes to the clipboard); a paste chord is left
// to the browser, whose paste event sends the clipboard.
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ClipboardEvent,
  type CompositionEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { StyleSheet, View } from "react-native";
import { realClock } from "@/lib/clock";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { composedInput, pasteInput, routeTerminalKey, strayInput } from "@/lib/terminal-keyboard";
import { ATTACH_BUFFER_MAX_CHARS } from "@/lib/session-stream";
import type { NativeMessage } from "@/lib/terminal-protocol";
import { encodeNativeMessage, parseFrameMessage } from "@/lib/terminal-protocol";
import { createTerminalReadyGate } from "@/lib/terminal-ready";
import { theme } from "@/lib/theme";
import { createWriteBatcher } from "@/lib/write-batcher";
import type { TerminalWebViewHandle, TerminalWebViewProps } from "./TerminalWebView";

export type {
  TerminalModes,
  TerminalView,
  TerminalWebViewHandle,
  TerminalWebViewProps,
} from "./TerminalWebView";

export const TerminalWebView = forwardRef<TerminalWebViewHandle, TerminalWebViewProps>(
  function TerminalWebView(
    {
      onReady,
      onResize,
      onModes,
      onNeedsReplay,
      onWheel,
      fixedSize,
      onHardwareInput,
      onView,
      onFound,
    },
    ref,
  ) {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const language = useLanguage();
    const captureRef = useRef<HTMLTextAreaElement>(null);
    const hardwareInputRef = useRef(onHardwareInput);
    hardwareInputRef.current = onHardwareInput;
    const keysEnabled = onHardwareInput !== undefined;
    const [keysFocused, setKeysFocused] = useState(false);
    // The page's current mouse selection ("" for none).
    const selectionRef = useRef("");
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
      selectionRef.current = "";
      getBatcher().clear();
      attachBufferRef.current = "";
      attachOverflowedRef.current = false;
      postToPage({ t: "reset" });
    }, [postToPage, getBatcher]);

    const postFit = useCallback(() => {
      postToPage({ t: "fit" });
    }, [postToPage]);

    const jump = useCallback(
      (to: "latest" | "prevCommand" | "nextCommand") => postToPage({ t: "jump", to }),
      [postToPage],
    );
    const find = useCallback(
      (query: string, direction: "next" | "prev") => postToPage({ t: "find", query, direction }),
      [postToPage],
    );

    useImperativeHandle(ref, () => ({ write, reset, fit: postFit, jump, find }), [
      write,
      reset,
      postFit,
      jump,
      find,
    ]);

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
          case "view":
            onView?.({ back: message.back, commands: message.commands });
            return;
          case "found":
            onFound?.(message.ok);
            return;
          case "selection":
            selectionRef.current = message.text;
            return;
        }
      }
      window.addEventListener("message", handleMessage);
      return () => {
        window.removeEventListener("message", handleMessage);
      };
    }, [
      onReady,
      onResize,
      onModes,
      onNeedsReplay,
      onWheel,
      postToPage,
      getBatcher,
      onView,
      onFound,
    ]);

    // A click on the terminal focuses the frame (the window blurs with the
    // frame as its active element); the capture textarea takes the focus
    // back so the keys reach this document. Wheel scrolling and selection
    // still happen in the frame.
    useEffect(() => {
      if (!keysEnabled) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      function handleBlur(): void {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (document.activeElement === iframeRef.current) {
            captureRef.current?.focus({ preventScroll: true });
          }
        }, 0);
      }
      window.addEventListener("blur", handleBlur);
      return () => {
        clearTimeout(timer);
        window.removeEventListener("blur", handleBlur);
      };
    }, [keysEnabled]);

    const handleKeyDown = useCallback(
      (event: KeyboardEvent<HTMLTextAreaElement>) => {
        const route = routeTerminalKey(event.nativeEvent, {
          hasSelection: selectionRef.current !== "",
        });
        if (route.stopPropagation) event.stopPropagation();
        if (route.preventDefault) event.preventDefault();
        if (route.copy) {
          // Inside the key gesture, so the browser allows the write. The
          // selection is then dropped, so the next Ctrl+C interrupts.
          const text = selectionRef.current;
          void navigator.clipboard?.writeText(text).catch(() => {
            console.log("[terminal] copy to the clipboard was refused");
          });
          selectionRef.current = "";
          postToPage({ t: "clearSelection" });
          return;
        }
        if (route.input !== undefined) hardwareInputRef.current?.(route.input);
      },
      [postToPage],
    );

    const handlePaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const input = pasteInput(event.clipboardData.getData("text/plain"));
      if (input !== undefined) hardwareInputRef.current?.(input);
    }, []);

    // An IME or dead-key composition, sent once when committed (Chrome
    // commits with a composing input event and then compositionend;
    // Safari fires compositionend and then a plain input event).
    const handleCompositionEnd = useCallback((event: CompositionEvent<HTMLTextAreaElement>) => {
      const input = composedInput(event.currentTarget, event.data);
      if (input !== undefined) hardwareInputRef.current?.(input);
    }, []);

    // Any other text the keydown handler left alone: send it and clear.
    const handleInput = useCallback((event: FormEvent<HTMLTextAreaElement>) => {
      const composing = (event.nativeEvent as InputEvent).isComposing;
      const input = strayInput(event.currentTarget, composing);
      if (input !== undefined) hardwareInputRef.current?.(input);
    }, []);

    // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on fixedSize's own cols/rows, deliberately not the object itself — a new object with the same values must not re-post.
    useEffect(() => {
      if (!readyRef.current) return;
      // Fit toggle: a size taken away again sends the page back to fitting.
      if (fixedSize === undefined) {
        postToPage({ t: "free" });
        return;
      }
      postToPage({ t: "size", cols: fixedSize.cols, rows: fixedSize.rows });
    }, [fixedSize?.cols, fixedSize?.rows, postToPage]);

    return (
      <View
        style={[
          styles.container,
          keysEnabled && styles.keysFrame,
          keysEnabled && keysFocused && styles.keysFocused,
        ]}
        onLayout={postFit}
      >
        {keysEnabled && (
          <textarea
            ref={captureRef}
            aria-label={t(language, "terminal.keyboardInput")}
            inputMode="none"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            tabIndex={0}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onInput={handleInput}
            onCompositionEnd={handleCompositionEnd}
            onFocus={() => setKeysFocused(true)}
            onBlur={() => setKeysFocused(false)}
            style={CAPTURE_STYLE}
          />
        )}
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

// Present and focusable but invisible: a 1px transparent box at the
// terminal's top corner, out of the pointer's way.
const CAPTURE_STYLE = {
  position: "absolute",
  top: 0,
  width: 1,
  height: 1,
  opacity: 0,
  border: "none",
  padding: 0,
  resize: "none",
  overflow: "hidden",
  pointerEvents: "none",
} as const;

const styles = StyleSheet.create({
  // ruling 12: the terminal container is always LTR, in both app languages.
  container: {
    flex: 1,
    direction: "ltr",
  },
  // A hairline that turns accent while the keyboard types into the
  // terminal: the focus the click moved here is visible.
  keysFrame: { borderWidth: 1, borderColor: "transparent" },
  keysFocused: { borderColor: theme.colors.accent },
});
