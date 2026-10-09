import { describe, expect, it } from "vitest";
import { MAX_MODEL_STATE_CHARS, modelDownloadFor, parseModelState } from "./model-state.js";

const good = {
  modelId: "qwen3-8b",
  ollamaTag: "qwen3:8b",
  state: "downloading",
  percent: 41.6,
  message: "Downloading",
  updatedAt: "2026-10-08T09:00:00Z",
};
const local = { kind: "ollama" as const, baseUrl: "http://127.0.0.1:11434", model: "qwen3:8b" };

describe("parseModelState (M2 contracts §5)", () => {
  it("parses the file field by field, rounding and clamping percent", () => {
    expect(parseModelState(JSON.stringify(good))).toEqual({ ...good, percent: 42 });
    expect(parseModelState(JSON.stringify({ ...good, percent: 140 }))?.percent).toBe(100);
    expect(parseModelState(JSON.stringify({ ...good, percent: -3 }))?.percent).toBe(0);
    expect(parseModelState(JSON.stringify({ ...good, message: 5, updatedAt: null }))).toEqual({
      ...good,
      percent: 42,
      message: "",
      updatedAt: "",
    });
  });

  it("refuses half-written, garbage, oversized and wrongly typed files", () => {
    expect(parseModelState(JSON.stringify(good).slice(0, 30))).toBeUndefined();
    expect(parseModelState("not json")).toBeUndefined();
    expect(parseModelState("[]")).toBeUndefined();
    expect(parseModelState(JSON.stringify({ ...good, state: "done" }))).toBeUndefined();
    expect(parseModelState(JSON.stringify({ ...good, percent: "42" }))).toBeUndefined();
    expect(parseModelState(JSON.stringify({ ...good, ollamaTag: "" }))).toBeUndefined();
    expect(parseModelState(" ".repeat(MAX_MODEL_STATE_CHARS + 1))).toBeUndefined();
  });
});

describe("modelDownloadFor", () => {
  const state = { ...good, state: "downloading" as const, percent: 42 };

  it("reports the download for the local Ollama model it belongs to", () => {
    expect(modelDownloadFor(local, state)).toEqual({ state: "downloading", percent: 42 });
    expect(modelDownloadFor({ ...local, baseUrl: "http://localhost:11434" }, state)).toEqual({
      state: "downloading",
      percent: 42,
    });
    expect(modelDownloadFor(local, { ...state, state: "ready", percent: 97 })).toEqual({
      state: "ready",
      percent: 100,
    });
  });

  it("treats a bare tag as :latest on both sides", () => {
    expect(
      modelDownloadFor({ ...local, model: "llama3.2" }, { ...state, ollamaTag: "llama3.2:latest" }),
    ).toEqual({ state: "downloading", percent: 42 });
  });

  it("is null for no model, no state, another model, a cloud kind or a LAN Ollama", () => {
    expect(modelDownloadFor(null, state)).toBeNull();
    expect(modelDownloadFor(local, null)).toBeNull();
    expect(modelDownloadFor({ ...local, model: "qwen3:4b" }, state)).toBeNull();
    expect(
      modelDownloadFor(
        { kind: "anthropic", baseUrl: "https://api.anthropic.com", model: "qwen3:8b" },
        state,
      ),
    ).toBeNull();
    expect(modelDownloadFor({ ...local, baseUrl: "http://192.168.1.20:11434" }, state)).toBeNull();
    expect(modelDownloadFor({ ...local, baseUrl: "nonsense" }, state)).toBeNull();
  });
});
