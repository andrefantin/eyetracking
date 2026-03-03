"use client";

import { CALIBRATION_POINTS } from "@/lib/calibration";

type Props = {
  currentIndex: number;
  onPointConfirmed: (index: number) => void;
};

export default function CalibrationLayer({ currentIndex, onPointConfirmed }: Props) {
  return (
    <div className="calibration-layer" aria-label="Calibration">
      {CALIBRATION_POINTS.map((point, index) => {
        const active = currentIndex === index;
        const done = currentIndex > index;
        return (
          <button
            key={`${point.x}-${point.y}`}
            type="button"
            className={`cal-point ${active ? "active" : ""} ${done ? "done" : ""}`}
            style={{ left: `${point.x}%`, top: `${point.y}%` }}
            disabled={!active}
            onClick={() => onPointConfirmed(index)}
          >
            {index + 1}
          </button>
        );
      })}
      <p className="calibration-help">
        Click each highlighted point while looking directly at it. If detection is slow, wait 1-2 seconds and click again.
      </p>
    </div>
  );
}
