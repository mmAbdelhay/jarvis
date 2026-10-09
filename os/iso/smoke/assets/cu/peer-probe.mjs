// Not jarvisd: jarvis-cu's peer check (v1.1 contracts §1, gap G5) must close
// this connection without answering. Prints ACCEPTED if the helper answered at
// all, REFUSED otherwise. CU_SOCK names the socket. Also run as
// `node --import file://<this file> /usr/lib/jarvis/daemon/jarvisd.mjs run`:
// the top-level await finishes and exits before any jarvisd code runs, so the
// process has jarvisd's exe and script but not its exact argv.
import { connect } from "node:net";

const verdict = await new Promise((resolve) => {
  let got = "";
  const socket = connect(process.env.CU_SOCK ?? "");
  const decide = () => resolve(got.includes("\n") ? "ACCEPTED" : "REFUSED");
  socket.on("data", (d) => {
    got += d;
    if (got.includes("\n")) {
      socket.destroy();
      decide();
    }
  });
  socket.on("error", decide);
  socket.on("close", decide);
  socket.on("connect", () => socket.write(`${JSON.stringify({ id: 1, op: "windows" })}\n`));
  setTimeout(() => {
    socket.destroy();
    decide();
  }, 3000);
});
process.stdout.write(`${verdict}\n`);
process.exit(0);
