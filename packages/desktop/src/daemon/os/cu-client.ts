// packages/desktop/src/daemon/os/cu-client.ts
// jarvisd's side of the jarvis-cu control socket (Rafiq v1.1 contracts §1):
// $XDG_RUNTIME_DIR/jarvis/cu.sock, newline-delimited JSON, one request id per
// call, typed refusals, and pushed `paused` events. Before the first byte is
// sent the kernel must name /usr/libexec/jarvis/jarvis-cu as the program on
// the other end (the M3 §5.8 sock_diag method, injected as verifyPeer), so a
// look-alike socket never receives a goal, a keystroke or a coordinate.
// Nothing here logs payloads: op names and error codes only.
//
// No electron here (core/no-electron.test.ts).
import { createConnection, type Socket } from "node:net";
import {
  type CuClient,
  CuClientError,
  type CuPauseReason,
  isCuPauseReason,
  isRecord,
  parseCuAppList,
  parseCuCapture,
  parseCuDescription,
  parseCuErrorCode,
  parseCuWindows,
} from "@jarvis/core";

export const CU_HELPER_PATH = "/usr/libexec/jarvis/jarvis-cu";
export const CU_REQUEST_TIMEOUT_MS = 10_000;
export const CU_CAPTURE_TIMEOUT_MS = 20_000;
export const CU_MAX_LINE_CHARS = 24 * 1024 * 1024;

export function cuSocketPath(env: { XDG_RUNTIME_DIR?: string | undefined }): string | undefined {
  const dir = env.XDG_RUNTIME_DIR;
  if (dir === undefined || dir === "" || !dir.startsWith("/")) return undefined;
  return `${dir.replace(/\/+$/, "")}/jarvis/cu.sock`;
}

export function connectUnix(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

export type CuClientOptions = {
  connect(): Promise<Socket>;
  /** True only when the kernel names jarvis-cu as the peer program. */
  verifyPeer(socket: Socket): Promise<boolean>;
  timers: {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  log(line: string): void;
  requestTimeoutMs?: number;
  captureTimeoutMs?: number;
  maxLineChars?: number;
};

type Pending = {
  op: string;
  resolve(data: unknown): void;
  reject(error: Error): void;
  timer: unknown;
};

export function createCuClient(options: CuClientOptions): CuClient & { close(): void } {
  const requestTimeout = options.requestTimeoutMs ?? CU_REQUEST_TIMEOUT_MS;
  const captureTimeout = options.captureTimeoutMs ?? CU_CAPTURE_TIMEOUT_MS;
  const maxLine = options.maxLineChars ?? CU_MAX_LINE_CHARS;
  const pending = new Map<string, Pending>();
  const pausedListeners = new Set<(reason: CuPauseReason) => void>();
  const goneListeners = new Set<() => void>();
  let socket: Socket | undefined;
  let opening: Promise<Socket> | undefined;
  let nextId = 0;

  function failAll(error: CuClientError): void {
    for (const [id, entry] of pending) {
      options.timers.clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(error);
    }
  }

  function onLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      options.log("[cu] jarvis-cu sent a line that is not JSON; ignored");
      return;
    }
    if (!isRecord(message)) return;
    if (typeof message["event"] === "string") {
      if (message["event"] === "paused" && isCuPauseReason(message["reason"])) {
        const reason = message["reason"];
        for (const listener of [...pausedListeners]) listener(reason);
      }
      return;
    }
    const id = message["id"];
    if (typeof id !== "string") return;
    const entry = pending.get(id);
    if (entry === undefined) return;
    pending.delete(id);
    options.timers.clearTimeout(entry.timer);
    if (message["ok"] === true) {
      entry.resolve(message["data"] ?? null);
      return;
    }
    const error = isRecord(message["error"]) ? message["error"] : {};
    const code = parseCuErrorCode(error["code"]);
    const text =
      typeof error["message"] === "string"
        ? error["message"].slice(0, 300)
        : `jarvis-cu refused ${entry.op}`;
    options.log(`[cu] ${entry.op}: ${code}`);
    entry.reject(new CuClientError(code, text));
  }

  async function open(): Promise<Socket> {
    if (socket !== undefined && !socket.destroyed) return socket;
    if (opening !== undefined) return opening;
    opening = (async () => {
      let connected: Socket;
      try {
        connected = await options.connect();
      } catch (error) {
        throw new CuClientError(
          "unsupported",
          `jarvis-cu is not running (${(error as { code?: string }).code ?? "no socket"})`,
        );
      }
      if (!(await options.verifyPeer(connected).catch(() => false))) {
        connected.destroy();
        options.log("[cu] the program on cu.sock is not jarvis-cu; refused");
        throw new CuClientError(
          "unsupported",
          "The program on the computer-use socket is not jarvis-cu.",
        );
      }
      let buffer = "";
      connected.setEncoding("utf8");
      connected.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > maxLine) {
          options.log("[cu] jarvis-cu sent a line that is too long; disconnecting");
          connected.destroy();
          return;
        }
        for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.trim() !== "") onLine(line);
        }
      });
      connected.on("error", (error: NodeJS.ErrnoException) =>
        options.log(`[cu] socket error: ${error.code ?? "unknown"}`),
      );
      connected.on("close", () => {
        if (socket === connected) socket = undefined;
        failAll(new CuClientError("failed", "jarvis-cu closed the connection"));
        for (const listener of [...goneListeners]) listener();
      });
      socket = connected;
      return connected;
    })().finally(() => {
      opening = undefined;
    });
    return opening;
  }

  async function request(
    op: string,
    fields: Record<string, unknown>,
    timeoutMs = requestTimeout,
  ): Promise<unknown> {
    const connected = await open();
    nextId++;
    const id = `r${nextId}`;
    return new Promise((resolve, reject) => {
      const timer = options.timers.setTimeout(() => {
        pending.delete(id);
        options.log(`[cu] ${op}: no answer in ${timeoutMs} ms`);
        reject(new CuClientError("failed", `jarvis-cu did not answer ${op} in time`));
      }, timeoutMs);
      pending.set(id, { op, resolve, reject, timer });
      connected.write(`${JSON.stringify({ id, op, ...fields })}\n`);
    });
  }

  const none = async (op: string, fields: Record<string, unknown> = {}) => {
    await request(op, fields);
  };

  return {
    apps: async () => parseCuAppList(await request("apps", {})),
    describeAt: async (x, y) => parseCuDescription(await request("describeAt", { x, y })),
    begin: (sessionId, appIds) => none("begin", { sessionId, appIds: [...appIds] }),
    windows: async () => parseCuWindows(await request("windows", {})),
    capture: async (maxEdge) =>
      parseCuCapture(await request("capture", { maxEdge }, captureTimeout)),
    click: (x, y, button, double) =>
      none("click", { x, y, button, ...(double ? { double: true } : {}) }),
    type: (text) => none("type", { text }),
    key: (combo) => none("key", { combo }),
    scroll: (x, y, dx, dy) => none("scroll", { x, y, dx, dy }),
    drag: (x1, y1, x2, y2) => none("drag", { x1, y1, x2, y2 }),
    end: () => none("end"),
    onPaused(listener) {
      pausedListeners.add(listener);
      return () => pausedListeners.delete(listener);
    },
    onGone(listener) {
      goneListeners.add(listener);
      return () => goneListeners.delete(listener);
    },
    close() {
      socket?.destroy();
      socket = undefined;
    },
  };
}
