#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

type ChatModel =
  | "deepseek-ai/DeepSeek-R1-0528"
  | "Qwen/Qwen3-32B"
  | "Qwen/Qwen3-VL-32B-Instruct";

type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

const API_BASE = "https://console.tenstorrent.com";
const CLI_VERSION = "v0.1";
const DEFAULT_MODEL: ChatModel = "Qwen/Qwen3-VL-32B-Instruct";
const SYSTEM_PROMPT =
  "당신은 tenstorrent-cli 의 어시스턴트입니다. 사용자가 영상/이미지 생성을 요청하면 /video <prompt> 명령을 안내하세요. 영상은 Wan 2.2 모델로 약 5초, 1280×720, ~$0.05 에 생성됩니다. 단독 이미지 생성은 현재 카탈로그에 없습니다. 그 외 일반 질문은 한국어로 친절하고 간결하게 답하세요. 답변이 너무 길어지지 않게 하세요.";
const VIDEO_MODEL = "Wan2.2-T2V-A14B-Diffusers";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MODELS: ChatModel[] = [
  "deepseek-ai/DeepSeek-R1-0528",
  "Qwen/Qwen3-32B",
  "Qwen/Qwen3-VL-32B-Instruct",
];

let currentModel: ChatModel = DEFAULT_MODEL;
let history: ChatMessage[] = [];

const key = process.env.TENSTORRENT_KEY;

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
    console.error(`✓ ${summary}`);
  }

  fail(summary: string) {
    this.stop();
    console.error(`✗ ${summary}`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    if (output.isTTY) {
      console.error("\r\x1b[K");
    }
  }

  private render() {
    const frame = SPINNER_FRAMES[this.frameIndex % SPINNER_FRAMES.length];
    this.frameIndex += 1;
    console.error(`\r\x1b[K${frame} ${this.label}  ${formatElapsed(Date.now() - this.startTime)}`);
  }
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

function modelLabel(model: ChatModel) {
  if (model === "deepseek-ai/DeepSeek-R1-0528") {
    return "DeepSeek-R1";
  }
  if (model === "Qwen/Qwen3-32B") {
    return "Qwen3-32B";
  }
  return "Qwen3-VL";
}

function modelKind(model: ChatModel) {
  if (model === "deepseek-ai/DeepSeek-R1-0528") {
    return "reasoning";
  }
  if (model === "Qwen/Qwen3-32B") {
    return "thinking";
  }
  return "vision";
}

function authHeaders() {
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...authHeaders(),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(JSON.stringify(json));
  }

  return json as T;
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

async function chat(prompt: string) {
  history.push({ role: "user", content: prompt });

  const progress = new ProgressIndicator(`흠… ${modelLabel(currentModel)}`);
  progress.start();

  try {
    const response = await requestJson<{
      choices?: Array<{ message?: Record<string, unknown> }>;
      usage?: {
        completion_tokens?: number;
        completion_tokens_details?: {
          reasoning_tokens?: number;
        };
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

async function generateVideo(prompt: string) {
  if (prompt.length > 2000) {
    throw new Error(`Prompt is ${prompt.length} characters. Tenstorrent video prompts must be 2000 or fewer.`);
  }

  console.error(`✻ ${VIDEO_MODEL} 에 prompt 전송`);

  const submitProgress = new ProgressIndicator("끄응… job 생성");
  submitProgress.start();
  let submit: { job_id?: string; id?: string };
  try {
    submit = await requestJson<{ job_id?: string; id?: string }>("/v1/video/jobs", {
      method: "POST",
      body: JSON.stringify({
        model: VIDEO_MODEL,
        prompt,
        negative_prompt: "low quality, distorted hands, blurry, watermark",
      }),
    });
    submitProgress.succeed("job 생성 완료");
  } catch (error) {
    submitProgress.fail("job 생성 실패");
    throw error;
  }

  const jobId = submit.job_id ?? submit.id;
  if (!jobId) {
    throw new Error(`No video job id returned: ${JSON.stringify(submit)}`);
  }

  console.error(`  job: ${jobId}`);
  const pollProgress = new ProgressIndicator("큐 대기 + 추론");
  pollProgress.start();

  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const status = await requestJson<{
      status?: string;
      video_url?: string;
      error?: unknown;
      duration_seconds?: number;
      actual_cents?: number;
      estimated_cents?: number;
    }>(`/v1/video/jobs/${jobId}`);

    pollProgress.update(`큐 대기 + 추론 · ${status.status ?? "unknown"}`);

    if (status.status === "completed") {
      if (!status.video_url) {
        await Bun.sleep(5000);
        continue;
      }

      pollProgress.succeed("영상 생성 완료");

      await mkdir("output", { recursive: true });
      const outputPath = `output/video-${Date.now()}.mp4`;
      await downloadVideo(status.video_url, outputPath);
      const duration = status.duration_seconds ? `${status.duration_seconds.toFixed(2)}s` : "5.06s";
      const cents = status.actual_cents ?? status.estimated_cents;
      const cost = typeof cents === "number" ? `$${(cents / 100).toFixed(2)}` : "~$0.05";
      console.error(`✓ 저장 → ${outputPath} (${duration}, 1280×720, ${cost})`);
      return outputPath;
    }

    if (status.status === "failed" || status.status === "cancelled") {
      pollProgress.fail(`영상 생성 ${status.status}`);
      throw new Error(JSON.stringify(status));
    }

    await Bun.sleep(5000);
  }

  pollProgress.fail(`timeout`);
  throw new Error(`Timed out waiting for video job ${jobId}`);
}

async function downloadVideo(videoUrl: string, outputPath: string) {
  const downloadProgress = new ProgressIndicator("다운로드");
  downloadProgress.start();

  const videoResponse = await fetch(videoUrl);
  if (!videoResponse.ok || !videoResponse.body) {
    downloadProgress.fail(`다운로드 실패 ${videoResponse.status}`);
    throw new Error(`Video download failed: ${videoResponse.status}`);
  }

  const contentLength = Number(videoResponse.headers.get("content-length") ?? 0);
  const reader = videoResponse.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    chunks.push(value);
    received += value.byteLength;
    const total = contentLength ? ` / ${formatBytes(contentLength)}` : "";
    downloadProgress.update(`다운로드 ${formatBytes(received)}${total}`);
  }

  await writeFile(outputPath, Buffer.concat(chunks));
  const total = contentLength || received;
  downloadProgress.succeed(`다운로드 완료 ${formatBytes(total)}`);
}

function printHelp() {
  console.log(`
Commands:
  /help             Show this help
  /model            Show model catalog
  /model <id>       Switch model
  /video <prompt>   Generate Wan 2.2 video and save it under ./output
  /clear            Clear chat history
  /exit             Exit

Models:
${MODELS.map((model) => `  ${model}`).join("\n")}
`);
}

function setModel(inputModel: string) {
  const aliases: Record<string, ChatModel> = {
    deepseek: "deepseek-ai/DeepSeek-R1-0528",
    qwen: "Qwen/Qwen3-32B",
    vl: "Qwen/Qwen3-VL-32B-Instruct",
  };
  const nextModel = aliases[inputModel] ?? inputModel;

  if (!MODELS.includes(nextModel as ChatModel)) {
    console.log("✗ 모르는 모델이야. 사용 가능한 모델:");
    for (const model of MODELS) {
      console.log(`  ${model}`);
    }
    return;
  }

  currentModel = nextModel as ChatModel;
  console.log(`✓ 모델 → ${currentModel} (${modelKind(currentModel)})`);
}

async function main() {
  console.log(`✻ tenstorrent-cli ${CLI_VERSION}  ·  모델 ${currentModel}`);
  console.log("   /help · /model · /video · /clear · /exit");

  const rl = createInterface({ input, output });
  const interactive = Boolean(input.isTTY);

  async function handleLine(rawLine: string) {
    const line = rawLine.trim();

    if (!line) {
      return false;
    }

    if (line === "/exit") {
      return true;
    }

    if (line === "/help") {
      printHelp();
      return false;
    }

    if (line === "/clear") {
      history = [];
      console.log("history cleared");
      return false;
    }

    if (line === "/model") {
      console.log(`current: ${currentModel}`);
      for (const model of MODELS) {
        console.log(`  ${model}`);
      }
      return false;
    }

    if (line.startsWith("/model ")) {
      setModel(line.slice("/model ".length).trim());
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
    if (interactive) {
      rl.prompt();
    }

    for await (const line of rl) {
      if (await handleLine(line)) {
        break;
      }

      if (interactive) {
        rl.prompt();
      }
    }
  } finally {
    rl.close();
  }
}

await main();
