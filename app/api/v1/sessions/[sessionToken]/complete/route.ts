import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    {
      status: "queued",
      mode: "mock",
      serverTs: Date.now()
    },
    { status: 202 }
  );
}
