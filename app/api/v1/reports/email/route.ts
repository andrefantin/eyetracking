import { NextResponse } from "next/server";

type TopScreen = { screenId: string; samples: number };

type RequestBody = {
  sessionToken: string;
  participantName?: string;
  figmaUrl: string;
  summary: {
    totalSamples: number;
    avgConfidence: number;
    durationSec: number;
    topScreens: TopScreen[];
  };
  heatmapPngDataUrl?: string;
  heatmapJpgDataUrl?: string;
};

function dataUrlToBase64(dataUrl?: string): string | null {
  if (!dataUrl || !dataUrl.startsWith("data:")) return null;
  const parts = dataUrl.split(",");
  if (parts.length < 2) return null;
  return parts[1] ?? null;
}

export async function POST(request: Request) {
  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body?.sessionToken || !body?.figmaUrl || !body?.summary) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const resendApiKey = process.env.RESEND_API_KEY;
  const toEmail = process.env.REPORT_EMAIL_TO || "andre.goncalves@allhuman.com";
  const fromEmail = process.env.REPORT_EMAIL_FROM || "Eye Tracker <reports@updates.allhuman.com>";

  if (!resendApiKey) {
    return NextResponse.json(
      {
        status: "skipped",
        reason: "RESEND_API_KEY not configured"
      },
      { status: 202 }
    );
  }

  const topScreensHtml =
    body.summary.topScreens.length > 0
      ? `<ul>${body.summary.topScreens
          .map((entry) => `<li>${entry.screenId}: ${entry.samples} samples</li>`)
          .join("")}</ul>`
      : "<p>No screen-level gaze data collected.</p>";

  const pngBase64 = dataUrlToBase64(body.heatmapPngDataUrl);
  const jpgBase64 = dataUrlToBase64(body.heatmapJpgDataUrl);

  const emailPayload = {
    from: fromEmail,
    to: [toEmail],
    subject: `Eye Tracking Report - ${body.sessionToken}`,
    html: `
      <h2>Eye Tracking Session Report</h2>
      <p><strong>Session ID:</strong> ${body.sessionToken}</p>
      <p><strong>Participant:</strong> ${body.participantName || "N/A"}</p>
      <p><strong>Target URL:</strong> <a href="${body.figmaUrl}">${body.figmaUrl}</a></p>
      <h3>Summary</h3>
      <p><strong>Total samples:</strong> ${body.summary.totalSamples}</p>
      <p><strong>Average confidence:</strong> ${body.summary.avgConfidence}</p>
      <p><strong>Duration:</strong> ${body.summary.durationSec}s</p>
      <h4>Top viewed screens</h4>
      ${topScreensHtml}
      <p>Heatmap images are attached when available.</p>
    `,
    attachments: [
      pngBase64
        ? {
            filename: `${body.sessionToken}-heatmap.png`,
            content: pngBase64
          }
        : null,
      jpgBase64
        ? {
            filename: `${body.sessionToken}-heatmap.jpg`,
            content: jpgBase64
          }
        : null
    ].filter(Boolean)
  };

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(emailPayload)
  });

  if (!response.ok) {
    const text = await response.text();
    return NextResponse.json({ error: `Resend error: ${text}` }, { status: 502 });
  }

  return NextResponse.json({ status: "sent" }, { status: 200 });
}
