// Task 7: attachment staging and verbatim text/Enter submission, independent
// of native pickers and transport. Removal cancels local work at await boundaries.
import type { AttachUploadResult } from "@jarvis/wire";
import type { SendResult, SessionInput } from "./session-input";

export type TrayItem = {
  id: string;
  name: string;
  state: "uploading" | "done" | "error";
  progress?: number;
  path?: string;
  error?: string;
};
export type AttachTray = {
  add(pick: { name: string }): void;
  remove(id: string): void;
  items(): TrayItem[];
  busy(): boolean;
  paths(): string[];
  clear(): void;
  subscribe(fn: () => void): () => void;
};

export function createAttachTray<Pick extends { name: string }>(deps: {
  /** `onProgress` takes the sent fraction, 0..1, for the chip's bar;
   *  `onCancel` registers what stops this upload when its chip goes. */
  upload(
    pick: Pick,
    onProgress?: (fraction: number) => void,
    onCancel?: (cancel: () => void) => void,
  ): Promise<{ fileId: string } | { error: string }>;
  attach(fileId: string): Promise<AttachUploadResult>;
  maxFiles: number;
}): Omit<AttachTray, "add"> & { add(pick: Pick): void } {
  let entries: TrayItem[] = [];
  let nextId = 0;
  const listeners = new Set<() => void>();
  const cancels = new Map<string, () => void>();
  function stop(id: string): void {
    const cancel = cancels.get(id);
    cancels.delete(id);
    cancel?.();
  }
  function emit(): void {
    for (const fn of [...listeners]) fn();
  }
  function update(id: string, patch: Partial<TrayItem>): void {
    entries = entries.map((item) => (item.id === id ? { ...item, ...patch } : item));
    emit();
  }
  async function upload(id: string, pick: Pick): Promise<void> {
    const active = () => entries.some((item) => item.id === id);
    try {
      const result = await deps.upload(
        pick,
        (fraction) => {
          if (active()) update(id, { progress: Math.max(0, Math.min(1, fraction)) });
        },
        (cancel) => {
          if (active()) cancels.set(id, cancel);
          else cancel();
        },
      );
      cancels.delete(id);
      if (!active()) return;
      if ("error" in result) {
        update(id, { state: "error", error: result.error });
        return;
      }
      const attached = await deps.attach(result.fileId);
      if (!active()) return;
      update(
        id,
        attached.ok
          ? { state: "done", path: attached.path }
          : { state: "error", error: attached.error },
      );
    } catch (error) {
      if (active())
        update(id, {
          state: "error",
          error: error instanceof Error ? error.message : "Upload failed",
        });
    }
  }
  return {
    add(pick) {
      if (entries.length >= deps.maxFiles) return;
      const id = String(++nextId);
      entries = [...entries, { id, name: pick.name, state: "uploading" }];
      emit();
      void upload(id, pick);
    },
    remove(id) {
      stop(id);
      entries = entries.filter((item) => item.id !== id);
      emit();
    },
    items: () => entries.map((item) => ({ ...item })),
    busy: () => entries.some((item) => item.state === "uploading"),
    paths: () =>
      entries.flatMap((item) =>
        item.state === "done" && item.path !== undefined ? [item.path] : [],
      ),
    clear() {
      for (const id of [...cancels.keys()]) stop(id);
      entries = [];
      emit();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

export function composeSubmission(
  text: string,
  paths: readonly string[],
): { text: string; enter: true } {
  return {
    text: paths.length ? `${paths.map((path) => `@${path}`).join(" ")} ${text}` : text,
    enter: true,
  };
}

export async function submit(
  input: SessionInput,
  tray: Pick<AttachTray, "busy" | "paths" | "clear">,
  text: string,
): Promise<"sent" | "blocked" | SendResult> {
  if (tray.busy()) return "blocked";
  const submission = composeSubmission(text, tray.paths());
  if (submission.text !== "") {
    const result = await input.sendText(submission.text);
    if (result.kind !== "sent") return result;
  }
  const entered = await input.sendKey("enter");
  if (entered.kind !== "sent") return entered;
  tray.clear();
  return "sent";
}
