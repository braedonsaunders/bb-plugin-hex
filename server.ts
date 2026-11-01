import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { homedir, tmpdir } from "node:os";
import { extname, join } from "node:path";
import { cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";

const MODEL_IDS = [
  "apple_speech",
  "parakeet_unified_en",
  "parakeet_v2",
  "parakeet_v3",
  "whisper_large_v3_turbo",
  "qwen3_asr06_b",
  "qwencleo_asr_1_7b",
  "ivrit_whisper_large_v3_turbo",
  "sense_voice_small",
  "cohere_transcribe",
  "underdog_bark_3_pro",
  "underdog_bark_3_clean",
  "parakeet_ultra",
  "nemotron_3_5_asr",
] as const;

type ModelId = (typeof MODEL_IDS)[number];

interface EmbeddedEndpoint {
  readonly type: "ready";
  readonly url: string;
  readonly token: string;
  readonly apiVersion: "2";
  readonly pid: number;
}

interface ModelInfo {
  readonly id: string;
  readonly name: string;
  readonly installed: boolean;
  readonly verified: boolean;
  readonly managed: boolean;
  readonly downloadBytes: number | null;
  readonly languages: readonly string[];
  readonly supportsLanguageDetection: boolean;
  readonly source: string | null;
}

interface ManagedHexHost {
  readonly executable: string;
  readonly child: ChildProcessWithoutNullStreams;
  readonly endpoint: EmbeddedEndpoint;
  readonly preparedModels: Set<string>;
  close(): Promise<void>;
}

interface HexHttpResponse {
  readonly status: number;
  readonly body: Buffer;
  text(): string;
  json<T = unknown>(): T;
}

const DEFAULT_HEX_CANDIDATES = [
  "/opt/homebrew/bin/hex",
  join(homedir(), ".local", "bin", "hex"),
  "/usr/local/bin/hex",
  join(homedir(), "Documents", "hex", "target", "release", "hex"),
];

const DEFAULT_FFMPEG_CANDIDATES = [
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "ffmpeg",
];

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveHexBinary(configuredPath: string): string | null {
  const trimmed = configuredPath.trim();
  if (trimmed !== "" && isExecutable(trimmed)) {
    return trimmed;
  }
  for (const candidate of DEFAULT_HEX_CANDIDATES) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveFfmpegBinary(): string {
  for (const candidate of DEFAULT_FFMPEG_CANDIDATES) {
    if (candidate === "ffmpeg" || isExecutable(candidate)) {
      return candidate;
    }
  }
  return "ffmpeg";
}

function createWavFromPcm16Mono(pcmBytes: Uint8Array, sampleRate = 16000): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcmBytes.byteLength - (pcmBytes.byteLength % 2);
  const buffer = Buffer.allocUnsafe(44 + dataSize);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
  buffer.writeUInt16LE(1, 20); // AudioFormat (1 = PCM)
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  buffer.set(pcmBytes.subarray(0, dataSize), 44);

  return buffer;
}

function guessExtension(file: File): string {
  const fromName = extname(file.name || "").toLowerCase();
  if (fromName) return fromName;
  const type = (file.type || "").toLowerCase();
  if (type.includes("webm")) return ".webm";
  if (type.includes("mp4") || type.includes("m4a") || type.includes("aac")) return ".m4a";
  if (type.includes("ogg") || type.includes("opus")) return ".ogg";
  if (type.includes("wav")) return ".wav";
  return ".bin";
}

async function convertToWav16kMono(audio: File, rawBytes: Uint8Array, signal?: AbortSignal): Promise<Buffer> {
  const ffmpeg = resolveFfmpegBinary();
  const tempDir = await mkdtemp(join(tmpdir(), "bb-hex-audio-"));
  const inputPath = join(tempDir, `input${guessExtension(audio)}`);
  const outputPath = join(tempDir, "output.pcm");

  try {
    await writeFile(inputPath, rawBytes);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        ffmpeg,
        [
          "-y",
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          inputPath,
          "-vn",
          "-ac",
          "1",
          "-ar",
          "16000",
          "-f",
          "s16le",
          "-acodec",
          "pcm_s16le",
          outputPath,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );

      const stderrChunks: Buffer[] = [];
      let settled = false;

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        if (err) reject(err);
        else resolve();
      };

      const onAbort = () => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        finish(new Error("Audio conversion cancelled"));
      };

      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });

      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
      child.once("error", (err) => finish(new Error(`Failed to run ffmpeg (${ffmpeg}): ${err.message}`)));
      child.once("close", (code) => {
        if (code !== 0) {
          const detail = Buffer.concat(stderrChunks).toString("utf8").trim();
          finish(new Error(`ffmpeg exited with code ${code}${detail ? `: ${detail}` : ""}`));
          return;
        }
        finish();
      });
    });

    const pcmBuffer = await readFile(outputPath);
    const pcmBytes = new Uint8Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.byteLength);
    if (pcmBytes.byteLength < 320) {
      throw new Error("Audio clip is too short or contains no audio samples");
    }
    return createWavFromPcm16Mono(pcmBytes, 16000);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams, timeoutMs = 3_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.stdin.end();
  } catch {
    // ignore
  }
  if (await waitForExit(child, timeoutMs)) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // ignore
  }
  if (await waitForExit(child, 1_000)) return;
  try {
    child.kill("SIGKILL");
  } catch {
    // ignore
  }
  await waitForExit(child, 1_000);
}

async function spawnHexEmbedded(executable: string, startupTimeoutMs = 10_000): Promise<ManagedHexHost> {
  const child = spawn(executable, ["service", "--embedded"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const line = await new Promise<string>((resolve, reject) => {
    let settled = false;
    let buffer = Buffer.alloc(0);
    let stderr = "";

    const finish = (err?: Error, handshakeLine?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
      if (err) reject(err);
      else resolve(handshakeLine!);
    };

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline >= 0) {
        finish(undefined, buffer.subarray(0, newline).toString("utf8"));
      }
    };

    const onStderr = (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8192);
    };

    const onError = (err: Error) => {
      finish(new Error(`Could not start hex service (${executable}): ${err.message}`));
    };

    const onExit = (code: number | null, sig: NodeJS.Signals | null) => {
      const detail = stderr.trim();
      finish(
        new Error(
          `hex service exited before becoming ready (${code ?? sig ?? "unknown"})${detail ? `: ${detail}` : ""}`,
        ),
      );
    };

    const timer = setTimeout(() => {
      finish(new Error(`hex service did not become ready within ${startupTimeoutMs}ms`));
    }, startupTimeoutMs);

    child.stdout.on("data", onData);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
  }).catch(async (err) => {
    await stopChild(child, 1_000);
    throw err;
  });

  const parsed = JSON.parse(line) as EmbeddedEndpoint;
  if (parsed.type !== "ready" || parsed.apiVersion !== "2" || !parsed.url || !parsed.token) {
    await stopChild(child, 1_000);
    throw new Error(`Invalid handshake from hex service: ${line}`);
  }

  child.stdout.resume();
  child.stderr.resume();

  let closePromise: Promise<void> | null = null;
  const close = () => {
    closePromise ??= stopChild(child);
    return closePromise;
  };

  return {
    executable,
    child,
    endpoint: parsed,
    preparedModels: new Set<string>(),
    close,
  };
}

/**
 * Use `node:http` with `agent: false` (`Connection: close`) because Hex's
 * embedded HTTP server handles exactly one request per TCP connection and
 * closes the socket, which causes Node's pooled `fetch` (undici) to throw
 * `TypeError: fetch failed` on reused sockets.
 */
async function hexRequest(
  host: ManagedHexHost,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: Buffer;
    signal?: AbortSignal;
  } = {},
): Promise<HexHttpResponse> {
  const url = new URL(`${host.endpoint.url}${path}`);
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${host.endpoint.token}`,
    Connection: "close",
    ...options.headers,
  };
  if (options.body !== undefined) {
    headers["Content-Length"] = String(options.body.byteLength);
  }

  const response = await new Promise<HexHttpResponse>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error, res?: HexHttpResponse) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve(res!);
    };

    const req = httpRequest(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.once("error", (err) => finish(err));
        res.once("end", () => {
          const body = Buffer.concat(chunks);
          finish(undefined, {
            status: res.statusCode ?? 500,
            body,
            text: () => body.toString("utf8"),
            json: <T = unknown>() => JSON.parse(body.toString("utf8")) as T,
          });
        });
      },
    );

    const onAbort = () => {
      req.destroy(new Error("Request aborted"));
      finish(new Error("Hex request cancelled"));
    };

    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    req.once("error", (err) => finish(err));
    if (options.body !== undefined) {
      req.end(options.body);
    } else {
      req.end();
    }
  });

  if (response.status < 200 || response.status >= 300) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = response.json<{ code?: string; message?: string }>();
      if (body.message) detail = `${body.code ?? "error"}: ${body.message}`;
      else if (body.code) detail = body.code;
    } catch {
      // ignore
    }
    throw new Error(`Hex request ${path} failed (${detail})`);
  }

  return response;
}

async function ensureModelPrepared(
  host: ManagedHexHost,
  model: string,
  language: string,
  signal?: AbortSignal,
): Promise<void> {
  const cacheKey = `${model}:${language}`;
  if (host.preparedModels.has(cacheKey)) return;

  const query = new URLSearchParams({ language });
  const response = await hexRequest(host, `/models/${encodeURIComponent(model)}/prepare?${query}`, {
    method: "POST",
    signal,
  });
  const text = response.text();
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (!raw) continue;
    const payload = JSON.parse(raw) as {
      type?: string;
      error?: { code?: string; message?: string };
    };
    if (payload.type === "error") {
      throw new Error(payload.error?.message ?? payload.error?.code ?? "Hex model preparation failed");
    }
    if (payload.type === "ok") {
      host.preparedModels.add(cacheKey);
      return;
    }
  }
  throw new Error("Hex model preparation stream ended without confirmation");
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    model: {
      type: "select",
      label: "Transcription model",
      options: [...MODEL_IDS],
      default: "apple_speech",
    },
    language: {
      type: "string",
      label: "Language code (e.g. en, auto)",
      default: "en",
    },
    hexBinaryPath: {
      type: "string",
      label: "Path to hex binary (optional override)",
      default: "",
    },
  });

  let activeHost: ManagedHexHost | null = null;
  let hostInFlight: Promise<ManagedHexHost> | null = null;
  let disposed = false;

  async function getOrStartHost(): Promise<ManagedHexHost> {
    if (disposed) {
      throw new Error("Hex plugin is shutting down");
    }
    const cfg = await settings.get();
    const binary = resolveHexBinary(cfg.hexBinaryPath);
    if (!binary) {
      throw new Error(
        "Hex binary not found. Install hex to /opt/homebrew/bin/hex or ~/.local/bin/hex, or set hexBinaryPath in plugin settings.",
      );
    }

    if (
      activeHost !== null &&
      activeHost.executable === binary &&
      activeHost.child.exitCode === null &&
      activeHost.child.signalCode === null
    ) {
      return activeHost;
    }

    if (hostInFlight !== null) {
      return hostInFlight;
    }

    hostInFlight = (async () => {
      if (activeHost !== null) {
        await activeHost.close().catch(() => {});
        activeHost = null;
      }
      const host = await spawnHexEmbedded(binary);
      host.child.once("exit", () => {
        if (activeHost === host) {
          activeHost = null;
        }
      });
      activeHost = host;
      return host;
    })().finally(() => {
      hostInFlight = null;
    });

    return hostInFlight;
  }

  bb.onDispose(async () => {
    disposed = true;
    if (activeHost !== null) {
      const host = activeHost;
      activeHost = null;
      await host.close().catch(() => {});
    }
  });

  bb.experimental_aiServices.register({
    id: "hex",
    displayName: "Hex (Apple Speech)",
    async status() {
      const cfg = await settings.get();
      const binary = resolveHexBinary(cfg.hexBinaryPath);
      if (!binary) {
        return {
          ready: false,
          message: "Hex binary not found — install hex to /opt/homebrew/bin/hex or set hexBinaryPath in plugin settings",
        };
      }
      try {
        const host = await getOrStartHost();
        const language = (cfg.language || "en").trim() || "en";
        const res = await hexRequest(host, `/models?${new URLSearchParams({ language })}`);
        const models = res.json<ModelInfo[]>();
        const selected = models.find((m) => m.id === cfg.model);
        if (!selected) {
          return {
            ready: false,
            message: `Model "${cfg.model}" is not available in Hex`,
          };
        }
        return { ready: true };
      } catch (err) {
        return {
          ready: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
    async transcribe(audio: File, { signal }) {
      const cfg = await settings.get();
      const model = (cfg.model || "apple_speech") as ModelId;
      const language = (cfg.language || "en").trim() || "en";

      const rawBuffer = new Uint8Array(await audio.arrayBuffer());
      if (rawBuffer.byteLength === 0) {
        throw new Error("Received empty audio clip");
      }

      const wavBuffer = await convertToWav16kMono(audio, rawBuffer, signal);

      const host = await getOrStartHost();
      await ensureModelPrepared(host, model, language, signal);

      const query = new URLSearchParams({ model, language });
      const response = await hexRequest(host, `/transcriptions?${query}`, {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: wavBuffer,
        signal,
      });

      const result = response.json<{ transcript?: string; durationMs?: number }>();
      return (result.transcript ?? "").trim();
    },
  });

  bb.cli.register(
    defineCli({
      name: "hex",
      summary: "Inspect and manage the Hex local voice transcription service.",
      commands: {
        status: cliCommand({
          summary: "Check Hex embedded service health and available models",
          options: {
            json: {
              type: "boolean",
              description: "Output JSON",
            },
          },
          async run({ options }) {
            const cfg = await settings.get();
            const binary = resolveHexBinary(cfg.hexBinaryPath);
            if (!binary) {
              return {
                exitCode: 1,
                stderr: "Hex binary: NOT FOUND\n",
              };
            }
            const host = await getOrStartHost();
            const language = (cfg.language || "en").trim() || "en";
            const [healthRes, modelsRes] = await Promise.all([
              hexRequest(host, "/health"),
              hexRequest(host, `/models?${new URLSearchParams({ language })}`),
            ]);
            const health = healthRes.json<{ version: string; apiVersion: string }>();
            const models = modelsRes.json<ModelInfo[]>();
            if (options.json) {
              return {
                exitCode: 0,
                stdout: `${JSON.stringify(
                  {
                    ready: true,
                    pid: host.endpoint.pid,
                    binary,
                    selectedModel: cfg.model,
                    language,
                    health,
                    models,
                  },
                  null,
                  2,
                )}\n`,
              };
            }
            const lines = [
              `Hex embedded service: READY (pid ${host.endpoint.pid}, v${health.version})`,
              `Binary:   ${binary}`,
              `Selected: ${cfg.model} (language: ${language})`,
              "",
              "Models:",
              ...models.map(
                (m) =>
                  `  ${m.id === cfg.model ? "*" : " "} ${m.id.padEnd(28)} ${m.installed ? "installed" : "not-installed"} (${m.name})`,
              ),
            ];
            return {
              exitCode: 0,
              stdout: `${lines.join("\n")}\n`,
            };
          },
        }),
      },
    }),
  );
}
