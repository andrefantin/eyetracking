export type SessionStateEventType =
  | "session_pause"
  | "session_resume"
  | "face_lost"
  | "face_reacquired";

export type GazeSampleEvent = {
  type: "gaze_sample";
  ts: number;
  x: number;
  y: number;
  confidence: number;
  screenId: string;
};

export type NavigationChangeEvent = {
  type: "navigation_change";
  ts: number;
  fromScreenId?: string;
  toScreenId: string;
};

export type SessionStateEvent = {
  type: SessionStateEventType;
  ts: number;
};

export type CalibrationResultEvent = {
  type: "calibration_result";
  ts: number;
  pointIndex: number;
  targetX: number;
  targetY: number;
  avgX: number;
  avgY: number;
  errorPx: number;
  score: number;
  sampleCount: number;
};

export type TrackingEvent =
  | GazeSampleEvent
  | NavigationChangeEvent
  | SessionStateEvent
  | CalibrationResultEvent;

export type ClientContext = {
  vw: number;
  vh: number;
  dpr: number;
  iframeRect: { x: number; y: number; w: number; h: number };
  scrollX: number;
  scrollY: number;
};

export type EventsBatchRequest = {
  events: TrackingEvent[];
  clientContext: ClientContext;
};
