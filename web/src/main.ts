import "./style.css";

const relayUrl = location.protocol === "https:" ? `wss://${location.host}/mine` : `ws://${location.hostname}:8080`;
const MAX_LOG_LINES = 500;
const SUPPORTED_CURRENCIES = ["BTC", "LTC", "DASH", "DGB", "FLUX", "RVN"];
const STORAGE_PREFIX = "minewhile";

const statusEl = document.querySelector("#status")!;
const modeEl = document.querySelector("#mode")!;
const hashEl = document.querySelector("#hashrate")!;
const userAcceptedEl = document.querySelector("#userAccepted")!;
const userRejectedEl = document.querySelector("#userRejected")!;
const devAcceptedEl = document.querySelector("#devAccepted")!;
const devRejectedEl = document.querySelector("#devRejected")!;
const logEl = document.querySelector("#log")!;
const startBtn = document.querySelector<HTMLButtonElement>("#start")!;
const stopBtn = document.querySelector<HTMLButtonElement>("#stop")!;
const currencyEl = document.querySelector<HTMLSelectElement>("#currency")!;
const walletEl = document.querySelector<HTMLInputElement>("#wallet")!;
const workerSlider = document.querySelector<HTMLInputElement>("#workerSlider")!;
const workerValue = document.querySelector("#workerValue")!;
const autoScrollToggle = document.querySelector<HTMLInputElement>("#autoscroll")!;
const clearLogBtn = document.querySelector<HTMLButtonElement>("#clearLog")!;
const countdownEl = document.querySelector("#countdown")!;

let ws: WebSocket | null = null;
const workers = new Map<number, Worker>();
let currentJob: any = null;
let acceptedUser = 0;
let rejectedUser = 0;
let acceptedDev = 0;
let rejectedDev = 0;
let currentMode: "user" | "dev" = "user";
let nextCountdownMs = 0;
let autoScroll = true;
const logLines: string[] = [];

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}.${key}`);
    return raw === null ? fallback : JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: unknown) {
  localStorage.setItem(`${STORAGE_PREFIX}.${key}`, JSON.stringify(value));
}

function log(message: string) {
  const line = `${new Date().toLocaleTimeString()} ${message}`;
  logLines.push(line);

  if (logLines.length > MAX_LOG_LINES) {
    logLines.splice(0, logLines.length - MAX_LOG_LINES);
  }

  logEl.textContent = logLines.join("\n");
  if (autoScroll) {
    logEl.scrollTop = logEl.scrollHeight;
  }
}

function updateWorkerDisplay() {
  const value = Number(workerSlider.value);
  workerValue.textContent = `${value}`;
  writeStored("workers", value);
}

function setModeLabel(mode: string, countdownMs: number) {
  currentMode = mode === "dev" ? "dev" : "user";
  nextCountdownMs = countdownMs;
  const label = mode === "dev" ? "Supporting Minewhile" : "User payout";
  modeEl.textContent = label;
  countdownEl.textContent = `${Math.max(0, Math.ceil(countdownMs / 1000))}s`;
}

function updateShareCounts() {
  userAcceptedEl.textContent = String(acceptedUser);
  userRejectedEl.textContent = String(rejectedUser);
  devAcceptedEl.textContent = String(acceptedDev);
  devRejectedEl.textContent = String(rejectedDev);
}

function stopWorkers() {
  for (const worker of workers.values()) {
    worker.terminate();
  }
  workers.clear();
}

function refreshWorkerPool() {
  const desired = Number(workerSlider.value);
  const existing = [...workers.keys()];

  for (const index of existing) {
    if (index >= desired) {
      workers.get(index)?.terminate();
      workers.delete(index);
    }
  }

  for (let index = 0; index < desired; index++) {
    if (!workers.has(index)) {
      const worker = new Worker(new URL("./miner.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === "ready") {
          log("WASM ready");
          return;
        }
        if (m.type === "hashrate") {
          const hps = Number(m.hps ?? 0);
          hashEl.textContent = `${hps.toFixed(2)} H/s`;
          return;
        }
        if (m.type === "share") {
          log(`candidate nonce=${m.nonceHex}`);
          ws?.send(JSON.stringify({
            type: "submit",
            jobId: m.jobId,
            extranonce2: m.extranonce2,
            ntime: m.ntime,
            nonceHex: m.nonceHex,
            mode: currentMode
          }));
        }
        if (m.type === "error") {
          log(`WORKER ERROR ${m.message}`);
        }
      };
      workers.set(index, worker);
    }
  }
}

function assignJobsToWorkers() {
  if (!currentJob) return;
  const workerCount = Number(workerSlider.value);
  for (let index = 0; index < workerCount; index++) {
    const worker = workers.get(index);
    if (!worker) continue;
    worker.postMessage({
      type: "job",
      job: currentJob,
      workerIndex: index,
      workerCount,
      nonceStart: (Math.random() * 0xffffffff) >>> 0
    });
  }
}

function stopMining() {
  stopWorkers();
  if (ws) {
    ws.send(JSON.stringify({ type: "stop" }));
    ws.close();
    ws = null;
  }
  currentJob = null;
  statusEl.textContent = "stopped";
  modeEl.textContent = "User payout";
  hashEl.textContent = "0 H/s";
  startBtn.disabled = false;
  stopBtn.disabled = true;
}

function startMining() {
  const selectedCurrency = currencyEl.value.toUpperCase();
  const selectedWallet = walletEl.value.trim();
  const selectedWorkers = Number(workerSlider.value);
  if (!selectedWallet) {
    log("Payout address is required.");
    return;
  }

  startBtn.disabled = true;
  stopBtn.disabled = false;
  statusEl.textContent = "connecting";

  refreshWorkerPool();

  ws = new WebSocket(relayUrl);
  ws.onopen = () => {
    statusEl.textContent = "connected / waiting for job";
    log("relay connected");
    ws?.send(JSON.stringify({
      type: "start",
      payoutCurrency: selectedCurrency,
      payoutAddress: selectedWallet,
      workerCount: selectedWorkers
    }));
  };

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === "job") {
      statusEl.textContent = "mining";
      currentJob = m;
      setModeLabel(m.mode ?? "user", nextCountdownMs || 0);
      assignJobsToWorkers();
    } else if (m.type === "mode") {
      setModeLabel(m.mode, m.countdownMs ?? 0);
    } else if (m.type === "share_result") {
      if (m.mode === "dev") {
        if (m.accepted) acceptedDev++; else rejectedDev++;
      } else {
        if (m.accepted) acceptedUser++; else rejectedUser++;
      }
      updateShareCounts();
      log(m.accepted ? "SHARE ACCEPTED" : `SHARE REJECTED ${JSON.stringify(m.error)}`);
    } else if (m.type === "log") {
      log(m.message);
    } else if (m.type === "error") {
      log(`RELAY ERROR ${m.message}`);
    } else if (m.type === "started") {
      log(`Mining started for ${m.payoutCurrency}: ${m.payoutAddress.slice(0, 8)}...`);
    } else if (m.type === "stopped") {
      log("Relay stopped session");
    }
  };

  ws.onerror = () => log("relay websocket error");
  ws.onclose = () => {
    if (workers.size) {
      stopWorkers();
    }
    log("relay disconnected");
    if (statusEl.textContent !== "stopped") {
      statusEl.textContent = "stopped";
      startBtn.disabled = false;
      stopBtn.disabled = true;
    }
  };
}

currencyEl.innerHTML = SUPPORTED_CURRENCIES.map((currency) => `<option value="${currency}">${currency}</option>`).join("");
currencyEl.value = readStored("currency", "LTC");
walletEl.value = readStored("wallet", "");
workerSlider.value = String(readStored("workers", Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 2)))));
workerSlider.max = String(Math.max(1, navigator.hardwareConcurrency || 4));
workerSlider.min = "1";
workerValue.textContent = workerSlider.value;
autoScrollToggle.checked = readStored("autoscroll", true);
autoScroll = autoScrollToggle.checked;

autoScrollToggle.onchange = () => {
  autoScroll = autoScrollToggle.checked;
  writeStored("autoscroll", autoScroll);
};

currencyEl.onchange = () => writeStored("currency", currencyEl.value);
walletEl.oninput = () => writeStored("wallet", walletEl.value);
workerSlider.oninput = () => {
  updateWorkerDisplay();
  if (workers.size) {
    refreshWorkerPool();
    if (currentJob) {
      assignJobsToWorkers();
    }
  }
};

clearLogBtn.onclick = () => {
  logLines.length = 0;
  logEl.textContent = "";
};

startBtn.onclick = startMining;
stopBtn.onclick = stopMining;
stopBtn.disabled = true;
updateWorkerDisplay();
updateShareCounts();
log("Minewhile ready");
