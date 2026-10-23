
'use strict';

const crypto = require('node:crypto');

const ALLOWED_ORIGINS = new Set([
  'https://cinderellahomecare.com.tr',
  'https://www.cinderellahomecare.com.tr',
]);

const ALLOWED_HOSTNAMES = new Set([
  'cinderellahomecare.com.tr',
  'www.cinderellahomecare.com.tr',
]);

const RATE_LIMIT_WINDOW_SECONDS = 10 * 60;
const RATE_LIMIT_MAX_REQUESTS = 10;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function getHeader(headers, name) {
  if (!headers) return '';
  const key = Object.keys(headers).find(
    (k) => k.toLowerCase() === name.toLowerCase()
  );
  return key ? String(headers[key] || '') : '';
}

async function checkAndCount(ip) {
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!redisUrl || !redisToken) {
    throw new Error('atomic_rate_limit_not_configured');
  }

  const key = `cinderella:verify-rate:${sha256(ip)}`;

  const script = [
    "local count = redis.call('INCR', KEYS[1])",
    "if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end",
    'return count',
  ].join('\n');

  const response = await fetch(redisUrl.replace(/\/$/, ''), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${redisToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([
      'EVAL',
      script,
      '1',
      key,
      String(RATE_LIMIT_WINDOW_SECONDS),
    ]),
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) throw new Error('rate_limit_store_unavailable');

  const result = await response.json();
  if (result.error) throw new Error('rate_limit_store_unavailable');

  const count = Number(result.result);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error('rate_limit_invalid_response');
  }

  return count > RATE_LIMIT_MAX_REQUESTS;
}

exports.handler = async (event) => {
  const origin = getHeader(event.headers, 'origin');
  const originIsAllowed = !origin || ALLOWED_ORIGINS.has(origin);

  const corsOrigin =
    origin && ALLOWED_ORIGINS.has(origin)
      ? origin
      : 'https://cinderellahomecare.com.tr';

  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };

  const reply = (statusCode, payload) => ({
    statusCode,
    headers,
    body: JSON.stringify(payload),
  });

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return reply(405, {
      success: false,
      error: 'method_not_allowed',
    });
  }

  if (!originIsAllowed) {
    return reply(403, {
      success: false,
      error: 'origin_not_allowed',
    });
  }

  const contentType = getHeader(event.headers, 'content-type');
  if (!contentType.toLowerCase().includes('application/json')) {
    return reply(415, {
      success: false,
      error: 'content_type_must_be_json',
    });
  }

  const clientIp = getHeader(
    event.headers,
    'x-nf-client-connection-ip'
  ).trim();

  if (!clientIp || clientIp.length > 100) {
    return reply(503, {
      success: false,
      error: 'rate_limit_ip_unavailable',
    });
  }

  try {
    if (await checkAndCount(clientIp)) {
      return reply(429, {
        success: false,
        error: 'rate_limited',
        message: 'Too many attempts. Please wait 10 minutes and try again.',
      });
    }
  } catch (_) {
    return reply(503, {
      success: false,
      error: 'rate_limit_store_unavailable',
    });
  }

  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    return reply(500, {
      success: false,
      error: 'verification_not_configured',
    });
  }

  let token;

  try {
    const body = JSON.parse(event.body || '{}');
    token = body.token;
  } catch (_) {
    return reply(400, {
      success: false,
      error: 'invalid_json',
    });
  }

  if (
    typeof token !== 'string' ||
    token.length < 10 ||
    token.length > 4096
  ) {
    return reply(400, {
      success: false,
      error: 'invalid_token',
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const form = new URLSearchParams({
      secret,
      response: token,
    });
    form.set('remoteip', clientIp);

    const response = await fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      return reply(502, {
        success: false,
        error: 'verification_unavailable',
      });
    }

    const result = await response.json();
    const hostname =
      typeof result.hostname === 'string'
        ? result.hostname.toLowerCase()
        : '';

    if (
      result.success === true &&
      ALLOWED_HOSTNAMES.has(hostname)
    ) {
      return reply(200, { success: true });
    }

    return reply(403, {
      success: false,
      error:
        result.success === true
          ? 'hostname_not_allowed'
          : 'verification_failed',
      codes: Array.isArray(result['error-codes'])
        ? result['error-codes']
        : [],
      hostname: hostname || undefined,
    });
  } catch (_) {
    return reply(502, {
      success: false,
      error: 'verification_unavailable',
    });
  } finally {
    clearTimeout(timeout);
  }
};
