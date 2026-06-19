# Tenstorrent CLI

Tenstorrent CLI for `console.tenstorrent.com`: chat REPL plus Wan 2.2 text-to-video generation.

## Install

From this repository:

```bash
bun install
bun install -g .
```

Or, after package publication:

```bash
npm i -g tenstorrent-cli
```

## Authentication

Create a Tenstorrent Console account at `https://console.tenstorrent.com`, generate an API key, and export it:

```bash
export TENSTORRENT_KEY="your-api-key"
```

The CLI reads only `TENSTORRENT_KEY`; it does not read or store keys from files.

## Usage

```bash
tenstorrent
```

For local development:

```bash
bun run start
```

## Commands

```text
/help                         Show commands
/model                        Show current model and catalog
/model <id>                   Switch between DeepSeek-R1, Qwen3-32B, Qwen3-VL, and Gemma-4
/image <prompt> [--model id]  Generate an image and save under ./output
/video <prompt> [--model id]  Submit a Wan 2.2 video job, poll it, and save ./output/video-*.mp4
/tts <text> [--model id]      Generate speech if the endpoint is available
/stt <file>                   Transcribe audio if the endpoint is available
/clear                        Clear chat history
/exit                         Exit
```

Default chat model:

```text
Qwen/Qwen3-VL-32B-Instruct
```

Supported chat models:

```text
deepseek-ai/DeepSeek-R1-0528
Qwen/Qwen3-32B
Qwen/Qwen3-VL-32B-Instruct
google/gemma-4-31B-it
```

Unofficial community tool. Not affiliated with or endorsed by Tenstorrent Inc.

## License

MIT. See `LICENSE`.
