import "./style.css";

const isViteDev = location.port === "5173";
const relayUrl = isViteDev
  ? `ws://${location.hostname}:8080`
  : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/mine`;

const MAX_LOG_LINES = 500;
const MAX_BROWSER_WORKERS = 64;
const SUPPORTED_CURRENCIES = ["BTC", "LTC", "BCH", "DASH", "ADVC", "ARRR", "BC2", "BCH2", "BELLS", "BTCZ", "BTGS", "CAP", "CAT", "CHI", "CY", "DGB", "DOGE", "DOGM", "EAC", "EQPAY", "EVR", "FJAR", "FLUX", "GBX", "GRR", "GRS", "HOOT", "KCCC", "KMD", "KRGN", "KV5", "LC2", "LCN", "LPEPE", "MAXI", "MCL", "MEC", "MECU", "MEWC", "MONA", "MYT", "NENG", "OBTC", "PAC", "PEPEW", "PLSR", "PPC", "RIN", "RTM", "RVN", "RXD", "SCC", "SKYDOGE", "SOH", "SWAMP", "TLS", "URSA", "VTC", "WDC", "WJK", "XDN", "YEC", "ZCL", "ZER"] as const;
const GUARANTEED_CURRENCIES = new Set(["BTC", "LTC", "DASH", "DGB", "FLUX", "RVN"]);
const STORAGE_PREFIX = "minewhile";

type MiningMode = "user" | "dev";
type BrowserJob = {
  jobId: string;
  header76Hex: string;
  targetHex: string;
  extranonce2: string;
  ntime: string;
  mode: MiningMode;
  generationId: number;
};

const statusEl = document.querySelector("#status")!;
const modeEl = document.querySelector("#mode")!;
const hashEl = document.querySelector("#hashrate")!;
const difficultyEl = document.querySelector("#difficulty")!;
const activeWorkersEl = document.querySelector("#activeWorkers")!;
const detectedThreadsEl = document.querySelector("#detectedThreads")!;
const sessionTimeEl = document.querySelector("#sessionTime")!;
const userAcceptedEl = document.querySelector("#userAccepted")!;
const userRejectedEl = document.querySelector("#userRejected")!;
const devAcceptedEl = document.querySelector("#devAccepted")!;
const devRejectedEl = document.querySelector("#devRejected")!;
const logEl = document.querySelector<HTMLElement>("#log")!;
const startBtn = document.querySelector<HTMLButtonElement>("#start")!;
const stopBtn = document.querySelector<HTMLButtonElement>("#stop")!;
const currencyEl = document.querySelector<HTMLSelectElement>("#currency")!;
const walletEl = document.querySelector<HTMLInputElement>("#wallet")!;
const workerSlider = document.querySelector<HTMLInputElement>("#workerSlider")!;
const workerValue = document.querySelector("#workerValue")!;
const autoScrollToggle = document.querySelector<HTMLInputElement>("#autoscroll")!;
const clearLogBtn = document.querySelector<HTMLButtonElement>("#clearLog")!;
const countdownEl = document.querySelector("#countdown")!;
const unpaidEl = document.querySelector("#walletUnpaid")!;
const balanceEl = document.querySelector("#walletBalance")!;
const paid24hEl = document.querySelector("#walletPaid24h")!;
const totalEarnedEl = document.querySelector("#walletTotal")!;
const sessionChangeEl = document.querySelector("#walletSessionChange")!;
const lastPayoutEl = document.querySelector("#lastPayout")!;
const recentBlocksEl = document.querySelector("#recentBlocks")!;
const statsUpdatedEl = document.querySelector("#statsUpdated")!;

let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let miningRequested = false;
let currentJob: BrowserJob | null = null;
let currentMode: MiningMode = "user";
let countdownDeadline = 0;
let sessionStartedAt = 0;
let autoScroll = true;
let walletBaselineTotal: number | null = null;

const workers = new Map<number, Worker>();
const workerRates = new Map<number, number>();
const readyWorkers = new Set<number>();
const difficultyByMode = new Map<MiningMode, number>();
const logLines: string[] = [];

let acceptedUser = 0;
let rejectedUser = 0;
let acceptedDev = 0;
let rejectedDev = 0;

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
  if (autoScroll) logEl.scrollTop = logEl.scrollHeight;
}

function formatHashrate(hps: number): string {
  if (!Number.isFinite(hps) || hps <= 0) return "0 H/s";
  if (hps >= 1_000_000) return `${(hps / 1_000_000).toFixed(2)} MH/s`;
  if (hps >= 1_000) return `${(hps / 1_000).toFixed(2)} kH/s`;
  return `${hps.toFixed(2)} H/s`;
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${minutes}:${String(rest).padStart(2, "0")}`;
}

function formatCoinAmount(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(8) : "—";
}

function formatBlockAge(unixSeconds: unknown): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - Number(unixSeconds || 0)));
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function requestWalletStats() {
  if (!miningRequested || ws?.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "stats" }));
}

function updateWalletStats(message: any) {
  const currency = currencyEl.value;
  const total = Number(message.total ?? 0);
  if (walletBaselineTotal === null) walletBaselineTotal = total;
  const delta = total - walletBaselineTotal;

  unpaidEl.textContent = `${formatCoinAmount(message.unpaid)} ${currency}`;
  balanceEl.textContent = `${formatCoinAmount(message.balance)} ${currency}`;
  paid24hEl.textContent = `${formatCoinAmount(message.paid24h)} ${currency}`;
  totalEarnedEl.textContent = `${formatCoinAmount(total)} ${currency}`;
  sessionChangeEl.textContent = `${delta >= 0 ? "+" : ""}${formatCoinAmount(delta)} ${currency}`;

  const payouts = Array.isArray(message.payouts) ? message.payouts : [];
  if (payouts.length) {
    const latest = payouts[0];
    const when = latest.time ? new Date(Number(latest.time) * 1000).toLocaleString() : "";
    lastPayoutEl.textContent = `${formatCoinAmount(latest.amount)} ${currency}${when ? ` · ${when}` : ""}`;
  } else {
    lastPayoutEl.textContent = "No payout reported yet";
  }

  const blocks = Array.isArray(message.recentBlocks) ? message.recentBlocks : [];
  recentBlocksEl.innerHTML = blocks.length
    ? blocks.map((block: any) => `
        <div class="block-row">
          <strong>${String(block.coin || "—")}</strong>
          <span>#${String(block.height || "—")}</span>
          <span>${formatCoinAmount(block.amount)}</span>
          <span>${formatBlockAge(block.time)} ago</span>
          <span>${String(block.category || "")}</span>
        </div>`).join("")
    : `<div class="empty-state">No recent standard YesPower blocks reported.</div>`;

  statsUpdatedEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

function updateHashrate() {
  const total = [...workerRates.values()].reduce((sum, value) => sum + value, 0);
  hashEl.textContent = formatHashrate(total);
}

function updateWorkerStatus() {
  activeWorkersEl.textContent = `${readyWorkers.size} / ${workers.size}`;
}

function updateWorkerDisplay() {
  const value = Number(workerSlider.value);
  workerValue.textContent = `${value}`;
  writeStored("workers", value);
}

function setConfigurationLocked(locked: boolean) {
  currencyEl.disabled = locked;
  walletEl.disabled = locked;
  workerSlider.disabled = locked;
}

function setModeLabel(mode: MiningMode, countdownMs: number) {
  currentMode = mode;
  countdownDeadline = Date.now() + Math.max(0, countdownMs);
  modeEl.textContent = mode === "dev" ? "Supporting Minewhile" : "User payout";
  const difficulty = difficultyByMode.get(mode);
  difficultyEl.textContent = difficulty === undefined ? "—" : String(difficulty);
}

function updateShareCounts() {
  userAcceptedEl.textContent = String(acceptedUser);
  userRejectedEl.textContent = String(rejectedUser);
  devAcceptedEl.textContent = String(acceptedDev);
  devRejectedEl.textContent = String(rejectedDev);
}

function resetSessionStats() {
  acceptedUser = 0;
  rejectedUser = 0;
  acceptedDev = 0;
  rejectedDev = 0;
  difficultyByMode.clear();
  workerRates.clear();
  currentJob = null;
  countdownDeadline = 0;
  sessionStartedAt = Date.now();
  walletBaselineTotal = null;
  updateShareCounts();
  updateHashrate();
  difficultyEl.textContent = "—";
}

function pauseWorkers() {
  currentJob = null;
  workerRates.clear();
  updateHashrate();
  for (const worker of workers.values()) worker.postMessage({ type: "stop" });
}

function stopWorkers() {
  for (const worker of workers.values()) worker.terminate();
  workers.clear();
  readyWorkers.clear();
  workerRates.clear();
  updateWorkerStatus();
  updateHashrate();
}

function createWorkerPool() {
  stopWorkers();
  const desired = Number(workerSlider.value);

  for (let index = 0; index < desired; index++) {
    const worker = new Worker(new URL("./miner.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (ev) => {
      const message = ev.data;

      if (message.type === "ready") {
        readyWorkers.add(index);
        updateWorkerStatus();
        return;
      }

      if (message.type === "hashrate") {
        workerRates.set(Number(message.workerIndex), Number(message.hps ?? 0));
        updateHashrate();
        return;
      }

      if (message.type === "share") {
        log(`candidate worker=${message.workerIndex + 1} nonce=${message.nonceHex}`);
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "submit",
            jobId: message.jobId,
            extranonce2: message.extranonce2,
            ntime: message.ntime,
            nonceHex: message.nonceHex,
            mode: message.mode,
            generationId: message.generationId
          }));
        }
        return;
      }

      if (message.type === "error") {
        log(`WORKER ${index + 1} ERROR ${message.message}`);
      }
    };
    worker.onerror = (event) => {
      readyWorkers.delete(index);
      workerRates.delete(index);
      updateWorkerStatus();
      updateHashrate();
      log(`WORKER ${index + 1} ERROR ${event.message}`);
    };
    workers.set(index, worker);
  }

  updateWorkerStatus();
}

function assignJobToWorkers(job: BrowserJob) {
  currentJob = job;
  workerRates.clear();
  updateHashrate();

  // One seed per job; nonce.ts partitions the full uint32 space into disjoint ranges.
  const nonceSeed = crypto.getRandomValues(new Uint32Array(1))[0];
  const workerCount = workers.size;

  for (let index = 0; index < workerCount; index++) {
    workers.get(index)?.postMessage({
      type: "job",
      job,
      workerIndex: index,
      workerCount,
      nonceSeed
    });
  }
}

function selectedStartPayload() {
  return {
    type: "start",
    payoutCurrency: currencyEl.value.toUpperCase(),
    payoutAddress: walletEl.value.trim(),
    workerCount: Number(workerSlider.value)
  };
}

function scheduleReconnect() {
  if (!miningRequested || reconnectTimer !== null) return;
  statusEl.textContent = "reconnecting";
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connectRelay();
  }, 3_000);
}

function connectRelay() {
  if (!miningRequested || ws) return;

  statusEl.textContent = "connecting";
  const socket = new WebSocket(relayUrl);
  ws = socket;

  socket.onopen = () => {
    if (ws !== socket || !miningRequested) return;
    statusEl.textContent = "connected / waiting for job";
    log("relay connected");
    socket.send(JSON.stringify(selectedStartPayload()));
  };

  socket.onmessage = (event) => {
    let message: any;
    try {
      message = JSON.parse(event.data);
    } catch {
      log("RELAY ERROR invalid JSON response");
      return;
    }

    if (message.type === "job") {
      const job = message as BrowserJob;
      statusEl.textContent = "mining";
      setModeLabel(job.mode, Math.max(0, countdownDeadline - Date.now()));
      assignJobToWorkers(job);
      return;
    }

    if (message.type === "pause") {
      pauseWorkers();
      statusEl.textContent = "waiting for job";
      log(`${String(message.mode).toUpperCase()} ${message.reason ?? "paused"}`);
      return;
    }

    if (message.type === "mode") {
      const mode: MiningMode = message.mode === "dev" ? "dev" : "user";
      if (currentJob && currentJob.mode !== mode) pauseWorkers();
      setModeLabel(mode, Number(message.countdownMs ?? 0));
      return;
    }

    if (message.type === "difficulty") {
      const mode: MiningMode = message.mode === "dev" ? "dev" : "user";
      difficultyByMode.set(mode, Number(message.value));
      if (mode === currentMode) difficultyEl.textContent = String(message.value);
      return;
    }

    if (message.type === "share_result") {
      if (message.shares) {
        acceptedUser = Number(message.shares.user?.accepted ?? acceptedUser);
        rejectedUser = Number(message.shares.user?.rejected ?? rejectedUser);
        acceptedDev = Number(message.shares.dev?.accepted ?? acceptedDev);
        rejectedDev = Number(message.shares.dev?.rejected ?? rejectedDev);
      } else if (message.mode === "dev") {
        message.accepted ? acceptedDev++ : rejectedDev++;
      } else {
        message.accepted ? acceptedUser++ : rejectedUser++;
      }
      updateShareCounts();
      log(message.accepted
        ? `SHARE ACCEPTED (${message.mode})`
        : `SHARE REJECTED (${message.mode}) ${JSON.stringify(message.error)}`);
      return;
    }

    if (message.type === "log") {
      log(message.message);
      return;
    }

    if (message.type === "wallet_stats") {
      updateWalletStats(message);
      return;
    }

    if (message.type === "error") {
      log(`RELAY ERROR ${message.message}`);
      return;
    }

    if (message.type === "started") {
      log(`Mining started for ${message.payoutCurrency}: ${String(message.payoutAddress).slice(0, 8)}...`);
      requestWalletStats();
      return;
    }

    if (message.type === "stopped") {
      log("Relay stopped session");
    }
  };

  socket.onerror = () => log("relay websocket error");
  socket.onclose = (event) => {
    if (ws === socket) ws = null;
    pauseWorkers();
    log(`relay disconnected${event.reason ? `: ${event.reason}` : ""}`);
    if (miningRequested && (event.code === 1008 || event.code === 1009)) {
      miningRequested = false;
      stopWorkers();
      setConfigurationLocked(false);
      startBtn.disabled = false;
      stopBtn.disabled = true;
      statusEl.textContent = "connection rejected";
      log("Connection was rejected by relay policy. Check WEB_ORIGIN / server configuration.");
      return;
    }
    if (miningRequested) scheduleReconnect();
  };
}

function startMining() {
  const payload = selectedStartPayload();
  if (!payload.payoutAddress) {
    log("Payout address is required.");
    return;
  }
  if (!SUPPORTED_CURRENCIES.includes(payload.payoutCurrency as typeof SUPPORTED_CURRENCIES[number])) {
    log("Unsupported payout currency.");
    return;
  }

  miningRequested = true;
  resetSessionStats();
  createWorkerPool();
  setConfigurationLocked(true);
  startBtn.disabled = true;
  stopBtn.disabled = false;
  connectRelay();
}

function stopMining() {
  miningRequested = false;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "stop" }));
    ws.close(1000, "User stopped mining");
    ws = null;
  }
  stopWorkers();
  currentJob = null;
  statusEl.textContent = "stopped";
  modeEl.textContent = "User payout";
  countdownEl.textContent = "—";
  difficultyEl.textContent = "—";
  sessionTimeEl.textContent = "0:00";
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setConfigurationLocked(false);
}

const detectedThreads = Math.max(1, navigator.hardwareConcurrency || 1);
const maxWorkers = Math.max(1, Math.min(MAX_BROWSER_WORKERS, detectedThreads));
const defaultWorkers = Math.max(1, Math.min(4, Math.floor(detectedThreads / 2) || 1));

currencyEl.innerHTML = [
  `<optgroup label="Guaranteed payout">${SUPPORTED_CURRENCIES
    .filter((currency) => GUARANTEED_CURRENCIES.has(currency))
    .map((currency) => `<option value="${currency}">${currency}</option>`)
    .join("")}</optgroup>`,
  `<optgroup label="Other payout currencies">${SUPPORTED_CURRENCIES
    .filter((currency) => !GUARANTEED_CURRENCIES.has(currency))
    .map((currency) => `<option value="${currency}">${currency}</option>`)
    .join("")}</optgroup>`
].join("");
currencyEl.value = readStored("currency", "LTC");
walletEl.value = readStored("wallet", "");
workerSlider.min = "1";
workerSlider.max = String(maxWorkers);
workerSlider.value = String(Math.min(maxWorkers, Math.max(1, Number(readStored("workers", defaultWorkers)))));
detectedThreadsEl.textContent = String(detectedThreads);
autoScrollToggle.checked = readStored("autoscroll", true);
autoScroll = autoScrollToggle.checked;

autoScrollToggle.onchange = () => {
  autoScroll = autoScrollToggle.checked;
  writeStored("autoscroll", autoScroll);
};
currencyEl.onchange = () => writeStored("currency", currencyEl.value);
walletEl.oninput = () => writeStored("wallet", walletEl.value);
workerSlider.oninput = updateWorkerDisplay;
clearLogBtn.onclick = () => {
  logLines.length = 0;
  logEl.textContent = "";
};
startBtn.onclick = startMining;
stopBtn.onclick = stopMining;

window.setInterval(requestWalletStats, 30_000);

window.setInterval(() => {
  countdownEl.textContent = countdownDeadline > 0
    ? formatDuration((countdownDeadline - Date.now()) / 1000)
    : "—";
  sessionTimeEl.textContent = miningRequested && sessionStartedAt > 0
    ? formatDuration((Date.now() - sessionStartedAt) / 1000)
    : "0:00";
}, 250);

stopBtn.disabled = true;
setConfigurationLocked(false);
updateWorkerDisplay();
updateWorkerStatus();
updateShareCounts();
log("Minewhile ready — mining starts only when you press START.");
