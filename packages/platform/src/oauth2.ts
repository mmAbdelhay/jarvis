import { interpolate } from "./http-runner.js";

// OAuth 2.0 token acquisition for a request whose auth mode is `oauth2`.
//
// Three grants, chosen because they are the three a developer actually meets:
// client credentials for machine-to-machine APIs, password for legacy first
// party ones, and authorization code for anything user-facing. The first two
// are a single POST; the third needs a browser, which is supplied by the
// caller — the Workspace already has one, and sending the user to their
// system browser to come back with a code by hand would be the worse product.

export type OAuth2Config = {
  grantType?: string;
  accessTokenUrl?: string;
  authorizationUrl?: string;
  refreshTokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  username?: string;
  password?: string;
  scope?: string;
  state?: string;
  callbackUrl?: string;
  pkce?: boolean | string;
  /** "body" (default) or "basic_auth_header". */
  credentialsPlacement?: string;
  /** Which field of the token response to use. */
  tokenSource?: string;
  tokenPlacement?: string;
  tokenHeaderPrefix?: string;
  tokenQueryKey?: string;
};

export type OAuth2Token = {
  accessToken: string;
  /** How the token is meant to be presented, carried through so the caller
   *  does not have to re-read the config to know. */
  placement: "header" | "url";
  headerPrefix: string;
  queryKey: string;
  /** Epoch milliseconds, when the response said. */
  expiresAt?: number;
  refreshToken?: string;
};

export type OAuth2Deps = {
  fetch: typeof fetch;
  now: () => number;
  /** Opens `url` and resolves with the redirect the provider sent the user
   *  back to — the one carrying `?code=`. Supplied by the caller because
   *  only it has a browser. */
  authorize?: (url: string, redirectUri: string) => Promise<string>;
};

export type OAuth2Result = { ok: true; token: OAuth2Token } | { ok: false; detail: string };

/** Everything the config needs interpolated before it is used. */
function resolved(config: OAuth2Config, variables: Record<string, string>): OAuth2Config {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    out[key] = typeof value === "string" ? interpolate(value, variables).text : value;
  }
  return out as OAuth2Config;
}

export async function fetchOAuth2Token(
  rawConfig: OAuth2Config,
  variables: Record<string, string>,
  deps: OAuth2Deps,
): Promise<OAuth2Result> {
  const config = resolved(rawConfig, variables);
  const grant = config.grantType ?? "client_credentials";

  if (grant === "authorization_code") return authorizationCode(config, deps);
  if (grant === "password") {
    return exchange(config, deps, {
      grant_type: "password",
      username: config.username ?? "",
      password: config.password ?? "",
      ...(config.scope === undefined || config.scope === "" ? {} : { scope: config.scope }),
    });
  }
  if (grant === "client_credentials") {
    return exchange(config, deps, {
      grant_type: "client_credentials",
      ...(config.scope === undefined || config.scope === "" ? {} : { scope: config.scope }),
    });
  }
  return { ok: false, detail: `Unsupported OAuth2 grant type: ${grant}` };
}

async function authorizationCode(config: OAuth2Config, deps: OAuth2Deps): Promise<OAuth2Result> {
  if (deps.authorize === undefined) {
    return { ok: false, detail: "This grant needs a browser, and none was supplied" };
  }
  if (config.authorizationUrl === undefined || config.authorizationUrl === "") {
    return { ok: false, detail: "No authorization URL" };
  }

  const redirectUri = config.callbackUrl ?? "";
  const authorize = new URL(config.authorizationUrl);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", config.clientId ?? "");
  if (redirectUri !== "") authorize.searchParams.set("redirect_uri", redirectUri);
  if (config.scope !== undefined && config.scope !== "")
    authorize.searchParams.set("scope", config.scope);
  if (config.state !== undefined && config.state !== "")
    authorize.searchParams.set("state", config.state);

  let redirected: string;
  try {
    redirected = await deps.authorize(authorize.toString(), redirectUri);
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }

  let code: string | null;
  try {
    const url = new URL(redirected);
    // A provider that refuses reports it here rather than by failing the
    // redirect, and that message is the useful one.
    const denied = url.searchParams.get("error_description") ?? url.searchParams.get("error");
    if (denied !== null) return { ok: false, detail: denied };
    code = url.searchParams.get("code");
  } catch {
    return { ok: false, detail: "The provider did not redirect back with a code" };
  }
  if (code === null) return { ok: false, detail: "The provider did not redirect back with a code" };

  return exchange(config, deps, {
    grant_type: "authorization_code",
    code,
    ...(redirectUri === "" ? {} : { redirect_uri: redirectUri }),
  });
}

async function exchange(
  config: OAuth2Config,
  deps: OAuth2Deps,
  fields: Record<string, string>,
): Promise<OAuth2Result> {
  const tokenUrl = config.accessTokenUrl ?? "";
  if (tokenUrl === "") return { ok: false, detail: "No access token URL" };

  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  const form = new URLSearchParams(fields);

  // Providers differ on where the client credentials belong, and sending them
  // in both places is rejected by some of them — so it is one or the other,
  // per the config.
  if (config.credentialsPlacement === "basic_auth_header") {
    const credential = `${config.clientId ?? ""}:${config.clientSecret ?? ""}`;
    headers["Authorization"] = `Basic ${Buffer.from(credential).toString("base64")}`;
  } else {
    if (config.clientId !== undefined && config.clientId !== "")
      form.set("client_id", config.clientId);
    if (config.clientSecret !== undefined && config.clientSecret !== "") {
      form.set("client_secret", config.clientSecret);
    }
  }

  let payload: Record<string, unknown>;
  try {
    const response = await deps.fetch(tokenUrl, { method: "POST", headers, body: form.toString() });
    const text = await response.text();
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // Some providers answer form-encoded, which is legal and old.
      payload = Object.fromEntries(new URLSearchParams(text));
    }
    if (!response.ok) {
      const detail = String(payload["error_description"] ?? payload["error"] ?? text.slice(0, 200));
      return { ok: false, detail: `${response.status}: ${detail}` };
    }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }

  const field =
    config.tokenSource === undefined || config.tokenSource === ""
      ? "access_token"
      : config.tokenSource;
  const token = payload[field];
  if (typeof token !== "string" || token === "") {
    return { ok: false, detail: `The token response carried no ${field}` };
  }

  const expiresIn = Number(payload["expires_in"]);
  const refresh = payload["refresh_token"];

  return {
    ok: true,
    token: {
      accessToken: token,
      placement: config.tokenPlacement === "url" ? "url" : "header",
      headerPrefix:
        config.tokenHeaderPrefix === undefined || config.tokenHeaderPrefix === ""
          ? "Bearer"
          : config.tokenHeaderPrefix,
      queryKey:
        config.tokenQueryKey === undefined || config.tokenQueryKey === ""
          ? "access_token"
          : config.tokenQueryKey,
      ...(Number.isFinite(expiresIn) ? { expiresAt: deps.now() + expiresIn * 1000 } : {}),
      ...(typeof refresh === "string" ? { refreshToken: refresh } : {}),
    },
  };
}
