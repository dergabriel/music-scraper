export function buildUrl(path, params = null) {
  if (!params) return path;
  const search = params instanceof URLSearchParams
    ? params
    : new URLSearchParams(
      Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== '')
    );
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

export async function apiFetch(url, options) {
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return body;
}
