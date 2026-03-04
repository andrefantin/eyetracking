import { NextResponse } from "next/server";

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function injectTelemetry(html: string): string {
  const telemetryScript = `
<script>
(function () {
  function postMetrics() {
    try {
      var de = document.documentElement || document.body;
      var body = document.body;
      var scrollY = window.scrollY || window.pageYOffset || 0;
      var docHeight = Math.max(
        de ? de.scrollHeight : 0,
        body ? body.scrollHeight : 0,
        de ? de.offsetHeight : 0,
        body ? body.offsetHeight : 0,
        de ? de.clientHeight : 0
      );
      parent.postMessage({
        type: "proxy_metrics",
        scrollY: scrollY,
        docHeight: docHeight,
        viewportHeight: window.innerHeight || 0,
        href: String(location.href || "")
      }, "*");
    } catch (err) {
      // ignore
    }
  }

  window.addEventListener("scroll", postMetrics, { passive: true });
  window.addEventListener("resize", postMetrics);
  window.addEventListener("load", postMetrics);

  var _pushState = history.pushState;
  history.pushState = function () {
    var result = _pushState.apply(history, arguments);
    setTimeout(postMetrics, 50);
    return result;
  };

  var _replaceState = history.replaceState;
  history.replaceState = function () {
    var result = _replaceState.apply(history, arguments);
    setTimeout(postMetrics, 50);
    return result;
  };

  setInterval(postMetrics, 700);
  postMetrics();
})();
</script>`;

  if (html.includes("</body>")) {
    return html.replace("</body>", `${telemetryScript}</body>`);
  }
  return `${html}${telemetryScript}`;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const target = searchParams.get("target")?.trim() || "";

  if (!target || !isHttpUrl(target)) {
    return NextResponse.json({ error: "Invalid target URL" }, { status: 400 });
  }

  const targetUrl = new URL(target);

  try {
    const response = await fetch(targetUrl.toString(), {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; EyeTrackerProxy/1.0)",
        Accept: "text/html,application/xhtml+xml"
      },
      redirect: "follow"
    });

    if (!response.ok) {
      return NextResponse.json({ error: `Target fetch failed (${response.status})` }, { status: 502 });
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      return NextResponse.json({ error: "Target is not an HTML page" }, { status: 415 });
    }

    const html = await response.text();
    const baseTag = `<base href="${targetUrl.toString()}">`;
    const withBase = html.includes("<head>") ? html.replace("<head>", `<head>${baseTag}`) : `${baseTag}${html}`;
    const withTelemetry = injectTelemetry(withBase);

    return new NextResponse(withTelemetry, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });
  } catch {
    return NextResponse.json({ error: "Proxy error" }, { status: 500 });
  }
}
