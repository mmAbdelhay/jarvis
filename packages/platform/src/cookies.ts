// A cookie jar, per project.
//
// Postman keeps one and so must this: an API you log into with one request
// and call with the next is the ordinary case, and without a jar the second
// request is anonymous. Deliberately small — RFC 6265 as far as a developer
// tool needs it, and no further.

export type Cookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Epoch milliseconds, or undefined for a session cookie. */
  expires?: number;
  secure: boolean;
  httpOnly: boolean;
};

export type CookieJar = {
  /** Records every Set-Cookie a response carried. */
  store(url: string, setCookieHeaders: readonly string[]): void;
  /** The Cookie header value for a request, or "" when nothing matches. */
  headerFor(url: string): string;
  list(): Cookie[];
  clear(): void;
  remove(name: string, domain: string, path: string): void;
};

/** Parses one Set-Cookie header. Returns undefined for a header with no
 *  name=value pair, which is not a cookie however well-formed the rest is.
 *
 *  `now` is injected rather than read from the clock so that Max-Age — which
 *  is relative — is measured against the same clock the jar expires against.
 *  With two clocks, a cookie set to expire immediately outlives a jar that
 *  disagrees about what time it is. */
export function parseSetCookie(
  header: string,
  requestUrl: string,
  now: () => number = Date.now,
): Cookie | undefined {
  const [pair, ...attributes] = header.split(";");
  const equals = pair?.indexOf("=") ?? -1;
  if (pair === undefined || equals <= 0) return undefined;

  let host: string;
  let requestPath: string;
  try {
    const url = new URL(requestUrl);
    host = url.hostname;
    requestPath = url.pathname;
  } catch {
    return undefined;
  }

  const cookie: Cookie = {
    name: pair.slice(0, equals).trim(),
    value: pair.slice(equals + 1).trim(),
    domain: host,
    // Default path is the request's directory, per RFC 6265 section 5.1.4.
    path: defaultPath(requestPath),
    secure: false,
    httpOnly: false,
  };

  for (const attribute of attributes) {
    const at = attribute.indexOf("=");
    const key = (at === -1 ? attribute : attribute.slice(0, at)).trim().toLowerCase();
    const value = at === -1 ? "" : attribute.slice(at + 1).trim();

    if (key === "domain" && value !== "") cookie.domain = value.replace(/^\./, "");
    else if (key === "path" && value !== "") cookie.path = value;
    else if (key === "secure") cookie.secure = true;
    else if (key === "httponly") cookie.httpOnly = true;
    else if (key === "max-age") {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) cookie.expires = now() + seconds * 1000;
    } else if (key === "expires" && cookie.expires === undefined) {
      // Max-Age wins over Expires when both are present, which is why this
      // only fills an empty slot.
      const at = Date.parse(value);
      if (Number.isFinite(at)) cookie.expires = at;
    }
  }

  return cookie;
}

function defaultPath(pathname: string): string {
  const lastSlash = pathname.lastIndexOf("/");
  if (lastSlash <= 0) return "/";
  return pathname.slice(0, lastSlash);
}

/** Host matches the cookie's domain exactly, or is a subdomain of it. */
function domainMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

export function createCookieJar(
  initial: readonly Cookie[] = [],
  now: () => number = Date.now,
): CookieJar {
  let cookies: Cookie[] = [...initial];

  const key = (cookie: Cookie): string => `${cookie.name} ${cookie.domain} ${cookie.path}`;

  const live = (): Cookie[] =>
    cookies.filter((cookie) => cookie.expires === undefined || cookie.expires > now());

  return {
    store(url, setCookieHeaders) {
      for (const header of setCookieHeaders) {
        const cookie = parseSetCookie(header, url, now);
        if (cookie === undefined) continue;
        // A cookie replaces one with the same name, domain and path — that
        // is what makes a re-login update the session rather than add one.
        cookies = cookies.filter((existing) => key(existing) !== key(cookie));
        // An expiry in the past is a delete instruction, not a cookie.
        if (cookie.expires !== undefined && cookie.expires <= now()) continue;
        cookies.push(cookie);
      }
    },

    headerFor(url) {
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        return "";
      }
      const isSecure = target.protocol === "https:";

      return live()
        .filter(
          (cookie) =>
            domainMatches(target.hostname, cookie.domain) &&
            pathMatches(target.pathname, cookie.path) &&
            (!cookie.secure || isSecure),
        )
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join("; ");
    },

    list: () => live().map((cookie) => ({ ...cookie })),

    clear() {
      cookies = [];
    },

    remove(name, domain, path) {
      cookies = cookies.filter(
        (cookie) => !(cookie.name === name && cookie.domain === domain && cookie.path === path),
      );
    },
  };
}
