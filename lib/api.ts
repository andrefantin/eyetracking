import type { ClientContext, EventsBatchRequest, TrackingEvent } from "@/lib/types";

function getApiBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (configured && configured.trim().length > 0) {
    return configured.replace(/\/+$/, "");
  }
  return "";
}

export async function postEventsBatch(
  sessionToken: string,
  events: TrackingEvent[],
  clientContext: ClientContext
): Promise<void> {
  if (!events.length) return;

  const payload: EventsBatchRequest = { events, clientContext };
  const apiBaseUrl = getApiBaseUrl();
  const response = await fetch(`${apiBaseUrl}/api/v1/sessions/${sessionToken}/events/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Batch upload failed (${response.status})`);
  }
}

export async function completeSession(sessionToken: string): Promise<void> {
  const apiBaseUrl = getApiBaseUrl();
  const response = await fetch(`${apiBaseUrl}/api/v1/sessions/${sessionToken}/complete`, {
    method: "POST"
  });

  if (!response.ok) {
    throw new Error(`Session complete failed (${response.status})`);
  }
}
