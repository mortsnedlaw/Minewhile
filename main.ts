import "./style.css";

const relayUrl =
  location.hostname === "localhost"
    ? "ws://localhost:8080"
    : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/mine`;

const statusEl = document.querySelector("#status")!;
const hashEl = document.querySelector("#hashrate")!;
const acceptedEl = document.querySelector("#accepted")!;
const rejectedEl = document.querySelector("#rejected")!;
const logEl = document.querySelector("#log")!;
const startBtn = document.querySelector<HTMLButtonElement>("#start")!;
const stopBtn = document.querySelector<HTMLButtonElement>("#stop")!;

let ws: WebSocket | null = null;
let worker: Worker | null = null;
let accepted = 0;
let rejected = 0;

function log(s: string) {
  logEl.textContent = `${new Date().toLocaleTimeString()} ${s}\n${logEl.textContent}`.slice(0, 20000);
}

function stop() {
  worker?.terminate();
  worker = null;
  ws?.close();
  ws = null;
  statusEl.textContent = "stopped";
  startBtn.disabled = false;
  stopBtn.disabled = true;
}

startBtn.onclick = () => {
  startBtn.disabled = true;
  stopBtn.disabled = false;
  statusEl.textContent = "connecting";

  worker = new Worker(new URL("./miner.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === "ready") {
      log("WASM ready");
      return;
    }
    if (m.type === "hashrate") {
      hashEl.textContent = `${m.hps.toFixed(2)} H/s`;
      return;
    }
    if (m.type === "share") {
      log(`candidate nonce=${m.nonceHex}`);
      ws?.send(JSON.stringify({
        type: "submit",
        jobId: m.jobId,
        extranonce2: m.extranonce2,
        ntime: m.ntime,
        nonceHex: m.nonceHex
      }));
    }
    if (m.type === "error") log(`WORKER ERROR ${m.message}`);
  };

  ws = new WebSocket(relayUrl);
  ws.onopen = () => {
    statusEl.textContent = "connected / waiting for job";
    log("relay connected");
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === "job") {
      statusEl.textContent = "mining";
      log(`job ${m.job.jobId}`);
      worker?.postMessage({ type: "job", job: m.job });
    } else if (m.type === "share_result") {
      if (m.accepted) accepted++; else rejected++;
      acceptedEl.textContent = String(accepted);
      rejectedEl.textContent = String(rejected);
      log(m.accepted ? "SHARE ACCEPTED" : `SHARE REJECTED ${JSON.stringify(m.error)}`);
    } else if (m.type === "log") {
      log(m.message);
    } else if (m.type === "error") {
      log(`RELAY ERROR ${m.message}`);
    }
  };
  ws.onerror = () => log("relay websocket error");
  ws.onclose = () => {
    log("relay disconnected");
    if (worker) stop();
  };
};

stopBtn.onclick = stop;
