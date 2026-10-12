import "./style.css";
import { initReferralCreator } from "./referral.js";

const isViteDev = location.port === "5173";
const relayUrl = isViteDev
  ? `ws://${location.hostname}:8080`
  : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/mine`;

const MAX_LOG_LINES = 500;
const MAX_BROWSER_WORKERS = 64;
const STORAGE_PREFIX = "minewhile";
const HASHRATE_STALE_MS = 12_000;
const HASHRATE_SMOOTH_TAU_MS = 8_000;
const ALGO_PROFILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SUPPORTED_CURRENCIES = ["BTC", "LTC", "BCH", "DASH", "ADVC", "ARRR", "BC2", "BCH2", "BELLS", "BTCZ", "BTGS", "CAP", "CAT", "CHI", "CY", "DGB", "DOGE", "DOGM", "EAC", "EQPAY", "EVR", "FJAR", "FLUX", "GBX", "GRR", "GRS", "HOOT", "KCCC", "KMD", "KRGN", "KV5", "LC2", "LCN", "LPEPE", "MAXI", "MCL", "MEC", "MECU", "MEWC", "MONA", "MYT", "NENG", "OBTC", "PAC", "PEPEW", "PLSR", "PPC", "RIN", "RTM", "RVN", "RXD", "SCC", "SKYDOGE", "SOH", "SWAMP", "TLS", "URSA", "VTC", "WDC", "WJK", "XDN", "YEC", "ZCL", "ZER"] as const;
const GUARANTEED_CURRENCIES = new Set(["BTC", "LTC", "DASH", "DGB", "FLUX", "RVN"]);

type MiningMode = "user" | "beneficiary" | "dev";
type AlgorithmId = "yespower" | "yespowertide" | "yespowerr16" | "yespowerurx" | "yespoweradvc" | "yespowerltncg" | "yespowersugar";
type BrowserJob = {
  jobId: string;
  header76Hex: string;
  targetHex: string;
  extranonce2: string;
  ntime: string;
  mode: MiningMode;
  generationId: number;
  algorithmId: AlgorithmId;
  N: number;
  r: number;
  personalization: string | null;
  tuning?: boolean;
  tuneId?: string;
};

type AlgoProfile = {
  at: number;
  workers: number;
  results: Record<string, number>;
};

type WorkerRate = {
  hps: number;
  seenAt: number;
  algorithmId: string;
};

const $ = <T extends HTMLElement>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing UI element ${selector}`);
  return el;
};

const statusEl = $("#status");
const modeEl = $("#mode");
const hashEl = $("#hashrate");
const hash1mEl = $("#hashrate1m");
const difficultyEl = $("#difficulty");
const activeWorkersEl = $("#activeWorkers");
const detectedThreadsEl = $("#detectedThreads");
const sessionTimeEl = $("#sessionTime");
const userAcceptedEl = $("#userAccepted");
const userRejectedEl = $("#userRejected");
const beneficiaryAcceptedEl = $("#beneficiaryAccepted");
const beneficiaryRejectedEl = $("#beneficiaryRejected");
const devAcceptedEl = $("#devAccepted");
const devRejectedEl = $("#devRejected");
const algorithmEl = $("#algorithm");
const schedulerEl = $("#scheduler");
const supportNoteEl = $("#supportNote");
const relayHealthEl = $("#relayHealth");
const poolHealthEl = $("#poolHealth");
const lastShareHealthEl = $("#lastShareHealth");
const schedulerBestEl = $("#schedulerBest");
const schedulerBenchmarkEl = $("#schedulerBenchmark");
const schedulerCoinEl = $("#schedulerCoin");
const schedulerNetworkEl = $("#schedulerNetwork");
const schedulerPoolEl = $("#schedulerPool");
const schedulerUserShareEl = $("#schedulerUserShare");
const schedulerFleetShareEl = $("#schedulerFleetShare");
const schedulerPenaltyEl = $("#schedulerPenalty");
const schedulerScoreEl = $("#schedulerScore");
const schedulerConfidenceEl = $("#schedulerConfidence");
const schedulerDetailsEl = $("#schedulerDetails");
const tuneProgressMinerEl = $("#tuneProgressMiner");

const logEl = $<HTMLElement>("#log");
const startBtn = $<HTMLButtonElement>("#start");
const startQuickBtn = $<HTMLButtonElement>("#startQuick");
const stopBtn = $<HTMLButtonElement>("#stop");
const currencyEl = $<HTMLSelectElement>("#currency");
const walletEl = $<HTMLInputElement>("#wallet");
const workerSlider = $<HTMLInputElement>("#workerSlider");
const workerValue = $("#workerValue");
const autoScrollToggle = $<HTMLInputElement>("#autoscroll");
const clearLogBtn = $<HTMLButtonElement>("#clearLog");
const countdownEl = $("#countdown");
const unpaidEl = $("#walletUnpaid");
const balanceEl = $("#walletBalance");
const paid24hEl = $("#walletPaid24h");
const totalEarnedEl = $("#walletTotal");
const sessionChangeEl = $("#walletSessionChange");
const lastPayoutEl = $("#lastPayout");
const recentBlocksEl = $("#recentBlocks");
const statsUpdatedEl = $("#statsUpdated");
const algorithmModeEl = $<HTMLSelectElement>("#algorithmMode");
const fixedAlgorithmEl = $<HTMLSelectElement>("#fixedAlgorithm");
const fixedAlgorithmRow = $("#fixedAlgorithmRow");
const tuneBtn = $<HTMLButtonElement>("#tune30");
const tuneMinerBtn = $<HTMLButtonElement>("#tuneMiner");
const tuneLiveStatusEl = $("#tuneLiveStatus");
const tuneStatusEl = $("#tuneStatus");
const tuneResultsEl = $("#tuneResults");
const httpSecretWarningEl = $("#httpSecretWarning");

let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let miningRequested = false;
let currentJob: BrowserJob | null = null;
let currentMode: MiningMode = "user";
let currentAlgorithmId: AlgorithmId = "yespower";
let countdownDeadline = 0;
let sessionStartedAt = 0;
let autoScroll = true;
let walletBaselineTotal: number | null = null;
let lastShareAt = 0;
let displayedHashrate = 0;
let lastHashrateRenderAt = 0;
let tuningActive = false;
let activeTuneId = "";
let pendingTuneStart = false;
let activeTuneAlgorithm = "";
let activeTuneTargetShares = 2;
let tunePlanIds: string[] = [];
const tuneAcceptedShares = new Map<string, number>();
let verifiedAlgorithms = new Set<AlgorithmId>(["yespower"]);

const workers = new Map<number, Worker>();
const workerRates = new Map<number, WorkerRate>();
const readyWorkers = new Set<number>();
const difficultyByMode = new Map<MiningMode, number>();
const logLines: string[] = [];
const rawHistory: Array<{ at: number; hps: number }> = [];
const tuneWorkerRates = new Map<string, Map<number, { hps: number; at: number }>>();
const tuneSamples = new Map<string, number[]>();

let acceptedUser = 0;
let rejectedUser = 0;
let beneficiaryAccepted = 0;
let beneficiaryRejected = 0;
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
  try { localStorage.setItem(`${STORAGE_PREFIX}.${key}`, JSON.stringify(value)); }
  catch { /* restricted/private storage */ }
}

function normalizeMiningMode(value: unknown): MiningMode {
  if (value === "dev") return "dev";
  if (value === "beneficiary") return "beneficiary";
  return "user";
}

function normalizeReferralCode(value: unknown): string {
  const code = String(value ?? "").trim().toUpperCase();
  return /^[A-HJ-NP-Z2-9]{8}$/.test(code) ? code : "";
}

function log(message: string) {
  const line = `${new Date().toLocaleTimeString()} ${message}`;
  logLines.push(line);
  if (logLines.length > MAX_LOG_LINES) logLines.splice(0, logLines.length - MAX_LOG_LINES);
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
  recentBlocksEl.replaceChildren();
  if (blocks.length) {
    for (const block of blocks) {
      const row = document.createElement("div");
      row.className = "block-row";
      for (const value of [
        { tag: "strong", text: String(block.coin || "—") },
        { tag: "span", text: `#${String(block.height || "—")}` },
        { tag: "span", text: formatCoinAmount(block.amount) },
        { tag: "span", text: `${formatBlockAge(block.time)} ago` },
        { tag: "span", text: String(block.category || "") }
      ]) {
        const el = document.createElement(value.tag);
        el.textContent = value.text;
        row.appendChild(el);
      }
      recentBlocksEl.appendChild(row);
    }
  } else {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No recent YesPower blocks reported.";
    recentBlocksEl.appendChild(empty);
  }
  statsUpdatedEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

function rawTotalHashrate(now = performance.now()): number {
  const activeAlgorithm = currentJob?.algorithmId ?? currentAlgorithmId;
  let total = 0;
  for (const rate of workerRates.values()) {
    if (rate.algorithmId === activeAlgorithm && now - rate.seenAt <= HASHRATE_STALE_MS) total += rate.hps;
  }
  return total;
}

function updateHashrate() {
  const now = performance.now();
  const raw = miningRequested ? rawTotalHashrate(now) : 0;
  const elapsed = lastHashrateRenderAt > 0 ? Math.max(1, now - lastHashrateRenderAt) : 1000;
  lastHashrateRenderAt = now;
  const alpha = 1 - Math.exp(-elapsed / HASHRATE_SMOOTH_TAU_MS);
  if (displayedHashrate <= 0 && raw > 0) displayedHashrate = raw;
  else displayedHashrate += alpha * (raw - displayedHashrate);
  if (!miningRequested || displayedHashrate < 0.05) displayedHashrate = 0;
  hashEl.textContent = formatHashrate(displayedHashrate);

  if (miningRequested && currentJob) rawHistory.push({ at: Date.now(), hps: raw });
  const cutoff = Date.now() - 60_000;
  while (rawHistory.length && rawHistory[0].at < cutoff) rawHistory.shift();
  const oneMinute = rawHistory.length
    ? rawHistory.reduce((sum, x) => sum + x.hps, 0) / rawHistory.length
    : 0;
  hash1mEl.textContent = formatHashrate(oneMinute);
}

function updateWorkerStatus() {
  activeWorkersEl.textContent = `${readyWorkers.size} / ${workers.size}`;
}

function updateWorkerDisplay() {
  const value = Number(workerSlider.value);
  workerValue.textContent = String(value);
  writeStored("workers", value);
}

function setConfigurationLocked(locked: boolean) {
  currencyEl.disabled = locked;
  walletEl.disabled = locked;
  workerSlider.disabled = locked;
  algorithmModeEl.disabled = locked;
  fixedAlgorithmEl.disabled = locked;
}

function setModeLabel(mode: MiningMode, countdownMs: number) {
  currentMode = mode;
  countdownDeadline = Date.now() + Math.max(0, countdownMs);
  modeEl.textContent = mode === "dev" ? (tuningActive ? "Quick Tune → Minewhile" : "Supporting Minewhile") : mode === "beneficiary" ? "Supporting referrer" : "User payout";
  const difficulty = difficultyByMode.get(mode);
  difficultyEl.textContent = difficulty === undefined ? "—" : String(difficulty);
}

function updateShareCounts() {
  userAcceptedEl.textContent = String(acceptedUser);
  userRejectedEl.textContent = String(rejectedUser);
  beneficiaryAcceptedEl.textContent = String(beneficiaryAccepted);
  beneficiaryRejectedEl.textContent = String(beneficiaryRejected);
  devAcceptedEl.textContent = String(acceptedDev);
  devRejectedEl.textContent = String(rejectedDev);
}

function resetSessionStats() {
  acceptedUser = 0;
  rejectedUser = 0;
  beneficiaryAccepted = 0;
  beneficiaryRejected = 0;
  acceptedDev = 0;
  rejectedDev = 0;
  difficultyByMode.clear();
  workerRates.clear();
  rawHistory.length = 0;
  displayedHashrate = 0;
  currentJob = null;
  countdownDeadline = 0;
  sessionStartedAt = Date.now();
  walletBaselineTotal = null;
  lastShareAt = 0;
  updateShareCounts();
  updateHashrate();
  difficultyEl.textContent = "—";
}

function pauseWorkers() {
  currentJob = null;
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

function setTuneStatus(text: string) { tuneStatusEl.textContent = text; tuneLiveStatusEl.textContent = text; }
function setTuneButtons(disabled: boolean) { tuneBtn.disabled = disabled; tuneMinerBtn.disabled = disabled; }
function renderTuneProgress(forceComplete = false) {
  const ids = tunePlanIds.length
    ? tunePlanIds
    : [...new Set([
        ...tuneSamples.keys(),
        ...tuneAcceptedShares.keys()
      ])];

  const renderInto = (target: HTMLElement) => {
    target.replaceChildren();

    for (const id of ids) {
      const samples = tuneSamples.get(id) ?? [];
      const hps = median(samples.slice(1));
      const accepted = tuneAcceptedShares.get(id) ?? 0;
      const verified = verifiedAlgorithms.has(id as AlgorithmId);

      let state =
        verified ? "VERIFIED ✓" :
        forceComplete ? "measured / not verified" :
        id === activeTuneAlgorithm ? "VERIFYING…" :
        accepted >= activeTuneTargetShares ? "accepted" :
        "pending";

      const row = document.createElement("div");
      row.className = `tune-result-row ${verified ? "verified" : ""}`;
      row.innerHTML =
        `<span>${id}</span>` +
        `<strong>${hps > 0 ? formatHashrate(hps) : "—"}</strong>` +
        `<span>${accepted}/${activeTuneTargetShares} shares</span>` +
        `<em>${state}</em>`;

      target.appendChild(row);
    }
  };

  renderInto(tuneResultsEl);
  renderInto(tuneProgressMinerEl);
}

function sendTuneRequest() {
  if (ws?.readyState !== WebSocket.OPEN) return;
  pendingTuneStart = false;
  const profile = getAlgoProfile();
  setTuneStatus("Starting tune — H/s is local; shares verify correctness…");
  ws.send(JSON.stringify({ type: "tune_start", results: profile?.results ?? {} }));
}
function recordTuneRate(message: any) {
  if (!message.tuning || !message.algorithmId) return;
  const algorithmId = String(message.algorithmId);
  let rates = tuneWorkerRates.get(algorithmId);
  if (!rates) {
    rates = new Map();
    tuneWorkerRates.set(algorithmId, rates);
  }
  const now = performance.now();
  rates.set(Number(message.workerIndex), { hps: Number(message.hps ?? 0), at: now });
  let total = 0;
  let live = 0;
  for (const rate of rates.values()) {
    if (now - rate.at <= 4_000) {
      total += rate.hps;
      live += 1;
    }
  }
  if (live >= Math.max(1, Math.ceil(workers.size * 0.5)) && total > 0) {
    const samples = tuneSamples.get(algorithmId) ?? [];
    samples.push(total);
    if (samples.length > 100) samples.shift();
    tuneSamples.set(algorithmId, samples);
    if (algorithmId === activeTuneAlgorithm) {
      const accepted = tuneAcceptedShares.get(algorithmId) ?? 0;
      setTuneStatus(`Tuning ${algorithmId} · ${formatHashrate(total)} · accepted ${accepted}/${activeTuneTargetShares} · Minewhile payout`);
    }
  }
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
        workerRates.set(Number(message.workerIndex), {
          hps: Number(message.hps ?? 0),
          seenAt: performance.now(),
          algorithmId: String(message.algorithmId ?? currentAlgorithmId)
        });
        recordTuneRate(message);
        return;
      }
      if (message.type === "share") {
        log(`candidate ${message.algorithmId} worker=${message.workerIndex + 1} nonce=${message.nonceHex}`);
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "submit",
            jobId: message.jobId,
            extranonce2: message.extranonce2,
            ntime: message.ntime,
            nonceHex: message.nonceHex,
            mode: message.mode,
            generationId: message.generationId,
            algorithmId: message.algorithmId,
            tuning: message.tuning === true,
            tuneId: message.tuneId ?? null
          }));
        }
        return;
      }
      if (message.type === "error") log(`WORKER ${index + 1} ERROR ${message.message}`);
    };
    worker.onerror = (event) => {
      readyWorkers.delete(index);
      workerRates.delete(index);
      updateWorkerStatus();
      log(`WORKER ${index + 1} ERROR ${event.message}`);
    };
    workers.set(index, worker);
  }
  updateWorkerStatus();
}

function assignJobToWorkers(job: BrowserJob) {
  currentJob = job;
  currentAlgorithmId = job.algorithmId;
  algorithmEl.textContent = `${job.algorithmId}${job.tuning ? " · tuning" : ""}`;
  const nonceSeed = crypto.getRandomValues(new Uint32Array(1))[0];
  const workerCount = workers.size;
  for (let index = 0; index < workerCount; index++) {
    workers.get(index)?.postMessage({ type: "job", job, workerIndex: index, workerCount, nonceSeed });
  }
}

function getAlgoProfile(): AlgoProfile | null {
  const profile = readStored<AlgoProfile | null>("algoProfileV1", null);
  if (!profile || typeof profile !== "object") return null;
  if (Number(profile.workers) !== Number(workerSlider.value)) return null;
  if (Date.now() - Number(profile.at) > ALGO_PROFILE_MAX_AGE_MS) return null;
  if (!profile.results || typeof profile.results !== "object") return null;
  return profile;
}

function sendAlgoProfile() {
  const profile = getAlgoProfile();
  if (!profile || !miningRequested || ws?.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "benchmark", results: profile.results }));
}

function median(values: number[]): number {
  const sorted = values.filter(Number.isFinite).filter((x) => x > 0).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function finishTuneProfile() {
  const previous = getAlgoProfile()?.results ?? {};
  const results: Record<string, number> = { ...previous };
  for (const [id, samples] of tuneSamples.entries()) {
    const value = median(samples.slice(1));
    if (value > 0) results[id] = value;
  }
  const profile: AlgoProfile = { at: Date.now(), workers: Number(workerSlider.value), results };
  writeStored("algoProfileV1", profile);
  return profile;
}

function updateVerifiedAlgorithms(raw: unknown) {
  if (!Array.isArray(raw)) return;
  verifiedAlgorithms = new Set(raw.map(String).filter(Boolean) as AlgorithmId[]);
  verifiedAlgorithms.add("yespower");
  const previous = fixedAlgorithmEl.value;
  fixedAlgorithmEl.replaceChildren();
  for (const id of verifiedAlgorithms) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = id === "yespower" ? "YesPower" : `${id} ✓ verified`;
    fixedAlgorithmEl.appendChild(option);
  }
  if ([...verifiedAlgorithms].includes(previous as AlgorithmId)) fixedAlgorithmEl.value = previous;
}

function selectedStartPayload() {
  return {
    type: "start",
    payoutCurrency: currencyEl.value.toUpperCase(),
    payoutAddress: walletEl.value.trim(),
    workerCount: Number(workerSlider.value),
    algorithmMode: algorithmModeEl.value === "fixed" ? "fixed" : "auto",
    algorithmId: algorithmModeEl.value === "fixed" ? fixedAlgorithmEl.value : "yespower",
    ...(activeBeneficiaryId ? { beneficiaryId: activeBeneficiaryId } : {})
  };
}

function scheduleReconnect(delayMs = 3_000) {
  if (!miningRequested || reconnectTimer !== null) return;
  statusEl.textContent = "reconnecting";
  relayHealthEl.textContent = "reconnecting";
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connectRelay();
  }, delayMs);
}

function connectRelay() {
  if (!miningRequested || ws) return;
  statusEl.textContent = "connecting";
  relayHealthEl.textContent = "connecting";
  const socket = new WebSocket(relayUrl);
  ws = socket;

  socket.onopen = () => {
    if (ws !== socket || !miningRequested) return;
    statusEl.textContent = "connected / waiting for job";
    relayHealthEl.textContent = "connected";
    log("relay connected");
    socket.send(JSON.stringify(selectedStartPayload()));
  };

  socket.onmessage = (event) => {
    let message: any;
    try { message = JSON.parse(event.data); }
    catch { log("RELAY ERROR invalid JSON response"); return; }

    if (message.type === "job") {
      const job = message as BrowserJob;
      statusEl.textContent = job.tuning ? "tuning" : "mining";
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
      const mode = normalizeMiningMode(message.mode);
      if (currentJob && currentJob.mode !== mode) pauseWorkers();
      setModeLabel(mode, Number(message.countdownMs ?? 0));
      return;
    }

    if (message.type === "difficulty") {
      const mode = normalizeMiningMode(message.mode);
      difficultyByMode.set(mode, Number(message.value));
      if (mode === currentMode || message.tuning) difficultyEl.textContent = String(message.value);
      return;
    }

    if (message.type === "health") {
      if (message.tuning || normalizeMiningMode(message.mode) === currentMode) {
        poolHealthEl.textContent = `${String(message.state ?? "unknown")} · ${String(message.algorithmId ?? currentAlgorithmId)}`;
      }
      return;
    }

    if (message.type === "share_result") {
      lastShareAt = Date.now();
      if (!message.tuning && message.shares) {
        acceptedUser = Number(message.shares.user?.accepted ?? acceptedUser);
        rejectedUser = Number(message.shares.user?.rejected ?? rejectedUser);
        beneficiaryAccepted = Number(message.shares.beneficiary?.accepted ?? beneficiaryAccepted);
        beneficiaryRejected = Number(message.shares.beneficiary?.rejected ?? beneficiaryRejected);
        acceptedDev = Number(message.shares.dev?.accepted ?? acceptedDev);
        rejectedDev = Number(message.shares.dev?.rejected ?? rejectedDev);
      } else if (message.tuning) {
        if (message.algorithmId) {
          tuneAcceptedShares.set(String(message.algorithmId), Number(message.acceptedForAlgorithm ?? 0));
          activeTuneTargetShares = Number(message.targetAcceptedShares ?? 2);
          renderTuneProgress();
        }
      } else if (message.mode === "beneficiary") {
        message.accepted ? beneficiaryAccepted++ : beneficiaryRejected++;
      } else if (message.mode === "dev") {
        message.accepted ? acceptedDev++ : rejectedDev++;
      } else {
        message.accepted ? acceptedUser++ : rejectedUser++;
      }
      updateShareCounts();
      log(message.accepted
        ? `SHARE ACCEPTED (${message.mode}${message.algorithmId ? `/${message.algorithmId}` : ""})`
        : `SHARE REJECTED (${message.mode}) ${JSON.stringify(message.error)}`);
      return;
    }

    if (message.type === "tune_plan") {
      tuningActive = true;
      activeTuneId = String(message.tuneId ?? "");
      tuneWorkerRates.clear();
      tuneSamples.clear();
      tuneAcceptedShares.clear();
      tunePlanIds = Array.isArray(message.algorithms) ? message.algorithms.map(String) : [];
      activeTuneTargetShares = Number(message.targetAcceptedShares ?? 2);
      setTuneButtons(true);
      setTuneStatus(`Tune plan: ${tunePlanIds.length ? tunePlanIds.join(" → ") : "starting"} · ${activeTuneTargetShares} accepted/algo`);
      renderTuneProgress();
      setView("miner", true);
      return;
    }

    if (message.type === "tune_step") {
      tuningActive = true;
      activeTuneAlgorithm = String(message.algorithmId ?? "");
      activeTuneTargetShares = Number(message.targetAcceptedShares ?? 2);
      tuneAcceptedShares.set(activeTuneAlgorithm, 0);
      setTuneStatus(`Tuning ${activeTuneAlgorithm} · step ${Number(message.index) + 1}/${message.total} · waiting for H/s · 0/${activeTuneTargetShares} accepted`);
      renderTuneProgress();
      modeEl.textContent = "Quick Tune → Minewhile";
      return;
    }

    if (message.type === "tune_complete") {
      pauseWorkers();
      tuningActive = false;
      activeTuneId = "";
      activeTuneAlgorithm = "";
      setTuneButtons(false);
      updateVerifiedAlgorithms(message.verifiedAlgorithms);
      const profile = finishTuneProfile();
      setTuneStatus("Tune complete. Normal mining resumed with a fresh 95% user window.");
      tunePlanIds = Object.keys(profile.results);
      renderTuneProgress(true);
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "benchmark", results: profile.results }));
      return;
    }

    if (message.type === "algorithm_recommendation") {
      schedulerEl.textContent = String(message.mode ?? "auto");
      updateVerifiedAlgorithms(message.verifiedAlgorithms);

      const selected = message.selected;
      const bestOverall = message.bestOverall;

      if (selected) {
        const networkHash = Number(selected.networkHashrate ?? 0);
        const poolHash = Number(selected.poolHashrate ?? 0);
        const browserShare = selected.browserNetworkShare == null ? null : Number(selected.browserNetworkShare);
        const fleetShare = selected.projectedFleetShare == null ? null : Number(selected.projectedFleetShare);
        const penalty = Number(selected.impactPenalty ?? 1);
        const blockSeconds = selected.networkBlockTimeSec == null ? null : Number(selected.networkBlockTimeSec);
        const source = String(selected.networkHashrateSource ?? "unavailable");
        const confidence = String(selected.networkConfidence ?? "learning");

        schedulerBestEl.textContent = String(selected.displayName ?? selected.id);
        schedulerBenchmarkEl.textContent = formatHashrate(Number(selected.benchmarkHps ?? 0));
        schedulerCoinEl.textContent = String(selected.currentCoin ?? "—");

        schedulerNetworkEl.textContent =
          networkHash > 0
            ? `${source === "pool-lower-bound" ? "≥ " : "~ "}${formatHashrate(networkHash)}`
            : "learning…";

        schedulerPoolEl.textContent = poolHash > 0 ? formatHashrate(poolHash) : "—";

        schedulerUserShareEl.textContent =
          browserShare == null ? "—" : `${(browserShare * 100).toFixed(3)}%`;

        schedulerFleetShareEl.textContent =
          fleetShare == null ? "—" : `${(fleetShare * 100).toFixed(3)}%`;

        schedulerPenaltyEl.textContent = `${(penalty * 100).toFixed(0)}%`;

        schedulerScoreEl.textContent =
          Number.isFinite(Number(selected.profitabilityScore))
            ? Number(selected.profitabilityScore).toExponential(3)
            : "—";

        schedulerConfidenceEl.textContent = confidence;

        schedulerDetailsEl.textContent = [
          `source: ${source}`,
          `confidence: ${confidence}`,
          `chain samples: ${Number(selected.networkSamples ?? 0)}`,
          `observed block time: ${blockSeconds == null ? "learning" : `${blockSeconds.toFixed(1)} s`}`,
          `active Minewhile fleet: ${Number(message.fleetEstimate ?? 1)}`,
          `projected fleet H/s: ${formatHashrate(Number(selected.projectedFleetHashrate ?? 0))}`,
          `current estimate: ${Number(selected.estimateCurrent ?? 0)}`,
          `24h estimate: ${Number(selected.estimate24h ?? 0)}`
        ].join("\n");

        const impact =
          fleetShare == null
            ? "network share learning"
            : `${(fleetShare * 100).toFixed(2)}% projected network share`;

        log(`Scheduler: best VERIFIED ${selected.displayName} @ ${formatHashrate(Number(selected.benchmarkHps))} · ${impact}`);
      }

      if (bestOverall && (!selected || bestOverall.id !== selected.id)) {
        log(`Scheduler: ${bestOverall.displayName} ranks higher but is not yet verified for user payout.`);
      }

      return;
    }

    if (message.type === "algorithm_switched") {
      currentAlgorithmId = String(message.algorithmId ?? "yespower") as AlgorithmId;
      algorithmEl.textContent = currentAlgorithmId;
      log(`AUTO switched to ${currentAlgorithmId}`);
      return;
    }

    if (message.type === "log") { const m=String(message.message??"").replace(/\s+[A-Za-z0-9.-]+\.mine\.zpool\.ca:\d+/gi,""); if (/\bJOB\s+[0-9a-f]+$/i.test(m) || /\bSUBSCRIBED\b/i.test(m)) return; log(m); return; }
    if (message.type === "wallet_stats") { updateWalletStats(message); return; }
    if (message.type === "stats_error") { log(`STATS ${message.message}`); statsUpdatedEl.textContent = "Temporarily unavailable"; return; }
    if (message.type === "error") {
      log(`RELAY ERROR ${message.message}`);
      if (pendingTuneStart) { pendingTuneStart = false; setTuneButtons(false); }
      if (tuningActive) setTuneStatus(String(message.message));
      return;
    }

    if (message.type === "started") {
      log(`Mining started for ${message.payoutCurrency}: ${String(message.payoutAddress).slice(0, 8)}...`);
      requestWalletStats();
      schedulerEl.textContent = `${String(message.schedulerMode ?? "auto")} / ${String(message.algorithmMode ?? "auto")}`;
      currentAlgorithmId = String(message.currentAlgorithm ?? "yespower") as AlgorithmId;
      algorithmEl.textContent = currentAlgorithmId;
      updateVerifiedAlgorithms(message.verifiedAlgorithms);
      setTuneStatus("Ready to tune. H/s is local; two accepted shares verify each algorithm.");
      sendAlgoProfile();
      if (pendingTuneStart) sendTuneRequest();
      return;
    }

    if (message.type === "stopped") log("Relay stopped session");
  };

  socket.onerror = () => log("relay websocket error");
  socket.onclose = (event) => {
    if (ws === socket) ws = null;
    pauseWorkers();
    relayHealthEl.textContent = "offline";
    poolHealthEl.textContent = "offline";
    log(`relay disconnected${event.reason ? `: ${event.reason}` : ""}`);
    if (miningRequested && (event.code === 1008 || event.code === 1009)) {
      miningRequested = false;
      pendingTuneStart = false;
      setTuneButtons(false);
      stopWorkers();
      setConfigurationLocked(false);
      startBtn.disabled = false;
      startQuickBtn.disabled = false;
      stopBtn.disabled = true;
      statusEl.textContent = "connection rejected";
      return;
    }
    if (miningRequested) scheduleReconnect(event.code === 1013 ? 30_000 : 3_000);
  };
}

function startMining() {
  const payload = selectedStartPayload();
  if (!payload.payoutAddress) { log("Payout address is required."); setView("settings", true); return; }
  if (!SUPPORTED_CURRENCIES.includes(payload.payoutCurrency as typeof SUPPORTED_CURRENCIES[number])) { log("Unsupported payout currency."); return; }
  miningRequested = true;
  resetSessionStats();
  createWorkerPool();
  setConfigurationLocked(true);
  startBtn.disabled = true;
  startQuickBtn.disabled = true;
  stopBtn.disabled = false;
  connectRelay();
  setView("miner", true);
}

function stopMining() {
  miningRequested = false;
  tuningActive = false;
  pendingTuneStart = false;
  activeTuneAlgorithm = "";
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
  relayHealthEl.textContent = "offline";
  poolHealthEl.textContent = "offline";
  countdownEl.textContent = "—";
  difficultyEl.textContent = "—";
  sessionTimeEl.textContent = "0:00";
  startBtn.disabled = false;
  startQuickBtn.disabled = false;
  stopBtn.disabled = true;
  setTuneButtons(false);
  setConfigurationLocked(false);
}

function startTune() {
  if (tuningActive || pendingTuneStart) return;
  if (!selectedStartPayload().payoutAddress) { setTuneStatus("Enter payout address first."); setView("settings", true); return; }
  pendingTuneStart = true;
  setTuneButtons(true);
  setTuneStatus(miningRequested ? "Requesting tune…" : "Starting mining, then tuning automatically…");
  if (!miningRequested) { startMining(); return; }
  if (ws?.readyState === WebSocket.OPEN) sendTuneRequest(); else connectRelay();
}

function setView(name: "miner" | "settings" | "referrals", updateHash = false) {
  document.querySelectorAll<HTMLElement>("[data-view]").forEach((el) => {
    const active = el.dataset.view === name;
    el.hidden = !active;
    el.classList.toggle("active", active);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((el) => {
    el.classList.toggle("active", el.dataset.tab === name);
  });
  if (updateHash) history.replaceState(null, "", `#${name}`);
}

function routeFromHash() {
  if (location.hash.startsWith("#manage=")) setView("referrals");
  else if (location.hash === "#settings") setView("settings");
  else if (location.hash === "#referrals") setView("referrals");
  else setView("miner");
}

const referralFromUrl = normalizeReferralCode(new URLSearchParams(location.search).get("r"));
let activeBeneficiaryId = normalizeReferralCode(readStored("beneficiaryId", ""));
if (referralFromUrl && !activeBeneficiaryId) {
  activeBeneficiaryId = referralFromUrl;
  writeStored("beneficiaryId", activeBeneficiaryId);
}
if (new URLSearchParams(location.search).has("r")) {
  const cleanUrl = new URL(location.href);
  cleanUrl.searchParams.delete("r");
  history.replaceState(null, "", cleanUrl.toString());
}

const detectedThreads = Math.max(1, navigator.hardwareConcurrency || 1);
const maxWorkers = Math.max(1, Math.min(MAX_BROWSER_WORKERS, detectedThreads));
const defaultWorkers = Math.max(1, Math.min(4, Math.floor(detectedThreads / 2) || 1));

currencyEl.innerHTML = [
  `<optgroup label="Guaranteed payout">${SUPPORTED_CURRENCIES.filter((currency) => GUARANTEED_CURRENCIES.has(currency)).map((currency) => `<option value="${currency}">${currency}</option>`).join("")}</optgroup>`,
  `<optgroup label="Other payout currencies">${SUPPORTED_CURRENCIES.filter((currency) => !GUARANTEED_CURRENCIES.has(currency)).map((currency) => `<option value="${currency}">${currency}</option>`).join("")}</optgroup>`
].join("");
currencyEl.value = readStored("currency", "LTC");
walletEl.value = readStored("wallet", "");
workerSlider.min = "1";
workerSlider.max = String(maxWorkers);
workerSlider.value = String(Math.min(maxWorkers, Math.max(1, Number(readStored("workers", defaultWorkers)))));
detectedThreadsEl.textContent = String(detectedThreads);
autoScrollToggle.checked = readStored("autoscroll", true);
autoScroll = autoScrollToggle.checked;
algorithmModeEl.value = readStored("algorithmMode", "auto");

initReferralCreator(relayUrl);

if (!window.isSecureContext) httpSecretWarningEl.hidden = false;

autoScrollToggle.onchange = () => {
  autoScroll = autoScrollToggle.checked;
  writeStored("autoscroll", autoScroll);
};
currencyEl.onchange = () => writeStored("currency", currencyEl.value);
walletEl.oninput = () => writeStored("wallet", walletEl.value);
workerSlider.oninput = updateWorkerDisplay;
algorithmModeEl.onchange = () => {
  writeStored("algorithmMode", algorithmModeEl.value);
  fixedAlgorithmRow.hidden = algorithmModeEl.value !== "fixed";
};
fixedAlgorithmRow.hidden = algorithmModeEl.value !== "fixed";
clearLogBtn.onclick = () => { logLines.length = 0; logEl.textContent = ""; };
startBtn.onclick = startMining;
startQuickBtn.onclick = startMining;
stopBtn.onclick = stopMining;
tuneBtn.onclick = startTune;
tuneMinerBtn.onclick = startTune;

document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((button) => {
  button.onclick = () => setView((button.dataset.tab || "miner") as "miner" | "settings" | "referrals", true);
});
window.addEventListener("hashchange", routeFromHash);

window.setInterval(requestWalletStats, 30_000);
window.setInterval(sendAlgoProfile, 5 * 60_000);
window.setInterval(() => {
  updateHashrate();
  countdownEl.textContent = countdownDeadline > 0 ? formatDuration((countdownDeadline - Date.now()) / 1000) : "—";
  sessionTimeEl.textContent = miningRequested && sessionStartedAt > 0 ? formatDuration((Date.now() - sessionStartedAt) / 1000) : "0:00";
  lastShareHealthEl.textContent = lastShareAt ? `${Math.max(0, Math.floor((Date.now() - lastShareAt) / 1000))}s ago` : "—";
}, 1000);

stopBtn.disabled = true;
setConfigurationLocked(false);
updateWorkerDisplay();
updateWorkerStatus();
updateShareCounts();
routeFromHash();
log("Minewhile v1 ready — mining starts only when you press START.");
if (activeBeneficiaryId) log(`Referral active: ${activeBeneficiaryId}`);
supportNoteEl.textContent = activeBeneficiaryId
  ? "95% you · 3% referrer · 2% Minewhile · pool fees are separate"
  : "95% you · 5% Minewhile · pool fees are separate";
