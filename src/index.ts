#!/usr/bin/env bun

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { clearLine, cursorTo } from "node:readline";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

type ModelKind = "chat" | "image" | "video" | "tts" | "stt";
type ChatModel = (typeof CATALOG.chat)[number];
type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

const API_BASE = "https://console.tenstorrent.com";
const CLI_VERSION = "v0.2";
const SYSTEM_PROMPT = `안녕! 나는 토렌디시야. tenstorrent-cli 의 밝고 발랄한 어시스턴트.
console.tenstorrent.com 인프라 위에서 영상·이미지·텍스트·음성·전사를 도와줘.

명령:
- 영상 생성: /video <prompt> (Wan 2.2 계열, ~5초 1280x720, ~$0.05)
- 이미지 생성: /image <prompt> (sdxl 기본, ~$0.02)
- 음성 합성: /tts <text> (tts-1)
- 음성 전사: /stt <파일경로> (whisper-large-v3)
- 모델 변경: /model <id>

사용자가 영상/이미지/음성 만들고 싶다고 자연어로 말하면 해당 슬래시 명령을 친근하게 안내해.
한국어로 단답 선호. 가벼운 농담은 좋지만 선 넘지 않게.
도움 되는 답을 우선해.`;

const CATALOG = {
  chat: [
    "deepseek-ai/DeepSeek-R1-0528",
    "Qwen/Qwen3-32B",
    "Qwen/Qwen3-VL-32B-Instruct",
    "google/gemma-4-31B-it",
  ],
  image: ["sdxl", "tt-sd3.5", "tt-z-image-turbo"],
  video: [
    "Wan2.2-T2V-A14B-Diffusers",
    "Prodia Wan 2.2 Lighting Text to Video",
    "prodia/Wan2.2-T2V-A14B-Lightning",
    "Wan2.2-T2V-A14B-Lighting-Diffusers",
    "Wan2.2-T2V-A14B-Lightning",
    "Wan2.2-T2V-A14B-Lightning-Diffusers",
    "Wan2.2-T2V-A14B-Lightning-Diffusers-FP8",
    "Wan2.2-T2V-Lightning",
  ],
  tts: ["tts-1"],
  stt: ["whisper-large-v3"],
} as const;

const DEFAULTS = {
  chat: "Qwen/Qwen3-VL-32B-Instruct",
  image: "sdxl",
  video: "Wan2.2-T2V-A14B-Diffusers",
  tts: "tts-1",
  stt: "whisper-large-v3",
} as const;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const key = process.env.TENSTORRENT_KEY;
let currentModel: ChatModel = DEFAULTS.chat;
let history: ChatMessage[] = [];

if (!key) {
  console.error("TENSTORRENT_KEY is required.");
  console.error("Create an API key at https://console.tenstorrent.com and run:");
  console.error('  export TENSTORRENT_KEY="your-api-key"');
  process.exit(1);
}

class ProgressIndicator {
  private frameIndex = 0;
  private timer: Timer | undefined;
  private readonly startTime = Date.now();

  constructor(private label: string) {}

  start() {
    if (!output.isTTY) {
      console.error(`✻ ${this.label}`);
      return;
    }
    this.timer = setInterval(() => this.render(), 100);
    this.render();
  }

  update(label: string) {
    this.label = label;
    if (!this.timer && output.isTTY) {
      this.render();
    }
  }

  succeed(summary: string) {
    this.stop();
    output.write(`✓ ${summary}\n`);
  }

  fail(summary: string) {
    this.stop();
    output.write(`✗ ${summary}\n`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (output.isTTY) {
      this.clearLine();
    }
  }

  private render() {
    const frame = SPINNER_FRAMES[this.frameIndex % SPINNER_FRAMES.length];
    this.frameIndex += 1;
    this.clearLine();
    output.write(`${frame} ${this.label}  ${formatElapsed(Date.now() - this.startTime)}`);
  }

  private clearLine() {
    cursorTo(output, 0);
    clearLine(output, 0);
    output.write("\r\x1b[K");
  }
}

function authHeaders() {
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

function authOnlyHeaders() {
  return { Authorization: `Bearer ${key}` };
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers ?? {}) },
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(JSON.stringify(json));
  }
  return json as T;
}

function formatElapsed(ms: number) {
  const seconds = ms / 1000;
  if (seconds < 10) {
    return `${seconds.toFixed(1)}s`;
  }
  const wholeSeconds = Math.floor(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const remainder = wholeSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function formatBytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function modelLabel(model: string) {
  if (model === "deepseek-ai/DeepSeek-R1-0528") return "DeepSeek-R1";
  if (model === "Qwen/Qwen3-32B") return "Qwen3-32B";
  if (model === "Qwen/Qwen3-VL-32B-Instruct") return "Qwen3-VL";
  if (model === "google/gemma-4-31B-it") return "Gemma-4-31B";
  return model;
}

function modelKind(model: string) {
  if (model === "deepseek-ai/DeepSeek-R1-0528") return "reasoning";
  if (model === "Qwen/Qwen3-32B") return "thinking";
  if (model === "Qwen/Qwen3-VL-32B-Instruct") return "default, vision-language";
  if (model === "Wan2.2-T2V-A14B-Diffusers") return "default, full 40 step";
  if (model === "sdxl") return "default";
  return "";
}

function isCatalogModel(kind: ModelKind, model: string) {
  return (CATALOG[kind] as readonly string[]).includes(model);
}

function parseOptions(inputText: string) {
  const parts = inputText.trim().split(/\s+/);
  const args: string[] = [];
  const options: Record<string, string> = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === "--model" || part === "--size") {
      const value = parts[index + 1];
      if (value) {
        options[part.slice(2)] = value;
        index += 1;
      }
      continue;
    }
    args.push(part);
  }
  return { text: args.join(" "), options };
}

function parseSize(rawSize?: string) {
  if (!rawSize) {
    return { width: 1024, height: 1024 };
  }
  const match = rawSize.match(/^(\d+)x(\d+)$/i);
  if (!match) {
    throw new Error("size 는 1024x1024 형식으로 입력해줘.");
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

function extractAssistantText(message: Record<string, unknown>) {
  const content = typeof message.content === "string" ? message.content : "";
  const reasoning = typeof message.reasoning === "string" ? message.reasoning : "";
  const reasoningContent =
    typeof message.reasoning_content === "string" ? message.reasoning_content : "";
  return content || reasoning || reasoningContent || JSON.stringify(message);
}

function extractReasoning(message: Record<string, unknown>) {
  const reasoning = typeof message.reasoning === "string" ? message.reasoning : "";
  const reasoningContent =
    typeof message.reasoning_content === "string" ? message.reasoning_content : "";
  return reasoning || reasoningContent;
}

function truncateLine(text: string, maxLength = 96) {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength - 1)}…` : oneLine;
}

function findUrl(value: unknown): string | undefined {
  if (typeof value === "string" && /^https?:\/\//.test(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUrl(item);
      if (found) return found;
    }
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      const found = findUrl(item);
      if (found) return found;
    }
  }
  return undefined;
}

function jobFailureMessage(kind: "image" | "video", jobId: string, status: Record<string, unknown>) {
  const state = String(status.status ?? "unknown");
  const message = typeof status.error === "string" ? `: ${status.error}` : "";
  return `${kind} job ${jobId} ended with status=${state}${message}`;
}

async function chat(prompt: string) {
  history.push({ role: "user", content: prompt });
  const progress = new ProgressIndicator(`흠… ${modelLabel(currentModel)}`);
  progress.start();

  try {
    const response = await requestJson<{
      choices?: Array<{ message?: Record<string, unknown> }>;
      usage?: {
        completion_tokens?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    }>("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: currentModel,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history],
        max_tokens: 1024,
      }),
    });

    const message = response.choices?.[0]?.message ?? {};
    const text = extractAssistantText(message);
    const reasoning = extractReasoning(message);
    history.push({ role: "assistant", content: text });
    progress.succeed(`${modelLabel(currentModel)} 응답 완료`);

    if (currentModel === "deepseek-ai/DeepSeek-R1-0528" && reasoning) {
      const reasoningTokens =
        response.usage?.completion_tokens_details?.reasoning_tokens ?? response.usage?.completion_tokens;
      const tokenText = reasoningTokens ? ` (${reasoningTokens} tokens)` : "";
      console.log(`\x1b[90m  reasoning: ${truncateLine(reasoning)}${tokenText}\x1b[0m`);
    }

    return text;
  } catch (error) {
    progress.fail(`${modelLabel(currentModel)} 응답 실패`);
    throw error;
  }
}

async function downloadBinary(url: string, outputPath: string, label = "다운로드") {
  const progress = new ProgressIndicator(label);
  progress.start();
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    progress.fail(`${label} 실패 ${response.status}`);
    throw new Error(`${label} failed: ${response.status}`);
  }
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    const total = contentLength ? ` / ${formatBytes(contentLength)}` : "";
    progress.update(`${label} ${formatBytes(received)}${total}`);
  }
  await writeFile(outputPath, Buffer.concat(chunks));
  progress.succeed(`${label} 완료 ${formatBytes(contentLength || received)}`);
}

async function generateImage(rawInput: string) {
  const { text: prompt, options } = parseOptions(rawInput);
  if (!prompt) throw new Error("/image <prompt> 로 입력해줘.");
  const model = options.model ?? DEFAULTS.image;
  if (!isCatalogModel("image", model)) throw new Error(`모르는 image 모델이야: ${model}`);
  const { width, height } = parseSize(options.size);

  console.error(`✻ ${model} 에 prompt 전송`);
  const submitProgress = new ProgressIndicator("끄응… image job 생성");
  submitProgress.start();
  let submit: Record<string, unknown>;
  try {
    submit = await requestJson<Record<string, unknown>>("/v1/image/jobs", {
      method: "POST",
      body: JSON.stringify({ model, prompt, width, height, steps: 20 }),
    });
    submitProgress.succeed("image job 생성 완료");
  } catch (error) {
    submitProgress.fail("image endpoint 실패");
    throw error;
  }

  const jobId = String(submit.id ?? submit.job_id ?? "");
  if (!jobId) throw new Error(`No image job id returned: ${JSON.stringify(submit)}`);
  console.error(`  job: ${jobId}`);
  const pollProgress = new ProgressIndicator("큐 대기 + 이미지 추론");
  pollProgress.start();

  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const status = await requestJson<Record<string, unknown>>(`/v1/image/jobs/${jobId}`);
    pollProgress.update(`큐 대기 + 이미지 추론 · ${String(status.status ?? "unknown")}`);
    if (status.status === "completed") {
      const imageUrl = findUrl(status);
      if (!imageUrl) {
        await Bun.sleep(3000);
        continue;
      }
      pollProgress.succeed("이미지 생성 완료");
      await mkdir("output", { recursive: true });
      const outputPath = `output/image-${Date.now()}.jpg`;
      await downloadBinary(imageUrl, outputPath, "다운로드");
      const cents = typeof status.estimated_cents === "number" ? status.estimated_cents : 2;
      console.error(`✓ 저장 → ${outputPath} ($${(cents / 100).toFixed(2)})`);
      return outputPath;
    }
    if (status.status === "failed" || status.status === "cancelled") {
      pollProgress.fail(`이미지 생성 ${String(status.status)}`);
      throw new Error(jobFailureMessage("image", jobId, status));
    }
    await Bun.sleep(3000);
  }

  pollProgress.fail("timeout");
  throw new Error(`Timed out waiting for image job ${jobId}`);
}

async function generateVideo(rawInput: string) {
  const { text: prompt, options } = parseOptions(rawInput);
  if (!prompt) throw new Error("/video <prompt> 로 입력해줘.");
  if (prompt.length > 2000) {
    throw new Error(`Prompt is ${prompt.length} characters. Tenstorrent video prompts must be 2000 or fewer.`);
  }
  const model = options.model ?? DEFAULTS.video;
  if (!isCatalogModel("video", model)) throw new Error(`모르는 video 모델이야: ${model}`);

  console.error(`✻ ${model} 에 prompt 전송`);
  const submitProgress = new ProgressIndicator("끄응… video job 생성");
  submitProgress.start();
  let submit: { job_id?: string; id?: string };
  try {
    submit = await requestJson<{ job_id?: string; id?: string }>("/v1/video/jobs", {
      method: "POST",
      body: JSON.stringify({
        model,
        prompt,
        negative_prompt: "low quality, distorted hands, blurry, watermark",
      }),
    });
    submitProgress.succeed("video job 생성 완료");
  } catch (error) {
    submitProgress.fail("video job 생성 실패");
    throw error;
  }

  const jobId = submit.job_id ?? submit.id;
  if (!jobId) throw new Error(`No video job id returned: ${JSON.stringify(submit)}`);
  console.error(`  job: ${jobId}`);
  const pollProgress = new ProgressIndicator("큐 대기 + 추론");
  pollProgress.start();

  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const status = await requestJson<Record<string, unknown>>(`/v1/video/jobs/${jobId}`);
    pollProgress.update(`큐 대기 + 추론 · ${String(status.status ?? "unknown")}`);
    if (status.status === "completed") {
      const videoUrl = findUrl(status);
      if (!videoUrl) {
        await Bun.sleep(5000);
        continue;
      }
      pollProgress.succeed("영상 생성 완료");
      await mkdir("output", { recursive: true });
      const outputPath = `output/video-${Date.now()}.mp4`;
      await downloadBinary(videoUrl, outputPath, "다운로드");
      const duration = typeof status.duration_seconds === "number" ? `${status.duration_seconds.toFixed(2)}s` : "5.06s";
      const cents = typeof status.actual_cents === "number" ? status.actual_cents : status.estimated_cents;
      const cost = typeof cents === "number" ? `$${(cents / 100).toFixed(2)}` : "~$0.05";
      console.error(`✓ 저장 → ${outputPath} (${duration}, 1280×720, ${cost})`);
      return outputPath;
    }
    if (status.status === "failed" || status.status === "cancelled") {
      pollProgress.fail(`영상 생성 ${String(status.status)}`);
      throw new Error(jobFailureMessage("video", jobId, status));
    }
    await Bun.sleep(5000);
  }

  pollProgress.fail("timeout");
  throw new Error(`Timed out waiting for video job ${jobId}`);
}

async function generateTts(rawInput: string) {
  const { text, options } = parseOptions(rawInput);
  if (!text) throw new Error("/tts <text> 로 입력해줘.");
  const model = options.model ?? DEFAULTS.tts;
  if (!isCatalogModel("tts", model)) throw new Error(`모르는 tts 모델이야: ${model}`);

  await mkdir("output", { recursive: true });
  const outputPath = `output/tts-${Date.now()}.mp3`;
  const progress = new ProgressIndicator("TTS endpoint 확인");
  progress.start();

  for (const endpoint of ["/v1/audio/speech", "/v1/tts/jobs"]) {
    try {
      progress.update(`${endpoint} 시도`);
      const response = await fetch(`${API_BASE}${endpoint}`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ model, input: text, voice: "alloy" }),
      });
      if (response.status === 404 || response.status === 405) continue;
      if (!response.ok) throw new Error(await response.text());

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const json = await response.json() as Record<string, unknown>;
        const audioUrl = findUrl(json);
        if (!audioUrl) throw new Error(`TTS JSON did not include an audio URL: ${JSON.stringify(json)}`);
        progress.succeed(`${endpoint} 매핑 확인`);
        await downloadBinary(audioUrl, outputPath, "다운로드");
      } else {
        progress.succeed(`${endpoint} 매핑 확인`);
        await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
      }

      console.error(`✓ 저장 → ${outputPath}`);
      return outputPath;
    } catch (error) {
      if (endpoint === "/v1/tts/jobs") {
        progress.fail("TTS endpoint 가 아직 매핑 안 됨. 곧 추가!");
        console.error(error instanceof Error ? error.message : error);
        return undefined;
      }
    }
  }

  progress.fail("TTS endpoint 가 아직 매핑 안 됨. 곧 추가!");
  return undefined;
}

async function transcribe(rawInput: string) {
  const { text: filePath, options } = parseOptions(rawInput);
  if (!filePath) throw new Error("/stt <파일경로> 로 입력해줘.");
  const model = options.model ?? DEFAULTS.stt;
  if (!isCatalogModel("stt", model)) throw new Error(`모르는 stt 모델이야: ${model}`);
  await readFile(filePath);

  const progress = new ProgressIndicator("STT endpoint 확인");
  progress.start();
  try {
    const form = new FormData();
    form.append("model", model);
    form.append("file", Bun.file(filePath));
    const response = await fetch(`${API_BASE}/v1/audio/transcriptions`, {
      method: "POST",
      headers: authOnlyHeaders(),
      body: form,
    });
    if (response.status === 404 || response.status === 405) {
      progress.fail("STT endpoint 가 아직 매핑 안 됨. 곧 추가!");
      return undefined;
    }
    const json = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(JSON.stringify(json));
    progress.succeed("전사 완료");
    const text = typeof json.text === "string" ? json.text : JSON.stringify(json);
    console.log(text);
    return text;
  } catch (error) {
    progress.fail("STT 실패");
    throw error;
  }
}

function printCatalog() {
  console.log(`현재 chat 모델: ${currentModel}

chat (${CATALOG.chat.length})
${CATALOG.chat.map((model) => `  - ${model}${modelKind(model) ? `  (${modelKind(model)})` : ""}`).join("\n")}

image (${CATALOG.image.length}) — /image 가 사용
${CATALOG.image.map((model) => `  - ${model}${modelKind(model) ? `  (${modelKind(model)})` : ""}`).join("\n")}

video (${CATALOG.video.length}) — /video 가 사용
${CATALOG.video.map((model) => `  - ${model}${modelKind(model) ? `  (${modelKind(model)})` : ""}`).join("\n")}

tts (${CATALOG.tts.length}) — /tts 가 사용
${CATALOG.tts.map((model) => `  - ${model}`).join("\n")}

stt (${CATALOG.stt.length}) — /stt 가 사용
${CATALOG.stt.map((model) => `  - ${model}`).join("\n")}`);
}

function printHelp() {
  console.log(`
Commands:
  /help                         Show this help
  /model                        Show model catalog
  /model <id>                   Switch chat model
  /image <prompt> [--model id]  Generate image and save under ./output
  /video <prompt> [--model id]  Generate Wan 2.2 video and save under ./output
  /tts <text> [--model id]      Generate speech if endpoint is available
  /stt <file>                   Transcribe audio if endpoint is available
  /clear                        Clear chat history
  /exit                         Exit
`);
}

function setModel(inputModel: string) {
  const aliases: Record<string, ChatModel> = {
    deepseek: "deepseek-ai/DeepSeek-R1-0528",
    qwen: "Qwen/Qwen3-32B",
    vl: "Qwen/Qwen3-VL-32B-Instruct",
    gemma: "google/gemma-4-31B-it",
  };
  const nextModel = aliases[inputModel] ?? inputModel;
  if (!isCatalogModel("chat", nextModel)) {
    console.log("✗ 모르는 chat 모델이야. /model 로 카탈로그를 봐줘.");
    return;
  }
  currentModel = nextModel as ChatModel;
  console.log(`✓ 모델 → ${currentModel}${modelKind(currentModel) ? ` (${modelKind(currentModel)})` : ""}`);
}

async function main() {
  console.log(`✻ 안녕~ 토렌디시야! tenstorrent-cli ${CLI_VERSION}`);
  console.log(`   현재 모델 ${currentModel} (chat)`);
  console.log("   /video /image /tts /stt /model /help /clear /exit");

  const rl = createInterface({ input, output });
  const interactive = Boolean(input.isTTY);

  async function handleLine(rawLine: string) {
    const line = rawLine.trim();
    if (!line) return false;
    if (line === "/exit") return true;
    if (line === "/help") {
      printHelp();
      return false;
    }
    if (line === "/clear") {
      history = [];
      console.log("✓ 대화 기록 지웠어.");
      return false;
    }
    if (line === "/model") {
      printCatalog();
      return false;
    }
    if (line.startsWith("/model ")) {
      setModel(line.slice("/model ".length).trim());
      return false;
    }
    if (line.startsWith("/image ")) {
      try {
        const outputPath = await generateImage(line.slice("/image ".length).trim());
        if (outputPath) console.log(`saved: ${outputPath}`);
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
      }
      return false;
    }
    if (line.startsWith("/video ")) {
      try {
        const outputPath = await generateVideo(line.slice("/video ".length).trim());
        console.log(`saved: ${outputPath}`);
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
      }
      return false;
    }
    if (line.startsWith("/tts ")) {
      try {
        const outputPath = await generateTts(line.slice("/tts ".length).trim());
        if (outputPath) console.log(`saved: ${outputPath}`);
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
      }
      return false;
    }
    if (line.startsWith("/stt ")) {
      try {
        await transcribe(line.slice("/stt ".length).trim());
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
      }
      return false;
    }
    if (line.startsWith("/")) {
      console.log("✗ 모르는 명령이야. /help 쳐봐.");
      return false;
    }
    try {
      console.log(await chat(line));
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
    }
    return false;
  }

  try {
    rl.setPrompt("> ");
    if (interactive) rl.prompt();
    for await (const line of rl) {
      if (await handleLine(line)) break;
      if (interactive) rl.prompt();
    }
  } finally {
    rl.close();
  }
}

await main();
