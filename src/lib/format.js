
export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  if (Math.round(n) < 1024) return `${Math.round(n)} B`;
  // Pick the unit after rounding, so 1048570 is "1.0 MB", not "1024.0 KB".
  const kb = (n / 1024).toFixed(1);
  if (Number(kb) < 1024) return `${kb} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const rounded = Math.round(ms);
  return rounded < 1000 ? `${rounded} ms` : `${(ms / 1000).toFixed(2)} s`;
}

// Human-readable reason a replay failed.
export function fetchErrorMessage(error, url, { cancelled = false, timedOut = false, timeoutMs = 0, online = true } = {}) {
  if (cancelled) return 'Request cancelled.';
  if (timedOut) return `No response after ${Math.round(timeoutMs / 1000)} s — timed out.`;
  if (!online) return 'You’re offline.';
  const message = typeof error === 'string' ? error
    : (typeof error?.message === 'string' && error.message) || error?.name || 'Unknown error';
  if (/failed to fetch|networkerror|network error|load failed/i.test(message)) {
    let host = url;
    try {
      host = new URL(url).host;
    } catch { /* keep url */ }
    return `Couldn’t reach ${host}. The server may be down, the host name may not resolve, `
      + 'the connection may have been refused, or the TLS handshake failed.';
  }
  return message;
}
