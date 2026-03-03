import type { ClientContext } from "@/lib/types";

export function getClientContext(iframe: HTMLIFrameElement | null): ClientContext {
  const rect = iframe?.getBoundingClientRect();

  return {
    vw: window.innerWidth,
    vh: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
    iframeRect: {
      x: rect?.left ?? 0,
      y: rect?.top ?? 0,
      w: rect?.width ?? window.innerWidth,
      h: rect?.height ?? window.innerHeight
    },
    scrollX: window.scrollX,
    scrollY: window.scrollY
  };
}
