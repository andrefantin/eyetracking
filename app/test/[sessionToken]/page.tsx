"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

import CalibrationLayer from "@/components/CalibrationLayer";
import CameraPermissionCard from "@/components/CameraPermissionCard";
import GazeOverlay from "@/components/GazeOverlay";
import { completeSession, emailSessionReport, postEventsBatch, type EmailReportRequest } from "@/lib/api";
import { CALIBRATION_POINTS } from "@/lib/calibration";
import {
  createGazeEngine,
  createPointerFallbackEngine,
  type CalibrationPointResult,
  type GazeEngine,
  type GazePoint
} from "@/lib/gaze";
import { getClientContext } from "@/lib/mapping";
import type { TrackingEvent } from "@/lib/types";

type TestStage = "permission" | "calibration" | "running" | "finished";

type PageProps = {
  params: { sessionToken: string };
};

type SessionReport = {
  totalSamples: number;
  avgConfidence: number;
  durationSec: number;
  topScreens: Array<{ screenId: string; samples: number }>;
  trackedDocHeight: number;
  maxScrollY: number;
  telemetryMode: "precise" | "estimated" | "none";
};

type ReportSample = {
  ts: number;
  confidence: number;
  screenId: string;
  x: number;
  y: number;
  inFrame: boolean;
  frameNX?: number;
  frameNY?: number;
  protoX?: number;
  protoY?: number;
};

type ScrollTelemetry = {
  ts: number;
  scrollY: number;
  docHeight: number;
  viewportHeight: number;
};

type EmailStatus = "idle" | "sending" | "sent" | "skipped" | "error";

type ProxyMetricsSnapshot = {
  ts?: number;
  scrollY?: number;
  docHeight?: number;
  viewportHeight?: number;
  scrollMode?: string;
};

const BATCH_INTERVAL_MS = 750;
const BATCH_MAX_EVENTS = 50;
const FIGMA_URL_PLACEHOLDER = "https://www.figma.com/proto/your-file-id/your-prototype";
const CALIBRATION_MAX_RETRIES_PER_POINT = 2;

function makeProxyUrl(target: string, retryKey?: string): string {
  const params = new URLSearchParams();
  params.set("target", target);
  if (retryKey) params.set("r", retryKey);
  return `/api/proxy-view?${params.toString()}`;
}

function pointDistance(aX: number, aY: number, bX: number, bY: number): number {
  const dx = aX - bX;
  const dy = aY - bY;
  return Math.sqrt(dx * dx + dy * dy);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function heatColor(t: number): [number, number, number, number] {
  const x = clamp(t, 0, 1);
  if (x < 0.33) {
    const p = x / 0.33;
    return [0, Math.round(180 * p), 255, 0.1 + 0.25 * p];
  }
  if (x < 0.66) {
    const p = (x - 0.33) / 0.33;
    return [Math.round(255 * p), 220, Math.round(255 * (1 - p)), 0.35 + 0.3 * p];
  }
  const p = (x - 0.66) / 0.34;
  return [255, Math.round(220 * (1 - p)), 0, 0.65 + 0.3 * p];
}

function buildHeatmapCanvas(width: number, height: number, samples: ReportSample[]): HTMLCanvasElement {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  const accumulation = document.createElement("canvas");
  accumulation.width = w;
  accumulation.height = h;
  const actx = accumulation.getContext("2d");
  if (!actx) return canvas;

  const frameSamples = samples.filter((sample) => sample.inFrame && sample.frameNX !== undefined && sample.frameNY !== undefined);
  const radius = Math.max(28, Math.round(Math.min(w, h) * 0.05));

  for (const sample of frameSamples) {
    const x = clamp((sample.frameNX as number) * w, 0, w);
    const y = clamp((sample.frameNY as number) * h, 0, h);
    const gradient = actx.createRadialGradient(x, y, 0, x, y, radius);
    const strength = clamp(0.05 + sample.confidence * 0.12, 0.04, 0.18);
    gradient.addColorStop(0, `rgba(255,255,255,${strength})`);
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    actx.fillStyle = gradient;
    actx.beginPath();
    actx.arc(x, y, radius, 0, Math.PI * 2);
    actx.fill();
  }

  const image = actx.getImageData(0, 0, w, h);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const intensity = data[i + 3] / 255;
    if (intensity < 0.02) {
      data[i + 3] = 0;
      continue;
    }

    const [r, g, b, a] = heatColor(Math.min(1, intensity * 1.9));
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = Math.round(a * 255);
  }

  ctx.putImageData(image, 0, 0);
  return canvas;
}

function buildScrollableHeatmapCanvas(
  viewportWidth: number,
  viewportHeight: number,
  samples: ReportSample[],
  fullDocHeight?: number
): HTMLCanvasElement {
  const frameSamples = samples.filter(
    (sample) => sample.inFrame && sample.protoX !== undefined && sample.protoY !== undefined
  );
  const width = Math.max(1, Math.floor(viewportWidth));
  const maxY = frameSamples.reduce((acc, sample) => Math.max(acc, sample.protoY as number), viewportHeight);
  const desiredHeight = Math.max(
    fullDocHeight && fullDocHeight > 0 ? fullDocHeight : 0,
    maxY + 120,
    viewportHeight
  );
  const maxCanvasHeight = 30000;
  const height = Math.max(1, Math.floor(Math.min(desiredHeight, maxCanvasHeight)));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  const accumulation = document.createElement("canvas");
  accumulation.width = width;
  accumulation.height = height;
  const actx = accumulation.getContext("2d");
  if (!actx) return canvas;

  const radius = Math.max(20, Math.round(Math.min(width, viewportHeight) * 0.05));
  for (const sample of frameSamples) {
    const x = clamp(sample.protoX as number, 0, width);
    const y = clamp(sample.protoY as number, 0, height);
    const gradient = actx.createRadialGradient(x, y, 0, x, y, radius);
    const strength = clamp(0.05 + sample.confidence * 0.12, 0.04, 0.18);
    gradient.addColorStop(0, `rgba(255,255,255,${strength})`);
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    actx.fillStyle = gradient;
    actx.beginPath();
    actx.arc(x, y, radius, 0, Math.PI * 2);
    actx.fill();
  }

  const image = actx.getImageData(0, 0, width, height);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const intensity = data[i + 3] / 255;
    if (intensity < 0.02) {
      data[i + 3] = 0;
      continue;
    }
    const [r, g, b, a] = heatColor(Math.min(1, intensity * 1.9));
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = Math.round(a * 255);
  }

  ctx.putImageData(image, 0, 0);
  return canvas;
}

function getBrowserHint(): string {
  const ua = navigator.userAgent.toLowerCase();
  const insecureContext = window.location.protocol !== "https:" && window.location.hostname !== "localhost";
  if (insecureContext) {
    return "Eye tracking requires HTTPS (or localhost). Deploy over HTTPS and retry.";
  }
  if (ua.includes("safari") && !ua.includes("chrome")) {
    return "Safari has limited support for webcam landmark tracking. Use latest Chrome for best results.";
  }
  if (ua.includes("firefox")) {
    return "Firefox support can be unstable for webcam landmark tracking. Use latest Chrome for best results.";
  }
  return "Ensure camera permission is allowed for this site and retry.";
}

async function buildPdfDataUrl(options: {
  sessionToken: string;
  participantName: string;
  targetUrl: string;
  summary: SessionReport;
  heatmapPngDataUrl: string | null;
}): Promise<string | null> {
  try {
    const jsPdfModule = await import("jspdf");
    const JsPdfCtor = jsPdfModule.jsPDF;
    const doc = new JsPdfCtor({
      orientation: "portrait",
      unit: "pt",
      format: "a4"
    });

    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 36;
    let y = margin;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.text("Eye Tracking Session Report", margin, y);
    y += 24;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    const lines = [
      `Session ID: ${options.sessionToken}`,
      `Participant: ${options.participantName || "N/A"}`,
      `Target URL: ${options.targetUrl}`,
      `Total gaze samples: ${options.summary.totalSamples}`,
      `Average confidence: ${options.summary.avgConfidence}`,
      `Duration: ${options.summary.durationSec}s`,
      `Telemetry mode: ${options.summary.telemetryMode}`,
      `Tracked document height: ${options.summary.trackedDocHeight}px`,
      `Max tracked scroll: ${options.summary.maxScrollY}px`
    ];
    for (const line of lines) {
      const wrapped = doc.splitTextToSize(line, pageWidth - margin * 2);
      doc.text(wrapped, margin, y);
      y += 16 + (wrapped.length - 1) * 12;
    }

    y += 8;
    doc.setFont("helvetica", "bold");
    doc.text("Top viewed screens", margin, y);
    y += 16;
    doc.setFont("helvetica", "normal");
    if (options.summary.topScreens.length === 0) {
      doc.text("- No screen data collected", margin, y);
      y += 16;
    } else {
      for (const entry of options.summary.topScreens) {
        doc.text(`- ${entry.screenId}: ${entry.samples} samples`, margin, y);
        y += 14;
      }
    }

    if (options.heatmapPngDataUrl) {
      y += 14;
      doc.setFont("helvetica", "bold");
      doc.text("Heatmap", margin, y);
      y += 10;

      const imgProps = doc.getImageProperties(options.heatmapPngDataUrl);
      const maxWidth = pageWidth - margin * 2;
      const maxHeight = 320;
      const widthRatio = maxWidth / imgProps.width;
      const heightRatio = maxHeight / imgProps.height;
      const ratio = Math.min(widthRatio, heightRatio);
      const imgWidth = imgProps.width * ratio;
      const imgHeight = imgProps.height * ratio;

      if (y + imgHeight > doc.internal.pageSize.getHeight() - margin) {
        doc.addPage();
        y = margin;
      }
      doc.addImage(options.heatmapPngDataUrl, "PNG", margin, y, imgWidth, imgHeight);
    }

    return doc.output("datauristring");
  } catch {
    return null;
  }
}

export default function TestRunnerPage({ params }: PageProps) {
  const { sessionToken } = params;
  const searchParams = useSearchParams();

  const [stage, setStage] = useState<TestStage>("permission");
  const [calibrationIndex, setCalibrationIndex] = useState(0);
  const [currentScreenId, setCurrentScreenId] = useState("screen-default");
  const [gazePoint, setGazePoint] = useState<{ x: number; y: number } | null>(null);
  const [status, setStatus] = useState("Waiting for camera permission");
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [engineName, setEngineName] = useState<"mediapipe" | "pointer-fallback" | null>(null);
  const [calibrationScores, setCalibrationScores] = useState<number[]>([]);
  const [sessionReport, setSessionReport] = useState<SessionReport | null>(null);
  const [heatmapPngDataUrl, setHeatmapPngDataUrl] = useState<string | null>(null);
  const [heatmapJpgDataUrl, setHeatmapJpgDataUrl] = useState<string | null>(null);
  const [reportPdfDataUrl, setReportPdfDataUrl] = useState<string | null>(null);
  const [emailStatus, setEmailStatus] = useState<EmailStatus>("idle");
  const [usingDirectFallback, setUsingDirectFallback] = useState(false);
  const [telemetryMode, setTelemetryMode] = useState<"precise" | "estimated" | "none">("none");
  const debugTelemetry =
    searchParams.get("debugTelemetry") === "1" || process.env.NEXT_PUBLIC_DEBUG_TELEMETRY === "1";

  const participantName = searchParams.get("participant")?.trim() ?? "";

  const streamRef = useRef<MediaStream | null>(null);
  const engineRef = useRef<GazeEngine | null>(null);
  const bufferRef = useRef<TrackingEvent[]>([]);
  const flushTimerRef = useRef<number | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const prototypeShellRef = useRef<HTMLElement | null>(null);
  const currentScreenIdRef = useRef(currentScreenId);
  const latestGazePointRef = useRef<GazePoint | null>(null);
  const calibrationRetryRef = useRef<Record<number, number>>({});
  const runStartedAtRef = useRef<number | null>(null);
  const reportSamplesRef = useRef<ReportSample[]>([]);
  const pointerPosRef = useRef<{ x: number; y: number } | null>(null);
  const currentProtoScrollYRef = useRef(0);
  const maxProtoScrollYRef = useRef(0);
  const maxProtoDocHeightRef = useRef(0);
  const proxyMetricsSeenRef = useRef(false);
  const lastProxyTelemetryTsRef = useRef<number>(0);
  const telemetryHistoryRef = useRef<ScrollTelemetry[]>([]);
  const latestTelemetryRef = useRef<ScrollTelemetry | null>(null);
  const telemetryPollIdRef = useRef<number | null>(null);
  const proxyRetryRef = useRef(0);
  const lastProxyLogAtRef = useRef(0);

  const figmaSourceUrl = useMemo(() => {
    const targetUrlFromQuery = searchParams.get("targetUrl")?.trim();
    const backwardCompatFigmaUrl = searchParams.get("figmaUrl")?.trim();
    return targetUrlFromQuery || backwardCompatFigmaUrl || process.env.NEXT_PUBLIC_FIGMA_EMBED_URL || FIGMA_URL_PLACEHOLDER;
  }, [searchParams]);

  const figmaEmbedUrl = useMemo(() => {
    const candidate = figmaSourceUrl;
    return candidate.includes("embed_host") ? candidate : `${candidate}${candidate.includes("?") ? "&" : "?"}embed_host=eye-tracker`;
  }, [figmaSourceUrl]);
  const isFigmaTarget = useMemo(() => /https?:\/\/(www\.)?figma\.com\/proto\//i.test(figmaSourceUrl), [figmaSourceUrl]);
  const isUsingPlaceholderFigma = figmaEmbedUrl.includes("your-file-id");
  const [activeIframeUrl, setActiveIframeUrl] = useState<string>("");
  const sourceModeLabel = useMemo(() => {
    if (usingDirectFallback) {
      return isFigmaTarget ? "figma-direct" : "website-direct";
    }
    return isFigmaTarget ? "figma-proxy" : "website-proxy";
  }, [isFigmaTarget, usingDirectFallback]);

  useEffect(() => {
    if (isUsingPlaceholderFigma) {
      setActiveIframeUrl(figmaEmbedUrl);
      setUsingDirectFallback(false);
      setTelemetryMode("none");
      proxyRetryRef.current = 0;
      return;
    }
    setActiveIframeUrl(makeProxyUrl(figmaSourceUrl));
    setUsingDirectFallback(false);
    setTelemetryMode("none");
    proxyRetryRef.current = 0;
  }, [figmaEmbedUrl, figmaSourceUrl, isUsingPlaceholderFigma]);

  useEffect(() => {
    if (!activeIframeUrl.startsWith("/api/proxy-view")) {
      if (telemetryPollIdRef.current !== null) {
        window.clearInterval(telemetryPollIdRef.current);
        telemetryPollIdRef.current = null;
      }
      return;
    }

    const readTelemetryFromIframe = () => {
      if (stage !== "running" && stage !== "finished") return;
      const frame = iframeRef.current;
      if (!frame) return;

      try {
        const win = frame.contentWindow as (Window & { __eyeProxyMetrics?: ProxyMetricsSnapshot }) | null;
        if (!win) return;

        // Primary source: telemetry injected in proxy page. This includes scroll-container metrics.
        const proxyMetrics = win.__eyeProxyMetrics;
        const proxyScrollY = toFiniteNumber(proxyMetrics?.scrollY);
        if (proxyMetrics && proxyScrollY !== null) {
          const proxyDocHeight = toFiniteNumber(proxyMetrics.docHeight);
          const proxyViewportHeight = toFiniteNumber(proxyMetrics.viewportHeight);
          const proxyTs = toFiniteNumber(proxyMetrics.ts) ?? Date.now();
          proxyMetricsSeenRef.current = true;
          lastProxyTelemetryTsRef.current = Date.now();
          setTelemetryMode("precise");
          recordTelemetry({
            ts: proxyTs,
            scrollY: Math.max(0, proxyScrollY),
            docHeight:
              proxyDocHeight !== null
                ? Math.max(proxyDocHeight, proxyScrollY + 1)
                : Math.max(maxProtoDocHeightRef.current, proxyScrollY + 1),
            viewportHeight:
              proxyViewportHeight !== null && proxyViewportHeight > 0
                ? proxyViewportHeight
                : Math.max(1, win.innerHeight || window.innerHeight)
          });
          return;
        }

        // If proxy metrics were already seen, never overwrite with window-level fallback values.
        if (proxyMetricsSeenRef.current) return;

        const doc = frame.contentDocument;
        if (!doc) return;
        const de = doc.documentElement;
        const body = doc.body;
        if (!de && !body) return;

        const scrollY = Math.max(
          win.scrollY || 0,
          win.pageYOffset || 0,
          de?.scrollTop || 0,
          body?.scrollTop || 0
        );
        const docHeight = Math.max(
          de?.scrollHeight || 0,
          body?.scrollHeight || 0,
          de?.offsetHeight || 0,
          body?.offsetHeight || 0,
          de?.clientHeight || 0
        );
        const viewportHeight = Math.max(
          win.innerHeight || 0,
          de?.clientHeight || 0
        );

        setTelemetryMode("estimated");
        recordTelemetry({
          ts: Date.now(),
          scrollY: Math.max(0, scrollY),
          docHeight: Math.max(docHeight, scrollY + viewportHeight),
          viewportHeight: Math.max(1, viewportHeight)
        });
      } catch {
        // Cross-origin or transient iframe read errors in direct mode.
      }
    };

    readTelemetryFromIframe();
    telemetryPollIdRef.current = window.setInterval(readTelemetryFromIframe, 120);

    return () => {
      if (telemetryPollIdRef.current !== null) {
        window.clearInterval(telemetryPollIdRef.current);
        telemetryPollIdRef.current = null;
      }
    };
  }, [activeIframeUrl, stage]);

  const averageCalibrationScore = useMemo(() => {
    if (!calibrationScores.length) return null;
    const sum = calibrationScores.reduce((acc, score) => acc + score, 0);
    return Math.round(sum / calibrationScores.length);
  }, [calibrationScores]);

  const queueEvent = (event: TrackingEvent) => {
    bufferRef.current.push(event);
    if (bufferRef.current.length >= BATCH_MAX_EVENTS) {
      void flushEvents();
    }
  };

  const flushEvents = async () => {
    if (!bufferRef.current.length) return;
    const batch = [...bufferRef.current];
    bufferRef.current = [];

    try {
      await postEventsBatch(sessionToken, batch, getClientContext(iframeRef.current));
      setError(null);
    } catch (err) {
      bufferRef.current = [...batch, ...bufferRef.current].slice(-1000);
      setError(err instanceof Error ? err.message : "Failed to upload tracking batch");
    }
  };

  const startBatchLoop = () => {
    if (flushTimerRef.current) return;
    flushTimerRef.current = window.setInterval(() => {
      void flushEvents();
    }, BATCH_INTERVAL_MS);
  };

  const stopBatchLoop = () => {
    if (!flushTimerRef.current) return;
    window.clearInterval(flushTimerRef.current);
    flushTimerRef.current = null;
  };

  const stopCameraStream = () => {
    if (!streamRef.current) return;
    streamRef.current.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  const buildSessionReport = (): SessionReport => {
    const samples = reportSamplesRef.current;
    const totalSamples = samples.length;
    const avgConfidence =
      totalSamples > 0
        ? Number((samples.reduce((acc, sample) => acc + sample.confidence, 0) / totalSamples).toFixed(2))
        : 0;

    const startTs = runStartedAtRef.current ?? samples[0]?.ts ?? Date.now();
    const endTs = samples[samples.length - 1]?.ts ?? Date.now();
    const durationSec = Math.max(0, Math.round((endTs - startTs) / 1000));

    const counts = new Map<string, number>();
    for (const sample of samples) {
      counts.set(sample.screenId, (counts.get(sample.screenId) ?? 0) + 1);
    }

    const topScreens = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([screenId, samplesCount]) => ({ screenId, samples: samplesCount }));

    return {
      totalSamples,
      avgConfidence,
      durationSec,
      topScreens,
      trackedDocHeight: Math.round(maxProtoDocHeightRef.current),
      maxScrollY: Math.round(maxProtoScrollYRef.current),
      telemetryMode: getEffectiveTelemetryMode()
    };
  };

  const generateHeatmapArtifacts = () => {
    const frameElement = iframeRef.current;
    const rect = frameElement?.getBoundingClientRect();
    const width = Math.max(320, Math.floor(rect?.width ?? window.innerWidth * 0.8));
    const height = Math.max(220, Math.floor(rect?.height ?? window.innerHeight * 0.65));
    const iframeDocumentMetrics = readIframeDocumentMetrics();
    const telemetryViewportHeight =
      iframeDocumentMetrics?.viewportHeight ??
      latestTelemetryRef.current?.viewportHeight ??
      height;
    const maxSampleProtoY = reportSamplesRef.current.reduce((acc, sample) => {
      if (!sample.inFrame || sample.protoY === undefined) return acc;
      return Math.max(acc, sample.protoY);
    }, 0);
    const derivedDocHeight = Math.max(
      maxProtoDocHeightRef.current,
      iframeDocumentMetrics?.docHeight ?? 0,
      maxProtoScrollYRef.current + telemetryViewportHeight,
      maxSampleProtoY + 120,
      height
    );
    const fullCanvas = buildScrollableHeatmapCanvas(width, height, reportSamplesRef.current, derivedDocHeight);

    return {
      pngDataUrl: fullCanvas.toDataURL("image/png"),
      jpgDataUrl: fullCanvas.toDataURL("image/jpeg", 0.9)
    };
  };

  const recordTelemetry = (entry: ScrollTelemetry) => {
    latestTelemetryRef.current = entry;
    telemetryHistoryRef.current.push(entry);
    if (telemetryHistoryRef.current.length > 20000) {
      telemetryHistoryRef.current = telemetryHistoryRef.current.slice(-20000);
    }
    currentProtoScrollYRef.current = Math.max(0, entry.scrollY);
    maxProtoScrollYRef.current = Math.max(maxProtoScrollYRef.current, currentProtoScrollYRef.current);
    maxProtoDocHeightRef.current = Math.max(maxProtoDocHeightRef.current, entry.docHeight);
  };

  const getEffectiveTelemetryMode = (): "precise" | "estimated" | "none" => {
    if (telemetryHistoryRef.current.length === 0) return "none";
    if (proxyMetricsSeenRef.current) return "precise";
    if (usingDirectFallback) return "estimated";
    return telemetryMode === "none" ? "estimated" : telemetryMode;
  };

  const mergeTelemetryTimeline = (entries: ScrollTelemetry[]) => {
    if (!entries.length) return;

    const combined = [...telemetryHistoryRef.current, ...entries]
      .filter((entry) =>
        Number.isFinite(entry.ts) &&
        Number.isFinite(entry.scrollY) &&
        Number.isFinite(entry.docHeight) &&
        Number.isFinite(entry.viewportHeight)
      )
      .map((entry) => ({
        ts: Math.max(0, Math.round(entry.ts)),
        scrollY: Math.max(0, entry.scrollY),
        docHeight: Math.max(1, entry.docHeight),
        viewportHeight: Math.max(1, entry.viewportHeight)
      }))
      .sort((a, b) => a.ts - b.ts);

    const deduped: ScrollTelemetry[] = [];
    for (const item of combined) {
      const prev = deduped[deduped.length - 1];
      if (
        prev &&
        prev.ts === item.ts &&
        Math.abs(prev.scrollY - item.scrollY) < 0.5 &&
        Math.abs(prev.docHeight - item.docHeight) < 0.5 &&
        Math.abs(prev.viewportHeight - item.viewportHeight) < 0.5
      ) {
        continue;
      }
      deduped.push(item);
    }

    telemetryHistoryRef.current = deduped.slice(-20000);
    const latest = telemetryHistoryRef.current[telemetryHistoryRef.current.length - 1] ?? null;
    latestTelemetryRef.current = latest;

    currentProtoScrollYRef.current = latest?.scrollY ?? 0;
    maxProtoScrollYRef.current = 0;
    maxProtoDocHeightRef.current = 0;
    for (const item of telemetryHistoryRef.current) {
      maxProtoScrollYRef.current = Math.max(maxProtoScrollYRef.current, item.scrollY);
      maxProtoDocHeightRef.current = Math.max(maxProtoDocHeightRef.current, item.docHeight);
    }
  };

  const pullProxyTelemetryTimeline = (): ScrollTelemetry[] => {
    const frame = iframeRef.current;
    if (!frame) return [];

    try {
      const win = frame.contentWindow as
        | (Window & {
            __eyeProxyTimeline?: unknown;
            __eyeProxyMetrics?: ProxyMetricsSnapshot;
          })
        | null;
      if (!win) return [];

      const timelineRaw = Array.isArray(win.__eyeProxyTimeline) ? win.__eyeProxyTimeline : [];
      const timeline: ScrollTelemetry[] = [];
      for (const item of timelineRaw) {
        if (typeof item !== "object" || !item) continue;
        const ts = toFiniteNumber((item as { ts?: unknown }).ts);
        const scrollY = toFiniteNumber((item as { scrollY?: unknown }).scrollY);
        const docHeight = toFiniteNumber((item as { docHeight?: unknown }).docHeight);
        const viewportHeight = toFiniteNumber((item as { viewportHeight?: unknown }).viewportHeight);
        if (ts === null || scrollY === null) continue;
        timeline.push({
          ts,
          scrollY: Math.max(0, scrollY),
          docHeight: docHeight !== null ? Math.max(docHeight, scrollY + 1) : Math.max(1, scrollY + 1),
          viewportHeight: viewportHeight !== null && viewportHeight > 0 ? viewportHeight : Math.max(1, window.innerHeight)
        });
      }

      const latestMetrics = win.__eyeProxyMetrics;
      const latestTs = toFiniteNumber(latestMetrics?.ts);
      const latestScrollY = toFiniteNumber(latestMetrics?.scrollY);
      const latestDocHeight = toFiniteNumber(latestMetrics?.docHeight);
      const latestViewportHeight = toFiniteNumber(latestMetrics?.viewportHeight);
      if (latestTs !== null && latestScrollY !== null) {
        timeline.push({
          ts: latestTs,
          scrollY: Math.max(0, latestScrollY),
          docHeight:
            latestDocHeight !== null
              ? Math.max(latestDocHeight, latestScrollY + 1)
              : Math.max(maxProtoDocHeightRef.current, latestScrollY + 1),
          viewportHeight:
            latestViewportHeight !== null && latestViewportHeight > 0
              ? latestViewportHeight
              : Math.max(1, window.innerHeight)
        });
      }

      return timeline;
    } catch {
      return [];
    }
  };

  const remapSamplesWithTelemetry = (viewportWidth: number, viewportHeight: number) => {
    const history = telemetryHistoryRef.current;
    if (!history.length) return;

    let cursor = 0;
    for (const sample of reportSamplesRef.current) {
      while (cursor + 1 < history.length && history[cursor + 1].ts <= sample.ts) {
        cursor += 1;
      }

      const current = history[cursor];
      const next = history[cursor + 1];
      let scrollOffset = current.scrollY;
      if (sample.ts < history[0].ts) {
        scrollOffset = history[0].scrollY;
      } else if (next && Math.abs(next.ts - sample.ts) < Math.abs(sample.ts - current.ts)) {
        scrollOffset = next.scrollY;
      }

      if (sample.inFrame && sample.frameNX !== undefined && sample.frameNY !== undefined) {
        sample.protoX = clamp(sample.frameNX * viewportWidth, 0, viewportWidth);
        sample.protoY = Math.max(0, sample.frameNY * viewportHeight + scrollOffset);
      } else {
        sample.protoX = undefined;
        sample.protoY = undefined;
      }
    }
  };

  const readIframeDocumentMetrics = (): { docHeight: number; viewportHeight: number } | null => {
    const frame = iframeRef.current;
    if (!frame) return null;

    try {
      const win = frame.contentWindow as (Window & { __eyeProxyMetrics?: ProxyMetricsSnapshot }) | null;
      const doc = frame.contentDocument;
      if (!win || !doc) return null;

      const de = doc.documentElement;
      const body = doc.body;
      const proxyDocHeight = toFiniteNumber(win.__eyeProxyMetrics?.docHeight) ?? 0;
      const proxyViewportHeight = toFiniteNumber(win.__eyeProxyMetrics?.viewportHeight) ?? 0;
      const windowDocHeight = Math.max(
        de?.scrollHeight || 0,
        body?.scrollHeight || 0,
        de?.offsetHeight || 0,
        body?.offsetHeight || 0,
        de?.clientHeight || 0
      );
      const windowViewportHeight = Math.max(
        win.innerHeight || 0,
        de?.clientHeight || 0
      );

      // Fallback for apps that scroll inside custom containers.
      let largestScrollableHeight = 0;
      const elements = doc.querySelectorAll<HTMLElement>("*");
      const maxElementsToScan = 2500;
      for (let i = 0; i < elements.length && i < maxElementsToScan; i += 1) {
        const node = elements[i];
        if (node.scrollHeight - node.clientHeight > 40) {
          largestScrollableHeight = Math.max(largestScrollableHeight, node.scrollHeight);
        }
      }

      const docHeight = Math.max(
        proxyDocHeight,
        windowDocHeight,
        largestScrollableHeight,
        maxProtoDocHeightRef.current
      );
      const viewportHeight = Math.max(
        proxyViewportHeight,
        windowViewportHeight,
        latestTelemetryRef.current?.viewportHeight ?? 0,
        1
      );

      return {
        docHeight: Math.max(1, Math.floor(docHeight)),
        viewportHeight: Math.max(1, Math.floor(viewportHeight))
      };
    } catch {
      return null;
    }
  };

  const getScrollOffsetForTimestamp = (ts: number): number => {
    const history = telemetryHistoryRef.current;
    if (history.length === 0) {
      return Math.max(0, currentProtoScrollYRef.current);
    }

    // Find closest telemetry sample at or before gaze timestamp.
    let candidate = history[0];
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (history[i].ts <= ts) {
        candidate = history[i];
        return Math.max(0, candidate.scrollY);
      }
    }

    // If none is older, use the closest by absolute time.
    candidate = history.reduce((best, next) =>
      Math.abs(next.ts - ts) < Math.abs(best.ts - ts) ? next : best
    );
    return Math.max(0, candidate.scrollY);
  };

  const sendEmailReport = async (report: SessionReport, pngDataUrl: string | null, jpgDataUrl: string | null) => {
    setEmailStatus("sending");
    try {
      const payload: EmailReportRequest = {
        sessionToken,
        participantName,
        figmaUrl: figmaSourceUrl,
        summary: report,
        heatmapPngDataUrl: pngDataUrl ?? undefined,
        heatmapJpgDataUrl: jpgDataUrl ?? undefined
      };

      const result = await emailSessionReport(payload);
      if (result.status === "sent") {
        setEmailStatus("sent");
      } else {
        setEmailStatus("skipped");
        setWarning("Email sending was skipped by the server configuration.");
      }
    } catch (err) {
      setEmailStatus("error");
      setWarning(`Could not send email report: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  };

  const handleGaze = (point: GazePoint) => {
    latestGazePointRef.current = point;
    setGazePoint({ x: point.x, y: point.y });

    const rect = iframeRef.current?.getBoundingClientRect();
    let inFrame = false;
    let frameNX: number | undefined;
    let frameNY: number | undefined;
    if (rect && rect.width > 0 && rect.height > 0) {
      const nx = (point.x - rect.left) / rect.width;
      const ny = (point.y - rect.top) / rect.height;
      inFrame = nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1;
      if (inFrame) {
        frameNX = nx;
        frameNY = ny;
      }
    }

    const scrollOffsetY = getScrollOffsetForTimestamp(point.ts);
    const protoX = inFrame && rect && frameNX !== undefined ? frameNX * rect.width : undefined;
    const protoY = inFrame && rect && frameNY !== undefined ? frameNY * rect.height + scrollOffsetY : undefined;

    reportSamplesRef.current.push({
      ts: point.ts,
      confidence: point.confidence,
      screenId: currentScreenIdRef.current,
      x: point.x,
      y: point.y,
      inFrame,
      frameNX,
      frameNY,
      protoX,
      protoY
    });

    if (reportSamplesRef.current.length > 100000) {
      reportSamplesRef.current = reportSamplesRef.current.slice(-100000);
    }

    queueEvent({
      type: "gaze_sample",
      ts: point.ts,
      x: point.x,
      y: point.y,
      confidence: point.confidence,
      screenId: currentScreenIdRef.current
    });
  };

  const initializeAndStartEngine = async () => {
    try {
      if (!engineRef.current) {
        engineRef.current = await createGazeEngine();
        setEngineName(engineRef.current.getEngineName());
      }

      if (!streamRef.current) {
        throw new Error("Camera stream not available");
      }

      engineRef.current.setListener(handleGaze);
      await engineRef.current.start(streamRef.current);
    } catch (err) {
      const fallback = createPointerFallbackEngine();
      fallback.setListener(handleGaze);
      await fallback.start();
      engineRef.current = fallback;
      setEngineName(fallback.getEngineName());
      const reason = err instanceof Error && err.message ? err.message : "unknown initialization error";
      setError(`Webcam eye tracker could not start (${reason}). Running in pointer fallback mode. ${getBrowserHint()}`);
    }
  };

  const stopEngine = () => {
    engineRef.current?.setListener(null);
    engineRef.current?.stop();
  };

  const stopTracking = () => {
    stopEngine();
    stopCameraStream();
    queueEvent({ type: "session_pause", ts: Date.now() });
    stopBatchLoop();
    setStatus("Tracking stopped");
  };

  const onCameraGranted = async (stream: MediaStream) => {
    streamRef.current = stream;
    reportSamplesRef.current = [];
    telemetryHistoryRef.current = [];
    latestTelemetryRef.current = null;
    lastProxyTelemetryTsRef.current = 0;
    proxyMetricsSeenRef.current = false;
    currentProtoScrollYRef.current = 0;
    maxProtoScrollYRef.current = 0;
    maxProtoDocHeightRef.current = 0;
    setStage("calibration");
    setStatus("Camera enabled. Starting eye-tracker...");

    try {
      await initializeAndStartEngine();
      startBatchLoop();
      setStatus("Camera enabled. Complete calibration.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start gaze engine");
      setStatus("Camera enabled, but tracking failed to initialize.");
    }
  };

  const handleCalibrationResult = (index: number, result: CalibrationPointResult | null) => {
    if (!result) {
      setError("Calibration sample was too weak. Keep your head steady and click again.");
      return;
    }

    setError(null);
    setCalibrationScores((previous) => [...previous, result.score]);

    queueEvent({
      type: "calibration_result",
      ts: Date.now(),
      pointIndex: index,
      targetX: result.targetX,
      targetY: result.targetY,
      avgX: result.avgX,
      avgY: result.avgY,
      errorPx: result.errorPx,
      score: result.score,
      sampleCount: result.sampleCount
    });
  };

  const onCalibrationPointConfirmed = (index: number) => {
    const point = CALIBRATION_POINTS[index];
    const targetX = (window.innerWidth * point.x) / 100;
    const targetY = (window.innerHeight * point.y) / 100;
    let result = engineRef.current?.recordCalibrationPoint(targetX, targetY) ?? null;

    if (!result && latestGazePointRef.current) {
      const latest = latestGazePointRef.current;
      const errorPx = pointDistance(latest.x, latest.y, targetX, targetY);
      const score = Math.max(0, Math.round((1 - errorPx / 300) * 100));
      result = {
        targetX,
        targetY,
        sampleCount: 1,
        avgX: latest.x,
        avgY: latest.y,
        errorPx,
        score
      };
    }

    if (!result) {
      const tries = (calibrationRetryRef.current[index] ?? 0) + 1;
      calibrationRetryRef.current[index] = tries;
      if (tries > CALIBRATION_MAX_RETRIES_PER_POINT) {
        result = {
          targetX,
          targetY,
          sampleCount: 0,
          avgX: targetX,
          avgY: targetY,
          errorPx: 300,
          score: 0
        };
        setError("Calibration signal is weak. Continuing with low-confidence calibration.");
      }
    } else {
      calibrationRetryRef.current[index] = 0;
    }

    handleCalibrationResult(index, result);

    if (result === null) return;

    if (index + 1 >= CALIBRATION_POINTS.length) {
      setStage("running");
      runStartedAtRef.current = Date.now();
      queueEvent({
        type: "session_resume",
        ts: Date.now()
      });
      setStatus("Calibration complete. Tracking is active.");
      return;
    }

    setCalibrationIndex(index + 1);
  };

  const onStopTest = async () => {
    stopTracking();
    await flushEvents();

    const frameRect = iframeRef.current?.getBoundingClientRect();
    const viewportWidth = Math.max(320, Math.floor(frameRect?.width ?? window.innerWidth * 0.8));
    const viewportHeight = Math.max(220, Math.floor(frameRect?.height ?? window.innerHeight * 0.65));
    const proxyTimeline = pullProxyTelemetryTimeline();
    if (proxyTimeline.length > 0) {
      mergeTelemetryTimeline(proxyTimeline);
      if (telemetryMode === "none") {
        setTelemetryMode("precise");
      }
    }
    remapSamplesWithTelemetry(viewportWidth, viewportHeight);

    if (debugTelemetry) {
      // eslint-disable-next-line no-console
      console.log("[eyetracker] heatmap gen", {
        telemetrySamples: telemetryHistoryRef.current.length,
        maxScrollY: maxProtoScrollYRef.current,
        trackedDocHeight: maxProtoDocHeightRef.current,
        reportSamples: reportSamplesRef.current.length,
        sourceMode: sourceModeLabel,
        targetType: isFigmaTarget ? "figma" : "website"
      });
    }

    if (getEffectiveTelemetryMode() === "none") {
      setWarning(
        "No page scroll telemetry was captured during this run. Heatmap is viewport-only for this session."
      );
    }

    const report = buildSessionReport();
    setSessionReport(report);
    const artifacts = generateHeatmapArtifacts();
    setHeatmapPngDataUrl(artifacts.pngDataUrl);
    setHeatmapJpgDataUrl(artifacts.jpgDataUrl);
    const pdfDataUrl = await buildPdfDataUrl({
      sessionToken,
      participantName,
      targetUrl: figmaSourceUrl,
      summary: report,
      heatmapPngDataUrl: artifacts.pngDataUrl
    });
    setReportPdfDataUrl(pdfDataUrl);

    setStage("finished");
    setStatus("Session complete.");

    void sendEmailReport(report, artifacts.pngDataUrl, artifacts.jpgDataUrl);

    try {
      await completeSession(sessionToken);
    } catch (err) {
      setWarning(
        `Session ended locally, but backend completion failed: ${
          err instanceof Error ? err.message : "unknown error"
        }`
      );
    }
  };

  useEffect(() => {
    currentScreenIdRef.current = currentScreenId;
  }, [currentScreenId]);

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      pointerPosRef.current = { x: event.clientX, y: event.clientY };
    };

    const shouldUseHeuristicScroll = () => {
      if (usingDirectFallback) return true;
      if (lastProxyTelemetryTsRef.current === 0) return true;
      return Date.now() - lastProxyTelemetryTsRef.current > 1200;
    };

    const addScrollDelta = (deltaY: number) => {
      const capped = clamp(deltaY, -900, 900);
      if (shouldUseHeuristicScroll()) {
        const next = Math.max(0, currentProtoScrollYRef.current + capped);
        setTelemetryMode("estimated");
        recordTelemetry({
          ts: Date.now(),
          scrollY: next,
          docHeight: Math.max(maxProtoDocHeightRef.current, next + window.innerHeight),
          viewportHeight: window.innerHeight
        });
      }
    };

    const onWheel = (event: WheelEvent) => {
      if (stage !== "running") return;
      const pointer = pointerPosRef.current;
      const rect = prototypeShellRef.current?.getBoundingClientRect() ?? iframeRef.current?.getBoundingClientRect();
      if (!rect) return;
      const px = pointer?.x ?? event.clientX;
      const py = pointer?.y ?? event.clientY;
      const inside =
        px >= rect.left &&
        px <= rect.right &&
        py >= rect.top &&
        py <= rect.bottom;
      if (!inside) return;
      addScrollDelta(event.deltaY);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (stage !== "running") return;
      let delta = 0;
      if (event.key === "PageDown") delta = window.innerHeight * 0.9;
      if (event.key === "PageUp") delta = -window.innerHeight * 0.9;
      if (event.key === "ArrowDown") delta = 120;
      if (event.key === "ArrowUp") delta = -120;
      if (delta !== 0) {
        addScrollDelta(delta);
      }
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("wheel", onWheel, { passive: true, capture: true });
    document.addEventListener("wheel", onWheel, { passive: true, capture: true });
    window.addEventListener("keydown", onKeyDown);

    const iframeElement = iframeRef.current;
    const shellElement = prototypeShellRef.current;
    iframeElement?.addEventListener("wheel", onWheel, { passive: true, capture: true });
    shellElement?.addEventListener("wheel", onWheel, { passive: true, capture: true });

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("wheel", onWheel, true);
      document.removeEventListener("wheel", onWheel, true);
      window.removeEventListener("keydown", onKeyDown);
      iframeElement?.removeEventListener("wheel", onWheel, true);
      shellElement?.removeEventListener("wheel", onWheel, true);
    };
  }, [stage, usingDirectFallback]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden && stage === "running") {
        queueEvent({ type: "face_lost", ts: Date.now() });
      } else if (!document.hidden && stage === "running") {
        queueEvent({ type: "face_reacquired", ts: Date.now() });
      }
    };

    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "object" || !event.data) return;
      if (event.data.type !== "figma_navigation") return;
      const nextScreen = String(event.data.screenId ?? "screen-default");
      queueEvent({
        type: "navigation_change",
        ts: Date.now(),
        fromScreenId: currentScreenId,
        toScreenId: nextScreen
      });
      setCurrentScreenId(nextScreen);
    };

    const onProxyMetrics = (event: MessageEvent) => {
      if (typeof event.data !== "object" || !event.data) return;
      if (event.data.type !== "proxy_metrics") return;
      proxyMetricsSeenRef.current = true;
      lastProxyTelemetryTsRef.current = Date.now();
      const scrollY = toFiniteNumber(event.data.scrollY);
      const docHeight = toFiniteNumber(event.data.docHeight);
      const viewportHeight = toFiniteNumber(event.data.viewportHeight);
      const ts = toFiniteNumber(event.data.ts) ?? Date.now();
      if (scrollY !== null) {
        setTelemetryMode("precise");
        recordTelemetry({
          ts,
          scrollY: Math.max(0, scrollY),
          docHeight: docHeight !== null ? Math.max(docHeight, scrollY + 1) : Math.max(maxProtoDocHeightRef.current, scrollY + 1),
          viewportHeight: viewportHeight !== null && viewportHeight > 0 ? viewportHeight : window.innerHeight
        });
        if (debugTelemetry && Date.now() - lastProxyLogAtRef.current > 900) {
          lastProxyLogAtRef.current = Date.now();
          // eslint-disable-next-line no-console
          console.log("[eyetracker] proxy_metrics", {
            ts,
            scrollY: Math.max(0, scrollY),
            docHeight: docHeight !== null ? Math.max(docHeight, scrollY + 1) : Math.max(maxProtoDocHeightRef.current, scrollY + 1),
            viewportHeight: viewportHeight !== null && viewportHeight > 0 ? viewportHeight : window.innerHeight,
            telemetrySamples: telemetryHistoryRef.current.length
          });
        }
      }
    };

    const onProxyError = (event: MessageEvent) => {
      if (typeof event.data !== "object" || !event.data) return;
      if (event.data.type !== "proxy_error") return;
      if (proxyRetryRef.current < 1) {
        proxyRetryRef.current += 1;
        setWarning("Proxy telemetry failed once. Retrying proxy mode before switching to direct mode...");
        setActiveIframeUrl(makeProxyUrl(figmaSourceUrl, String(Date.now())));
        return;
      }
      setUsingDirectFallback(true);
      setTelemetryMode("estimated");
      setActiveIframeUrl(isFigmaTarget ? figmaEmbedUrl : figmaSourceUrl);
      setWarning(
        "Proxy mode failed for this target. Switched to direct loading. Full-page heatmap may be viewport-only."
      );
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("message", onMessage);
    window.addEventListener("message", onProxyMetrics);
    window.addEventListener("message", onProxyError);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("message", onMessage);
      window.removeEventListener("message", onProxyMetrics);
      window.removeEventListener("message", onProxyError);
    };
  }, [currentScreenId, debugTelemetry, figmaEmbedUrl, figmaSourceUrl, isFigmaTarget, stage]);

  useEffect(() => {
    return () => {
      stopEngine();
      stopBatchLoop();
      stopCameraStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="runner-root">
      <header className="runner-header">
        <div>
          <h1>Prototype Test Session</h1>
          <p>Session: {sessionToken}</p>
          {participantName && <p>Participant: {participantName}</p>}
        </div>
        <div className="status-pill">{status}</div>
      </header>

      {error && <p className="error-banner">{error}</p>}
      {warning && <p className="warning-banner">{warning}</p>}
      {isUsingPlaceholderFigma && (
        <p className="error-banner">
          No target URL detected. Go back to the home page and paste a website or Figma prototype link.
        </p>
      )}

      <section className="meta-strip">
        <span>Engine: {engineName ?? "not initialized"}</span>
        <span>Calibration score: {averageCalibrationScore !== null ? `${averageCalibrationScore}/100` : "pending"}</span>
        <span>Email report: {emailStatus}</span>
        <span>Source mode: {sourceModeLabel}</span>
        <span>Telemetry: {telemetryMode}</span>
        <span>Telemetry samples: {telemetryHistoryRef.current.length}</span>
      </section>
      {usingDirectFallback && (
        <p className="warning-banner">
          {isFigmaTarget
            ? "Figma is running in direct mode (proxy failed), so internal scroll telemetry is limited. Exported heatmap may be viewport-only."
            : "Website is running in direct mode (proxy failed), so internal scroll telemetry is limited. Exported heatmap may be viewport-only."}
        </p>
      )}

      {stage === "permission" && <CameraPermissionCard onGranted={onCameraGranted} />}

      {stage !== "permission" && (
        <section
          className="prototype-shell"
          ref={(node) => {
            prototypeShellRef.current = node;
          }}
        >
          {stage === "calibration" ? (
            <div className="calibration-shell">
              <h2>Calibration</h2>
              <p>Look at each point and click it to calibrate eye tracking.</p>
              <p className="calibration-subtle">The prototype will appear after calibration is complete.</p>
            </div>
          ) : (
            <>
              <iframe
                ref={iframeRef}
                title="Tracked Target"
                src={activeIframeUrl}
                className="prototype-frame"
                allow="camera; microphone"
              />
              {stage === "running" && <GazeOverlay x={gazePoint?.x ?? 0} y={gazePoint?.y ?? 0} visible={!!gazePoint} />}
            </>
          )}
          {stage === "calibration" && (
            <CalibrationLayer currentIndex={calibrationIndex} onPointConfirmed={onCalibrationPointConfirmed} />
          )}
        </section>
      )}

      {stage === "finished" && sessionReport && (
        <section className="report-box">
          <h3>Session Report</h3>
          <p>
            <strong>Session ID:</strong> {sessionToken}
          </p>
          <p>
            <strong>Participant:</strong> {participantName || "N/A"}
          </p>
          <p>
            <strong>Target URL:</strong> {figmaSourceUrl}
          </p>
          <p>
            <strong>Total gaze samples:</strong> {sessionReport.totalSamples}
          </p>
          <p>
            <strong>Average confidence:</strong> {sessionReport.avgConfidence}
          </p>
          <p>
            <strong>Duration:</strong> {sessionReport.durationSec}s
          </p>
          <p>
            <strong>Telemetry mode:</strong> {sessionReport.telemetryMode}
          </p>
          <p>
            <strong>Heatmap coverage:</strong>{" "}
            {sessionReport.telemetryMode === "none"
              ? "Viewport-only (scroll telemetry unavailable)"
              : "Scroll-aware full-page mapping"}
          </p>
          <p>
            <strong>Tracked document height:</strong> {sessionReport.trackedDocHeight}px
          </p>
          <p>
            <strong>Max tracked scroll:</strong> {sessionReport.maxScrollY}px
          </p>
          <p>
            <strong>Top viewed screens:</strong>
          </p>
          <ul>
            {sessionReport.topScreens.length === 0 && <li>No screen data collected</li>}
            {sessionReport.topScreens.map((entry) => (
              <li key={entry.screenId}>
                {entry.screenId}: {entry.samples} samples
              </li>
            ))}
          </ul>
          <div className="report-actions">
            <span>Downloads include the full-session scroll heatmap.</span>
            {heatmapPngDataUrl && (
              <a href={heatmapPngDataUrl} target="_blank" rel="noreferrer" className="report-download-link">
                Open Full Heatmap
              </a>
            )}
            {reportPdfDataUrl && (
              <a href={reportPdfDataUrl} download={`${sessionToken}-report.pdf`} className="report-download-link">
                Download PDF
              </a>
            )}
            {heatmapPngDataUrl ? (
              <a href={heatmapPngDataUrl} download={`${sessionToken}-heatmap.png`} className="report-download-link">
                Download PNG
              </a>
            ) : (
              <span>PNG not ready</span>
            )}
            {heatmapJpgDataUrl ? (
              <a href={heatmapJpgDataUrl} download={`${sessionToken}-heatmap.jpg`} className="report-download-link">
                Download JPG
              </a>
            ) : (
              <span>JPG not ready</span>
            )}
          </div>
        </section>
      )}

      <footer className="runner-footer">
        <div className="report-actions">
          <button onClick={onStopTest} disabled={stage !== "running"} className="stop-button">
            End Test
          </button>
          {stage === "finished" && heatmapPngDataUrl && (
            <a href={heatmapPngDataUrl} download={`${sessionToken}-heatmap.png`} className="report-download-link">
              Download PNG
            </a>
          )}
          {stage === "finished" && reportPdfDataUrl && (
            <a href={reportPdfDataUrl} download={`${sessionToken}-report.pdf`} className="report-download-link">
              Download PDF
            </a>
          )}
          {stage === "finished" && heatmapJpgDataUrl && (
            <a href={heatmapJpgDataUrl} download={`${sessionToken}-heatmap.jpg`} className="report-download-link">
              Download JPG
            </a>
          )}
        </div>
        {stage === "finished" && <p>Done. Camera has been stopped.</p>}
      </footer>
    </main>
  );
}
