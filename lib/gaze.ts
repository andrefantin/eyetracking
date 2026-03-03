export type GazePoint = {
  x: number;
  y: number;
  confidence: number;
  ts: number;
};

type GazeHandler = (point: GazePoint) => void;

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
  start: () => Promise<void>;
  stop: () => void;
  setListener: (listener: GazeHandler | null) => void;
  isRunning: () => boolean;
  recordCalibrationPoint: (targetX: number, targetY: number) => CalibrationPointResult | null;
  getEngineName: () => "webgazer" | "pointer-fallback";
};

type WebGazerLike = {
  begin?: () => Promise<unknown> | unknown;
  end?: () => void;
  showVideo?: (show: boolean) => WebGazerLike | unknown;
  showPredictionPoints?: (show: boolean) => WebGazerLike | unknown;
  saveDataAcrossSessions?: (save: boolean) => WebGazerLike | unknown;
  setGazeListener?: (cb: (data: { x: number; y: number } | null, ts: number) => void) => WebGazerLike | unknown;
  clearGazeListener?: () => WebGazerLike;
  pause?: () => WebGazerLike;
  resume?: () => WebGazerLike;
  recordScreenPosition?: (x: number, y: number, eventType?: string) => void;
};

declare global {
  interface Window {
    webgazer?: WebGazerLike;
  }
}

const WEBGAZER_SCRIPT_ID = "webgazer-script";
const WEBGAZER_PRIMARY_URL = "https://cdn.jsdelivr.net/npm/webgazer@3.4.0/dist/webgazer.js";
const WEBGAZER_FALLBACK_URL = "https://webgazer.cs.brown.edu/webgazer.js";

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

async function appendWebGazerScript(scriptUrl: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.id = WEBGAZER_SCRIPT_ID;
    script.src = scriptUrl;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load WebGazer script: ${scriptUrl}`));
    document.head.appendChild(script);
  });
}

function removeExistingWebGazerScript(): void {
  const existing = document.getElementById(WEBGAZER_SCRIPT_ID);
  if (existing?.parentNode) {
    existing.parentNode.removeChild(existing);
  }
}

async function loadWebGazerScript(): Promise<WebGazerLike | null> {
  if (typeof window === "undefined") return null;
  if (window.webgazer) return window.webgazer;

  const existing = document.getElementById(WEBGAZER_SCRIPT_ID) as HTMLScriptElement | null;
  if (existing) {
    await new Promise<void>((resolve, reject) => {
      if (window.webgazer) {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Failed to load WebGazer")), { once: true });
    });
    return window.webgazer ?? null;
  }

  const configuredScriptUrl =
    process.env.NEXT_PUBLIC_WEBGAZER_SCRIPT_URL &&
    process.env.NEXT_PUBLIC_WEBGAZER_SCRIPT_URL.trim().length > 0
      ? process.env.NEXT_PUBLIC_WEBGAZER_SCRIPT_URL.trim()
      : undefined;
  const scriptUrls = [configuredScriptUrl, WEBGAZER_PRIMARY_URL, WEBGAZER_FALLBACK_URL].filter(
    (url): url is string => typeof url === "string" && url.length > 0
  );
  let lastError: Error | null = null;

  for (const scriptUrl of scriptUrls) {
    try {
      removeExistingWebGazerScript();
      await appendWebGazerScript(scriptUrl);
      if (window.webgazer) return window.webgazer;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error("Unknown WebGazer load error");
    }
  }

  if (lastError) throw lastError;

  return window.webgazer ?? null;
}

function createWebGazerEngine(webgazer: WebGazerLike): GazeEngine {
  let listener: GazeHandler | null = null;
  let running = false;
  let recentPoints: GazePoint[] = [];

  const gazeListener = (data: { x: number; y: number } | null, ts: number) => {
    if (!running || !listener || !data) return;
    const point: GazePoint = {
      x: data.x,
      y: data.y,
      confidence: 0.8,
      ts: Number.isFinite(ts) ? ts : Date.now()
    };

    recentPoints.push(point);
    if (recentPoints.length > 120) recentPoints = recentPoints.slice(-120);
    listener(point);
  };

  // Keep integration minimal to avoid runtime incompatibilities across WebGazer builds.
  if (typeof webgazer.setGazeListener === "function") {
    webgazer.setGazeListener(gazeListener);
  } else {
    throw new Error("WebGazer setGazeListener API unavailable");
  }

  return {
    async start() {
      if (running) return;
      if (typeof webgazer.begin !== "function") {
        throw new Error("WebGazer begin API unavailable");
      }
      await Promise.resolve(webgazer.begin());
      if (webgazer.resume) webgazer.resume();
      running = true;
    },
    stop() {
      if (!running) return;
      running = false;
      if (webgazer.pause) webgazer.pause();
    },
    setListener(nextListener) {
      listener = nextListener;
    },
    isRunning() {
      return running;
    },
    recordCalibrationPoint(targetX: number, targetY: number) {
      if (webgazer.recordScreenPosition) {
        webgazer.recordScreenPosition(targetX, targetY, "click");
      }

      const calibrationWindow = recentPoints.slice(-25);
      if (!calibrationWindow.length) return null;

      const sum = calibrationWindow.reduce(
        (acc, point) => {
          acc.x += point.x;
          acc.y += point.y;
          return acc;
        },
        { x: 0, y: 0 }
      );

      const avgX = sum.x / calibrationWindow.length;
      const avgY = sum.y / calibrationWindow.length;
      const errorPx = distance(avgX, avgY, targetX, targetY);

      return {
        targetX,
        targetY,
        sampleCount: calibrationWindow.length,
        avgX,
        avgY,
        errorPx,
        score: scoreFromErrorPx(errorPx)
      };
    },
    getEngineName() {
      return "webgazer";
    }
  };
}

export function createPointerFallbackEngine(): GazeEngine {
  let listener: GazeHandler | null = null;
  let running = false;
  let recentPoints: GazePoint[] = [];

  const onMove = (event: MouseEvent) => {
    if (!listener || !running) return;
    const point: GazePoint = {
      x: event.clientX,
      y: event.clientY,
      confidence: 0.65,
      ts: Date.now()
    };
    recentPoints.push(point);
    if (recentPoints.length > 120) recentPoints = recentPoints.slice(-120);
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
      const sample = recentPoints.at(-1);
      if (!sample) return null;
      const errorPx = distance(sample.x, sample.y, targetX, targetY);
      return {
        targetX,
        targetY,
        sampleCount: 1,
        avgX: sample.x,
        avgY: sample.y,
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
  try {
    const webgazer = await loadWebGazerScript();
    if (webgazer && typeof webgazer.setGazeListener === "function" && typeof webgazer.begin === "function") {
      return createWebGazerEngine(webgazer);
    }
  } catch {
    // fall through to pointer fallback
  }

  return createPointerFallbackEngine();
}
