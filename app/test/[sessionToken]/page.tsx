"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import CalibrationLayer from "@/components/CalibrationLayer";
import CameraPermissionCard from "@/components/CameraPermissionCard";
import GazeOverlay from "@/components/GazeOverlay";
import { completeSession, postEventsBatch } from "@/lib/api";
import { CALIBRATION_POINTS } from "@/lib/calibration";
import { createGazeEngine, type CalibrationPointResult, type GazeEngine, type GazePoint } from "@/lib/gaze";
import { getClientContext } from "@/lib/mapping";
import type { TrackingEvent } from "@/lib/types";

type TestStage = "permission" | "calibration" | "running" | "finished";

type PageProps = {
  params: { sessionToken: string };
};

const BATCH_INTERVAL_MS = 750;
const BATCH_MAX_EVENTS = 50;
const FIGMA_URL_PLACEHOLDER = "https://www.figma.com/proto/your-file-id/your-prototype";

export default function TestRunnerPage({ params }: PageProps) {
  const { sessionToken } = params;
  const [stage, setStage] = useState<TestStage>("permission");
  const [calibrationIndex, setCalibrationIndex] = useState(0);
  const [currentScreenId, setCurrentScreenId] = useState("screen-default");
  const [gazePoint, setGazePoint] = useState<{ x: number; y: number } | null>(null);
  const [status, setStatus] = useState("Waiting for camera permission");
  const [error, setError] = useState<string | null>(null);
  const [engineName, setEngineName] = useState<"webgazer" | "pointer-fallback" | null>(null);
  const [calibrationScores, setCalibrationScores] = useState<number[]>([]);

  const streamRef = useRef<MediaStream | null>(null);
  const engineRef = useRef<GazeEngine | null>(null);
  const bufferRef = useRef<TrackingEvent[]>([]);
  const flushTimerRef = useRef<number | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const currentScreenIdRef = useRef(currentScreenId);

  const figmaEmbedUrl = useMemo(() => {
    const candidate = process.env.NEXT_PUBLIC_FIGMA_EMBED_URL ?? FIGMA_URL_PLACEHOLDER;
    return candidate.includes("embed_host") ? candidate : `${candidate}${candidate.includes("?") ? "&" : "?"}embed_host=eye-tracker`;
  }, []);

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

  const handleGaze = (point: GazePoint) => {
    setGazePoint({ x: point.x, y: point.y });
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
    if (!engineRef.current) {
      engineRef.current = await createGazeEngine();
      setEngineName(engineRef.current.getEngineName());
    }

    engineRef.current.setListener(handleGaze);
    await engineRef.current.start();
  };

  const stopEngine = () => {
    engineRef.current?.setListener(null);
    engineRef.current?.stop();
  };

  const stopTracking = () => {
    stopEngine();
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
    const result = engineRef.current?.recordCalibrationPoint(targetX, targetY) ?? null;

    handleCalibrationResult(index, result);

    if (result === null) return;

    if (index + 1 >= CALIBRATION_POINTS.length) {
      setStage("running");
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

    try {
      await completeSession(sessionToken);
      setStage("finished");
      setStatus("Session complete. Report generation has started.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to complete session");
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
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="runner-root">
      <header className="runner-header">
        <div>
          <h1>Prototype Test Session</h1>
          <p>Session: {sessionToken}</p>
        </div>
        <div className="status-pill">{status}</div>
      </header>

      {error && <p className="error-banner">{error}</p>}

      <section className="meta-strip">
        <span>Engine: {engineName ?? "not initialized"}</span>
        <span>
          Calibration score: {averageCalibrationScore !== null ? `${averageCalibrationScore}/100` : "pending"}
        </span>
      </section>

      {stage === "permission" && <CameraPermissionCard onGranted={onCameraGranted} />}

      {stage !== "permission" && (
        <section className="prototype-shell">
          <iframe
            ref={iframeRef}
            title="Figma Prototype"
            src={figmaEmbedUrl}
            className="prototype-frame"
            allow="camera; microphone"
          />
          <GazeOverlay x={gazePoint?.x ?? 0} y={gazePoint?.y ?? 0} visible={(stage === "running" || stage === "calibration") && !!gazePoint} />
          {stage === "calibration" && (
            <CalibrationLayer currentIndex={calibrationIndex} onPointConfirmed={onCalibrationPointConfirmed} />
          )}
        </section>
      )}

      <footer className="runner-footer">
        <button onClick={onStopTest} disabled={stage !== "running"} className="stop-button">
          End Test
        </button>
        {stage === "finished" && <p>Done. You can close this window.</p>}
      </footer>
    </main>
  );
}
