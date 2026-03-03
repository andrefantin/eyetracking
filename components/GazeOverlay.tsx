"use client";

type Props = {
  x: number;
  y: number;
  visible: boolean;
};

export default function GazeOverlay({ x, y, visible }: Props) {
  if (!visible) return null;

  return (
    <div
      className="gaze-overlay"
      style={{
        transform: `translate(${x - 10}px, ${y - 10}px)`
      }}
    />
  );
}
