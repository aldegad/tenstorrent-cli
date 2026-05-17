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
const DEFAULT_MODEL: ChatModel = "Qwen/Qwen3-VL-32B-Instruct";
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

async function chat(prompt: string) {
  history.push({ role: "user", content: prompt });

  const response = await requestJson<{
    choices?: Array<{ message?: Record<string, unknown> }>;
  }>("/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: currentModel,
      messages: history,
      max_tokens: 1024,
    }),
  });

  const message = response.choices?.[0]?.message ?? {};
  const text = extractAssistantText(message);
  history.push({ role: "assistant", content: text });
  return text;
}

async function generateVideo(prompt: string) {
  if (prompt.length > 2000) {
    throw new Error(`Prompt is ${prompt.length} characters. Tenstorrent video prompts must be 2000 or fewer.`);
  }

  const submit = await requestJson<{ job_id?: string; id?: string }>("/v1/video/jobs", {
    method: "POST",
    body: JSON.stringify({
      model: "Wan2.2-T2V-A14B-Diffusers",
      prompt,
      negative_prompt: "low quality, distorted hands, blurry, watermark",
    }),
  });

  const jobId = submit.job_id ?? submit.id;
  if (!jobId) {
    throw new Error(`No video job id returned: ${JSON.stringify(submit)}`);
  }

  console.log(`video job: ${jobId}`);

  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const status = await requestJson<{
      status?: string;
      video_url?: string;
      error?: unknown;
    }>(`/v1/video/jobs/${jobId}`);

    console.log(`status: ${status.status ?? "unknown"}`);

    if (status.status === "completed") {
      if (!status.video_url) {
        await Bun.sleep(5000);
        continue;
      }

      const videoResponse = await fetch(status.video_url);
      if (!videoResponse.ok || !videoResponse.body) {
        throw new Error(`Video download failed: ${videoResponse.status}`);
      }

      await mkdir("output", { recursive: true });
      const outputPath = `output/video-${Date.now()}.mp4`;
      await writeFile(outputPath, Buffer.from(await videoResponse.arrayBuffer()));
      return outputPath;
    }

    if (status.status === "failed" || status.status === "cancelled") {
      throw new Error(JSON.stringify(status));
    }

    await Bun.sleep(5000);
  }

  throw new Error(`Timed out waiting for video job ${jobId}`);
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
  if (!MODELS.includes(inputModel as ChatModel)) {
    console.log("Unknown model. Available models:");
    for (const model of MODELS) {
      console.log(`  ${model}`);
    }
    return;
  }

  currentModel = inputModel as ChatModel;
  console.log(`model: ${currentModel}`);
}

async function main() {
  console.log("Tenstorrent CLI");
  console.log(`model: ${currentModel}`);
  console.log("Type /help for commands.");

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
