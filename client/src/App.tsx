import {
  CheckCircle2,
  Download,
  FileText,
  FileVideo,
  LoaderCircle,
  Redo2,
  RotateCcw,
  Scissors,
  SlidersHorizontal,
  Trash2,
  Undo2,
  UploadCloud,
  WandSparkles,
  X,
  XCircle
} from "lucide-react";
import {
  type CSSProperties,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState
} from "react";

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

type TranscriptWord = {
  text: string;
  normalized: string;
  start: number;
  end: number;
};

type Transcript = {
  available: boolean;
  language?: string;
  duration?: number;
  notes?: string[];
  words: TranscriptWord[];
  text_cuts?: CutSegment[];
};

type SelectionRange = {
  anchor: number;
  focus: number;
};

type PlaybackSource = "before" | "after";

type TranscriptPlayback = {
  source: PlaybackSource | null;
  originalTime: number;
  isPlaying: boolean;
};

type TranscriptBlock = {
  id: string;
  start: number;
  end: number;
  gapBefore: number;
  words: Array<{
    word: TranscriptWord;
    index: number;
  }>;
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
  enableTranscription: true,
  enableAiCleanup: false
};

const activeStatuses: JobStatus[] = ["queued", "analyzing", "rendering"];
const maxQualityCrf = 12;
const apiBaseUrl = getApiBaseUrl();
const playbackSources: PlaybackSource[] = ["before", "after"];
const textEntryInputTypes = new Set([
  "",
  "date",
  "datetime-local",
  "email",
  "month",
  "number",
  "password",
  "search",
  "tel",
  "text",
  "time",
  "url",
  "week"
]);

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
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [transcriptJobId, setTranscriptJobId] = useState<string | null>(null);
  const [isTranscriptLoading, setIsTranscriptLoading] = useState(false);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [textCutHistory, setTextCutHistory] = useState<CutSegment[][]>([[]]);
  const [textCutHistoryIndex, setTextCutHistoryIndex] = useState(0);
  const [appliedTextCuts, setAppliedTextCuts] = useState<CutSegment[]>([]);
  const [selectedTranscriptRange, setSelectedTranscriptRange] = useState<SelectionRange | null>(null);
  const [isSelectingTranscript, setIsSelectingTranscript] = useState(false);
  const [transcriptPlayback, setTranscriptPlayback] = useState<TranscriptPlayback>({
    source: null,
    originalTime: 0,
    isPlaying: false
  });
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("mp4");
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportError, setExportError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const videoRefs = useRef<Record<PlaybackSource, HTMLVideoElement | null>>({
    before: null,
    after: null
  });

  const isProcessing = job ? activeStatuses.includes(job.status) : false;
  const isBusy = isUploading || isProcessing;
  const activeCleanupMode = getCleanupMode(settings);
  const progressValue = Math.round((job?.progress ?? (isUploading ? 0.04 : 0)) * 100);
  const manualTextCuts = textCutHistory[textCutHistoryIndex] ?? [];
  const hasPendingTextCuts = !areCutListsEqual(manualTextCuts, appliedTextCuts);
  const canProcess = Boolean(job && !isBusy);
  const canExport = job?.status === "completed" && !hasPendingTextCuts;
  const beforeVideoUrl = job?.source_url ? apiUrl(job.source_url) : localSourceUrl;
  const afterVideoUrl = job?.status === "completed" && job.preview_url ? apiUrl(job.preview_url) : undefined;
  const exportProgressPercent = Math.round(exportProgress * 100);
  const showExportProgress = isExporting || exportProgress > 0 || Boolean(exportError);
  const isExportProgressIndeterminate = isExporting && exportProgress <= 0.08;
  const hasStatusPanel = Boolean(uploadError || job?.error) || isProcessing || job?.status === "failed";
  const canUndoTextEdit = textCutHistoryIndex > 0;
  const canRedoTextEdit = textCutHistoryIndex < textCutHistory.length - 1;
  const runButtonCopy =
    job?.status === "completed"
      ? "Reprocesar con estos ajustes"
      : job?.status === "failed"
        ? "Reintentar limpieza"
        : "Ejecutar limpieza";
  const registerVideo = useCallback((source: PlaybackSource, video: HTMLVideoElement | null) => {
    videoRefs.current[source] = video;
  }, []);

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
    if (!job || !settings.enableTranscription || transcriptJobId === job.id) return;
    let isCurrent = true;
    let retryTimer: number | undefined;
    let didRequestTranscription = false;
    setIsTranscriptLoading(true);
    setTranscriptError(null);

    async function loadTranscript() {
      try {
        const payload = await fetchTranscript(job!.id);
        if (!isCurrent) return;
        const textCuts = payload.text_cuts ?? [];
        setTranscript(payload);
        setTranscriptJobId(job!.id);
        setTextCutHistory([textCuts]);
        setTextCutHistoryIndex(0);
        setAppliedTextCuts(textCuts);
        setSelectedTranscriptRange(null);
        setIsTranscriptLoading(false);
      } catch (error) {
        if (!isCurrent) return;
        const canStartTranscription = job!.status === "uploaded" || job!.status === "completed" || job!.status === "failed";

        if (!didRequestTranscription && canStartTranscription) {
          didRequestTranscription = true;
          try {
            await startTranscript(job!.id);
          } catch (startError) {
            if (!isCurrent) return;
            setTranscript(null);
            setTranscriptError(startError instanceof Error ? startError.message : "No pude iniciar la transcripcion.");
            setIsTranscriptLoading(false);
            return;
          }
        }

        if (didRequestTranscription || activeStatuses.includes(job!.status)) {
          retryTimer = window.setTimeout(loadTranscript, 1200);
          return;
        }

        setTranscript(null);
        setTextCutHistory([[]]);
        setTextCutHistoryIndex(0);
        setAppliedTextCuts([]);
        setSelectedTranscriptRange(null);
        setTranscriptError(error instanceof Error ? error.message : "No pude cargar la transcripcion.");
        setIsTranscriptLoading(false);
      }
    }

    void loadTranscript();

    return () => {
      isCurrent = false;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [job?.id, job?.status, settings.enableTranscription, transcriptJobId]);

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
    if (!isSelectingTranscript) return;
    const stopSelecting = () => setIsSelectingTranscript(false);
    window.addEventListener("pointerup", stopSelecting);
    window.addEventListener("pointercancel", stopSelecting);
    return () => {
      window.removeEventListener("pointerup", stopSelecting);
      window.removeEventListener("pointercancel", stopSelecting);
    };
  }, [isSelectingTranscript]);

  useEffect(() => {
    if (!job || isExportModalOpen) return;

    function handleEditorKeyDown(event: globalThis.KeyboardEvent) {
      if (!isSpaceShortcut(event) || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
      if (shouldKeepSpaceForFocusedElement(event.target)) return;

      const didHandlePlayback = event.repeat
        ? Boolean(getPreferredPlaybackVideo(event.target))
        : toggleKeyboardPlayback(event.target);
      if (!didHandlePlayback) return;

      event.preventDefault();
      event.stopPropagation();
    }

    window.addEventListener("keydown", handleEditorKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleEditorKeyDown, { capture: true });
  }, [job, isExportModalOpen, transcriptPlayback.source]);

  useEffect(() => {
    if (!canExport) setIsExportModalOpen(false);
  }, [canExport]);

  async function submitFile(nextFile: File) {
    setFile(nextFile);
    setJob(null);
    setUploadError(null);
    resetTranscriptState();
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
      if (transcriptJobId === job.id) {
        formData.append("text_cuts", JSON.stringify(toEditableCutPayload(manualTextCuts)));
      }

      resetTranscriptState();
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
    resetTranscriptState();
    setIsExportModalOpen(false);
    setIsExporting(false);
    setExportProgress(0);
    setExportError(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  function applyCleanupMode(mode: CleanupMode) {
    setSettings((current) => ({ ...current, ...mode.settings }));
  }

  function resetTranscriptState() {
    setTranscript(null);
    setTranscriptJobId(null);
    setIsTranscriptLoading(false);
    setTranscriptError(null);
    setTextCutHistory([[]]);
    setTextCutHistoryIndex(0);
    setAppliedTextCuts([]);
    setSelectedTranscriptRange(null);
    setIsSelectingTranscript(false);
    setTranscriptPlayback({ source: null, originalTime: 0, isPlaying: false });
  }

  function handleVideoPlayback(source: PlaybackSource, currentTime: number, isPlaying: boolean) {
    if (isPlaying) pauseOtherPlayback(source);

    const originalTime =
      source === "after"
        ? mapRenderedTimeToOriginal(currentTime, job?.cuts ?? [], job?.duration ?? transcript?.duration)
        : Math.max(0, currentTime);

    setTranscriptPlayback({
      source,
      originalTime,
      isPlaying
    });
  }

  function pauseOtherPlayback(source: PlaybackSource) {
    playbackSources.forEach((otherSource) => {
      if (otherSource === source) return;
      const video = videoRefs.current[otherSource];
      if (video && !video.paused) video.pause();
    });
  }

  function toggleKeyboardPlayback(target: EventTarget | null) {
    const preferredPlayback = getPreferredPlaybackVideo(target);
    if (!preferredPlayback) return false;

    const { source, video } = preferredPlayback;
    if (video.paused || video.ended) {
      pauseOtherPlayback(source);
      if (video.ended) video.currentTime = 0;
      void video.play().catch(() => undefined);
      return true;
    }

    video.pause();
    return true;
  }

  function getPreferredPlaybackVideo(target: EventTarget | null) {
    const sourceFromTarget = getPlaybackSourceFromTarget(target);
    if (sourceFromTarget) {
      const video = videoRefs.current[sourceFromTarget];
      if (isPlayableVideo(video)) return { source: sourceFromTarget, video };
    }

    if (transcriptPlayback.source) {
      const video = videoRefs.current[transcriptPlayback.source];
      if (isPlayableVideo(video)) return { source: transcriptPlayback.source, video };
    }

    const playingSource = playbackSources.find((source) => {
      const video = videoRefs.current[source];
      return isPlayableVideo(video) && !video.paused && !video.ended;
    });
    if (playingSource) return { source: playingSource, video: videoRefs.current[playingSource]! };

    const afterVideo = videoRefs.current.after;
    if (isPlayableVideo(afterVideo)) return { source: "after" as const, video: afterVideo };

    const beforeVideo = videoRefs.current.before;
    if (isPlayableVideo(beforeVideo)) return { source: "before" as const, video: beforeVideo };

    return null;
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

  function startTranscriptSelection(index: number) {
    if (isBusy || isWordDeleted(transcript?.words[index], manualTextCuts)) return;
    setSelectedTranscriptRange({ anchor: index, focus: index });
    setIsSelectingTranscript(true);
  }

  function extendTranscriptSelection(index: number) {
    if (!isSelectingTranscript || isBusy) return;
    setSelectedTranscriptRange((current) => (current ? { ...current, focus: index } : { anchor: index, focus: index }));
  }

  function clearTranscriptSelection() {
    setSelectedTranscriptRange(null);
    setIsSelectingTranscript(false);
  }

  function deleteSelectedTranscript() {
    if (!transcript || !selectedTranscriptRange || isBusy) return;
    const [startIndex, endIndex] = normalizeRange(selectedTranscriptRange);
    const selectedWords = transcript.words
      .slice(startIndex, endIndex + 1)
      .filter((word) => !isWordDeleted(word, manualTextCuts));
    if (!selectedWords.length) return;

    const firstWord = selectedWords[0];
    const lastWord = selectedWords[selectedWords.length - 1];
    const selectedText = selectedWords.map((word) => word.text).join(" ").replace(/\s+/g, " ").trim();
    const start = Math.max(0, firstWord.start - 0.04);
    const end = lastWord.end + 0.04;
    commitTextCuts([
      ...manualTextCuts,
      {
        start,
        end,
        duration: Math.max(0, end - start),
        reason: `Texto eliminado: ${selectedText.slice(0, 120)}`
      }
    ]);
  }

  function undoTextEdit() {
    if (!canUndoTextEdit || isBusy) return;
    setTextCutHistoryIndex((current) => Math.max(0, current - 1));
    clearTranscriptSelection();
  }

  function redoTextEdit() {
    if (!canRedoTextEdit || isBusy) return;
    setTextCutHistoryIndex((current) => Math.min(textCutHistory.length - 1, current + 1));
    clearTranscriptSelection();
  }

  function commitTextCuts(nextCuts: CutSegment[]) {
    const nextHistory = [...textCutHistory.slice(0, textCutHistoryIndex + 1), nextCuts];
    setTextCutHistory(nextHistory);
    setTextCutHistoryIndex(nextHistory.length - 1);
    clearTranscriptSelection();
  }

  async function applyPendingTextCuts() {
    if (!job || !hasPendingTextCuts || isBusy) return;
    setUploadError(null);

    try {
      const response = await fetch(apiUrl(`/api/jobs/${job.id}/text-edits`), {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          cuts: toEditableCutPayload(manualTextCuts)
        })
      });
      const payload = await parseResponse<Job>(response);
      setAppliedTextCuts(manualTextCuts);
      setJob(payload);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "No pude aplicar los cortes por texto.");
    }
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
        <input
          ref={inputRef}
          className="file-input"
          type="file"
          accept="video/mp4,video/quicktime,video/x-m4v,video/webm,video/x-matroska"
          onChange={handleFileChange}
          disabled={isUploading}
        />
        <div
          className={`empty-dropzone ${isDragging ? "is-dragging" : ""} ${isUploading ? "is-busy" : ""}`}
          role="button"
          tabIndex={0}
          onClick={() => {
            if (!isUploading) inputRef.current?.click();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            if (!isUploading) inputRef.current?.click();
          }}
        >
          <AppBrand centered />
          <div className="drop-copy">
            <strong>{isUploading ? "Subiendo video..." : "Arrastra tu video aqui"}</strong>
            <span>o haz click para subirlo manualmente</span>
          </div>
          <span className="manual-upload-pill">{isUploading ? "Importando" : "Elegir archivo"}</span>
          <small>MP4, MOV, M4V, MKV o WEBM</small>
        </div>
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
        <AppBrand />
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
          playbackSource="before"
          onVideoMount={registerVideo}
          onPlaybackChange={handleVideoPlayback}
        />
        <VideoPanel
          title="Despues"
          src={afterVideoUrl}
          emptyText={isBusy ? "Procesando limpieza" : "Ejecuta limpieza para ver resultado"}
          playbackSource="after"
          onVideoMount={registerVideo}
          onPlaybackChange={handleVideoPlayback}
        />
      </section>

      <section className="editor-workspace">
        <div className="tool-column">
          <div
            className={`dropzone ${file ? "has-file" : ""} ${isDragging ? "is-dragging" : ""} ${isBusy ? "is-busy" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              if (!isBusy) setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            role="button"
            tabIndex={0}
            onClick={() => {
              if (!isBusy) inputRef.current?.click();
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              if (!isBusy) inputRef.current?.click();
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
            <div className="drop-copy">
              <strong>{file ? file.name : "Arrastra tu video aqui"}</strong>
              <span>{file ? "Arrastra otro video o elige uno manualmente" : "o haz click para subirlo manualmente"}</span>
            </div>
            <span className="manual-upload-pill">{file ? "Cambiar video" : "Elegir archivo"}</span>
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
                checked={settings.enableTranscription}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    enableTranscription: event.target.checked
                  }))
                }
                disabled={isBusy || settings.enableAiCleanup}
              />
              <span>
                <span className="toggle-title">
                  <FileText size={16} />
                  Transcripcion
                </span>
                <small>Muestra lo dicho con timestamps.</small>
              </span>
            </label>
            {settings.enableTranscription && health?.dialogue_cleanup === false && (
              <p className="ai-warning">Whisper no esta instalado en este entorno.</p>
            )}

            <label className="toggle-card">
              <input
                type="checkbox"
                checked={settings.enableAiCleanup}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    enableAiCleanup: event.target.checked,
                    enableTranscription: event.target.checked ? true : current.enableTranscription
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

          {settings.enableTranscription && (
            <TranscriptPanel
              transcript={transcript}
              isLoading={isTranscriptLoading || (isProcessing && settings.enableTranscription)}
              error={transcriptError}
              jobStatus={job.status}
              health={health}
              selectedRange={selectedTranscriptRange}
              manualCuts={manualTextCuts}
              playbackTime={transcriptPlayback.source ? transcriptPlayback.originalTime : null}
              playbackSource={transcriptPlayback.source}
              isPlaybackActive={transcriptPlayback.source !== null}
              isPlaybackRunning={transcriptPlayback.isPlaying}
              hasPendingCuts={hasPendingTextCuts}
              canUndo={canUndoTextEdit}
              canRedo={canRedoTextEdit}
              isBusy={isBusy}
              onWordPointerDown={startTranscriptSelection}
              onWordPointerEnter={extendTranscriptSelection}
              onClearSelection={clearTranscriptSelection}
              onDeleteSelected={deleteSelectedTranscript}
              onApplyCuts={() => void applyPendingTextCuts()}
              onUndo={undoTextEdit}
              onRedo={redoTextEdit}
            />
          )}

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

function AppBrand({ centered = false }: { centered?: boolean }) {
  return (
    <div className={`app-brand ${centered ? "is-centered" : ""}`}>
      <span className="app-logo" aria-hidden="true">
        <img src="/app-icon.svg?v=mic-clean-v3" alt="" />
      </span>
      <div>
        <p className="eyebrow">Limpiador de video</p>
        <h1>Auto Video Cleaner</h1>
      </div>
    </div>
  );
}

function TranscriptPanel({
  transcript,
  isLoading,
  error,
  jobStatus,
  health,
  selectedRange,
  manualCuts,
  playbackTime,
  playbackSource,
  isPlaybackActive,
  isPlaybackRunning,
  hasPendingCuts,
  canUndo,
  canRedo,
  isBusy,
  onWordPointerDown,
  onWordPointerEnter,
  onClearSelection,
  onDeleteSelected,
  onApplyCuts,
  onUndo,
  onRedo
}: {
  transcript: Transcript | null;
  isLoading: boolean;
  error: string | null;
  jobStatus: JobStatus;
  health: Health | null;
  selectedRange: SelectionRange | null;
  manualCuts: CutSegment[];
  playbackTime: number | null;
  playbackSource: PlaybackSource | null;
  isPlaybackActive: boolean;
  isPlaybackRunning: boolean;
  hasPendingCuts: boolean;
  canUndo: boolean;
  canRedo: boolean;
  isBusy: boolean;
  onWordPointerDown: (index: number) => void;
  onWordPointerEnter: (index: number) => void;
  onClearSelection: () => void;
  onDeleteSelected: () => void;
  onApplyCuts: () => void;
  onUndo: () => void;
  onRedo: () => void;
}) {
  const words = transcript?.words ?? [];
  const blocks = buildTranscriptBlocks(words);
  const activeWordRef = useRef<HTMLButtonElement | null>(null);
  const selectedBounds = selectedRange ? normalizeRange(selectedRange) : null;
  const selectedWords = selectedBounds
    ? words.slice(selectedBounds[0], selectedBounds[1] + 1).filter((word) => !isWordDeleted(word, manualCuts))
    : [];
  const deletedWordCount = words.filter((word) => isWordDeleted(word, manualCuts)).length;
  const pendingCutSeconds = mergeCutRanges(manualCuts).reduce((total, cut) => total + Math.max(0, cut.end - cut.start), 0);
  const selectedStart = selectedWords[0]?.start;
  const selectedEnd = selectedWords[selectedWords.length - 1]?.end;
  const hasWords = words.length > 0;
  const notes = transcript?.notes ?? [];
  const activeWordIndex = getActiveTranscriptWordIndex(words, playbackTime);
  const playbackLabel = playbackSource === "after" ? "Despues" : playbackSource === "before" ? "Antes" : null;
  const emptyCopy =
    error ??
    (health?.dialogue_cleanup === false
      ? "Whisper no esta instalado en este entorno."
      : jobStatus === "completed"
        ? "No hay transcripcion para mostrar."
        : "Pendiente de procesar.");

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const key = event.key.toLowerCase();
    if ((key === "delete" || key === "backspace") && selectedWords.length && !isBusy) {
      event.preventDefault();
      onDeleteSelected();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && key === "z" && !isBusy) {
      event.preventDefault();
      if (event.shiftKey) {
        if (canRedo) onRedo();
      } else if (canUndo) {
        onUndo();
      }
      return;
    }
    if (key === "escape") {
      onClearSelection();
    }
  }

  useEffect(() => {
    if (!isPlaybackRunning || activeWordIndex < 0) return;
    activeWordRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeWordIndex, isPlaybackRunning]);

  return (
    <div className="transcript-panel">
      <div className="transcript-header">
        <div className="panel-title">
          <FileText size={17} />
          <h2>Transcripcion</h2>
        </div>
        <div className="transcript-actions" aria-label="Acciones de transcripcion">
          <button className="tool-button" type="button" onClick={onUndo} disabled={!canUndo || isBusy} title="Deshacer">
            <Undo2 size={16} />
          </button>
          <button className="tool-button" type="button" onClick={onRedo} disabled={!canRedo || isBusy} title="Rehacer">
            <Redo2 size={16} />
          </button>
          <button
            className="tool-button danger-tool"
            type="button"
            onClick={onDeleteSelected}
            disabled={!selectedWords.length || isBusy}
            title="Eliminar seleccion"
          >
            <Trash2 size={16} />
            <span>Eliminar</span>
          </button>
          <button
            className="tool-button apply-tool"
            type="button"
            onClick={onApplyCuts}
            disabled={!hasPendingCuts || isBusy}
            title="Aplicar cortes al video"
          >
            {isBusy ? <LoaderCircle className="spin" size={16} /> : <Scissors size={16} />}
            <span>Aplicar cortes</span>
          </button>
        </div>
      </div>

      <div className="transcript-meta">
        <span>{hasWords ? `${words.length} palabras` : isLoading ? "Transcribiendo" : emptyCopy}</span>
        {playbackLabel && playbackTime !== null && <span>Karaoke {playbackLabel}: {formatSeconds(playbackTime)}</span>}
        {deletedWordCount > 0 && <span>{deletedWordCount} borradas</span>}
        {deletedWordCount > 0 && <span>{formatSeconds(pendingCutSeconds)} marcado</span>}
        {hasPendingCuts && <span>Pendiente de aplicar</span>}
        {selectedWords.length > 0 && selectedStart !== undefined && selectedEnd !== undefined && (
          <span>
            {selectedWords.length} seleccionadas · {formatSeconds(selectedStart)} - {formatSeconds(selectedEnd)}
          </span>
        )}
      </div>

      <div
        className="transcript-surface"
        aria-label="Transcripcion"
        aria-readonly="true"
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        {isLoading && !hasWords ? (
          <div className="transcript-empty">
            <LoaderCircle className="spin" size={22} />
            <span>Transcribiendo</span>
          </div>
        ) : hasWords ? (
          blocks.map((block) => (
            <div
              className={`dialogue-row ${block.gapBefore >= 1.2 ? "has-paragraph-gap" : ""} ${
                block.words.some(({ index }) => index === activeWordIndex) ? "is-current-line" : ""
              }`}
              key={block.id}
            >
              <time className="dialogue-time">{formatSeconds(block.start)}</time>
              <p className="dialogue-text">
                {block.words.map(({ word, index }) => {
                  const isSelected = selectedBounds ? index >= selectedBounds[0] && index <= selectedBounds[1] : false;
                  const isDeleted = isWordDeleted(word, manualCuts);
                  const isCurrent = isPlaybackActive && activeWordIndex === index && !isDeleted;
                  const isPlayed = playbackTime !== null && word.end < playbackTime && !isDeleted;
                  const wordStyle = isCurrent
                    ? ({ "--word-progress": `${getWordProgressPercent(word, playbackTime)}%` } as CSSProperties)
                    : undefined;
                  return (
                    <span className="transcript-token" key={`${word.start}-${word.end}-${index}`}>
                      <button
                        ref={isCurrent ? activeWordRef : undefined}
                        className={`transcript-word ${isPlayed ? "is-played" : ""} ${isCurrent ? "is-current" : ""} ${
                          isSelected ? "is-selected" : ""
                        } ${isDeleted ? "is-deleted" : ""}`}
                        type="button"
                        disabled={isDeleted || isBusy}
                        aria-pressed={isSelected}
                        title={`${formatSeconds(word.start)} - ${formatSeconds(word.end)}`}
                        style={wordStyle}
                        onPointerDown={(event) => {
                          event.preventDefault();
                          onWordPointerDown(index);
                        }}
                        onPointerEnter={() => onWordPointerEnter(index)}
                      >
                        {word.text}
                      </button>{" "}
                    </span>
                  );
                })}
              </p>
            </div>
          ))
        ) : (
          <p className="muted">{emptyCopy}</p>
        )}
      </div>

      {notes.map((note) => (
        <p className="ai-note" key={note}>
          {note}
        </p>
      ))}
    </div>
  );
}

function VideoPanel({
  title,
  src,
  emptyText,
  playbackSource,
  onVideoMount,
  onPlaybackChange
}: {
  title: string;
  src?: string | null;
  emptyText: string;
  playbackSource: PlaybackSource;
  onVideoMount: (source: PlaybackSource, video: HTMLVideoElement | null) => void;
  onPlaybackChange: (source: PlaybackSource, currentTime: number, isPlaying: boolean) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const lastReportRef = useRef(0);

  useEffect(() => stopPlaybackLoop, []);

  useEffect(() => {
    onVideoMount(playbackSource, videoRef.current);
    return () => onVideoMount(playbackSource, null);
  }, [onVideoMount, playbackSource, src]);

  function stopPlaybackLoop() {
    if (frameRef.current === null) return;
    window.cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }

  function reportPlayback(video: HTMLVideoElement, isPlaying: boolean) {
    onPlaybackChange(playbackSource, video.currentTime, isPlaying);
  }

  function startPlaybackLoop(video: HTMLVideoElement) {
    stopPlaybackLoop();
    reportPlayback(video, true);
    lastReportRef.current = 0;

    const tick = (timestamp: number) => {
      const currentVideo = videoRef.current;
      if (!currentVideo || currentVideo.paused || currentVideo.ended) {
        stopPlaybackLoop();
        return;
      }

      if (timestamp - lastReportRef.current >= 80) {
        reportPlayback(currentVideo, true);
        lastReportRef.current = timestamp;
      }

      frameRef.current = window.requestAnimationFrame(tick);
    };

    frameRef.current = window.requestAnimationFrame(tick);
  }

  return (
    <div className="video-panel" data-playback-source={playbackSource}>
      <div className="video-panel-header">
        <span>{title}</span>
      </div>
      <div className="video-stage">
        {src ? (
          <video
            ref={videoRef}
            className="preview-video"
            src={src}
            controls
            playsInline
            onPlay={(event) => startPlaybackLoop(event.currentTarget)}
            onTimeUpdate={(event) => reportPlayback(event.currentTarget, !event.currentTarget.paused)}
            onPause={(event) => {
              stopPlaybackLoop();
              reportPlayback(event.currentTarget, false);
            }}
            onEnded={(event) => {
              stopPlaybackLoop();
              reportPlayback(event.currentTarget, false);
            }}
            onSeeked={(event) => reportPlayback(event.currentTarget, !event.currentTarget.paused)}
          />
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

function isSpaceShortcut(event: globalThis.KeyboardEvent) {
  return event.code === "Space" || event.key === " " || event.key === "Spacebar";
}

function shouldKeepSpaceForFocusedElement(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;

  const contentEditableElement = target.closest("[contenteditable]");
  if (contentEditableElement instanceof HTMLElement && contentEditableElement.isContentEditable) return true;

  const nativeSpaceElement = target.closest(
    "input, textarea, select, [role='textbox'], [role='searchbox'], [role='combobox'], [data-editor-space='native']"
  );
  if (!nativeSpaceElement) return false;

  if (nativeSpaceElement instanceof HTMLTextAreaElement || nativeSpaceElement instanceof HTMLSelectElement) return true;
  if (nativeSpaceElement instanceof HTMLInputElement) {
    return textEntryInputTypes.has(nativeSpaceElement.type.toLowerCase());
  }

  return true;
}

function getPlaybackSourceFromTarget(target: EventTarget | null): PlaybackSource | null {
  if (!(target instanceof Element)) return null;

  const sourceElement = target.closest("[data-playback-source]");
  if (!(sourceElement instanceof HTMLElement)) return null;

  const source = sourceElement.dataset.playbackSource;
  return source === "before" || source === "after" ? source : null;
}

function isPlayableVideo(video: HTMLVideoElement | null): video is HTMLVideoElement {
  return Boolean(video && (video.currentSrc || video.src));
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

async function fetchTranscript(jobId: string): Promise<Transcript> {
  const response = await fetch(apiUrl(`/api/jobs/${jobId}/transcript`));
  return parseResponse<Transcript>(response);
}

async function startTranscript(jobId: string): Promise<void> {
  const response = await fetch(apiUrl(`/api/jobs/${jobId}/transcribe`), {
    method: "POST"
  });
  await parseResponse<{ status: string }>(response);
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

function toEditableCutPayload(cuts: CutSegment[]) {
  return cuts.map((cut) => ({
    start: cut.start,
    end: cut.end,
    reason: cut.reason
  }));
}

function buildTranscriptBlocks(words: TranscriptWord[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  let current: TranscriptBlock | null = null;

  words.forEach((word, index) => {
    const previous = words[index - 1];
    const gapBefore = previous ? Math.max(0, word.start - previous.end) : 0;
    const currentLength = current?.words.length ?? 0;
    const sentenceBreak = previous ? /[.!?]$/.test(previous.text.trim()) : false;
    const shouldStartBlock =
      !current || gapBefore >= 0.65 || (gapBefore >= 0.28 && currentLength >= 16) || (sentenceBreak && currentLength >= 9);

    if (shouldStartBlock) {
      current = {
        id: `${word.start}-${index}`,
        start: word.start,
        end: word.end,
        gapBefore,
        words: []
      };
      blocks.push(current);
    }

    current!.words.push({ word, index });
    current!.end = word.end;
  });

  return blocks;
}

function normalizeRange(range: SelectionRange): [number, number] {
  return [Math.min(range.anchor, range.focus), Math.max(range.anchor, range.focus)];
}

function isWordDeleted(word: TranscriptWord | undefined, cuts: CutSegment[]) {
  if (!word) return false;
  return cuts.some((cut) => word.start < cut.end && word.end > cut.start);
}

function getActiveTranscriptWordIndex(words: TranscriptWord[], playbackTime: number | null) {
  if (playbackTime === null) return -1;
  return words.findIndex((word) => playbackTime >= word.start && playbackTime <= word.end);
}

function getWordProgressPercent(word: TranscriptWord, playbackTime: number | null) {
  if (playbackTime === null) return 0;
  const duration = Math.max(0.05, word.end - word.start);
  return clampNumber(((playbackTime - word.start) / duration) * 100, 0, 100);
}

function mapRenderedTimeToOriginal(renderedTime: number, cuts: CutSegment[], sourceDuration?: number) {
  const safeRenderedTime = Math.max(0, Number.isFinite(renderedTime) ? renderedTime : 0);
  const originalTime = mergeCutRanges(cuts).reduce((time, cut) => {
    if (time < cut.start) return time;
    return time + Math.max(0, cut.end - cut.start);
  }, safeRenderedTime);

  return sourceDuration && sourceDuration > 0 ? clampNumber(originalTime, 0, sourceDuration) : originalTime;
}

function mergeCutRanges(cuts: CutSegment[]) {
  const sorted = [...cuts].sort((left, right) => left.start - right.start);
  const merged: Array<Pick<CutSegment, "start" | "end">> = [];

  sorted.forEach((cut) => {
    const last = merged[merged.length - 1];
    if (last && cut.start <= last.end) {
      last.end = Math.max(last.end, cut.end);
      return;
    }
    merged.push({ start: cut.start, end: cut.end });
  });

  return merged;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function areCutListsEqual(left: CutSegment[], right: CutSegment[]) {
  if (left.length !== right.length) return false;
  return left.every((cut, index) => {
    const other = right[index];
    return (
      Boolean(other) &&
      Math.abs(cut.start - other.start) < 0.001 &&
      Math.abs(cut.end - other.end) < 0.001 &&
      cut.reason === other.reason
    );
  });
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
