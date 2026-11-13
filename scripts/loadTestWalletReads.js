const fs = require('node:fs/promises');

const REQUIRED_CONFIRMATION = 'I_OWN_THIS_STAGING_SERVICE';
const PRODUCTION_HOSTS = new Set([
  'gwic-backend.onrender.com',
]);
const REQUEST_TIMEOUT_MS = 15_000;
const EXPECTED_USERS = 70;

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set.`);
  return value;
}

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function getSessionCookie(response) {
  const setCookies = response.headers.getSetCookie?.() ?? [];
  const cookieHeader = setCookies.find((value) => value.startsWith('gwic_session='))
    ?? response.headers.get('set-cookie');
  const cookie = cookieHeader?.split(';', 1)[0];
  if (!cookie?.startsWith('gwic_session=') || cookie.length <= 'gwic_session='.length) {
    throw new Error('A staging test account did not receive a session cookie.');
  }
  return cookie;
}

async function login(baseUrl, user) {
  const response = await fetch(new URL('/api/auth/login', baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email: user.email, password: user.password }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Staging login failed with HTTP ${response.status}.`);
  }
  await response.body?.cancel();
  return getSessionCookie(response);
}

async function readWallet(baseUrl, cookie) {
  const startedAt = performance.now();
  try {
    const response = await fetch(new URL('/api/wallet', baseUrl), {
      headers: { Accept: 'application/json', Cookie: cookie },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    await response.arrayBuffer();
    return { status: response.status, durationMs: performance.now() - startedAt };
  } catch (error) {
    return {
      status: error.name === 'TimeoutError' ? 'timeout' : 'network_error',
      durationMs: performance.now() - startedAt,
    };
  }
}

async function logout(baseUrl, cookie) {
  const response = await fetch(new URL('/api/auth/logout', baseUrl), {
    method: 'POST',
    headers: { Accept: 'application/json', Cookie: cookie },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  await response.body?.cancel();
  return response.ok;
}

async function main() {
  const baseUrl = new URL(requireEnv('LOAD_TEST_BASE_URL'));
  const confirmedHost = requireEnv('LOAD_TEST_CONFIRM_HOST').toLowerCase();
  const confirmation = requireEnv('LOAD_TEST_CONFIRMATION');
  const usersPath = requireEnv('LOAD_TEST_USERS_FILE');

  if (!['http:', 'https:'].includes(baseUrl.protocol)) {
    throw new Error('LOAD_TEST_BASE_URL must use HTTP or HTTPS.');
  }
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash
    || (baseUrl.pathname !== '/' && baseUrl.pathname !== '')) {
    throw new Error('LOAD_TEST_BASE_URL must contain only the scheme and host.');
  }
  if (PRODUCTION_HOSTS.has(baseUrl.hostname.toLowerCase())) {
    throw new Error('This load test refuses to target the production backend.');
  }
  if (confirmedHost !== baseUrl.hostname.toLowerCase()) {
    throw new Error('LOAD_TEST_CONFIRM_HOST must exactly match the staging hostname.');
  }
  if (confirmation !== REQUIRED_CONFIRMATION) {
    throw new Error(`Set LOAD_TEST_CONFIRMATION=${REQUIRED_CONFIRMATION} to confirm an authorized staging test.`);
  }
  if (baseUrl.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(baseUrl.hostname)) {
    throw new Error('Non-local staging targets must use HTTPS.');
  }

  const users = JSON.parse(await fs.readFile(usersPath, 'utf8'));
  if (!Array.isArray(users) || users.length !== EXPECTED_USERS
    || users.some((user) => (
      typeof user?.email !== 'string'
      || !user.email.includes('@')
      || typeof user?.password !== 'string'
      || user.password.length === 0
    ))) {
    throw new Error(`The users file must contain exactly ${EXPECTED_USERS} test accounts with email and password fields.`);
  }

  console.log(`Preparing ${EXPECTED_USERS} test sessions for ${baseUrl.origin}; logins are sequential.`);
  const cookies = [];
  try {
    for (const user of users) {
      cookies.push(await login(baseUrl, user));
    }

    console.log(`Sending one authenticated GET /api/wallet request concurrently for each of ${EXPECTED_USERS} test accounts.`);
    const testStartedAt = performance.now();
    const results = await Promise.all(cookies.map((cookie) => readWallet(baseUrl, cookie)));
    const totalDurationMs = performance.now() - testStartedAt;
    const durations = results.map((result) => result.durationMs);
    const statusCounts = new Map();
    for (const result of results) {
      statusCounts.set(result.status, (statusCounts.get(result.status) ?? 0) + 1);
    }

    console.log(`Requests completed in ${Math.round(totalDurationMs)} ms.`);
    console.log(`HTTP 200: ${statusCounts.get(200) ?? 0}/${EXPECTED_USERS}`);
    for (const [status, count] of statusCounts) {
      if (status !== 200) console.log(`${status}: ${count}`);
    }
    console.log(`Latency ms: p50=${Math.round(percentile(durations, 0.5))}, p95=${Math.round(percentile(durations, 0.95))}, max=${Math.round(Math.max(...durations))}`);

    if (results.some((result) => result.status !== 200)) process.exitCode = 1;
  } finally {
    let logoutFailures = 0;
    for (const cookie of cookies) {
      try {
        if (!(await logout(baseUrl, cookie))) logoutFailures += 1;
      } catch {
        logoutFailures += 1;
      }
    }
    if (logoutFailures > 0) {
      console.error(`Could not log out ${logoutFailures} staging test account(s); invalidate their sessions before reusing them.`);
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
