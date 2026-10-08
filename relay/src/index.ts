import { WebSocketServer } from "ws";
import { config } from "./config.js";
import { StratumSession } from "./stratum.js";

const wss = new WebSocketServer({ port: config.relayPort });
console.log(`Relay listening on :${config.relayPort}`);

wss.on("connection", (ws, req) => {
  console.log("BROWSER CONNECT", {
    ip: req.socket.remoteAddress,
    origin: req.headers.origin,
    expectedOrigin: config.webOrigin
  });

  ws.on("close", (code, reason) => {
    console.log("BROWSER CLOSED", {
      code,
      reason: reason.toString()
    });
  });

  const upstream = new StratumSession();

  const send = (x: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(x));
  };

  upstream.on("log", (message) => {
    console.log(`[${req.socket.remoteAddress}] ${message}`);
    send({ type: "log", message });
  });
  upstream.on("difficulty", (value) => send({ type: "difficulty", value }));
  upstream.on("job", (job) => send({ type: "job", job }));
  upstream.on("submitted", (x) => send({ type: "submitted", ...x }));
  upstream.on("shareResult", (x) => send({ type: "share_result", ...x }));
  upstream.on("error", (e: Error) => {
    console.error(e);
    send({ type: "error", message: e.message });
  });
  upstream.on("close", () => send({ type: "upstream_closed" }));

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

    if (m?.type !== "submit") return;

    try {
      upstream.submit(
        String(m.jobId),
        String(m.extranonce2),
        String(m.ntime),
        String(m.nonceHex)
      );
    } catch (e: any) {
      send({ type: "error", message: e.message });
    }
  });

  ws.on("close", () => upstream.close());
  upstream.connect();
});
