import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  defaultCertDir,
  findTailscaleCli,
  issueCertificate,
  obtainCertificate,
  tailnetName,
  type TailscaleCertDeps,
  type TailscaleExec,
  type TailscaleFs,
} from "./tailscale-cert.js";

/** Every dep a vi.fn returning success; a test overrides only what it
 *  asserts on — same discipline as dispatch.test.ts's own fakeDeps. */
function fakeDeps(overrides: Partial<TailscaleCertDeps> = {}): TailscaleCertDeps {
  const exec: TailscaleExec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
  const fs: TailscaleFs = {
    access: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    chmod: vi.fn(async () => undefined),
  };
  return {
    exec,
    fs,
    homedir: vi.fn(() => "/Users/x"),
    platform: "darwin",
    ...overrides,
  };
}

const STATUS_JSON = (dnsName: string) => JSON.stringify({ Self: { DNSName: dnsName } });

describe("defaultCertDir", () => {
  it("is ~/.config/jarvis/tls", () => {
    // Built with join(), so the expectation is too (backslashes on win32).
    expect(defaultCertDir({ homedir: () => "/Users/x" })).toBe(
      join("/Users/x", ".config", "jarvis", "tls"),
    );
  });
});

describe("findTailscaleCli", () => {
  it("darwin: the fixed app-bundle path when it exists", async () => {
    const deps = fakeDeps({ platform: "darwin" });
    await expect(findTailscaleCli(deps)).resolves.toBe(
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    );
    expect(deps.exec).not.toHaveBeenCalled();
  });

  it("darwin: undefined when the app bundle is not there", async () => {
    const deps = fakeDeps({
      platform: "darwin",
      fs: {
        access: vi.fn(async () => {
          throw new Error("ENOENT");
        }),
        mkdir: vi.fn(async () => undefined),
        chmod: vi.fn(async () => undefined),
      },
    });
    await expect(findTailscaleCli(deps)).resolves.toBeUndefined();
  });

  it("linux: 'tailscale' when running it succeeds", async () => {
    const exec: TailscaleExec = vi.fn(async () => ({ code: 0, stdout: "1.2.3\n", stderr: "" }));
    const deps = fakeDeps({ platform: "linux", exec });
    await expect(findTailscaleCli(deps)).resolves.toBe("tailscale");
    expect(exec).toHaveBeenCalledWith("tailscale", ["version"], expect.any(Object));
  });

  it("linux: undefined when the binary exits non-zero", async () => {
    const exec: TailscaleExec = vi.fn(async () => ({ code: 127, stdout: "", stderr: "not found" }));
    const deps = fakeDeps({ platform: "linux", exec });
    await expect(findTailscaleCli(deps)).resolves.toBeUndefined();
  });

  it("linux: undefined when spawning rejects (not installed)", async () => {
    const exec: TailscaleExec = vi.fn(async () => {
      throw new Error("ENOENT: spawn tailscale");
    });
    const deps = fakeDeps({ platform: "linux", exec });
    await expect(findTailscaleCli(deps)).resolves.toBeUndefined();
  });
});

describe("tailnetName", () => {
  it("parses Self.DNSName and strips the trailing dot", async () => {
    const exec: TailscaleExec = vi.fn(async () => ({
      code: 0,
      stdout: STATUS_JSON("e1089167.tailfee19e.ts.net."),
      stderr: "",
    }));
    const deps = fakeDeps({ exec });
    await expect(tailnetName(deps, "tailscale")).resolves.toBe("e1089167.tailfee19e.ts.net");
  });

  it("undefined when the command exits non-zero (not running)", async () => {
    const exec: TailscaleExec = vi.fn(async () => ({ code: 1, stdout: "", stderr: "stopped" }));
    const deps = fakeDeps({ exec });
    await expect(tailnetName(deps, "tailscale")).resolves.toBeUndefined();
  });

  it("undefined when spawning rejects", async () => {
    const exec: TailscaleExec = vi.fn(async () => {
      throw new Error("boom");
    });
    const deps = fakeDeps({ exec });
    await expect(tailnetName(deps, "tailscale")).resolves.toBeUndefined();
  });

  it("undefined on unparsable JSON", async () => {
    const exec: TailscaleExec = vi.fn(async () => ({ code: 0, stdout: "not json", stderr: "" }));
    const deps = fakeDeps({ exec });
    await expect(tailnetName(deps, "tailscale")).resolves.toBeUndefined();
  });

  it("undefined when Self.DNSName is missing or empty", async () => {
    const exec: TailscaleExec = vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify({ Self: {} }),
      stderr: "",
    }));
    const deps = fakeDeps({ exec });
    await expect(tailnetName(deps, "tailscale")).resolves.toBeUndefined();
  });
});

describe("issueCertificate", () => {
  const NAME = "e1089167.tailfee19e.ts.net";
  const DIR = "/Users/x/.config/jarvis/tls";

  it("runs `tailscale cert --cert-file <dir>/<name>.crt --key-file <dir>/<name>.key <name>`, tightens modes, returns the paths", async () => {
    const exec: TailscaleExec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const deps = fakeDeps({ exec });

    const result = await issueCertificate(deps, "tailscale", { name: NAME, dir: DIR });

    expect(result).toEqual({
      ok: true,
      certPath: join(DIR, `${NAME}.crt`),
      keyPath: join(DIR, `${NAME}.key`),
      name: NAME,
    });
    expect(exec).toHaveBeenCalledWith(
      "tailscale",
      [
        "cert",
        "--cert-file",
        join(DIR, `${NAME}.crt`),
        "--key-file",
        join(DIR, `${NAME}.key`),
        NAME,
      ],
      { timeoutMs: 60_000, maxOutputBytes: expect.any(Number) },
    );
    expect(deps.fs.mkdir).toHaveBeenCalledWith(DIR, { recursive: true, mode: 0o700 });
    expect(deps.fs.chmod).toHaveBeenCalledWith(DIR, 0o700);
    expect(deps.fs.chmod).toHaveBeenCalledWith(join(DIR, `${NAME}.crt`), 0o600);
    expect(deps.fs.chmod).toHaveBeenCalledWith(join(DIR, `${NAME}.key`), 0o600);
  });

  it("classifies 'does not support getting TLS certs' as https-disabled, with only the last line as detail", async () => {
    const exec: TailscaleExec = vi.fn(async () => ({
      code: 1,
      stdout: "",
      stderr:
        "some preamble\n500 Internal Server Error: your Tailscale account does not support getting TLS certs",
    }));
    const deps = fakeDeps({ exec });

    const result = await issueCertificate(deps, "tailscale", { name: NAME, dir: DIR });

    expect(result).toEqual({
      ok: false,
      kind: "https-disabled",
      detail:
        "500 Internal Server Error: your Tailscale account does not support getting TLS certs",
    });
  });

  it("any other non-zero exit classifies as failed, detail is the last output line only", async () => {
    const exec: TailscaleExec = vi.fn(async () => ({
      code: 1,
      stdout: "",
      stderr: "line one\nline two\nsome other failure",
    }));
    const deps = fakeDeps({ exec });

    const result = await issueCertificate(deps, "tailscale", { name: NAME, dir: DIR });

    expect(result).toEqual({ ok: false, kind: "failed", detail: "some other failure" });
  });

  it("a thrown exec (e.g. the 60s timeout) classifies as failed", async () => {
    const exec: TailscaleExec = vi.fn(async () => {
      throw new Error("command timed out\nafter 60000ms");
    });
    const deps = fakeDeps({ exec });

    const result = await issueCertificate(deps, "tailscale", { name: NAME, dir: DIR });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ kind: "failed" });
  });

  it("never logs the key: no fs call and no exec call ever carries key material", async () => {
    const exec: TailscaleExec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const logged: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    const deps = fakeDeps({ exec });

    await issueCertificate(deps, "tailscale", { name: NAME, dir: DIR });

    expect(logged).toEqual([]);
    spy.mockRestore();
  });

  it("a failed mkdir/chmod on the directory classifies as failed, never runs the CLI", async () => {
    const exec: TailscaleExec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const deps = fakeDeps({
      exec,
      fs: {
        access: vi.fn(async () => undefined),
        mkdir: vi.fn(async () => {
          throw new Error("EACCES: permission denied");
        }),
        chmod: vi.fn(async () => undefined),
      },
    });

    const result = await issueCertificate(deps, "tailscale", { name: NAME, dir: DIR });

    expect(result).toEqual({ ok: false, kind: "failed", detail: "EACCES: permission denied" });
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("obtainCertificate", () => {
  it("no-tailscale when the CLI cannot be found — never calls exec for status/cert", async () => {
    const deps = fakeDeps({
      platform: "darwin",
      fs: {
        access: vi.fn(async () => {
          throw new Error("ENOENT");
        }),
        mkdir: vi.fn(async () => undefined),
        chmod: vi.fn(async () => undefined),
      },
    });

    const result = await obtainCertificate(deps);

    expect(result).toEqual({ ok: false, kind: "no-tailscale", detail: expect.any(String) });
    expect(deps.exec).not.toHaveBeenCalled();
  });

  it("not-connected when tailnetName resolves to undefined", async () => {
    const exec: TailscaleExec = vi.fn(async () => ({ code: 1, stdout: "", stderr: "stopped" }));
    const deps = fakeDeps({ exec });

    const result = await obtainCertificate(deps);

    expect(result).toEqual({ ok: false, kind: "not-connected", detail: expect.any(String) });
  });

  it("issues the certificate under ~/.config/jarvis/tls for the resolved name on success", async () => {
    const exec: TailscaleExec = vi.fn(async (_command, args) => {
      if (args[0] === "status") {
        return { code: 0, stdout: STATUS_JSON("m1.tailnet.ts.net."), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const deps = fakeDeps({ exec, homedir: () => "/Users/x" });

    const result = await obtainCertificate(deps);

    expect(result).toEqual({
      ok: true,
      certPath: join("/Users/x", ".config", "jarvis", "tls", "m1.tailnet.ts.net.crt"),
      keyPath: join("/Users/x", ".config", "jarvis", "tls", "m1.tailnet.ts.net.key"),
      name: "m1.tailnet.ts.net",
    });
  });
});
