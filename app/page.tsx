"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

const figmaUrlPattern = /^https:\/\/(www\.)?figma\.com\/proto\/.+/i;

function makeSessionToken(participant: string): string {
  const base = participant
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
    now.getDate()
  ).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${base || "session"}-${stamp}-${rand}`;
}

export default function HomePage() {
  const router = useRouter();
  const [participant, setParticipant] = useState("");
  const [figmaUrl, setFigmaUrl] = useState("");
  const [token, setToken] = useState("demo-token");
  const [error, setError] = useState<string | null>(null);

  const generatedToken = useMemo(() => makeSessionToken(participant), [participant]);

  const openSession = (useGeneratedToken: boolean) => {
    const chosenToken = (useGeneratedToken ? generatedToken : token).trim();
    const trimmedFigmaUrl = figmaUrl.trim();
    const trimmedParticipant = participant.trim();

    if (!chosenToken) {
      setError("Session token is required.");
      return;
    }

    if (trimmedFigmaUrl.length > 0 && !figmaUrlPattern.test(trimmedFigmaUrl)) {
      setError("Please paste a valid Figma prototype URL (https://www.figma.com/proto/...).");
      return;
    }

    setError(null);
    const query = new URLSearchParams();
    if (trimmedFigmaUrl) query.set("figmaUrl", trimmedFigmaUrl);
    if (trimmedParticipant) query.set("participant", trimmedParticipant);
    const queryString = query.toString();

    router.push(`/test/${encodeURIComponent(chosenToken)}${queryString ? `?${queryString}` : ""}`);
  };

  const fillGeneratedToken = () => {
    setToken(generatedToken);
  };

  const openSessionWithManualToken = () => {
    const value = token.trim();
    if (!value) return;
    openSession(false);
  };

  return (
    <main style={{ padding: 24, fontFamily: "ui-sans-serif, system-ui", maxWidth: 760 }}>
      <h1>Eye Tracker</h1>
      <p>Set up a participant session and optionally paste a Figma prototype URL for this run.</p>

      <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
        <label style={{ display: "grid", gap: 6 }}>
          <span>Participant name (optional)</span>
          <input
            value={participant}
            onChange={(event) => setParticipant(event.target.value)}
            placeholder="e.g. Participant 01"
            style={{
              padding: "10px 12px",
              borderRadius: 8,
              border: "1px solid #cbd5e1"
            }}
          />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <span>Figma prototype URL (optional)</span>
          <input
            value={figmaUrl}
            onChange={(event) => setFigmaUrl(event.target.value)}
            placeholder="https://www.figma.com/proto/..."
            style={{
              padding: "10px 12px",
              borderRadius: 8,
              border: "1px solid #cbd5e1"
            }}
          />
        </label>
      </div>

      <div style={{ display: "grid", gap: 8, marginTop: 16 }}>
        <p style={{ margin: 0 }}>
          Suggested token: <code>{generatedToken}</code>
        </p>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={fillGeneratedToken}
            style={{
              padding: "10px 12px",
              borderRadius: 8,
              border: "none",
              background: "#334155",
              color: "white",
              fontWeight: 600
            }}
          >
            Use Suggested Token
          </button>
          <button
            type="button"
            onClick={() => openSession(true)}
            style={{
              padding: "10px 12px",
              borderRadius: 8,
              border: "none",
              background: "#1f3ba8",
              color: "white",
              fontWeight: 600
            }}
          >
            Start Session
          </button>
        </div>
      </div>

      <p style={{ marginTop: 18, marginBottom: 8 }}>Or enter a manual session token:</p>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
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
          onClick={openSessionWithManualToken}
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
      {error && <p style={{ color: "#b42318", marginTop: 10 }}>{error}</p>}
      <p style={{ marginTop: 12 }}>
        Direct URL format: <code>/test/&lt;sessionToken&gt;</code>
      </p>
    </main>
  );
}
