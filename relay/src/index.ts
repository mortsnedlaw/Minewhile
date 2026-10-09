import { WebSocketServer } from "ws";
import { assertRuntimeConfig, config } from "./config.js";
import { MiningSession, validateStartRequest } from "./session.js";

assertRuntimeConfig();

const wss = new WebSocketServer({ host: config.relayHost, port: config.relayPort });
console.log(`Relay listening on ${config.relayHost}:${config.relayPort}`);

wss.on("connection", (ws, req) => {
  console.log("BROWSER CONNECT", {
    ip: req.socket.remoteAddress,
    origin: req.headers.origin,
    expectedOrigin: config.webOrigin
  });

  const session = new MiningSession();

  const send = (x: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(x));
  };

  session.on("log", (message: string) => {
    console.log(`[${req.socket.remoteAddress}] ${message}`);
    send({ type: "log", message });
  });
  session.on("difficulty", (payload: { mode: string; value: number }) => send({ type: "difficulty", ...payload }));
  session.on("job", (job: any) => send({ type: "job", ...job }));
  session.on("mode", (payload: { mode: string; countdownMs: number }) => send({ type: "mode", ...payload }));
  session.on("shareResult", (x: any) => send({ type: "share_result", ...x }));
  session.on("error", (payload: any) => {
    const error = payload?.error ?? payload;
    console.error(error);
    send({ type: "error", message: error instanceof Error ? error.message : String(error) });
  });
  session.on("closed", () => send({ type: "stopped" }));

  ws.on("message", (raw) => {
    const rawSize = Array.isArray(raw)
      ? raw.reduce((n, part) => n + part.byteLength, 0)
      : raw.byteLength;

    if (rawSize > 16_384) {
      ws.close(1009, "Message too large");
      return;
    }

    let m: any;
    try { m = JSON.parse(raw.toString()); }
    catch { return; }

    if (m?.type === "start") {
      const check = validateStartRequest(m);
      if (!check.valid) {
        send({ type: "error", message: check.error });
        return;
      }

      try {
        session.start(check.value);
        send({ type: "started", payoutCurrency: check.value.payoutCurrency, payoutAddress: check.value.payoutAddress, workerCount: check.value.workerCount });
      } catch (error: any) {
        send({ type: "error", message: error?.message ?? String(error) });
      }
      return;
    }

    if (m?.type === "stop") {
      session.close();
      return;
    }

    if (m?.type !== "submit") return;

    try {
      session.submit({
        jobId: String(m.jobId),
        extranonce2: String(m.extranonce2),
        ntime: String(m.ntime),
        nonceHex: String(m.nonceHex),
        mode: String(m.mode || "user") === "dev" ? "dev" : "user"
      });
    } catch (error: any) {
      send({ type: "error", message: error?.message ?? String(error) });
    }
  });

  ws.on("close", () => session.close());
});
