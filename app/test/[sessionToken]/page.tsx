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
};

type EmailStatus = "idle" | "sending" | "sent" | "skipped" | "error";

const BATCH_INTERVAL_MS = 750;
const BATCH_MAX_EVENTS = 50;
const FIGMA_URL_PLACEHOLDER = "https://www.figma.com/proto/your-file-id/your-prototype";
const CALIBRATION_MAX_RETRIES_PER_POINT = 2;

function pointDistance(aX: number, aY: number, bX: number, bY: number): number {
  const dx = aX - bX;
  const dy = aY - bY;
  return Math.sqrt(dx * dx + dy * dy);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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
  const [emailStatus, setEmailStatus] = useState<EmailStatus>("idle");

  const participantName = searchParams.get("participant")?.trim() ?? "";

  const streamRef = useRef<MediaStream | null>(null);
  const engineRef = useRef<GazeEngine | null>(null);
  const bufferRef = useRef<TrackingEvent[]>([]);
  const flushTimerRef = useRef<number | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const currentScreenIdRef = useRef(currentScreenId);
  const latestGazePointRef = useRef<GazePoint | null>(null);
  const calibrationRetryRef = useRef<Record<number, number>>({});
  const runStartedAtRef = useRef<number | null>(null);
  const reportSamplesRef = useRef<ReportSample[]>([]);

  const figmaSourceUrl = useMemo(() => {
    const figmaUrlFromQuery = searchParams.get("figmaUrl")?.trim();
    return figmaUrlFromQuery || process.env.NEXT_PUBLIC_FIGMA_EMBED_URL || FIGMA_URL_PLACEHOLDER;
  }, [searchParams]);

  const figmaEmbedUrl = useMemo(() => {
    const candidate = figmaSourceUrl;
    return candidate.includes("embed_host") ? candidate : `${candidate}${candidate.includes("?") ? "&" : "?"}embed_host=eye-tracker`;
  }, [figmaSourceUrl]);

  const isUsingPlaceholderFigma = figmaEmbedUrl.includes("your-file-id");

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
      topScreens
    };
  };

  const generateHeatmapArtifacts = () => {
    const frameElement = iframeRef.current;
    if (!frameElement) {
      return { pngDataUrl: null as string | null, jpgDataUrl: null as string | null };
    }

    const rect = frameElement.getBoundingClientRect();
    const width = Math.max(320, Math.floor(rect.width));
    const height = Math.max(220, Math.floor(rect.height));
    const canvas = buildHeatmapCanvas(width, height, reportSamplesRef.current);

    return {
      pngDataUrl: canvas.toDataURL("image/png"),
      jpgDataUrl: canvas.toDataURL("image/jpeg", 0.9)
    };
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

    reportSamplesRef.current.push({
      ts: point.ts,
      confidence: point.confidence,
      screenId: currentScreenIdRef.current,
      x: point.x,
      y: point.y,
      inFrame,
      frameNX,
      frameNY
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

    const report = buildSessionReport();
    setSessionReport(report);
    const artifacts = generateHeatmapArtifacts();
    setHeatmapPngDataUrl(artifacts.pngDataUrl);
    setHeatmapJpgDataUrl(artifacts.jpgDataUrl);

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

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("message", onMessage);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("message", onMessage);
    };
  }, [currentScreenId, stage]);

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
          No Figma prototype URL detected. Go back to the home page and paste a real `https://www.figma.com/proto/...` link.
        </p>
      )}

      <section className="meta-strip">
        <span>Engine: {engineName ?? "not initialized"}</span>
        <span>Calibration score: {averageCalibrationScore !== null ? `${averageCalibrationScore}/100` : "pending"}</span>
        <span>Email report: {emailStatus}</span>
      </section>

      {stage === "permission" && <CameraPermissionCard onGranted={onCameraGranted} />}

      {stage !== "permission" && (
        <section className="prototype-shell">
          {stage === "calibration" ? (
            <div className="calibration-shell">
              <h2>Calibration</h2>
              <p>Look at each point and click it to calibrate eye tracking.</p>
              <p className="calibration-subtle">The prototype will appear after calibration is complete.</p>
            </div>
          ) : (
            <>
              <iframe ref={iframeRef} title="Figma Prototype" src={figmaEmbedUrl} className="prototype-frame" allow="camera; microphone" />
              {stage === "running" && <GazeOverlay x={gazePoint?.x ?? 0} y={gazePoint?.y ?? 0} visible={!!gazePoint} />}
              {stage === "finished" && heatmapPngDataUrl && (
                <img src={heatmapPngDataUrl} alt="Heatmap overlay" className="heatmap-overlay" />
              )}
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
            <strong>Figma URL:</strong> {figmaSourceUrl}
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
            {heatmapPngDataUrl && (
              <a href={heatmapPngDataUrl} download={`${sessionToken}-heatmap.png`} className="report-download-link">
                Download PNG
              </a>
            )}
            {heatmapJpgDataUrl && (
              <a href={heatmapJpgDataUrl} download={`${sessionToken}-heatmap.jpg`} className="report-download-link">
                Download JPG
              </a>
            )}
          </div>
        </section>
      )}

      <footer className="runner-footer">
        <button onClick={onStopTest} disabled={stage !== "running"} className="stop-button">
          End Test
        </button>
        {stage === "finished" && <p>Done. Camera has been stopped.</p>}
      </footer>
    </main>
  );
}
