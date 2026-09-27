import { describe, expect, it, vi } from "vitest";
import {
  locateByIp,
  parseIpApiCo,
  parseIpWhoIs,
  type IpLocateFetcher,
  type IpLocateResponse,
} from "./ip-locate.js";

function response(ok: boolean, body: unknown): IpLocateResponse {
  return { ok, json: async () => body };
}

describe("parseIpApiCo", () => {
  it("parses a valid response into latitude/longitude/name", () => {
    expect(
      parseIpApiCo({ latitude: 31.2, longitude: 29.9, city: "Alexandria", country_name: "Egypt" }),
    ).toEqual({ latitude: 31.2, longitude: 29.9, name: "Alexandria, Egypt" });
  });

  it("joins whichever of city/country is present", () => {
    expect(parseIpApiCo({ latitude: 31.2, longitude: 29.9 })).toEqual({
      latitude: 31.2,
      longitude: 29.9,
      name: "",
    });
    expect(parseIpApiCo({ latitude: 31.2, longitude: 29.9, city: "Alexandria" })).toEqual({
      latitude: 31.2,
      longitude: 29.9,
      name: "Alexandria",
    });
  });

  it("rejects a body missing latitude/longitude", () => {
    expect(parseIpApiCo({ city: "Alexandria" })).toBeNull();
    expect(parseIpApiCo({ latitude: 31.2 })).toBeNull();
  });

  it("rejects out-of-range coordinates", () => {
    expect(parseIpApiCo({ latitude: 200, longitude: 29.9 })).toBeNull();
    expect(parseIpApiCo({ latitude: 31.2, longitude: -400 })).toBeNull();
  });

  it("rejects the provider's own error shape (no coordinates)", () => {
    expect(parseIpApiCo({ error: true, reason: "RateLimited" })).toBeNull();
  });

  it("rejects a non-object body", () => {
    expect(parseIpApiCo(null)).toBeNull();
    expect(parseIpApiCo("nope")).toBeNull();
    expect(parseIpApiCo(undefined)).toBeNull();
  });

  it("caps the joined name at 80 characters", () => {
    const city = "A".repeat(60);
    const country = "B".repeat(60);
    const result = parseIpApiCo({ latitude: 31.2, longitude: 29.9, city, country_name: country });
    expect(result?.name.length).toBe(80);
    expect(result?.name).toBe(`${city}, ${country}`.slice(0, 80));
  });

  it("trims before capping so the cut isn't mid-whitespace-padding", () => {
    const result = parseIpApiCo({
      latitude: 31.2,
      longitude: 29.9,
      city: `  ${"C".repeat(85)}  `,
    });
    expect(result?.name.length).toBe(80);
    expect(result?.name).toBe("C".repeat(80));
  });
});

describe("parseIpWhoIs", () => {
  it("parses a valid response into latitude/longitude/name", () => {
    expect(
      parseIpWhoIs({
        success: true,
        latitude: 31.2,
        longitude: 29.9,
        city: "Alexandria",
        country: "Egypt",
      }),
    ).toEqual({ latitude: 31.2, longitude: 29.9, name: "Alexandria, Egypt" });
  });

  it("rejects success: false regardless of any other fields present", () => {
    expect(
      parseIpWhoIs({ success: false, message: "reserved range", latitude: 1, longitude: 2 }),
    ).toBeNull();
  });

  it("rejects a body missing latitude/longitude", () => {
    expect(parseIpWhoIs({ success: true, city: "Alexandria" })).toBeNull();
  });

  it("rejects out-of-range coordinates", () => {
    expect(parseIpWhoIs({ success: true, latitude: 91, longitude: 29.9 })).toBeNull();
  });

  it("rejects a non-object body", () => {
    expect(parseIpWhoIs(null)).toBeNull();
  });
});

describe("locateByIp", () => {
  it("returns ipapi.co's result without calling ipwho.is", async () => {
    const fetch = vi.fn(async (url: string) => {
      expect(url).toBe("https://ipapi.co/json/");
      return response(true, {
        latitude: 31.2,
        longitude: 29.9,
        city: "Alexandria",
        country_name: "Egypt",
      });
    });
    const result = await locateByIp({ fetch });
    expect(result).toEqual({ latitude: 31.2, longitude: 29.9, name: "Alexandria, Egypt" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to ipwho.is when ipapi.co's response does not parse", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url === "https://ipapi.co/json/") return response(true, { error: true });
      return response(true, { success: true, latitude: 1, longitude: 2, city: "X", country: "Y" });
    });
    const result = await locateByIp({ fetch });
    expect(result).toEqual({ latitude: 1, longitude: 2, name: "X, Y" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("falls back to ipwho.is when ipapi.co's request rejects (network error)", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url === "https://ipapi.co/json/") throw new Error("ENOTFOUND");
      return response(true, { success: true, latitude: 1, longitude: 2 });
    });
    const result = await locateByIp({ fetch });
    expect(result).toEqual({ latitude: 1, longitude: 2, name: "" });
  });

  it("falls back to ipwho.is when ipapi.co's response is not ok", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url === "https://ipapi.co/json/") return response(false, {});
      return response(true, { success: true, latitude: 1, longitude: 2 });
    });
    const result = await locateByIp({ fetch });
    expect(result).toEqual({ latitude: 1, longitude: 2, name: "" });
  });

  it("returns an error once both providers fail", async () => {
    const fetch: IpLocateFetcher["fetch"] = async () => response(false, {});
    const result = await locateByIp({ fetch });
    expect(result).toEqual({ error: "unavailable" });
  });
});
