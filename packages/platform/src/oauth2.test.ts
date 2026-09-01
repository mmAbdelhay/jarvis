import { describe, expect, it } from "vitest";
import { fetchOAuth2Token } from "./oauth2.js";

type Captured = { url: string; init: RequestInit };

function harness(payload: unknown = { access_token: "t0ken", expires_in: 3600 }, status = 200) {
  const captured: Captured[] = [];
  const deps = {
    fetch: ((url: string, init: RequestInit) => {
      captured.push({ url, init });
      return Promise.resolve(
        new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status }),
      );
    }) as unknown as typeof fetch,
    now: () => 1_000_000,
  };
  return { captured, deps };
}

const body = (captured: Captured[]) => new URLSearchParams(String(captured[0]?.init.body));

describe("fetchOAuth2Token", () => {
  it("gets a token with the client credentials grant", async () => {
    const { captured, deps } = harness();

    const result = await fetchOAuth2Token(
      {
        grantType: "client_credentials",
        accessTokenUrl: "http://auth/token",
        clientId: "id",
        clientSecret: "secret",
        scope: "read write",
      },
      {},
      deps,
    );

    expect(result).toEqual({
      ok: true,
      token: {
        accessToken: "t0ken",
        placement: "header",
        headerPrefix: "Bearer",
        queryKey: "access_token",
        expiresAt: 1_000_000 + 3_600_000,
      },
    });
    expect(captured[0]?.url).toBe("http://auth/token");
    expect(body(captured).get("grant_type")).toBe("client_credentials");
    expect(body(captured).get("client_id")).toBe("id");
    expect(body(captured).get("scope")).toBe("read write");
  });

  it("resolves variables in the config before using it", async () => {
    const { captured, deps } = harness();

    await fetchOAuth2Token(
      { grantType: "client_credentials", accessTokenUrl: "{{authBase}}/token", clientId: "{{id}}" },
      { authBase: "http://auth", id: "resolved" },
      deps,
    );

    expect(captured[0]?.url).toBe("http://auth/token");
    expect(body(captured).get("client_id")).toBe("resolved");
  });

  // Sending credentials in both places is rejected by some providers, so it
  // is one or the other.
  it("puts credentials in a Basic header when asked, and not in the body", async () => {
    const { captured, deps } = harness();

    await fetchOAuth2Token(
      {
        grantType: "client_credentials",
        accessTokenUrl: "http://auth/token",
        clientId: "id",
        clientSecret: "secret",
        credentialsPlacement: "basic_auth_header",
      },
      {},
      deps,
    );

    expect((captured[0]?.init.headers as Record<string, string>)["Authorization"]).toBe(
      `Basic ${Buffer.from("id:secret").toString("base64")}`,
    );
    expect(body(captured).get("client_secret")).toBeNull();
  });

  it("gets a token with the password grant", async () => {
    const { captured, deps } = harness();

    await fetchOAuth2Token(
      {
        grantType: "password",
        accessTokenUrl: "http://auth/token",
        username: "u",
        password: "p",
      },
      {},
      deps,
    );

    expect(body(captured).get("grant_type")).toBe("password");
    expect(body(captured).get("username")).toBe("u");
  });

  it("drives the authorization code grant through the supplied browser", async () => {
    const { captured, deps } = harness();
    const opened: string[] = [];

    const result = await fetchOAuth2Token(
      {
        grantType: "authorization_code",
        authorizationUrl: "http://auth/authorize",
        accessTokenUrl: "http://auth/token",
        clientId: "id",
        callbackUrl: "http://localhost/callback",
        scope: "read",
        state: "xyz",
      },
      {},
      {
        ...deps,
        authorize: (url) => {
          opened.push(url);
          return Promise.resolve("http://localhost/callback?code=abc123&state=xyz");
        },
      },
    );

    const authorizeUrl = new URL(opened[0] ?? "");
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe("http://auth/authorize");
    expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe("http://localhost/callback");
    expect(authorizeUrl.searchParams.get("state")).toBe("xyz");

    expect(body(captured).get("code")).toBe("abc123");
    expect(result.ok && result.token.accessToken).toBe("t0ken");
  });

  it("reports a provider that refuses in the redirect", async () => {
    const { deps } = harness();

    const result = await fetchOAuth2Token(
      {
        grantType: "authorization_code",
        authorizationUrl: "http://auth/authorize",
        accessTokenUrl: "http://auth/token",
        callbackUrl: "http://localhost/cb",
      },
      {},
      { ...deps, authorize: () => Promise.resolve("http://localhost/cb?error=access_denied") },
    );

    expect(result).toEqual({ ok: false, detail: "access_denied" });
  });

  it("refuses the authorization code grant with no browser to drive it", async () => {
    const { deps } = harness();

    const result = await fetchOAuth2Token(
      { grantType: "authorization_code", authorizationUrl: "http://a", accessTokenUrl: "http://t" },
      {},
      deps,
    );

    expect(result.ok).toBe(false);
  });

  // Legal, and old.
  it("reads a form-encoded token response", async () => {
    const { deps } = harness("access_token=formtoken&token_type=bearer");

    const result = await fetchOAuth2Token(
      { grantType: "client_credentials", accessTokenUrl: "http://auth/token" },
      {},
      deps,
    );

    expect(result.ok && result.token.accessToken).toBe("formtoken");
  });

  it("reports the provider's own error on a rejected exchange", async () => {
    const { deps } = harness({ error: "invalid_client", error_description: "Bad secret" }, 401);

    const result = await fetchOAuth2Token(
      { grantType: "client_credentials", accessTokenUrl: "http://auth/token" },
      {},
      deps,
    );

    expect(result).toEqual({ ok: false, detail: "401: Bad secret" });
  });

  it("reports a token response with no token in it", async () => {
    const { deps } = harness({ nothing: "here" });

    const result = await fetchOAuth2Token(
      { grantType: "client_credentials", accessTokenUrl: "http://auth/token" },
      {},
      deps,
    );

    expect(result).toEqual({ ok: false, detail: "The token response carried no access_token" });
  });

  it("honours a custom token field, prefix and placement", async () => {
    const { deps } = harness({ id_token: "custom" });

    const result = await fetchOAuth2Token(
      {
        grantType: "client_credentials",
        accessTokenUrl: "http://auth/token",
        tokenSource: "id_token",
        tokenPlacement: "url",
        tokenHeaderPrefix: "Token",
        tokenQueryKey: "t",
      },
      {},
      deps,
    );

    expect(result.ok && result.token).toMatchObject({
      accessToken: "custom",
      placement: "url",
      headerPrefix: "Token",
      queryKey: "t",
    });
  });

  it("refuses a grant it does not implement rather than guessing", async () => {
    const { deps } = harness();

    const result = await fetchOAuth2Token(
      { grantType: "implicit", accessTokenUrl: "http://auth/token" },
      {},
      deps,
    );

    expect(result).toEqual({ ok: false, detail: "Unsupported OAuth2 grant type: implicit" });
  });

  it("keeps a refresh token when one is offered", async () => {
    const { deps } = harness({ access_token: "a", refresh_token: "r" });

    const result = await fetchOAuth2Token(
      { grantType: "client_credentials", accessTokenUrl: "http://auth/token" },
      {},
      deps,
    );

    expect(result.ok && result.token.refreshToken).toBe("r");
  });
});
