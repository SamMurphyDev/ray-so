import { type NextRequest, NextResponse } from "next/server";

// This route is the target of the `fallback` rewrite in next.config.js
// (source "/:path*" -> destination "/fallback-proxy/:path*"). It is reached only
// for requests that did not match any real page, static asset, or dynamic route.
// It proxies those requests to an upstream origin defined by the FALLBACK_URL
// environment variable, read at request time so the target can be configured at
// runtime (e.g. via a Kubernetes env var) without rebuilding.
//
// Note: the folder is intentionally NOT prefixed with "_" — App Router treats
// "_"-prefixed folders as private and excludes them from routing.

// Never statically optimize/cache: we must read process.env and the incoming
// request on every call.
export const dynamic = "force-dynamic";

const DEFAULT_FALLBACK_URL = "https://go.ray.so";

// Hop-by-hop headers must not be forwarded when proxying (per RFC 7230).
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-encoding",
  "host",
]);

function getUpstreamBase(): string {
  const raw = process.env.FALLBACK_URL?.trim();
  const base = raw && raw.length > 0 ? raw : DEFAULT_FALLBACK_URL;
  // Normalize: drop any trailing slash so we can join paths predictably.
  return base.replace(/\/+$/, "");
}

function buildUpstreamUrl(req: NextRequest, pathSegments: string[]): string {
  const base = getUpstreamBase();
  // Re-encode each segment so paths with special characters survive the round trip.
  const path = pathSegments.map(encodeURIComponent).join("/");
  const search = req.nextUrl.search; // includes leading "?" or empty string
  return `${base}/${path}${search}`;
}

function filterHeaders(headers: Headers): Headers {
  const filtered = new Headers();
  headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      filtered.set(key, value);
    }
  });
  return filtered;
}

async function proxy(req: NextRequest, pathSegments: string[]): Promise<Response> {
  const target = buildUpstreamUrl(req, pathSegments);

  const hasBody = req.method !== "GET" && req.method !== "HEAD";

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(target, {
      method: req.method,
      headers: filterHeaders(req.headers),
      body: hasBody ? req.body : undefined,
      // Required by fetch when streaming a request body.
      ...(hasBody ? { duplex: "half" } : {}),
      // Pass upstream redirects straight through to the client rather than
      // following them server-side.
      redirect: "manual",
    } as RequestInit);
  } catch (error) {
    console.error(`Fallback proxy to "${target}" failed:`, error);
    return NextResponse.json({ error: "Fallback upstream unreachable" }, { status: 502 });
  }

  // Strip hop-by-hop headers from the upstream response before returning it.
  const responseHeaders = filterHeaders(upstreamResponse.headers);

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}

type RouteContext = { params: Promise<{ path?: string[] }> };

async function handler(req: NextRequest, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  return proxy(req, path ?? []);
}

export {
  handler as GET,
  handler as POST,
  handler as PUT,
  handler as PATCH,
  handler as DELETE,
  handler as HEAD,
  handler as OPTIONS,
};
