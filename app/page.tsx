"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function HomePage() {
  const router = useRouter();
  const [token, setToken] = useState("demo-token");

  const openSession = () => {
    const value = token.trim();
    if (!value) return;
    router.push(`/test/${encodeURIComponent(value)}`);
  };

  return (
    <main style={{ padding: 24, fontFamily: "ui-sans-serif, system-ui", maxWidth: 720 }}>
      <h1>Eye Tracker</h1>
      <p>Start a test session by entering a token.</p>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="session token"
          style={{
            padding: "10px 12px",
            borderRadius: 8,
            border: "1px solid #cbd5e1",
            minWidth: 280
          }}
        />
        <button
          type="button"
          onClick={openSession}
          style={{
            padding: "10px 12px",
            borderRadius: 8,
            border: "none",
            background: "#1f3ba8",
            color: "white",
            fontWeight: 600
          }}
        >
          Open Session
        </button>
      </div>
      <p style={{ marginTop: 12 }}>
        Direct URL format: <code>/test/&lt;sessionToken&gt;</code>
      </p>
    </main>
  );
}
