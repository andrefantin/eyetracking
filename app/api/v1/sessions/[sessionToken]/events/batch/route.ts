import { NextResponse } from "next/server";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const events = Array.isArray(body?.events) ? body.events : [];

    return NextResponse.json(
      {
        accepted: events.length,
        dropped: 0,
        serverTs: Date.now(),
        mode: "mock"
      },
      { status: 202 }
    );
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }
}
