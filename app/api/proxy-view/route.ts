import { NextResponse } from "next/server";

const CHROME_LIKE_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function looksLikeHtml(contentType: string, body: string): boolean {
  const normalized = contentType.toLowerCase();
  if (normalized.includes("text/html") || normalized.includes("application/xhtml+xml")) {
    return true;
  }
  const probe = body.slice(0, 2048).toLowerCase();
  return probe.includes("<!doctype html") || probe.includes("<html");
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
  var activeScroll = {
    top: 0,
    height: 0,
    client: 0,
    updatedAt: 0
  };
  var virtualScroll = {
    offset: 0,
    updatedAt: 0
  };
  var maxSeenDocHeight = 0;
  var maxSeenScrollY = 0;
  var timeline = [];
  window.__eyeProxyTimeline = timeline;

  function pushTimeline(entry) {
    try {
      var prev = timeline.length > 0 ? timeline[timeline.length - 1] : null;
      var changed =
        !prev ||
        Math.abs(prev.scrollY - entry.scrollY) >= 1 ||
        Math.abs(prev.docHeight - entry.docHeight) >= 1 ||
        Math.abs(prev.viewportHeight - entry.viewportHeight) >= 1 ||
        entry.ts - prev.ts >= 700;
      if (!changed) return;
      timeline.push(entry);
      if (timeline.length > 22000) {
        timeline.splice(0, timeline.length - 22000);
      }
      window.__eyeProxyTimeline = timeline;
    } catch (e) {
      // ignore
    }
  }

  function readWindowMetrics() {
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
    return {
      scrollY: scrollY,
      docHeight: docHeight,
      viewportHeight: window.innerHeight || 0
    };
  }

  function readKnownContainerMetrics(winSpan) {
    try {
      var selectors = [
        "[data-scroll-container]",
        "[data-scrollable]",
        "#root",
        "#app",
        "#__next",
        "main",
        ".scroll-container"
      ];
      var best = null;
      for (var i = 0; i < selectors.length; i += 1) {
        var el = document.querySelector(selectors[i]);
        if (!el) continue;
        var top = typeof el.scrollTop === "number" ? el.scrollTop : 0;
        var height = typeof el.scrollHeight === "number" ? el.scrollHeight : 0;
        var client = typeof el.clientHeight === "number" ? el.clientHeight : 0;
        var span = height - client;
        if (span <= 40) continue;
        if (!best || span > best.span) {
          best = {
            scrollY: Math.max(0, top),
            docHeight: Math.max(height, top + client),
            viewportHeight: Math.max(1, client),
            span: span
          };
        }
      }
      if (best && best.span >= winSpan) return best;
      return null;
    } catch (e) {
      return null;
    }
  }

  function readEffectiveMetrics() {
    var win = readWindowMetrics();
    var activeSpan = Math.max(0, activeScroll.height - activeScroll.client);
    var winSpan = Math.max(0, win.docHeight - win.viewportHeight);
    var activeIsFresh = Date.now() - activeScroll.updatedAt < 5000;
    var virtualIsFresh = Date.now() - virtualScroll.updatedAt < 5000;

    if (activeIsFresh && activeSpan > 40 && activeSpan >= winSpan) {
      return {
        scrollY: Math.max(0, activeScroll.top),
        docHeight: Math.max(activeScroll.height, activeScroll.top + activeScroll.client),
        viewportHeight: Math.max(1, activeScroll.client),
        mode: "container"
      };
    }

    var knownContainer = readKnownContainerMetrics(winSpan);
    if (knownContainer) {
      return {
        scrollY: knownContainer.scrollY,
        docHeight: knownContainer.docHeight,
        viewportHeight: knownContainer.viewportHeight,
        mode: "container-known"
      };
    }

    if (virtualIsFresh && Math.abs(virtualScroll.offset - win.scrollY) > 8) {
      return {
        scrollY: Math.max(0, virtualScroll.offset),
        docHeight: Math.max(win.docHeight, virtualScroll.offset + win.viewportHeight),
        viewportHeight: Math.max(1, win.viewportHeight),
        mode: "virtual-wheel"
      };
    }

    return {
      scrollY: Math.max(0, win.scrollY),
      docHeight: Math.max(win.docHeight, win.scrollY + win.viewportHeight),
      viewportHeight: Math.max(1, win.viewportHeight),
      mode: "window"
    };
  }

  function postMetrics() {
    try {
      var effective = readEffectiveMetrics();
      var now = Date.now();
      var stableDocHeight = Math.max(
        maxSeenDocHeight,
        effective.docHeight,
        effective.scrollY + effective.viewportHeight
      );
      maxSeenDocHeight = stableDocHeight;
      maxSeenScrollY = Math.max(maxSeenScrollY, effective.scrollY);
      window.__eyeProxyMetrics = {
        ts: now,
        scrollY: effective.scrollY,
        docHeight: stableDocHeight,
        viewportHeight: effective.viewportHeight,
        scrollMode: effective.mode,
        maxScrollY: maxSeenScrollY
      };
      pushTimeline({
        ts: now,
        scrollY: effective.scrollY,
        docHeight: stableDocHeight,
        viewportHeight: effective.viewportHeight,
        scrollMode: effective.mode
      });
      parent.postMessage({
        type: "proxy_metrics",
        ts: now,
        scrollY: effective.scrollY,
        docHeight: stableDocHeight,
        viewportHeight: effective.viewportHeight,
        scrollMode: effective.mode,
        href: String(location.href || "")
      }, "*");
    } catch (err) {
      // ignore
    }
  }

  window.addEventListener("scroll", function () {
    try {
      var y = window.scrollY || window.pageYOffset || 0;
      virtualScroll.offset = Math.max(0, y);
      virtualScroll.updatedAt = Date.now();
    } catch (e) {
      // ignore
    }
    postMetrics();
  }, { passive: true });
  document.addEventListener("scroll", function (event) {
    try {
      var target = event.target;
      if (!target || target === document || target === window || target === document.documentElement || target === document.body) {
        postMetrics();
        return;
      }
      var top = typeof target.scrollTop === "number" ? target.scrollTop : 0;
      var height = typeof target.scrollHeight === "number" ? target.scrollHeight : 0;
      var client = typeof target.clientHeight === "number" ? target.clientHeight : 0;
      var span = height - client;
      if (span > 40) {
        activeScroll.top = Math.max(0, top);
        activeScroll.height = Math.max(height, top + client);
        activeScroll.client = Math.max(1, client);
        activeScroll.updatedAt = Date.now();
        virtualScroll.offset = Math.max(0, top);
        virtualScroll.updatedAt = Date.now();
      }
      postMetrics();
    } catch (e) {
      postMetrics();
    }
  }, { passive: true, capture: true });
  document.addEventListener("wheel", function (event) {
    try {
      var deltaY = typeof event.deltaY === "number" ? event.deltaY : 0;
      if (!isFinite(deltaY) || deltaY === 0) return;
      var capped = Math.max(-900, Math.min(900, deltaY));
      virtualScroll.offset = Math.max(0, virtualScroll.offset + capped);
      virtualScroll.updatedAt = Date.now();
      postMetrics();
    } catch (e) {
      // ignore
    }
  }, { passive: true, capture: true });
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

  setInterval(postMetrics, 180);
  postMetrics();
})();
</script>`;

  if (sanitizedHtml.includes("<head>")) {
    return sanitizedHtml.replace("<head>", `<head>${telemetryScript}`);
  }
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
    const timeout = setTimeout(() => controller.abort(), 20000);

    const response = await fetch(targetUrl.toString(), {
      headers: {
        "User-Agent": CHROME_LIKE_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
      },
      redirect: "follow",
      signal: controller.signal
    });
    clearTimeout(timeout);

    const contentType = response.headers.get("content-type") || "";
    const html = await response.text();
    if (!looksLikeHtml(contentType, html)) {
      return new NextResponse(proxyErrorHtml(`Target is not an HTML page (content-type: ${contentType || "unknown"})`), {
        status: 415,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
      });
    }

    // Some websites return an HTML error page with non-2xx status. Keep proxy mode available in that case.
    const baseTag = `<base href="${targetUrl.toString()}">`;
    const withBase = html.includes("<head>") ? html.replace("<head>", `<head>${baseTag}`) : `${baseTag}${html}`;
    const withTelemetry = injectTelemetry(withBase);

    return new NextResponse(withTelemetry, {
      status: response.ok ? 200 : response.status,
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
