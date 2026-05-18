#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const CONFIG = {
  apiKey: process.env.OPENAI_API_KEY ?? process.env.GEMINI_API_KEY ?? "",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
  model: "gemini-3-flash-preview",
  clipSeconds: 8,
  clipOffsetSeconds: 25,
};

const ANALYSIS_PROMPT = [
  "Analyze the audio clip and describe the music in Japanese.",
  "Focus on genre/style, mood, energy, instrumentation, texture, and any notable rhythmic or harmonic traits.",
  "If the audio is ambiguous, say so instead of inventing details.",
  "Keep the answer concise and practical for choosing visual direction.",
].join(" ");

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    file: null,
    seconds: CONFIG.clipSeconds,
    offset: CONFIG.clipOffsetSeconds,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--seconds" && args[i + 1]) {
      options.seconds = Number(args[++i]);
      continue;
    }
    if (arg.startsWith("--seconds=")) {
      options.seconds = Number(arg.split("=", 2)[1]);
      continue;
    }
    if (arg === "--offset" && args[i + 1]) {
      options.offset = Number(args[++i]);
      continue;
    }
    if (arg.startsWith("--offset=")) {
      options.offset = Number(arg.split("=", 2)[1]);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsageAndExit(0);
    }
    if (!arg.startsWith("-") && !options.file) {
      options.file = arg;
    }
  }

  if (!options.file) printUsageAndExit(1);
  if (!Number.isFinite(options.seconds) || options.seconds <= 0) {
    throw new Error("--seconds must be a positive number");
  }
  if (!Number.isFinite(options.offset) || options.offset < 0) {
    throw new Error("--offset must be 0 or greater");
  }

  return options;
}

function printUsageAndExit(code) {
  console.log("Usage: node scripts/analyze_music.mjs <audio-file> [--seconds N] [--offset N]");
  process.exit(code);
}

function buildApiUrl(baseUrl, route) {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/v1")) return `${trimmed}/${route}`;
  return `${trimmed}/v1/${route}`;
}

function extractClipToWav(inputPath, seconds, offsetSeconds) {
  const tempDir = mkdtempSync(join(tmpdir(), "vjled-audio-"));
  const outputPath = join(tempDir, "clip.wav");
  try {
    const ffmpegArgs = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      String(offsetSeconds),
      "-t",
      String(seconds),
      "-i",
      inputPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "wav",
      outputPath,
    ];

    const result = spawnSync("ffmpeg", ffmpegArgs, { encoding: "utf8" });
    if (result.error) {
      throw new Error(`Failed to start ffmpeg: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const stderr = (result.stderr || "").trim();
      throw new Error(`ffmpeg failed: ${stderr || `exit code ${result.status}`}`);
    }

    return readFileSync(outputPath).toString("base64");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function extractTextFromResponse(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  if (Array.isArray(payload?.output)) {
    const pieces = [];
    for (const item of payload.output) {
      if (Array.isArray(item?.content)) {
        for (const part of item.content) {
          if (typeof part?.text === "string") pieces.push(part.text);
          if (typeof part?.output_text === "string") pieces.push(part.output_text);
          if (typeof part?.transcript === "string") pieces.push(part.transcript);
        }
      }
    }
    const text = pieces.join("\n").trim();
    if (text) return text;
  }

  if (Array.isArray(payload?.choices)) {
    const text = payload.choices
      .flatMap((choice) => {
        const content = choice?.message?.content;
        if (typeof content === "string") return [content];
        if (Array.isArray(content)) {
          return content.flatMap((part) => {
            if (typeof part?.text === "string") return [part.text];
            if (typeof part === "string") return [part];
            return [];
          });
        }
        return [];
      })
      .filter((content) => typeof content === "string" && content.trim())
      .join("\n")
      .trim();
    if (text) return text;
  }

  throw new Error("Could not extract text from the API response");
}

async function sendToModel(audioBase64, seconds) {
  if (!CONFIG.apiKey) {
    throw new Error("Set OPENAI_API_KEY or GEMINI_API_KEY before running");
  }

  const url = buildApiUrl(CONFIG.baseUrl, "chat/completions");
  const body = {
    model: CONFIG.model,
    messages: [
      {
        role: "system",
        content: "You analyze short music clips and describe their mood, style, and energy in Japanese. Be concise and factual.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: `${ANALYSIS_PROMPT}\nClip length: ${seconds} seconds.` },
          {
            type: "input_audio",
            input_audio: {
              data: audioBase64,
              format: "wav",
            },
          },
        ],
      },
    ],
    temperature: 0.2,
    max_tokens: 1500,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CONFIG.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`API error (${response.status} ${response.statusText}): ${raw}`);
  }

  const payload = JSON.parse(raw);
  return extractTextFromResponse(payload);
}

async function main() {
  const options = parseArgs(process.argv);
  const inputPath = resolve(options.file);

  if (!existsSync(inputPath)) {
    throw new Error(`Audio file not found: ${inputPath}`);
  }

  const audioBase64 = extractClipToWav(inputPath, options.seconds, options.offset);
  const text = await sendToModel(audioBase64, options.seconds);
  console.log(text);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
