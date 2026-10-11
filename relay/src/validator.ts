import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

const VALIDATION_TIMEOUT_MS = 5_000;
const MAX_PENDING_VALIDATIONS = 256;

const validatorPath =
  process.env.YESPOWER_VALIDATOR ||
  fileURLToPath(new URL("../../native/yespower-validator", import.meta.url));

type Pending = {
  resolve: (value: boolean) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

let processHandle: ChildProcessWithoutNullStreams | null = null;
let stdoutBuffer = "";
let stderrBuffer = "";
let nextId = 1;
const pending = new Map<number, Pending>();

function rejectAll(error: Error) {
  for (const item of pending.values()) {
    clearTimeout(item.timer);
    item.reject(error);
  }
  pending.clear();
}

function stopValidator(error: Error) {
  const proc = processHandle;
  processHandle = null;
  stdoutBuffer = "";
  stderrBuffer = "";
  rejectAll(error);
  proc?.kill("SIGKILL");
}

function ensureValidator(): ChildProcessWithoutNullStreams {
  if (processHandle) return processHandle;

  const proc = spawn(validatorPath, [], {
    stdio: ["pipe", "pipe", "pipe"]
  });

  processHandle = proc;
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");

  proc.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;

    let newline: number;
    while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);

      if (!line) continue;

      const [idText, result] = line.split(/\s+/);
      const id = Number(idText);
      const item = pending.get(id);

      if (!item) continue;

      pending.delete(id);
      clearTimeout(item.timer);

      if (result === "1") item.resolve(true);
      else if (result === "0") item.resolve(false);
      else item.reject(new Error("Native YesPower validator returned an invalid result."));
    }
  });

  proc.stderr.on("data", (chunk: string) => {
    stderrBuffer = (stderrBuffer + chunk).slice(-4096);
  });

  proc.on("error", (error) => {
    if (processHandle === proc) {
      stopValidator(new Error(`Failed to start YesPower validator: ${error.message}`));
    }
  });

  proc.on("exit", (code, signal) => {
    if (processHandle !== proc) return;

    processHandle = null;
    const detail = stderrBuffer.trim();
    stderrBuffer = "";

    rejectAll(
      new Error(
        `YesPower validator exited (${code ?? signal ?? "unknown"})${detail ? `: ${detail}` : ""}`
      )
    );
  });

  return proc;
}

export function validateYespowerShare(
  header76Hex: string,
  targetHex: string,
  nonceHex: string
): Promise<boolean> {
  if (!/^[0-9a-fA-F]{152}$/.test(header76Hex)) {
    return Promise.reject(new Error("Invalid 76-byte header for local validation."));
  }

  if (!/^[0-9a-fA-F]{64}$/.test(targetHex)) {
    return Promise.reject(new Error("Invalid target for local validation."));
  }

  if (!/^[0-9a-fA-F]{8}$/.test(nonceHex)) {
    return Promise.reject(new Error("Invalid nonce for local validation."));
  }

  if (pending.size >= MAX_PENDING_VALIDATIONS) {
    return Promise.reject(new Error("Local share validation queue is full."));
  }

  const id = nextId++;
  const proc = ensureValidator();

  return new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pending.delete(id)) return;

      reject(new Error("Local YesPower validation timed out."));
      stopValidator(new Error("Resetting YesPower validator after timeout."));
    }, VALIDATION_TIMEOUT_MS);

    pending.set(id, { resolve, reject, timer });

    proc.stdin.write(
      `${id} ${header76Hex.toLowerCase()} ${targetHex.toLowerCase()} ${nonceHex.toLowerCase()}\n`,
      (error) => {
        if (!error) return;

        const item = pending.get(id);
        if (!item) return;

        pending.delete(id);
        clearTimeout(item.timer);
        reject(error);
      }
    );
  });
}
