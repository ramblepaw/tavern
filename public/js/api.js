async function request(method, url, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new Error("Can't reach the server. Check your connection.");
  }
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/login') && !url.startsWith('/api/register')) {
      window.dispatchEvent(new Event('tavern:unauthorized'));
    }
    const fallback = res.status === 413 ? 'That upload is too large for the server.' : `Something went wrong (${res.status}).`;
    const err = new Error(data?.error || fallback);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body) => request('POST', url, body ?? {}),
  patch: (url, body) => request('PATCH', url, body ?? {}),
  del: (url) => request('DELETE', url),
};
