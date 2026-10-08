_/**
 * Cloudflare Worker - CORS Proxy (port of cors-anywhere)
 * © 2013 - 2016 Rob Wu <rob@robwu.nl>
 * Released under the MIT license
 * Tuned to match original Node.js app.js behavior exactly
 */

const DEFAULT_OPTIONS = {
  maxRedirects: 5,
  keywordBlacklist: [],
  originBlacklist: [],
  originWhitelist: [],
  redirectSameOrigin: true,
  requireHeader: null,
  removeHeaders: [
    'x-heroku-queue-wait-time',
    'x-heroku-queue-depth',
    'x-heroku-dynos-in-use',
    'x-request-start',
  ],
  setHeaders: {},
  corsMaxAge: 0,
};

/**
 * Check whether the specified hostname is valid.
 * Must have a dot (domain), be an IPv4, or be an IPv6
 */
function isValidHostName(hostname) {
  if (hostname.indexOf('.') > 0) return true;
  // Check IPv4
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) &&
    hostname.split('.').every(num => parseInt(num) <= 255);
  if (ipv4) return true;
  // Check IPv6 (simple check for colons)
  if (hostname.indexOf(':') > 0) return true;
  return false;
}

/**
 * Parse URL from request path, exactly like the Node version
 * Handles scheme-omitted URLs, relative URLs, etc.
 */
function parseURL(req_url) {
  if (!req_url) return null;

  // Match: optional scheme, optional //, hostname:port, path+query
  const match = req_url.match(/^(?:(https?:)?\/\/)?(([^\/?]+?)(?::(\d{0,5})(?=[\/?]|$))?)([\/?][\S\s]*|$)/i);

  if (!match) {
    return null;
  }

  if (!match[1]) {
    // Scheme is omitted
    if (/^https?:/i.test(req_url)) {
      return null; // Ambiguous: could be host "http:" with path "//..."
    }
    if (req_url.lastIndexOf('//', 0) === -1) {
      // "//" is also omitted
      req_url = '//' + req_url;
    }
    // Default to https if port is 443, otherwise http
    req_url = (match[4] === '443' ? 'https:' : 'http:') + req_url;
  }

  try {
    const parsed = new URL(req_url);
    if (!parsed.hostname) {
      return null;
    }
    // Add .path for compatibility
    parsed.path = parsed.pathname + parsed.search;
    return parsed;
  } catch (e) {
    return null;
  }
}

/**
 * Adds CORS headers to the response headers.
 * Mirrors the Node.js withCORS function exactly.
 */
function withCORS(headers, request, corsMaxAge) {
  const result = new Headers(headers);
  result.set('access-control-allow-origin', '*');

  if (corsMaxAge) {
    result.set('access-control-max-age', String(corsMaxAge));
  }

  const requestMethod = request.headers.get('access-control-request-method');
  if (requestMethod) {
    result.set('access-control-allow-methods', requestMethod);
  }

  const requestHeaders = request.headers.get('access-control-request-headers');
  if (requestHeaders) {
    result.set('access-control-allow-headers', requestHeaders);
  }

  // Expose all headers
  const expose = Array.from(result.keys()).join(',');
  result.set('access-control-expose-headers', expose);

  return result;
}

/**
 * Check if request has required headers
 */
function hasRequiredHeaders(request, requireHeader) {
  if (!requireHeader) return true;

  const headers = request.headers;
  const required = Array.isArray(requireHeader) ? requireHeader : [requireHeader];
  return required.some((headerName) => headers.has(headerName.toLowerCase()));
}

/**
 * Handle redirects exactly like the Node version:
 * - For 301/302/303: follow internally up to maxRedirects
 * - For 307/308: rewrite location header (don't follow)
 * - Store X-CORS-Redirect-N headers for debugging
 */
function handleRedirectResponse(response, requestState, proxyBaseUrl, redirectCount) {
  const status = response.status;

  if (![301, 302, 303, 307, 308].includes(status)) {
    return null;
  }

  const locationHeader = response.headers.get('location');
  if (!locationHeader) {
    return null;
  }

  try {
    // Resolve relative URLs
    const resolved = new URL(locationHeader, requestState.location.href).href;
    const parsedLocation = parseURL(resolved);

    if (!parsedLocation) {
      return null;
    }

    if ([301, 302, 303].includes(status)) {
      // Follow redirects for 301/302/303
      const newCount = redirectCount + 1;
      if (newCount <= requestState.maxRedirects) {
        return {
          kind: 'follow',
          location: parsedLocation,
          redirectCount: newCount,
          debugHeader: `X-CORS-Redirect-${newCount}`,
          debugValue: `${status} ${resolved}`,
        };
      }
    }

    // For 307/308 or exceeded redirects, rewrite the location header
    return {
      kind: 'rewrite',
      location: `${proxyBaseUrl}/${resolved}`,
    };
  } catch (e) {
    return null;
  }
}

/**
 * Perform the actual proxied fetch
 */
async function proxyFetch(request, location, requestState, options, proxyBaseUrl, redirectCount = 0, responseHeaders = null) {
  const headers = new Headers(request.headers);

  // Set host to target
  headers.set('host', location.host);

  // Remove headers
  options.removeHeaders.forEach((header) => {
    headers.delete(header);
  });

  // Set custom headers
  Object.entries(options.setHeaders || {}).forEach(([key, value]) => {
    headers.set(key, String(value));
  });

  const body = (request.method !== 'GET' && request.method !== 'HEAD')
    ? await request.clone().arrayBuffer()
    : undefined;

  let response;
  try {
    response = await fetch(location.href, {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
    });
  } catch (error) {
    const corsHeaders = withCORS(new Headers(), request, options.corsMaxAge);
    return new Response(`Not found because of proxy error: ${error.message}`, {
      status: 404,
      headers: corsHeaders,
    });
  }

  // Collect outgoing headers
  const outHeaders = new Headers(response.headers);

  // Strip cookies
  outHeaders.delete('set-cookie');
  outHeaders.delete('set-cookie2');

  // Set x-final-url and x-request-url only on first request
  if (redirectCount === 0) {
    outHeaders.set('x-request-url', requestState.location.href);
  }
  outHeaders.set('x-final-url', requestState.location.href);

  // Handle redirects
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const redirectInfo = handleRedirectResponse(response, requestState, proxyBaseUrl, redirectCount);

    if (redirectInfo && redirectInfo.kind === 'follow') {
      // Follow the redirect internally
      requestState.location = redirectInfo.location;
      outHeaders.set(redirectInfo.debugHeader, redirectInfo.debugValue);

      const newRequest = new Request(location.href, {
        method: 'GET',
        headers: new Headers(),
      });

      return proxyFetch(
        newRequest,
        redirectInfo.location,
        requestState,
        options,
        proxyBaseUrl,
        redirectInfo.redirectCount,
        outHeaders
      );
    } else if (redirectInfo && redirectInfo.kind === 'rewrite') {
      // Rewrite location header
      outHeaders.set('location', redirectInfo.location);
    }
  }

  // Apply CORS headers
  const finalHeaders = withCORS(outHeaders, request, options.corsMaxAge);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: finalHeaders,
  });
}

/**
 * Main request handler
 */
async function handleRequest(request, env) {
  const options = { ...DEFAULT_OPTIONS };
  const url = new URL(request.url);
  const clientIP = request.headers.get('cf-connecting-ip') || 'unknown';

  // Log request (like the Node version)
  console.log(JSON.stringify([
    new Date().toISOString(),
    request.method,
    url.pathname,
    clientIP,
    request.headers.get('user-agent') || 'unknown',
  ]));

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    const corsHeaders = withCORS(new Headers(), request, options.corsMaxAge);
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  // Parse target URL from path
  const targetPath = decodeURIComponent(url.pathname.slice(1));
  const location = parseURL(targetPath);

  if (!location) {
    // Invalid URL, return usage info
    const corsHeaders = withCORS(new Headers(), request, options.corsMaxAge);
    // corsHeaders.set('content-type', 'application/json');
    corsHeaders.set('content-type', 'text/html; charset=UTF-8');
    // return new Response(JSON.stringify({
    //  usage: 'Host/{URL}',
    //  source: 'https://github.com/mrdnkl/proxy',
    // }),{
    return new Response(await nginx(), {
      status: 200,
      headers: corsHeaders,
    });
  }

  async function nginx() {
	const text = `
	<!DOCTYPE html>
	<html>
	<head>
	<title>Welcome to nginx!</title>
	<style>
		body {
			width: 35em;
			margin: 0 auto;
			font-family: Tahoma, Verdana, Arial, sans-serif;
		}
	</style>
	</head>
	<body>
	<h1>Welcome to nginx!</h1>
	<p>If you see this page, the nginx web server is successfully installed and
	working. Further configuration is required.</p>
	
	<p>For online documentation and support please refer to
	<a href="http://nginx.org/">nginx.org</a>.<br/>
	Commercial support is available at
	<a href="http://nginx.com/">nginx.com</a>.</p>
	
	<p><em>Thank you for using nginx.</em></p>
	</body>
	</html>
	`
	return text;
}

  // Check for special iscorsneeded endpoint
  if (location.host === 'iscorsneeded') {
    return new Response('no', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
  }

  // Validate port
  if (location.port && Number(location.port) > 65535) {
    const corsHeaders = withCORS(new Headers(), request, options.corsMaxAge);
    return new Response(`Port number too large: ${location.port}`, {
      status: 400,
      headers: corsHeaders,
    });
  }

  // Validate hostname (must have dot, IPv4, or IPv6)
  if (!/^\/https?:/.test(url.pathname) && !isValidHostName(location.hostname)) {
    const corsHeaders = withCORS(new Headers(), request, options.corsMaxAge);
    return new Response(`Invalid host: ${location.hostname}`, {
      status: 404,
      headers: corsHeaders,
    });
  }

  // Check required headers
  if (!hasRequiredHeaders(request, options.requireHeader)) {
    const corsHeaders = withCORS(new Headers(), request, options.corsMaxAge);
    return new Response(
      `Missing required request header. Must specify one of: ${options.requireHeader}`,
      {
        status: 400,
        headers: corsHeaders,
      }
    );
  }

  // Check keyword blacklist
  if (options.keywordBlacklist.some((keyword) => location.href.indexOf(keyword) >= 0)) {
    const corsHeaders = withCORS(new Headers(), request, options.corsMaxAge);
    return new Response(
      `The keyword "${options.keywordBlacklist.join(' ')}" was blacklisted by the operator of this proxy.`,
      {
        status: 403,
        headers: corsHeaders,
      }
    );
  }

  // Check origin blacklist
  if (options.originBlacklist.includes(location.hostname)) {
    const corsHeaders = withCORS(new Headers(), request, options.corsMaxAge);
    return new Response(
      `The origin "${location.hostname}" was blacklisted by the operator of this proxy.`,
      {
        status: 403,
        headers: corsHeaders,
      }
    );
  }

  // Check origin whitelist
  if (options.originWhitelist.length && !options.originWhitelist.includes(location.hostname)) {
    const corsHeaders = withCORS(new Headers(), request, options.corsMaxAge);
    return new Response(
      `The origin "${location.hostname}" was not whitelisted by the operator of this proxy.`,
      {
        status: 403,
        headers: corsHeaders,
      }
    );
  }

  // Check for same-origin redirect
  const origin = request.headers.get('origin') || '';
  if (options.redirectSameOrigin && origin) {
    // Check if location starts with origin and has "/" after it
    if (location.href.slice(0, origin.length) === origin &&
        location.href[origin.length] === '/') {
      // Redirect client directly
      const redirectHeaders = withCORS(new Headers(), request, options.corsMaxAge);
      redirectHeaders.set('vary', 'origin');
      redirectHeaders.set('cache-control', 'private');
      redirectHeaders.set('location', location.href);
      return new Response(null, {
        status: 301,
        headers: redirectHeaders,
      });
    }
  }

  // Determine proxy base URL (handle x-forwarded-proto for HTTPS detection)
  const isHttps = url.protocol === 'https:' ||
    /^\s*https/.test(request.headers.get('x-forwarded-proto') || '');
  const proxyBaseUrl = `${isHttps ? 'https:' : 'http:'}//${url.host}`;

  // Create request state
  const requestState = {
    location,
    maxRedirects: options.maxRedirects,
    corsMaxAge: options.corsMaxAge,
    proxyBaseUrl,
  };

  return proxyFetch(request, location, requestState, options, proxyBaseUrl);
}

/**
 * Cloudflare Worker entrypoint
 */
export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error('Worker error:', error);
      return new Response(`Internal Server Error: ${error.message}`, {
        status: 500,
        headers: { 'access-control-allow-origin': '*' },
      });
    }
  },
};
