import { describe, expect, it } from "vitest";
import {
  SIDECAR_DESKTOP_WEBVIEW_PROPS,
  SIDECAR_USER_AGENT_LINUX,
  SIDECAR_USER_AGENT_MACOS,
  SIDECAR_VIEWPORT_SCRIPT,
  SIDECAR_ZOOM_DEFAULT,
  SIDECAR_ZOOM_MAX,
  SIDECAR_ZOOM_MIN,
  SIDECAR_ZOOM_STEP,
  nextZoom,
  sidecarDesktopWebViewProps,
  sidecarUserAgent,
  sidecarZoomDefault,
  zoomScript,
} from "./sidecar-webview-config";

describe("SIDECAR_DESKTOP_WEBVIEW_PROPS", () => {
  const expected: Record<string, unknown> = {
    setBuiltInZoomControls: true,
    setDisplayZoomControls: false,
  };

  for (const [key, value] of Object.entries(expected)) {
    it(`has ${key} = ${JSON.stringify(value)} [bite-proof: flip this and the test fails]`, () => {
      expect((SIDECAR_DESKTOP_WEBVIEW_PROPS as Record<string, unknown>)[key]).toEqual(value);
    });
  }

  it("has exactly these props, nothing extra", () => {
    expect(Object.keys(SIDECAR_DESKTOP_WEBVIEW_PROPS).sort()).toEqual(Object.keys(expected).sort());
  });

  it("is frozen", () => {
    expect(Object.isFrozen(SIDECAR_DESKTOP_WEBVIEW_PROPS)).toBe(true);
  });
});

describe("desktop user agent strings", () => {
  const NO_MOBILE_TOKENS = ["Mobile", "Android", "iPhone"];

  it.each([
    ["SIDECAR_USER_AGENT_MACOS", SIDECAR_USER_AGENT_MACOS],
    ["SIDECAR_USER_AGENT_LINUX", SIDECAR_USER_AGENT_LINUX],
  ])(
    "%s contains no mobile-sniffing token " +
      '[bite-proof: add "Mobile"/"Android"/"iPhone" to either UA string and this fails]',
    (_name, ua) => {
      for (const token of NO_MOBILE_TOKENS) {
        expect(ua).not.toContain(token);
      }
    },
  );

  it("both strings claim to be a current desktop Chrome", () => {
    expect(SIDECAR_USER_AGENT_MACOS).toContain("Chrome/");
    expect(SIDECAR_USER_AGENT_LINUX).toContain("Chrome/");
  });

  it("the macOS string is Macintosh-shaped, the Linux string is X11-shaped", () => {
    expect(SIDECAR_USER_AGENT_MACOS).toContain("Macintosh");
    expect(SIDECAR_USER_AGENT_LINUX).toContain("X11; Linux");
  });
});

describe("sidecarUserAgent", () => {
  it("picks the macOS-style UA on iOS", () => {
    expect(sidecarUserAgent("ios")).toBe(SIDECAR_USER_AGENT_MACOS);
  });

  it("picks the Linux-style UA on android", () => {
    expect(sidecarUserAgent("android")).toBe(SIDECAR_USER_AGENT_LINUX);
  });

  it("picks the Linux-style UA for any other platform string (never crashes)", () => {
    expect(sidecarUserAgent("web")).toBe(SIDECAR_USER_AGENT_LINUX);
    expect(sidecarUserAgent("")).toBe(SIDECAR_USER_AGENT_LINUX);
  });
});

describe("sidecarDesktopWebViewProps", () => {
  it("toggle on: includes userAgent, every desktop prop, and the before-load zoom script at the 100% default", () => {
    expect(sidecarDesktopWebViewProps(true, "ios")).toEqual({
      userAgent: SIDECAR_USER_AGENT_MACOS,
      ...SIDECAR_DESKTOP_WEBVIEW_PROPS,
      injectedJavaScriptBeforeContentLoaded: SIDECAR_VIEWPORT_SCRIPT,
    });
    expect(sidecarDesktopWebViewProps(true, "android")).toEqual({
      userAgent: SIDECAR_USER_AGENT_LINUX,
      ...SIDECAR_DESKTOP_WEBVIEW_PROPS,
      injectedJavaScriptBeforeContentLoaded: SIDECAR_VIEWPORT_SCRIPT,
    });
  });

  it(
    "toggle on with a zoom: the before-load script already lays the page out at that zoom " +
      "[bite-proof: real-device fix — DbGate at its 60% default must not first flash 'not supported' at 100%]",
    () => {
      expect(
        sidecarDesktopWebViewProps(true, "android", 60).injectedJavaScriptBeforeContentLoaded,
      ).toBe(zoomScript(60));
    },
  );

  it(
    "toggle off: an empty object — no userAgent override, no zoom props, no " +
      "injected script [bite-proof: leak a desktop prop through when off and this fails]",
    () => {
      expect(sidecarDesktopWebViewProps(false, "ios")).toEqual({});
      expect(sidecarDesktopWebViewProps(false, "android")).toEqual({});
    },
  );
});

describe("sidecarZoomDefault", () => {
  it("DbGate starts at 60% — it refuses to run below ~600 px of layout width (measured: runs at 60% = 640 px, refuses at 70% = 549 px)", () => {
    expect(sidecarZoomDefault("database")).toBe(60);
  });

  it("code-server and Headlamp start at the 100% default; so does an unknown or missing kind", () => {
    expect(sidecarZoomDefault("editor")).toBe(SIDECAR_ZOOM_DEFAULT);
    expect(sidecarZoomDefault("cluster")).toBe(SIDECAR_ZOOM_DEFAULT);
    expect(sidecarZoomDefault("nonsense")).toBe(SIDECAR_ZOOM_DEFAULT);
    expect(sidecarZoomDefault(undefined)).toBe(SIDECAR_ZOOM_DEFAULT);
  });
});

describe("SIDECAR_VIEWPORT_SCRIPT", () => {
  it("is the shared zoom script at the 100% default — one model for first load, load end and the −/+ buttons", () => {
    expect(SIDECAR_VIEWPORT_SCRIPT).toBe(zoomScript(SIDECAR_ZOOM_DEFAULT));
    expect(SIDECAR_VIEWPORT_SCRIPT).toContain("window.__jarvisSidecarZoom = 100;");
  });

  it(
    "lays the page out to the screen's own width in dp, never a fixed desktop width " +
      "[bite-proof: real-device fix — a fixed width=1024 fitted the whole desktop layout into 384 dp, unreadable and untappable]",
    () => {
      expect(SIDECAR_VIEWPORT_SCRIPT).toContain("window.screen.width");
      expect(SIDECAR_VIEWPORT_SCRIPT).not.toContain("width=1024");
      expect(SIDECAR_VIEWPORT_SCRIPT).not.toContain("width=1280");
      expect(SIDECAR_VIEWPORT_SCRIPT).toContain('meta[name="viewport"]');
    },
  );

  it("ends with a truthy return, per RNWV's injected-script convention", () => {
    expect(SIDECAR_VIEWPORT_SCRIPT.trimEnd().endsWith("true;\n})();")).toBe(true);
  });
});

describe("zoom range constants", () => {
  it("50-200 in 10% steps, default 100", () => {
    expect(SIDECAR_ZOOM_MIN).toBe(50);
    expect(SIDECAR_ZOOM_MAX).toBe(200);
    expect(SIDECAR_ZOOM_STEP).toBe(10);
    expect(SIDECAR_ZOOM_DEFAULT).toBe(100);
  });
});

describe("nextZoom", () => {
  it("steps up by 10 from the default", () => {
    expect(nextZoom(100, "in")).toBe(110);
  });

  it("steps down by 10 from the default", () => {
    expect(nextZoom(100, "out")).toBe(90);
  });

  it(
    "clamps at the top of the range " +
      "[bite-proof: drop the clamp and this returns 210, not 200]",
    () => {
      expect(nextZoom(200, "in")).toBe(200);
      expect(nextZoom(195, "in")).toBe(200);
    },
  );

  it(
    "clamps at the bottom of the range " +
      "[bite-proof: drop the clamp and this returns 40, not 50]",
    () => {
      expect(nextZoom(50, "out")).toBe(50);
      expect(nextZoom(55, "out")).toBe(50);
    },
  );

  it("a non-finite or out-of-range starting point is treated as clamped first, then stepped", () => {
    expect(nextZoom(Number.NaN, "in")).toBe(110);
    expect(nextZoom(9999, "out")).toBe(190);
    expect(nextZoom(-50, "in")).toBe(60);
  });
});

describe("zoomScript", () => {
  it("hands the page the percent; the page derives scale = percent / 100 and width = screen.width / scale", () => {
    expect(zoomScript(100)).toContain("window.__jarvisSidecarZoom = 100;");
    expect(zoomScript(200)).toContain("window.__jarvisSidecarZoom = 200;");
    expect(zoomScript(120)).toContain("window.__jarvisSidecarZoom = 120;");
    expect(zoomScript(100)).toContain("var scale = percent / 100;");
    expect(zoomScript(100)).toContain("Math.round(base / scale)");
  });

  it(
    "pins minimum-scale and maximum-scale to the same scale, not just initial-scale " +
      "[bite-proof: real-device fix — an initial scale alone is only honoured on first load, so the −/+ buttons visibly did nothing]",
    () => {
      const script = zoomScript(100);
      expect(script).toContain('", initial-scale=" + scale');
      expect(script).toContain('", minimum-scale=" + scale');
      expect(script).toContain('", maximum-scale=" + scale');
    },
  );

  it("re-applies itself on resize (rotation), bound once, and skips an unchanged content string", () => {
    const script = zoomScript(100);
    expect(script).toContain('window.addEventListener("resize", apply)');
    expect(script).toContain("__jarvisSidecarZoomBound");
    expect(script).toContain('meta.getAttribute("content") !== content');
  });

  it("clears any leftover CSS zoom so the two mechanisms never stack", () => {
    expect(zoomScript(120)).toContain('style.zoom = ""');
  });

  it("ends with a truthy return, per RNWV's injected-script convention", () => {
    expect(zoomScript(100).trimEnd().endsWith("true;\n})();")).toBe(true);
  });

  it("is wrapped in try/catch, matching every other injected script here", () => {
    expect(zoomScript(100)).toContain("try {");
    expect(zoomScript(100)).toContain("catch (e) {}");
  });

  it(
    "clamps an out-of-range factor into [50, 200] before it ever reaches the script string " +
      "[bite-proof: pass the raw factor through unclamped and this fails]",
    () => {
      expect(zoomScript(9999)).toContain("window.__jarvisSidecarZoom = 200;");
      expect(zoomScript(-50)).toContain("window.__jarvisSidecarZoom = 50;");
    },
  );

  it(
    "a non-finite factor falls back to the 100% default instead of producing a broken script " +
      "[bite-proof: skip the finite check and this throws or emits 'NaN']",
    () => {
      expect(zoomScript(Number.NaN)).toContain("window.__jarvisSidecarZoom = 100;");
      expect(zoomScript(Number.POSITIVE_INFINITY)).toContain("window.__jarvisSidecarZoom = 100;");
    },
  );

  it(
    "the script's substituted value is only digits — no user-controlled content " +
      "can ever reach the injected script " +
      "[bite-proof: interpolate an unclamped/unrounded factor and this fails]",
    () => {
      for (const factor of [50, 73.6, 100, 120, 200, -1000, 1e9, Number.NaN]) {
        const script = zoomScript(factor);
        const match = script.match(/window\.__jarvisSidecarZoom = ([^;]*);/);
        expect(match).not.toBeNull();
        expect(match?.[1]).toMatch(/^[0-9]+$/);
      }
    },
  );
});
