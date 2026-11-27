// Small HTTP helpers on the built-in fetch. A non-2xx answer throws an error with
// response { status, data }; a request longer than timeout ms is aborted.

async function readBody(response, responseType) {
  if (responseType === 'arraybuffer') return response.arrayBuffer();
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Resolves to { data }: parsed JSON (or text), or an ArrayBuffer with responseType 'arraybuffer'.
async function request(method, url, { body, headers = {}, params, timeout = 10_000, responseType = 'json' } = {}) {
  const target = params ? `${url}?${new URLSearchParams(params)}` : url;
  const response = await fetch(target, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const data = await readBody(response, responseType);
  if (!response.ok) {
    const err = new Error(`Request failed with status code ${response.status}`);
    err.response = { status: response.status, data };
    throw err;
  }
  return { data };
}

const get = (url, options) => request('GET', url, options);
const post = (url, body, options) => request('POST', url, { ...options, body });

module.exports = { get, post };
