import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = join(rootDir, "native", "bin");
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const require = createRequire(import.meta.url);

rmSync(outputDir, { force: true, recursive: true });
mkdirSync(outputDir, { recursive: true });

for (const binary of ["ffmpeg", "ffprobe"]) {
  const source = findBundledExecutable(binary) ?? findSystemExecutable(`${binary}${executableSuffix}`);
  if (!source) {
    console.warn(`No encontre ${binary} en PATH; el paquete usara el FFmpeg instalado en la maquina destino.`);
    continue;
  }

  const target = join(outputDir, basename(source));
  copyFileSync(source, target);
  if (process.platform !== "win32") chmodSync(target, 0o755);
  console.log(`Copiado ${binary}: ${source} -> ${target}`);
}

function findBundledExecutable(binary) {
  try {
    const installer = require(binary === "ffmpeg" ? "@ffmpeg-installer/ffmpeg" : "@ffprobe-installer/ffprobe");
    if (installer?.path && existsSync(installer.path) && statSync(installer.path).isFile()) {
      return installer.path;
    }
  } catch {
    return null;
  }
  return null;
}

function findSystemExecutable(name) {
  const command = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(command, [name], {
    encoding: "utf8",
    shell: false
  });

  if (result.status !== 0) return null;

  const candidates = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}
