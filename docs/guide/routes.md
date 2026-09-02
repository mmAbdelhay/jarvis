# The routes

Five, along the top. Only one is visible at a time, and the Workspace's hosted
pages are native views floating over the window — which is why leaving that
route explicitly hides them rather than merely covering them up.

Jarvis opens **full screen**: it is the surface you work from, not a panel
beside something else. Leaving full screen restores it to 1440×900.

## Dashboard

What every agent is doing, and what the machine is doing.

- **Sessions** — each running agent, its project, its model and its state.
- **Providers** — each configured account, whether it is reachable, and how
  much capacity is left. Three different unknowns are reported as three
  different sentences, never collapsed into one "unknown": a provider that
  offers no capacity reading, one whose reading failed, and one not yet
  checked are distinct facts.
- **System** — CPU, memory and disk. Memory and disk are `total - available`,
  which is what `df` and Activity Monitor report; a platform's own `used`
  counts cached pages and reads near 100% on a healthy machine. Each reading is
  taken as often as it actually changes rather than every tick: CPU and network
  every two seconds, memory every six, disk and uptime every minute. Reading
  all of them every tick cost a tenth of a core permanently, most of it
  enumerating two dozen mounted volumes to answer a number that had not moved.
- **Conversation** and **History** — what has been said, and to whom.

## Changes

The working tree of a session's project: which files changed, the diff for
each (side by side or unified), staging, and committing.

A session that has ended still shows its repository's *current* state, and the
view says so — it is not a snapshot of what that agent did, and pretending
otherwise would be the more comfortable lie.

## Session

One agent's real terminal, under a pty. Every byte the agent writes goes to
xterm.js untouched and every keystroke goes back untouched, which is what makes
slash commands, permission prompts and plan mode work at all.

While this route is open, **⌥Space** talks to *this session* rather than to the
brain. The badge in the corner says so, because it is the one thing about voice
that the terminal itself cannot show.

## Workspace

A browser with tabs, per project — and the tabs are not only web pages. See
**[Workspace tabs](workspace-tabs.md)**.

## Settings

Every key of `jarvis.yaml`, edited in place: agents, routing, projects,
databases, editor roots, the brain, voice and Whisper. One **Save** for the whole file, one
validation pass, and a **Restart Jarvis** button afterwards — nothing is
applied live, because a save can change which agent answers and killing a
running session to apply it would be the wrong kind of helpful.

A per-agent **Test** button runs the health probe against the *draft* command
before it is ever saved.
