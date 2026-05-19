import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modelDir = resolve(root, "src-tauri/models");

const models = [
  {
    path: "msd-musicnn-1.onnx",
    url: "https://essentia.upf.edu/models/feature-extractors/musicnn/msd-musicnn-1.onnx",
    sha256: "49668ffec47e52e94b96f45930bb46a28a1368d4bdfb5c05378fa834aca616e1",
  },
  {
    path: "msd-musicnn-1.json",
    url: "https://essentia.upf.edu/models/feature-extractors/musicnn/msd-musicnn-1.json",
    sha256: "8e6b3b509f0610c0e65dce467fd459d6777509388eaddb13ed138d8ac1341ffe",
  },
];

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

async function download(url, target) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  await pipeline(response.body, createWriteStream(target));
}

async function ensureModel(model) {
  const target = resolve(modelDir, model.path);
  if (await exists(target)) {
    const actual = await sha256(target);
    if (actual === model.sha256) {
      console.log(`model ok: ${model.path}`);
      return;
    }
    console.warn(`model checksum mismatch, re-downloading: ${model.path}`);
  }

  const temp = `${target}.tmp`;
  await rm(temp, { force: true });
  console.log(`downloading model: ${model.path}`);
  await download(model.url, temp);

  const actual = await sha256(temp);
  if (actual !== model.sha256) {
    await rm(temp, { force: true });
    throw new Error(`Checksum mismatch for ${model.path}: expected ${model.sha256}, got ${actual}`);
  }

  await rename(temp, target);
}

await mkdir(modelDir, { recursive: true });
for (const model of models) {
  await ensureModel(model);
}
