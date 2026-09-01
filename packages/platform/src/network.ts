import { Agent, ProxyAgent, fetch as undiciFetch } from "undici";
import type { NetworkOptions } from "./http-runner.js";

// The network layer behind the API tab's requests.
//
// Node's global fetch gives no way to reach a proxy or to relax certificate
// verification, and both are ordinary needs for a developer tool: a corporate
// proxy, and a development server with a self-signed certificate. undici is
// the implementation behind global fetch anyway; using it explicitly is what
// makes those two options expressible at all.
//
// undiciFetch rather than globalThis.fetch on purpose: a dispatcher from this
// copy of undici is only honoured by this copy's fetch.

export const apiFetch = undiciFetch as unknown as typeof fetch;

/**
 * Builds the dispatcher for one request, or returns undefined when the
 * defaults will do — which is the common case, and the one that should cost
 * nothing.
 *
 * Verification is only ever relaxed by an explicit choice, never by falling
 * back to it: `verifyCertificate: false` has to be set by someone.
 */
export function dispatcherFor(options: NetworkOptions): unknown {
  const insecure = options.verifyCertificate === false;
  const proxyUrl = options.proxyUrl;

  if (proxyUrl !== undefined && proxyUrl !== "") {
    return new ProxyAgent({
      uri: proxyUrl,
      ...(insecure ? { requestTls: { rejectUnauthorized: false } } : {}),
    });
  }

  if (insecure) return new Agent({ connect: { rejectUnauthorized: false } });

  return undefined;
}
