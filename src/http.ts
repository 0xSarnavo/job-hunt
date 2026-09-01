const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

// Gentle pacing: one host is never hit more often than every 500ms.
const lastHit = new Map<string, number>();
async function pace(url: string) {
  const host = new URL(url).host;
  const wait = (lastHit.get(host) ?? 0) + 500 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastHit.set(host, Date.now());
}

export async function get(url: string, timeoutMs = 20_000): Promise<Response> {
  await pace(url);
  return fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json, text/html, */*" },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "follow",
  });
}

export async function getJson(url: string, timeoutMs = 20_000): Promise<any | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await get(url, timeoutMs);
      if (res.ok) return await res.json();
      if (res.status >= 400 && res.status < 500) return null; // no retry on 4xx
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

export async function getText(url: string): Promise<string | null> {
  try {
    const res = await get(url);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export async function postJson(url: string, body: unknown): Promise<any | null> {
  try {
    await pace(url);
    const res = await fetch(url, {
      method: "POST",
      headers: { "User-Agent": UA, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
