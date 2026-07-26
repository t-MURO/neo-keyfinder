import { spawn } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const binary = process.argv[2] && resolve(process.argv[2]);
const verifyBpm = process.argv.includes("--bpm");
if (!binary) {
  throw new Error(
    "Usage: node scripts/verify-release-sidecar.mjs <sidecar> [--bpm]",
  );
}
if (statSync(binary).size < 1_024) {
  throw new Error(`Sidecar is unexpectedly small: ${binary}`);
}

const child = spawn(binary, [], {
  env: verifyBpm
    ? { ...process.env, NKF_BPM_DIAGNOSTICS: "1" }
    : process.env,
  stdio: ["pipe", "pipe", "inherit"],
  windowsHide: true,
});
const lines = createInterface({ input: child.stdout });
const pendingRequests = new Map();
const queuedEvents = [];
const eventWaiters = new Set();
let requestSequence = 0;

const failPending = (error) => {
  for (const pending of pendingRequests.values()) pending.reject(error);
  pendingRequests.clear();
  for (const waiter of eventWaiters) waiter.reject(error);
  eventWaiters.clear();
};

child.once("error", failPending);
child.once("exit", (code) => {
  if (code && code !== 0) {
    failPending(new Error(`Sidecar exited with code ${code}`));
  }
});

lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    failPending(new Error(`Sidecar emitted invalid JSON: ${line}`));
    return;
  }
  const pending = message.requestId && pendingRequests.get(message.requestId);
  if (pending) {
    pendingRequests.delete(message.requestId);
    clearTimeout(pending.timeout);
    if (message.error) {
      pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
    } else {
      pending.resolve(message.result);
    }
    return;
  }

  queuedEvents.push(message);
  for (const waiter of eventWaiters) {
    if (!waiter.predicate(message)) continue;
    eventWaiters.delete(waiter);
    clearTimeout(waiter.timeout);
    waiter.resolve(message);
    break;
  }
});

const request = (method, params = {}) => {
  const requestId = `release-${++requestSequence}`;
  return new Promise((resolveRequest, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`Sidecar request timed out: ${method}`));
    }, 30_000);
    pendingRequests.set(requestId, {
      resolve: resolveRequest,
      reject,
      timeout,
    });
    child.stdin.write(
      `${JSON.stringify({
        version: 1,
        requestId,
        method,
        params,
      })}\n`,
    );
  });
};

const waitForEvent = (predicate) => {
  const queued = queuedEvents.find(predicate);
  if (queued) return Promise.resolve(queued);
  return new Promise((resolveEvent, reject) => {
    const waiter = {
      predicate,
      resolve: resolveEvent,
      reject,
      timeout: undefined,
    };
    waiter.timeout = setTimeout(() => {
      eventWaiters.delete(waiter);
      reject(new Error("Sidecar event timed out"));
    }, 90_000);
    eventWaiters.add(waiter);
  });
};

const writeClickTrack = (path, bpm = 120) => {
  const sampleRate = 44_100;
  const seconds = 30;
  const samples = sampleRate * seconds;
  const dataSize = samples * 2;
  const output = Buffer.allocUnsafe(44 + dataSize);
  output.write("RIFF", 0);
  output.writeUInt32LE(36 + dataSize, 4);
  output.write("WAVEfmt ", 8);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36);
  output.writeUInt32LE(dataSize, 40);
  const beatSamples = Math.round(sampleRate * 60 / bpm);
  for (let sample = 0; sample < samples; sample += 1) {
    const beatOffset = sample % beatSamples;
    const value = beatOffset < sampleRate / 10
      ? Math.sin(2 * Math.PI * 90 * beatOffset / sampleRate) *
        Math.exp(-beatOffset / (sampleRate * 0.018))
      : 0;
    output.writeInt16LE(Math.round(value * 28_000), 44 + sample * 2);
  }
  writeFileSync(path, output);
};

let temporary;
try {
  const health = await request("health");
  if (health?.service !== "keyfinder-native" || health?.protocolVersion !== 1) {
    throw new Error(`Unexpected sidecar health response: ${JSON.stringify(health)}`);
  }

  if (verifyBpm) {
    temporary = mkdtempSync(join(tmpdir(), "neo-keyfinder-release-"));
    const clickTrack = join(temporary, "120-bpm.wav");
    writeClickTrack(clickTrack);
    const settings = {
      parallel: false,
      bpmAnalysisEnabled: true,
      maxDurationMinutes: 60,
      automaticWrites: false,
    };
    const expanded = await request("expandFiles", {
      paths: [clickTrack],
      settings,
    });
    const track = expanded?.tracks?.[0];
    if (!track) throw new Error("Sidecar did not scan the BPM smoke-test track");

    const started = await request("startAnalysis", {
      tracks: [track],
      settings,
      owner: "release-verifier",
      writeAuthorization: false,
    });
    await waitForEvent(
      (event) =>
        event.event === "jobFinished" && event.jobId === started?.jobId,
    );
    const completed = queuedEvents
      .filter(
        (event) =>
          event.event === "trackUpdated" &&
          event.jobId === started?.jobId &&
          event.payload?.track?.status === "completed",
      )
      .at(-1)?.payload?.track;
    if (!completed) {
      const failed = queuedEvents
        .filter(
          (event) =>
            event.event === "trackUpdated" && event.jobId === started?.jobId,
        )
        .at(-1)?.payload?.track;
      throw new Error(
        `Sidecar BPM smoke test failed: ${JSON.stringify(failed?.error || failed)}`,
      );
    }
    if (
      typeof completed.detectedBpm !== "number" ||
      Math.abs(completed.detectedBpm - 120) > 1
    ) {
      throw new Error(
        `Expected approximately 120 BPM, received ${completed.detectedBpm}`,
      );
    }
    console.log(`Verified Essentia BPM detection: ${completed.detectedBpm} BPM`);
  }

  console.log(`Verified release sidecar: ${binary}`);
} finally {
  child.stdin.end();
  child.kill();
  lines.close();
  if (temporary) rmSync(temporary, { recursive: true, force: true });
}
