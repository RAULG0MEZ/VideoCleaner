import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = path.join(rootDir, "server");
const pythonPath = path.join(
  serverDir,
  ".venv",
  process.platform === "win32" ? "Scripts" : "bin",
  process.platform === "win32" ? "python.exe" : "python"
);

if (!existsSync(pythonPath)) {
  throw new Error(`No encontre el Python virtual del backend en ${pythonPath}. Ejecuta la instalacion del README primero.`);
}

run(pythonPath, ["-m", "pip", "show", "pyinstaller"], {
  cwd: serverDir,
  allowFailure: true,
  onFailure() {
    run(pythonPath, ["-m", "pip", "install", "pyinstaller"], { cwd: serverDir });
  }
});

run(pythonPath, ["-m", "PyInstaller", "desktop_server.spec", "--noconfirm", "--clean"], {
  cwd: serverDir
});

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? rootDir,
    stdio: "inherit",
    shell: false
  });

  if (result.status === 0) return;
  if (options.allowFailure) {
    options.onFailure?.();
    return;
  }

  const rendered = [command, ...args].join(" ");
  throw new Error(`Fallo el comando: ${rendered}`);
}
