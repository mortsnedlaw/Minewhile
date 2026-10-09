import type { IncomingMessage } from "node:http";
import { WebSocketServer, type RawData } from "ws";
import { assertRuntimeConfig, config, isAllowedOrigin } from "./config.js";
import { SlidingWindowRateLimiter } from "./rateLimit.js";
import { MiningSession, validateStartRequest, type MiningMode } from "./session.js";

assertRuntimeConfig();

const MAX_CONNECTIONS_PER_IP = 8;
const activeConnectionsByIp = new Map<string, number>();

function clientIp(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? "unknown";
  const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (isLoopback) {
    const forwarded = req.headers["x-forwarded-for"];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0];
    if (first?.trim()) return first.trim();
  }
  return remote;
}

function rawDataToString(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  return Buffer.from(raw).toString("utf8");
}

const wss = new WebSocketServer({
  host: config.relayHost,
  port: config.relayPort,
  maxPayload: 16_384,
  perMessageDeflate: false
});
console.log(`Relay listening on ${config.relayHost}:${config.relayPort}`);
console.log(`Allowed browser origin(s): ${config.webOrigins.join(", ")}`);

wss.on("connection", (ws, req) => {
  const origin = req.headers.origin;
  const ip = clientIp(req);

  if (!isAllowedOrigin(origin)) {
    console.warn("Rejected browser origin", { ip, origin });
    ws.close(1008, "Origin not allowed");
    return;
  }

  const currentConnections = activeConnectionsByIp.get(ip) ?? 0;
  if (currentConnections >= MAX_CONNECTIONS_PER_IP) {
    ws.close(1013, "Too many connections");
    return;
  }
  activeConnectionsByIp.set(ip, currentConnections + 1);

  console.log("BROWSER CONNECT", { ip, origin });

  const session = new MiningSession();
  const allMessages = new SlidingWindowRateLimiter(600, 60_000);
  const startMessages = new SlidingWindowRateLimiter(4, 60_000);
  const submitMessages = new SlidingWindowRateLimiter(300, 60_000);
  let closed = false;

  const send = (x: unknown) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(x));
  };

  session.on("log", (message: string) => {
    console.log(`[${ip}] ${message}`);
    send({ type: "log", message });
  });
  session.on("debug", (message: string) => {
    console.debug(`[${ip}] DEBUG ${message}`);
  });
  session.on("difficulty", (payload: { mode: string; value: number }) => send({ type: "difficulty", ...payload }));
  session.on("job", (job: any) => send({ type: "job", ...job }));
  session.on("pause", (payload: any) => send({ type: "pause", ...payload }));
  session.on("mode", (payload: { mode: string; countdownMs: number }) => send({ type: "mode", ...payload }));
  session.on("shareResult", (payload: any) => send({ type: "share_result", ...payload }));
  session.on("error", (payload: any) => {
    const error = payload?.error ?? payload;
    console.error(`[${ip}]`, error);
    send({ type: "error", message: error instanceof Error ? error.message : String(error) });
  });
  session.on("closed", () => send({ type: "stopped" }));

  ws.on("message", (raw) => {
    if (!allMessages.allow()) {
      ws.close(1008, "Rate limit exceeded");
      return;
    }

    let message: any;
    try {
      message = JSON.parse(rawDataToString(raw));
    } catch {
      send({ type: "error", message: "Invalid JSON." });
      return;
    }

    if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.type !== "string") {
      send({ type: "error", message: "Invalid message." });
      return;
    }

    if (message.type === "start") {
      if (!startMessages.allow()) {
        send({ type: "error", message: "Too many start requests." });
        return;
      }
      const check = validateStartRequest(message);
      if (!check.valid) {
        send({ type: "error", message: check.error });
        return;
      }
      try {
        session.start(check.value);
        send({
          type: "started",
          payoutCurrency: check.value.payoutCurrency,
          payoutAddress: check.value.payoutAddress,
          workerCount: check.value.workerCount
        });
      } catch (error: any) {
        send({ type: "error", message: error?.message ?? String(error) });
      }
      return;
    }

    if (message.type === "stop") {
      session.close();
      return;
    }

    if (message.type === "submit") {
      if (!submitMessages.allow()) {
        send({ type: "error", message: "Share submission rate limit exceeded." });
        return;
      }
      try {
        const mode: MiningMode = message.mode === "dev" ? "dev" : "user";
        session.submit({
          jobId: String(message.jobId ?? ""),
          extranonce2: String(message.extranonce2 ?? ""),
          ntime: String(message.ntime ?? ""),
          nonceHex: String(message.nonceHex ?? ""),
          mode,
          generationId: Number(message.generationId)
        });
      } catch (error: any) {
        send({ type: "error", message: error?.message ?? String(error) });
      }
      return;
    }

    send({ type: "error", message: `Unknown message type: ${message.type}` });
  });

  ws.on("close", () => {
    if (closed) return;
    closed = true;
    session.close();
    const nextCount = Math.max(0, (activeConnectionsByIp.get(ip) ?? 1) - 1);
    if (nextCount === 0) activeConnectionsByIp.delete(ip);
    else activeConnectionsByIp.set(ip, nextCount);
    console.log("BROWSER CLOSED", { ip });
  });
});
