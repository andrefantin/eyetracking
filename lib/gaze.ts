export type GazePoint = {
  x: number;
  y: number;
  confidence: number;
  ts: number;
};

type GazeHandler = (point: GazePoint) => void;

type RawGazeFeature = {
  x: number; // normalized [0..1]
  y: number; // normalized [0..1]
};

type CalibrationSample = {
  rawX: number;
  rawY: number;
  targetX: number;
  targetY: number;
};

type GazeModel = {
  x: [number, number, number];
  y: [number, number, number];
};

export type CalibrationPointResult = {
  targetX: number;
  targetY: number;
  sampleCount: number;
  avgX: number;
  avgY: number;
  errorPx: number;
  score: number;
};

export type GazeEngine = {
  start: (stream?: MediaStream | null) => Promise<void>;
  stop: () => void;
  setListener: (listener: GazeHandler | null) => void;
  isRunning: () => boolean;
  recordCalibrationPoint: (targetX: number, targetY: number) => CalibrationPointResult | null;
  getEngineName: () => "mediapipe" | "pointer-fallback";
};

type FaceLandmark = { x: number; y: number; z?: number };
type FaceMeshResults = {
  multiFaceLandmarks?: FaceLandmark[][];
};

type FaceMeshLike = {
  setOptions: (options: Record<string, unknown>) => void;
  onResults: (cb: (results: FaceMeshResults) => void) => void;
  send: (payload: { image: HTMLVideoElement }) => Promise<void>;
  close?: () => void;
};

type FaceMeshCtor = new (config: { locateFile: (file: string) => string }) => FaceMeshLike;

declare global {
  interface Window {
    FaceMesh?: FaceMeshCtor;
  }
}

const MEDIAPIPE_FACE_MESH_SCRIPT_ID = "mediapipe-face-mesh-script";
const MEDIAPIPE_FACE_MESH_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/face_mesh.js";
const MEDIAPIPE_FACE_MESH_ASSET_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh";

function distance(aX: number, aY: number, bX: number, bY: number): number {
  const dx = aX - bX;
  const dy = aY - bY;
  return Math.sqrt(dx * dx + dy * dy);
}

function scoreFromErrorPx(errorPx: number): number {
  const worstUsefulError = 300;
  const normalized = Math.max(0, 1 - errorPx / worstUsefulError);
  return Math.round(normalized * 100);
}

function averagePoint(points: FaceLandmark[]): RawGazeFeature | null {
  if (!points.length) return null;
  const sum = points.reduce(
    (acc, point) => {
      acc.x += point.x;
      acc.y += point.y;
      return acc;
    },
    { x: 0, y: 0 }
  );
  return { x: sum.x / points.length, y: sum.y / points.length };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function extractRawFeature(landmarks: FaceLandmark[]): RawGazeFeature | null {
  // Iris landmarks when refineLandmarks=true.
  const leftIrisIdx = [468, 469, 470, 471, 472];
  const rightIrisIdx = [473, 474, 475, 476, 477];

  const leftIris = leftIrisIdx
    .map((index) => landmarks[index])
    .filter((point): point is FaceLandmark => Boolean(point));
  const rightIris = rightIrisIdx
    .map((index) => landmarks[index])
    .filter((point): point is FaceLandmark => Boolean(point));

  let eyeCenter: RawGazeFeature | null = null;
  if (leftIris.length >= 3 && rightIris.length >= 3) {
    const l = averagePoint(leftIris);
    const r = averagePoint(rightIris);
    if (l && r) {
      eyeCenter = { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 };
    }
  }

  // Fallback: use eye corners if iris is not available.
  if (!eyeCenter) {
    const leftOuter = landmarks[33];
    const leftInner = landmarks[133];
    const rightInner = landmarks[362];
    const rightOuter = landmarks[263];
    if (leftOuter && leftInner && rightInner && rightOuter) {
      eyeCenter = {
        x: (leftOuter.x + leftInner.x + rightInner.x + rightOuter.x) / 4,
        y: (leftOuter.y + leftInner.y + rightInner.y + rightOuter.y) / 4
      };
    }
  }

  if (!eyeCenter) return null;
  return { x: clamp(eyeCenter.x, 0, 1), y: clamp(eyeCenter.y, 0, 1) };
}

function solve3x3(matrix: number[][], vector: number[]): [number, number, number] | null {
  const a = matrix.map((row) => [...row]);
  const b = [...vector];

  for (let col = 0; col < 3; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 3; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) {
        pivot = row;
      }
    }

    if (Math.abs(a[pivot][col]) < 1e-9) return null;

    if (pivot !== col) {
      [a[col], a[pivot]] = [a[pivot], a[col]];
      [b[col], b[pivot]] = [b[pivot], b[col]];
    }

    const pivotValue = a[col][col];
    for (let c = col; c < 3; c += 1) {
      a[col][c] /= pivotValue;
    }
    b[col] /= pivotValue;

    for (let row = 0; row < 3; row += 1) {
      if (row === col) continue;
      const factor = a[row][col];
      for (let c = col; c < 3; c += 1) {
        a[row][c] -= factor * a[col][c];
      }
      b[row] -= factor * b[col];
    }
  }

  return [b[0], b[1], b[2]];
}

function fitCalibrationModel(samples: CalibrationSample[]): GazeModel | null {
  if (samples.length < 3) return null;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let sx = 0;
  let sy = 0;
  let n = 0;

  let bxX = 0;
  let byX = 0;
  let b1X = 0;

  let bxY = 0;
  let byY = 0;
  let b1Y = 0;

  for (const sample of samples) {
    const x = sample.rawX;
    const y = sample.rawY;
    const one = 1;

    sxx += x * x;
    syy += y * y;
    sxy += x * y;
    sx += x;
    sy += y;
    n += one;

    bxX += x * sample.targetX;
    byX += y * sample.targetX;
    b1X += sample.targetX;

    bxY += x * sample.targetY;
    byY += y * sample.targetY;
    b1Y += sample.targetY;
  }

  const normalMatrix = [
    [sxx, sxy, sx],
    [sxy, syy, sy],
    [sx, sy, n]
  ];

  const coeffX = solve3x3(normalMatrix, [bxX, byX, b1X]);
  const coeffY = solve3x3(normalMatrix, [bxY, byY, b1Y]);

  if (!coeffX || !coeffY) return null;

  return {
    x: coeffX,
    y: coeffY
  };
}

function predictFromModel(model: GazeModel | null, raw: RawGazeFeature): { x: number; y: number } {
  if (!model) {
    return {
      x: raw.x * window.innerWidth,
      y: raw.y * window.innerHeight
    };
  }

  const x = model.x[0] * raw.x + model.x[1] * raw.y + model.x[2];
  const y = model.y[0] * raw.x + model.y[1] * raw.y + model.y[2];
  return {
    x: clamp(x, 0, window.innerWidth),
    y: clamp(y, 0, window.innerHeight)
  };
}

async function loadFaceMeshScript(): Promise<FaceMeshCtor | null> {
  if (typeof window === "undefined") return null;
  if (window.FaceMesh) return window.FaceMesh;

  const existing = document.getElementById(MEDIAPIPE_FACE_MESH_SCRIPT_ID) as HTMLScriptElement | null;
  if (existing) {
    await new Promise<void>((resolve, reject) => {
      if (window.FaceMesh) {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Failed to load MediaPipe FaceMesh")), {
        once: true
      });
    });
    return window.FaceMesh ?? null;
  }

  await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.id = MEDIAPIPE_FACE_MESH_SCRIPT_ID;
    script.src = MEDIAPIPE_FACE_MESH_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load MediaPipe FaceMesh script"));
    document.head.appendChild(script);
  });

  return window.FaceMesh ?? null;
}

function createHiddenVideoElement(): HTMLVideoElement {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.style.position = "fixed";
  video.style.width = "1px";
  video.style.height = "1px";
  video.style.opacity = "0";
  video.style.pointerEvents = "none";
  video.style.left = "-10000px";
  document.body.appendChild(video);
  return video;
}

async function createMediapipeEngine(): Promise<GazeEngine> {
  const FaceMesh = await loadFaceMeshScript();
  if (!FaceMesh) {
    throw new Error("MediaPipe FaceMesh API unavailable");
  }

  const faceMesh = new FaceMesh({
    locateFile: (file: string) => `${MEDIAPIPE_FACE_MESH_ASSET_BASE}/${file}`
  });

  faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5
  });

  let listener: GazeHandler | null = null;
  let running = false;
  let rafId: number | null = null;
  let inFlight = false;
  let videoEl: HTMLVideoElement | null = null;
  let latestRaw: RawGazeFeature | null = null;
  let latestMapped: { x: number; y: number } | null = null;
  const calibrationSamples: CalibrationSample[] = [];
  let model: GazeModel | null = null;

  faceMesh.onResults((results: FaceMeshResults) => {
    if (!running) return;
    const landmarks = results.multiFaceLandmarks?.[0];
    if (!landmarks) return;

    const raw = extractRawFeature(landmarks);
    if (!raw) return;

    latestRaw = raw;
    const mapped = predictFromModel(model, raw);
    latestMapped = mapped;

    if (listener) {
      listener({
        x: mapped.x,
        y: mapped.y,
        confidence: model ? 0.82 : 0.6,
        ts: Date.now()
      });
    }
  });

  const loop = async () => {
    if (!running || !videoEl) return;
    if (!inFlight && videoEl.readyState >= 2) {
      inFlight = true;
      try {
        await faceMesh.send({ image: videoEl });
      } catch {
        // Ignore intermittent frame processing issues.
      } finally {
        inFlight = false;
      }
    }
    rafId = window.requestAnimationFrame(() => {
      void loop();
    });
  };

  return {
    async start(stream?: MediaStream | null) {
      if (running) return;
      if (!stream) {
        throw new Error("Camera stream is required for MediaPipe tracking");
      }

      if (!videoEl) {
        videoEl = createHiddenVideoElement();
      }

      videoEl.srcObject = stream;
      await videoEl.play();

      running = true;
      rafId = window.requestAnimationFrame(() => {
        void loop();
      });
    },
    stop() {
      if (!running) return;
      running = false;
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (videoEl) {
        videoEl.pause();
        videoEl.srcObject = null;
      }
    },
    setListener(nextListener) {
      listener = nextListener;
    },
    isRunning() {
      return running;
    },
    recordCalibrationPoint(targetX: number, targetY: number) {
      if (!latestRaw) return null;

      calibrationSamples.push({
        rawX: latestRaw.x,
        rawY: latestRaw.y,
        targetX,
        targetY
      });

      const fitted = fitCalibrationModel(calibrationSamples);
      if (fitted) {
        model = fitted;
      }

      const estimate = latestMapped ?? predictFromModel(model, latestRaw);
      const errorPx = distance(estimate.x, estimate.y, targetX, targetY);

      return {
        targetX,
        targetY,
        sampleCount: calibrationSamples.length,
        avgX: estimate.x,
        avgY: estimate.y,
        errorPx,
        score: scoreFromErrorPx(errorPx)
      };
    },
    getEngineName() {
      return "mediapipe";
    }
  };
}

export function createPointerFallbackEngine(): GazeEngine {
  let listener: GazeHandler | null = null;
  let running = false;
  let latestPoint: GazePoint | null = null;

  const onMove = (event: MouseEvent) => {
    if (!listener || !running) return;
    const point: GazePoint = {
      x: event.clientX,
      y: event.clientY,
      confidence: 0.65,
      ts: Date.now()
    };
    latestPoint = point;
    listener(point);
  };

  return {
    async start() {
      if (running) return;
      running = true;
      window.addEventListener("mousemove", onMove);
    },
    stop() {
      if (!running) return;
      running = false;
      window.removeEventListener("mousemove", onMove);
    },
    setListener(nextListener) {
      listener = nextListener;
    },
    isRunning() {
      return running;
    },
    recordCalibrationPoint(targetX: number, targetY: number) {
      if (!latestPoint) return null;
      const errorPx = distance(latestPoint.x, latestPoint.y, targetX, targetY);
      return {
        targetX,
        targetY,
        sampleCount: 1,
        avgX: latestPoint.x,
        avgY: latestPoint.y,
        errorPx,
        score: scoreFromErrorPx(errorPx)
      };
    },
    getEngineName() {
      return "pointer-fallback";
    }
  };
}

export async function createGazeEngine(): Promise<GazeEngine> {
  return createMediapipeEngine();
}
