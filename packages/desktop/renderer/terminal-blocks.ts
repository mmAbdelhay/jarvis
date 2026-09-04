// Where one command ends and the next begins.
//
// Pure by construction: chunks in, events out, the clock injected. Every
// hard case in this file is a case the tests state, because the stream is
// the one thing here we do not control — a mark can be split across two
// reads, a program can print its own OSC, and a shell can die mid-command.
//
// The one invariant that must never break: every byte that is not part of a
// mark comes out in an "output" event, in order. The live terminal is fed
// from those events, so a byte this file swallows is a byte the user never
// sees.

const ESC = "";
const BEL = "";
const ST = "\\";

export type BlockRecord = {
  id: number;
  command: string;
  /** Raw ANSI between C and D, capped at maxOutputBytes. */
  output: string;
  exitCode: number | undefined;
  startedAt: number;
  endedAt: number | undefined;
  cwd: string | undefined;
  truncated: boolean;
};

export type BlockEvent =
  /** Bytes the live xterm must draw. Emitted for every byte of the stream
   *  that is not an OSC mark, in order, always. */
  | { type: "output"; text: string }
  | { type: "prompt" }
  | { type: "command-start"; id: number; command: string; cwd: string | undefined }
  | { type: "block-done"; block: BlockRecord }
  | { type: "alt-screen"; active: boolean };

export type Splitter = {
  push(chunk: string): BlockEvent[];
  /** The command that is running now, if one is. */
  active(): BlockRecord | undefined;
};

const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/** The alternate-screen sequences, checked in this order so the shorter
 *  "on" form is never mistaken for a prefix of anything else. */
const ALT_SEQUENCES: ReadonlyArray<readonly [string, boolean]> = [
  ["[?1049h", true],
  ["[?1049l", false],
];

export function createSplitter(deps: { now?: () => number; maxOutputBytes?: number } = {}): Splitter {
  const now = deps.now ?? (() => Date.now());
  const maxOutputBytes = deps.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  /** A partial escape sequence left by the previous chunk. Held back rather
   *  than emitted: emitting half an escape sequence would draw garbage, and
   *  scanning it as plain bytes could hide a mark (or an alt-screen entry)
   *  that straddles the boundary. */
  let pending = "";
  let nextId = 1;
  let current: BlockRecord | undefined;
  let cwd: string | undefined;
  let alt = false;

  function startOsc(text: string, from: number): { payload: string; end: number } | undefined {
    // text[from] is ESC and text[from + 1] is "]". Returns undefined when
    // the terminator has not arrived yet.
    const bel = text.indexOf(BEL, from);
    const st = text.indexOf(ST, from);
    const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
    if (end === -1) return undefined;
    const payload = text.slice(from + 2, end);
    return { payload, end: end + (end === st ? ST.length : BEL.length) };
  }

  /**
   * What is kept past the cap, for the block being built: the tail, and how
   * many lines fell out between it and the head.
   *
   * Undefined until the head fills. The head is `current.output` itself,
   * frozen at `headBytes` once it is full; everything after that goes here,
   * with the front dropped as it overflows. The two are joined by
   * `finishOutput` when the block closes.
   */
  let overflow: { tail: string; elidedLines: number } | undefined;
  const headBytes = Math.ceil(maxOutputBytes / 2);
  const tailBytes = maxOutputBytes - headBytes;

  /**
   * Head and tail, not head alone.
   *
   * A build log's failure is at its *end* — truncating forward kept the
   * banner and threw away the error, and "Explain this failure" then sent
   * the brain the last 4 KB of the beginning of a log it was asked to
   * explain the end of. So the head is kept for context, the tail is kept
   * for the answer, and what fell out between them is stated rather than
   * silently dropped (the design's Bounds section: "the head and tail are
   * kept with a `… N lines elided` marker between them").
   */
  function appendOutput(text: string): void {
    if (current === undefined || alt || text === "") return;
    if (overflow === undefined) {
      const room = headBytes - current.output.length;
      if (text.length <= room) {
        current.output += text;
        return;
      }
      // The head is full: keep what fits, and open the tail with the rest.
      current.output += text.slice(0, room);
      current.truncated = true;
      overflow = { tail: "", elidedLines: 0 };
      text = text.slice(room);
    }
    overflow.tail += text;
    const excess = overflow.tail.length - tailBytes;
    if (excess <= 0) return;
    const dropped = overflow.tail.slice(0, excess);
    overflow.tail = overflow.tail.slice(excess);
    // Newlines in what fell out — a run of bytes with no newline in it at
    // all is still a piece of a line, so nothing ever elides "0 lines".
    const newlines = dropped.split("\n").length - 1;
    overflow.elidedLines += Math.max(1, newlines);
  }

  /** Joins the kept head to the kept tail, with the marker between them.
   *  Called once, as the block closes: until then `output` is the head and
   *  the tail is still moving. */
  function finishOutput(record: BlockRecord): void {
    if (overflow === undefined) return;
    record.output = `${record.output}\r\n… ${overflow.elidedLines} lines elided\r\n${overflow.tail}`;
    overflow = undefined;
  }

  function handleMark(payload: string, events: BlockEvent[]): void {
    if (payload.startsWith("7;file://")) {
      cwd = payload.slice("7;file://".length);
      return;
    }
    if (!payload.startsWith("133;")) return;
    const body = payload.slice("133;".length);
    const kind = body.charAt(0);

    if (kind === "A") {
      events.push({ type: "prompt" });
      return;
    }
    if (kind === "C") {
      // "C" or "C;<command>" — the wrapper sends the command, an older
      // wrapper (or another terminal's integration) sends neither.
      const command = body.startsWith("C;") ? body.slice(2) : "";
      // A block that never closed (a shell that died mid-command) must not
      // leave its tail to be joined onto the next one's head.
      overflow = undefined;
      current = {
        id: nextId++,
        command,
        output: "",
        exitCode: undefined,
        startedAt: now(),
        endedAt: undefined,
        cwd,
        truncated: false,
      };
      events.push({ type: "command-start", id: current.id, command, cwd });
      return;
    }
    if (kind === "D") {
      if (current === undefined) return; // A D that closes nothing.
      const code = Number.parseInt(body.slice(2), 10);
      current.exitCode = Number.isNaN(code) ? undefined : code;
      current.endedAt = now();
      // Head, marker, tail — the block is closing, so the tail has stopped
      // moving and the two halves can finally be joined.
      finishOutput(current);
      // A full-screen program can die (a signal, say) without ever writing
      // [?1049l. Left set, `alt` would silently swallow every later
      // command's output forever — so a block closing while it is held
      // clears it too, and says so: the pane keys its full-screen layout
      // off this event, and clearing the flag without announcing it would
      // leave the UI stuck full-screen even though capture had resumed.
      // Emitted after block-done, matching the order the bytes implied:
      // the block ended first, and only then — because it ended — is the
      // screen no longer "alternate" from this file's point of view.
      events.push({ type: "block-done", block: current });
      if (alt) {
        alt = false;
        events.push({ type: "alt-screen", active: false });
      }
      current = undefined;
    }
  }

  return {
    push(chunk) {
      const events: BlockEvent[] = [];
      const text = pending + chunk;
      pending = "";
      let plain = "";
      let index = 0;

      const flush = (): void => {
        if (plain === "") return;
        events.push({ type: "output", text: plain });
        appendOutput(plain);
        plain = "";
      };

      while (index < text.length) {
        const escape = text.indexOf(ESC, index);
        if (escape === -1) {
          plain += text.slice(index);
          break;
        }
        plain += text.slice(index, escape);

        const next = text.charAt(escape + 1);
        if (next === "") {
          // A lone ESC at the end of a chunk: the rest is coming.
          pending = text.slice(escape);
          break;
        }

        if (next === "]") {
          const osc = startOsc(text, escape);
          if (osc === undefined) {
            // The terminator has not arrived yet — hold the whole partial
            // OSC back rather than guess at its payload.
            pending = text.slice(escape);
            break;
          }
          const ours = osc.payload.startsWith("133;") || osc.payload.startsWith("7;file://");
          if (ours) {
            // A mark is not something to draw. Flush what came before it so
            // the ordering of output and events is the stream's ordering.
            flush();
            handleMark(osc.payload, events);
          } else {
            // Somebody else's OSC — a title, a clipboard write. Ours to pass
            // through untouched.
            plain += text.slice(escape, osc.end);
          }
          index = osc.end;
          continue;
        }

        // The alternate screen, in either of the forms a program writes it.
        let matchedAlt = false;
        for (const [sequence, active] of ALT_SEQUENCES) {
          if (text.startsWith(sequence, escape + 1)) {
            plain += ESC + sequence;
            // Entering: flag it before the flush, so the entry sequence
            // itself is drawn to the live terminal but not kept as block
            // output. Leaving: flush first, so the exit sequence — still
            // inside the frame it is ending — is likewise excluded, only
            // then clear the flag.
            if (active) alt = active;
            flush();
            alt = active;
            events.push({ type: "alt-screen", active });
            index = escape + 1 + sequence.length;
            matchedAlt = true;
            break;
          }
        }
        if (matchedAlt) continue;

        // A prefix of the alternate-screen sequence that has not fully
        // arrived yet: hold it back rather than emit it as plain bytes, or
        // an alt-screen entry landing exactly on a chunk boundary would go
        // undetected.
        const isPartialAlt = ALT_SEQUENCES.some(([sequence]) => {
          const remaining = text.length - (escape + 1);
          return remaining < sequence.length && sequence.startsWith(text.slice(escape + 1));
        });
        if (isPartialAlt) {
          pending = text.slice(escape);
          break;
        }

        // Any other escape sequence is the live terminal's business.
        plain += ESC;
        index = escape + 1;
      }

      flush();
      return events;
    },

    active: () => current,
  };
}
