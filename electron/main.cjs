const { app, BrowserWindow, dialog } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const isDev = process.argv.includes("--dev") || !app.isPackaged;

let mainWindow = null;
let serverProcess = null;
let serverPort = null;
let isQuitting = false;

app.whenReady().then(async () => {
  try {
    serverPort = await getFreePort();
    await startBackend(serverPort);
    await waitForHealth(serverPort);
    await createWindow(serverPort);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox("Auto Video Cleaner no pudo iniciar", message);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverPort !== null) {
    await createWindow(serverPort);
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  stopBackend();
});

async function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 920,
    minWidth: 1120,
    minHeight: 760,
    title: "Auto Video Cleaner",
    backgroundColor: "#0b0f14",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    if (!isQuitting && process.platform !== "darwin") app.quit();
  });

  const apiBaseUrl = `http://127.0.0.1:${port}`;
  if (isDev) {
    await waitForUrl("http://127.0.0.1:5173");
    await mainWindow.loadURL(`http://127.0.0.1:5173?apiBaseUrl=${encodeURIComponent(apiBaseUrl)}`);
    mainWindow.webContents.openDevTools({ mode: "detach" });
    return;
  }

  await mainWindow.loadURL(apiBaseUrl);
}

async function startBackend(port) {
  const env = {
    ...process.env,
    AUTO_VIDEO_CLEANER_DESKTOP: "1",
    AUTO_VIDEO_CLEANER_PORT: String(port),
    AUTO_VIDEO_CLEANER_DATA_DIR: path.join(app.getPath("userData"), "jobs"),
    AUTO_VIDEO_CLEANER_CLIENT_DIR: app.isPackaged
      ? path.join(process.resourcesPath, "client")
      : path.join(app.getAppPath(), "client", "dist"),
    PATH: buildBackendPath()
  };

  const command = isDev ? devPythonPath() : packagedServerPath();
  const args = isDev ? [path.join(app.getAppPath(), "server", "desktop_server.py")] : [];
  const cwd = isDev ? path.join(app.getAppPath(), "server") : path.dirname(command);

  serverProcess = spawn(command, args, {
    cwd,
    env,
    stdio: isDev ? "inherit" : ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  if (!isDev) {
    serverProcess.stdout?.on("data", (chunk) => console.log(`[server] ${chunk}`));
    serverProcess.stderr?.on("data", (chunk) => console.error(`[server] ${chunk}`));
  }

  serverProcess.on("exit", (code, signal) => {
    serverProcess = null;
    if (!isQuitting && mainWindow) {
      dialog.showErrorBox(
        "El servidor local se cerro",
        `El backend de Auto Video Cleaner termino con codigo ${code ?? "sin codigo"} (${signal ?? "sin senal"}).`
      );
      app.quit();
    }
  });
}

function stopBackend() {
  if (!serverProcess) return;

  const child = serverProcess;
  serverProcess = null;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"], { windowsHide: true });
    return;
  }
  child.kill("SIGTERM");
}

function packagedServerPath() {
  const executable = process.platform === "win32" ? "auto-video-cleaner-server.exe" : "auto-video-cleaner-server";
  return path.join(process.resourcesPath, "server", executable);
}

function devPythonPath() {
  const executable = process.platform === "win32" ? "python.exe" : "python";
  return path.join(app.getAppPath(), "server", ".venv", process.platform === "win32" ? "Scripts" : "bin", executable);
}

function buildBackendPath() {
  const bundledBinPath = app.isPackaged ? path.join(process.resourcesPath, "bin") : path.join(app.getAppPath(), "native", "bin");
  return [bundledBinPath, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("No pude reservar un puerto local para el backend.")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port) {
  await waitForUrl(`http://127.0.0.1:${port}/api/health`, 30000);
}

function waitForUrl(url, timeoutMs = 20000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const tick = () => {
      const request = http.get(url, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 500) {
          resolve();
          return;
        }
        retry();
      });

      request.on("error", retry);
      request.setTimeout(1200, () => {
        request.destroy();
        retry();
      });
    };

    const retry = () => {
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`Tiempo agotado esperando ${url}.`));
        return;
      }
      setTimeout(tick, 300);
    };

    tick();
  });
}
