import {
  CheckCircle2,
  Download,
  FileVideo,
  LoaderCircle,
  RotateCcw,
  Scissors,
  SlidersHorizontal,
  UploadCloud,
  WandSparkles,
  X,
  XCircle
} from "lucide-react";
import { ChangeEvent, DragEvent, useEffect, useId, useRef, useState } from "react";

type JobStatus = "uploaded" | "queued" | "analyzing" | "rendering" | "completed" | "failed";

type CutSegment = {
  start: number;
  end: number;
  duration: number;
  reason: string;
};

type Job = {
  id: string;
  filename: string;
  status: JobStatus;
  progress: number;
  message: string;
  duration?: number;
  cleaned_duration?: number;
  cuts: CutSegment[];
  ai_notes?: string[];
  error?: string;
  render_version?: number;
  source_url?: string;
  preview_url?: string;
  download_urls?: Record<"mp4" | "mov", string>;
};

type Settings = {
  silenceThresholdDb: number;
  minSilenceSec: number;
  keepSilenceSec: number;
  enableTranscription: boolean;
  enableAiCleanup: boolean;
};

type Health = {
  ok: boolean;
  ffmpeg: boolean;
  ffprobe: boolean;
  dialogue_cleanup: boolean;
};

type CleanupMode = {
  id: "soft" | "balanced" | "strong";
  label: string;
  badge: string;
  description: string;
  settings: Pick<Settings, "silenceThresholdDb" | "minSilenceSec" | "keepSilenceSec">;
};

type ExportFormat = "mp4" | "mov";

const initialSettings: Settings = {
  silenceThresholdDb: -35,
  minSilenceSec: 0.45,
  keepSilenceSec: 0.12,
  enableTranscription: false,
  enableAiCleanup: false
};

const activeStatuses: JobStatus[] = ["queued", "analyzing", "rendering"];
const maxQualityCrf = 12;
const apiBaseUrl = getApiBaseUrl();

const cleanupModes: CleanupMode[] = [
  {
    id: "soft",
    label: "Suave",
    badge: "Cuida palabras",
    description: "Menos cortes",
    settings: { silenceThresholdDb: -42, minSilenceSec: 0.65, keepSilenceSec: 0.18 }
  },
  {
    id: "balanced",
    label: "Normal",
    badge: "Recomendado",
    description: "Buen balance",
    settings: { silenceThresholdDb: -35, minSilenceSec: 0.45, keepSilenceSec: 0.12 }
  },
  {
    id: "strong",
    label: "Fuerte",
    badge: "Mas rapido",
    description: "Quita mas pausas",
    settings: { silenceThresholdDb: -30, minSilenceSec: 0.3, keepSilenceSec: 0.08 }
  }
];

export function App() {
  const [settings, setSettings] = useState<Settings>(initialSettings);
  const [file, setFile] = useState<File | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [localSourceUrl, setLocalSourceUrl] = useState<string | null>(null);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("mp4");
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportError, setExportError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const isProcessing = job ? activeStatuses.includes(job.status) : false;
  const isBusy = isUploading || isProcessing;
  const activeCleanupMode = getCleanupMode(settings);
  const progressValue = Math.round((job?.progress ?? (isUploading ? 0.04 : 0)) * 100);
  const canProcess = Boolean(job && !isBusy);
  const canExport = job?.status === "completed";
  const beforeVideoUrl = job?.source_url ? apiUrl(job.source_url) : localSourceUrl;
  const afterVideoUrl = job?.status === "completed" && job.preview_url ? apiUrl(job.preview_url) : undefined;
  const exportProgressPercent = Math.round(exportProgress * 100);
  const showExportProgress = isExporting || exportProgress > 0 || Boolean(exportError);
  const isExportProgressIndeterminate = isExporting && exportProgress <= 0.08;
  const cleanedDuration = job?.cleaned_duration ?? 0;
  const originalDuration = job?.duration ?? 0;
  const removedDuration =
    originalDuration > 0 && cleanedDuration > 0 ? Math.max(0, originalDuration - cleanedDuration) : undefined;
  const hasStatusPanel = Boolean(uploadError || job?.error) || isProcessing || job?.status === "failed";
  const runButtonCopy =
    job?.status === "completed"
      ? "Reprocesar con estos ajustes"
      : job?.status === "failed"
        ? "Reintentar limpieza"
        : "Ejecutar limpieza";

  useEffect(() => {
    if (!job || !activeStatuses.includes(job.status)) return;
    const timer = window.setInterval(async () => {
      try {
        const next = await fetchJob(job.id);
        setJob(next);
      } catch (error) {
        setUploadError(error instanceof Error ? error.message : "No pude actualizar el progreso.");
      }
    }, 900);
    return () => window.clearInterval(timer);
  }, [job]);

  useEffect(() => {
    fetch(apiUrl("/api/health"))
      .then((response) => parseResponse<Health>(response))
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  useEffect(() => {
    if (!file) {
      setLocalSourceUrl(null);
      return;
    }

    const url = URL.createObjectURL(file);
    setLocalSourceUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    if (!canExport) setIsExportModalOpen(false);
  }, [canExport]);

  async function submitFile(nextFile: File) {
    setFile(nextFile);
    setJob(null);
    setUploadError(null);
    setIsExportModalOpen(false);
    setIsExporting(false);
    setExportProgress(0);
    setExportError(null);
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", nextFile);

      const response = await fetch(apiUrl("/api/jobs"), {
        method: "POST",
        body: formData
      });
      const payload = await parseResponse<Job>(response);
      setJob(payload);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "No pude subir el video.");
    } finally {
      setIsUploading(false);
    }
  }

  async function processCurrentJob() {
    if (!job || isBusy) return;
    setUploadError(null);

    try {
      const formData = new FormData();
      formData.append("silence_threshold_db", String(settings.silenceThresholdDb));
      formData.append("min_silence_sec", String(settings.minSilenceSec));
      formData.append("keep_silence_sec", String(settings.keepSilenceSec));
      formData.append("crf", String(maxQualityCrf));
      formData.append("enable_transcription", String(settings.enableTranscription));
      formData.append("enable_ai_cleanup", String(settings.enableAiCleanup));

      const response = await fetch(apiUrl(`/api/jobs/${job.id}/process`), {
        method: "POST",
        body: formData
      });
      const payload = await parseResponse<Job>(response);
      setJob(payload);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "No pude ejecutar la limpieza.");
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    if (isBusy) return;
    const nextFile = event.dataTransfer.files?.[0];
    if (nextFile) void submitFile(nextFile);
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const nextFile = event.target.files?.[0];
    if (nextFile) void submitFile(nextFile);
  }

  function reset() {
    setFile(null);
    setJob(null);
    setUploadError(null);
    setIsExportModalOpen(false);
    setIsExporting(false);
    setExportProgress(0);
    setExportError(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  function applyCleanupMode(mode: CleanupMode) {
    setSettings((current) => ({ ...current, ...mode.settings }));
  }

  function openExportModal() {
    if (!canExport) return;
    setExportError(null);
    setExportProgress(0);
    setIsExportModalOpen(true);
  }

  function closeExportModal() {
    if (isExporting) return;
    setIsExportModalOpen(false);
    setExportError(null);
  }

  function startExport() {
    if (!job || !canExport || isExporting) return;

    setExportError(null);
    setExportProgress(0.08);
    setIsExporting(true);

    const request = new XMLHttpRequest();
    request.open("GET", apiUrl(`/api/jobs/${job.id}/download?format=${exportFormat}`));
    request.responseType = "blob";

    request.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        setExportProgress(Math.max(0.08, Math.min(0.98, event.loaded / event.total)));
        return;
      }
      setExportProgress((current) => (current >= 0.82 ? current : current + 0.08));
    };

    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        downloadBlob(request.response as Blob, getExportFilename(job.filename, exportFormat));
        setExportProgress(1);
        window.setTimeout(() => {
          setIsExporting(false);
          setIsExportModalOpen(false);
          setExportProgress(0);
        }, 450);
        return;
      }

      setIsExporting(false);
      setExportError("No pude exportar el video.");
    };

    request.onerror = () => {
      setIsExporting(false);
      setExportError("No pude exportar el video.");
    };

    request.send();
  }

  if (!job) {
    return (
      <main
        className={`empty-shell ${isDragging ? "is-dragging" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          if (!isUploading) setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
      >
        <p className="eyebrow">Limpiador de video</p>
        <h1>Auto Video Cleaner</h1>
        <input
          ref={inputRef}
          className="file-input"
          type="file"
          accept="video/mp4,video/quicktime,video/x-m4v,video/webm,video/x-matroska"
          onChange={handleFileChange}
          disabled={isUploading}
        />
        <button
          className="empty-upload-button"
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={isUploading}
        >
          {isUploading ? <LoaderCircle className="spin" size={22} /> : <UploadCloud size={22} />}
          {isUploading ? "Subiendo video..." : "Subir video"}
        </button>
        {isUploading && (
          <div className="empty-progress" aria-label="Importando video">
            <div className="progress-track is-indeterminate">
              <span />
            </div>
          </div>
        )}
        {uploadError && <p className="empty-error">{uploadError}</p>}
      </main>
    );
  }

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">Limpiador de video</p>
          <h1>Auto Video Cleaner</h1>
        </div>
        <div className="topbar-actions">
          <button
            className="export-trigger"
            type="button"
            onClick={openExportModal}
            disabled={!canExport || isExporting}
          >
            <Download size={18} />
            Exportar
          </button>
          <button
            className="icon-button"
            onClick={reset}
            disabled={isExporting}
            aria-label="Reiniciar flujo"
            title="Reiniciar"
          >
            <RotateCcw size={18} />
          </button>
        </div>
      </section>

      <section className="video-comparison" aria-label="Comparacion de video">
        <VideoPanel
          title="Antes"
          src={beforeVideoUrl}
          emptyText={isUploading ? "Subiendo video" : "Sube un video para verlo aqui"}
        />
        <VideoPanel
          title="Despues"
          src={afterVideoUrl}
          emptyText={isBusy ? "Procesando limpieza" : "Ejecuta limpieza para ver resultado"}
        />
      </section>

      <section className="editor-workspace">
        <div className="tool-column">
          <div
            className={`dropzone ${isDragging ? "is-dragging" : ""} ${isBusy ? "is-busy" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            role="button"
            tabIndex={0}
            onClick={() => {
              if (!isBusy) inputRef.current?.click();
            }}
            onKeyDown={(event) => {
              if (!isBusy && (event.key === "Enter" || event.key === " ")) inputRef.current?.click();
            }}
          >
            <input
              ref={inputRef}
              className="file-input"
              type="file"
              accept="video/mp4,video/quicktime,video/x-m4v,video/webm,video/x-matroska"
              onChange={handleFileChange}
              disabled={isBusy}
            />
            <div className="drop-icon">
              {isBusy ? <LoaderCircle className="spin" size={28} /> : <UploadCloud size={30} />}
            </div>
            <div>
              <strong>{file ? file.name : "Sube o cambia el video"}</strong>
              <span>Arrastra aqui o haz click</span>
            </div>
          </div>

          <div className="panel controls-panel">
            <div className="panel-title">
              <SlidersHorizontal size={17} />
              <h2>Ajustes de limpieza</h2>
            </div>

            <section className="control-section">
              <div className="control-heading">
                <span>Corte de pausas</span>
                <strong>{activeCleanupMode?.badge ?? "Manual"}</strong>
              </div>
              <div className="preset-grid">
                {cleanupModes.map((mode) => (
                  <button
                    key={mode.id}
                    className={`preset-button ${activeCleanupMode?.id === mode.id ? "is-selected" : ""}`}
                    type="button"
                    onClick={() => applyCleanupMode(mode)}
                    disabled={isBusy}
                  >
                    <strong>{mode.label}</strong>
                    <span>{mode.description}</span>
                  </button>
                ))}
              </div>
            </section>

            <label className="toggle-card">
              <input
                type="checkbox"
                checked={settings.enableAiCleanup}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    enableAiCleanup: event.target.checked,
                    enableTranscription: event.target.checked
                  }))
                }
                disabled={isBusy}
              />
              <span>
                <span className="toggle-title">
                  <WandSparkles size={16} />
                  Limpiar muletillas
                </span>
                <small>Opcional, tarda mas.</small>
              </span>
            </label>
            {settings.enableAiCleanup && health?.dialogue_cleanup === false && (
              <p className="ai-warning">Whisper no esta instalado en este entorno.</p>
            )}

            <details className="advanced-settings">
              <summary>
                <SlidersHorizontal size={16} />
                Ajustes finos
              </summary>
              <div className="advanced-body">
                <Slider
                  label="Sensibilidad"
                  value={settings.silenceThresholdDb}
                  min={-60}
                  max={-20}
                  step={1}
                  suffix="dB"
                  hint="Mas alto corta mas."
                  onChange={(value) => setSettings((current) => ({ ...current, silenceThresholdDb: value }))}
                  disabled={isBusy}
                />
                <Slider
                  label="Pausa minima"
                  value={settings.minSilenceSec}
                  min={0.2}
                  max={2}
                  step={0.05}
                  suffix="s"
                  hint="Mas bajo detecta pausas mas cortas."
                  onChange={(value) => setSettings((current) => ({ ...current, minSilenceSec: value }))}
                  disabled={isBusy}
                />
                <Slider
                  label="Aire en cortes"
                  value={settings.keepSilenceSec}
                  min={0}
                  max={0.6}
                  step={0.02}
                  suffix="s"
                  hint="Mas alto deja cortes menos secos."
                  onChange={(value) => setSettings((current) => ({ ...current, keepSilenceSec: value }))}
                  disabled={isBusy}
                />
              </div>
            </details>

            <button className="run-button" type="button" onClick={processCurrentJob} disabled={!canProcess}>
              {isBusy ? <LoaderCircle className="spin" size={18} /> : <Scissors size={18} />}
              {isBusy ? "Procesando..." : runButtonCopy}
            </button>
          </div>
        </div>

        <div className="review-column">
          {hasStatusPanel && (
            <div className="status-panel">
              {job.status === "failed" ? (
                <div className="status-line">
                  <XCircle className="danger" size={18} />
                  <strong>{job.error ?? job.message}</strong>
                </div>
              ) : (
                <div className="status-line">
                  {job.status === "completed" ? (
                    <CheckCircle2 className="success" size={18} />
                  ) : (
                    <LoaderCircle className={isProcessing ? "spin" : ""} size={18} />
                  )}
                  <strong>{job.message}</strong>
                </div>
              )}
              {isProcessing && (
                <>
                  <div className="progress-track">
                    <span style={{ width: `${Math.max(0, Math.min(100, progressValue))}%` }} />
                  </div>
                  <div className="progress-meta">
                    <span>{statusCopy[job.status]}</span>
                    <span>{progressValue}%</span>
                  </div>
                </>
              )}
              {(uploadError || (job.error && job.status !== "failed")) && (
                <p className="error-text">{uploadError ?? job.error}</p>
              )}
            </div>
          )}

          <div className="metrics-panel">
            <div className="metric">
              <span>Original</span>
              <strong>{formatSeconds(originalDuration)}</strong>
            </div>
            <div className="metric">
              <span>Final</span>
              <strong>{formatSeconds(cleanedDuration || undefined)}</strong>
            </div>
            <div className="metric">
              <span>Recortado</span>
              <strong>{formatSeconds(removedDuration)}</strong>
            </div>
            <div className="metric">
              <span>Cortes</span>
              <strong>{job.cuts.length}</strong>
            </div>
          </div>

          <div className="cut-list">
            <div className="panel-title">
              <Scissors size={17} />
              <h2>Cortes detectados</h2>
            </div>
            {job.cuts.length ? (
              <ol>
                {job.cuts.slice(0, 16).map((cut, index) => (
                  <li key={`${cut.start}-${cut.end}-${index}`}>
                    <span>{cut.reason || "Silencio detectado"}</span>
                    <time>
                      {formatSeconds(cut.start)} - {formatSeconds(cut.end)}
                    </time>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted">
                {job.status === "completed" ? "No se detectaron silencios para cortar." : "Pendiente de procesar."}
              </p>
            )}
          </div>

          {job.ai_notes?.map((note) => (
            <p className="ai-note" key={note}>
              {note}
            </p>
          ))}
        </div>
      </section>

      {isExportModalOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={closeExportModal}>
          <section
            className="export-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="export-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <p className="eyebrow">Salida final</p>
                <h2 id="export-title">Exportar video</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                onClick={closeExportModal}
                disabled={isExporting}
                aria-label="Cerrar exportacion"
              >
                <X size={18} />
              </button>
            </div>

            <div className="modal-section">
              <span className="modal-label">Formato</span>
              <div className="segmented-control">
                {(["mp4", "mov"] as ExportFormat[]).map((format) => (
                  <button
                    key={format}
                    type="button"
                    className={exportFormat === format ? "is-selected" : ""}
                    onClick={() => setExportFormat(format)}
                    disabled={isExporting}
                  >
                    {format.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            <div className="export-summary">
              <span>Duracion final</span>
              <strong>{formatSeconds(job.cleaned_duration)}</strong>
              <span>Cortes aplicados</span>
              <strong>{job.cuts.length}</strong>
              <span>Salida</span>
              <strong>Maxima</strong>
            </div>

            {showExportProgress && (
              <div className="modal-progress" aria-label="Progreso de exportacion">
                <div className={`progress-track ${isExportProgressIndeterminate ? "is-indeterminate" : ""}`}>
                  <span
                    style={
                      isExportProgressIndeterminate
                        ? undefined
                        : { width: `${Math.max(0, Math.min(100, exportProgressPercent))}%` }
                    }
                  />
                </div>
                <div className="modal-progress-meta">
                  <span>{exportError ?? (isExporting ? "Exportando archivo" : "Exportacion lista")}</span>
                  {!exportError && <span>{exportProgressPercent}%</span>}
                </div>
              </div>
            )}

            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={closeExportModal} disabled={isExporting}>
                Cancelar
              </button>
              <button className="export-download" type="button" onClick={startExport} disabled={isExporting}>
                {isExporting ? <LoaderCircle className="spin" size={18} /> : <Download size={18} />}
                {isExporting ? "Exportando..." : "Descargar"}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function VideoPanel({ title, src, emptyText }: { title: string; src?: string | null; emptyText: string }) {
  return (
    <div className="video-panel">
      <div className="video-panel-header">
        <span>{title}</span>
      </div>
      <div className="video-stage">
        {src ? (
          <video className="preview-video" src={src} controls playsInline />
        ) : (
          <div className="empty-preview">
            <FileVideo size={38} />
            <span>{emptyText}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  suffix,
  hint,
  disabled,
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  hint: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const inputId = useId();

  return (
    <div className="slider-row">
      <div className="slider-heading">
        <label htmlFor={inputId}>{label}</label>
        <output htmlFor={inputId}>
          {formatSettingValue(value)}
          {suffix}
        </output>
      </div>
      <input
        id={inputId}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <p className="slider-hint">{hint}</p>
    </div>
  );
}

function getApiBaseUrl() {
  const fromQuery = new URLSearchParams(window.location.search).get("apiBaseUrl") ?? "";
  const fromEnv = import.meta.env.VITE_API_BASE_URL ?? "";
  return (fromQuery || fromEnv).replace(/\/+$/, "");
}

function apiUrl(path: string) {
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return apiBaseUrl ? `${apiBaseUrl}${normalizedPath}` : normalizedPath;
}

async function fetchJob(jobId: string): Promise<Job> {
  const response = await fetch(apiUrl(`/api/jobs/${jobId}`));
  return parseResponse<Job>(response);
}

async function parseResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.detail ?? "La peticion fallo.";
    throw new Error(message);
  }
  return payload as T;
}

function formatSeconds(value?: number) {
  if (value === undefined || value === null || Number.isNaN(value)) return "--";
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  const millis = Math.round((value - Math.floor(value)) * 10);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${millis}`;
}

function formatSettingValue(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function getExportFilename(filename: string, format: ExportFormat) {
  const baseName = filename.replace(/\.[^/.]+$/, "").trim() || "video";
  return `${baseName}-cleaned.${format}`;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function getCleanupMode(settings: Settings) {
  return cleanupModes.find(
    (mode) =>
      mode.settings.silenceThresholdDb === settings.silenceThresholdDb &&
      mode.settings.minSilenceSec === settings.minSilenceSec &&
      mode.settings.keepSilenceSec === settings.keepSilenceSec
  );
}

const statusCopy: Record<JobStatus, string> = {
  uploaded: "Cargado",
  queued: "En cola",
  analyzing: "Analizando",
  rendering: "Renderizando",
  completed: "Completado",
  failed: "Fallo"
};
