"use client";

import { useState } from "react";

type Props = {
  onGranted: (stream: MediaStream) => void;
};

export default function CameraPermissionCard({ onGranted }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);

  const requestCamera = async () => {
    setError(null);
    setRequesting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
        audio: false
      });
      onGranted(stream);
    } catch {
      setError("Camera access denied or unavailable. Please allow access and retry.");
    } finally {
      setRequesting(false);
    }
  };

  return (
    <section className="card">
      <h2>Camera Access</h2>
      <p>This test needs camera access for gaze tracking. Video stays local by default.</p>
      <button onClick={requestCamera} disabled={requesting}>
        {requesting ? "Requesting..." : "Enable Camera"}
      </button>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
