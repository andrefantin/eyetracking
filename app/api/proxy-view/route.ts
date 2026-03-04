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
  // Remove CSP meta tags so injected telemetry script can run in proxied document.
  const sanitizedHtml = html.replace(
    /<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi,
    ""
  );
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

  if (sanitizedHtml.includes("</body>")) {
    return sanitizedHtml.replace("</body>", `${telemetryScript}</body>`);
  }
  return `${sanitizedHtml}${telemetryScript}`;
}

function proxyErrorHtml(message: string): string {
  const safe = message.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Proxy Error</title></head>
  <body style="font-family: ui-sans-serif, system-ui; padding: 20px;">
    <h3>Proxy could not load this website</h3>
    <p>${safe}</p>
    <script>
      try {
        parent.postMessage({ type: "proxy_error", message: ${JSON.stringify(message)} }, "*");
      } catch (e) {}
    </script>
  </body>
</html>`;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const target = searchParams.get("target")?.trim() || "";

  if (!target || !isHttpUrl(target)) {
    return new NextResponse(proxyErrorHtml("Invalid target URL"), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
    });
  }

  const targetUrl = new URL(target);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(targetUrl.toString(), {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; EyeTrackerProxy/1.0)",
        Accept: "text/html,application/xhtml+xml"
      },
      redirect: "follow",
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return new NextResponse(proxyErrorHtml(`Target fetch failed (${response.status})`), {
        status: 502,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
      });
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      return new NextResponse(proxyErrorHtml("Target is not an HTML page"), {
        status: 415,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
      });
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
    return new NextResponse(proxyErrorHtml("Proxy error"), {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
    });
  }
}
