import { NextResponse } from "next/server";

export const runtime = "nodejs";

const GDELT_PROXY_BASE = "https://nameless-paper-1be6.chrisdmuggie.workers.dev";

// GDELT asks for 1 request / 5 seconds. We'll enforce 6s to be safe.
const MIN_GDELT_INTERVAL_MS = 6000;

// Best-effort per-instance throttle (Vercel serverless may run multiple instances)
let lastGdeltAt = 0;

type SeriesPoint = { date: string; close: number };
type GdeltArticle = {
  url?: string;
  title?: string;
  seendate?: string;
  seenDate?: string;
  date?: string;
  datetime?: string;
};

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") || "border wall").trim();
  const result = await analyze(q);

  const jsonText = JSON.stringify(result, null, 2);
  return new Response(
    `<!doctype html><meta charset="utf-8">
<pre style="white-space:pre-wrap;word-break:break-word;font:14px/1.4 system-ui;color:#111;background:#fff;padding:12px;margin:0">
${escapeHtml(jsonText)}
</pre>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
  );
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const quoteRaw = String(body?.quote ?? "").trim();
    if (!quoteRaw) {
      return NextResponse.json({ ok: false, error: "Missing quote", httpStatus: 400 }, { status: 400 });
    }

    const result = await analyze(quoteRaw);
    const status = result.ok ? 200 : result.httpStatus ?? 500;
    return NextResponse.json(result, { status, headers: { "Cache-Control": "no-store" } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Bad request", httpStatus: 400 }, { status: 400 });
  }
}

async function analyze(input: string): Promise<any> {
  try {
    const normalized = input
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/\s+/g, " ")
      .slice(0, 240);

    const safe = normalized.replace(/"/g, '\\"');
    const query = `"${safe}" trump`;

    const gdeltUrl =
      "https://api.gdeltproject.org/api/v2/doc/doc" +
      `?query=${encodeURIComponent(query)}` +
      `&mode=artlist&format=json&sort=dateasc&maxrecords=20`;

    // --- Throttle (best-effort)
    const now = Date.now();
    const waitMs = lastGdeltAt ? Math.max(0, MIN_GDELT_INTERVAL_MS - (now - lastGdeltAt)) : 0;
    if (waitMs > 0) {
      return {
        ok: false,
        httpStatus: 429,
        error: `Rate limited to protect GDELT. Wait ${Math.ceil(waitMs / 1000)}s and try again.`,
        debug: { rule: "min 1 request / 6s", waitMs },
      };
    }
    lastGdeltAt = now;

    // Proxy request + ask worker/CDN to cache briefly to reduce repeated hits
    const proxied = `${GDELT_PROXY_BASE}/?url=${encodeURIComponent(gdeltUrl)}&cache=1`;

    const gdeltRes = await fetch(proxied);
    const gdeltStatus = gdeltRes.status;
    const gdeltText = await gdeltRes.text();

    // Handle 429 plain-text from GDELT (via proxy)
    if (gdeltStatus === 429) {
      return {
        ok: false,
        httpStatus: 429,
        error: "GDELT rate limited this request. Try again in ~5–10 seconds.",
        debug: {
          gdeltStatus,
          proxied,
          preview: gdeltText.slice(0, 200),
        },
      };
    }

    let gdeltJson: any;
    try {
      gdeltJson = JSON.parse(gdeltText);
    } catch {
      return {
        ok: false,
        httpStatus: 502,
        error: `GDELT (via proxy) returned non-JSON (status ${gdeltStatus}).`,
        debug: { gdeltStatus, proxied, preview: gdeltText.slice(0, 200) },
      };
    }

    const articles: GdeltArticle[] = Array.isArray(gdeltJson?.articles) ? gdeltJson.articles : [];
    if (!articles.length) {
      return {
        ok: false,
        httpStatus: 404,
        error: "No matching articles found in GDELT for that phrase.",
        debug: { query, gdeltStatus, proxied },
      };
    }

    const earliest = articles[0];
    const earliestRaw = getBestDate(earliest);
    const earliestIso = toIso(earliestRaw);

    if (!earliestIso) {
      return {
        ok: false,
        httpStatus: 500,
        error: "Could not parse earliest publish datetime from GDELT.",
        debug: { earliestRaw, gdeltStatus },
      };
    }

    // SPY daily history from Stooq
    const stooqUrl = "https://stooq.com/q/d/l/?s=spy.us&i=d";
    const stooqRes = await fetch(stooqUrl);
    const stooqStatus = stooqRes.status;
    const csvText = await stooqRes.text();

    if (csvText.trim().startsWith("<")) {
      return {
        ok: false,
        httpStatus: 502,
        error: `Stooq returned non-CSV (status ${stooqStatus}).`,
        debug: { stooqStatus, preview: csvText.slice(0, 200) },
      };
    }

    const seriesAll = parseStooqDaily(csvText);
    if (seriesAll.length < 30) {
      return { ok: false, httpStatus: 500, error: "Stooq returned too little data.", debug: { stooqStatus, seriesLen: seriesAll.length } };
    }

    const eventDate = earliestIso.slice(0, 10);
    const eventIdx = findIndexOnOrAfter(seriesAll, eventDate);
    if (eventIdx < 1) {
      return { ok: false, httpStatus: 500, error: "Could not align event date to SPY trading data.", debug: { earliestIso, eventDate } };
    }

    const prev = seriesAll[eventIdx - 1];
    const evt = seriesAll[eventIdx];
    const next = seriesAll[eventIdx + 1];

    const start = Math.max(0, eventIdx - 10);
    const end = Math.min(seriesAll.length, eventIdx + 11);

    return {
      ok: true,
      input,
      normalized,
      query,
      earliest: {
        datetime: earliestIso,
        title: earliest.title ?? "",
        url: earliest.url ?? "",
      },
      spy: {
        eventTradingDate: evt.date,
        retPrevToEventPct: pctChange(prev.close, evt.close),
        retEventToNextPct: next ? pctChange(evt.close, next.close) : undefined,
      },
      series: seriesAll.slice(start, end),
      debug: { gdeltStatus, stooqStatus },
    };
  } catch (e: any) {
    return { ok: false, httpStatus: 500, error: e?.message || "Server error" };
  }
}

function getBestDate(a: any): string | null {
  return a?.seendate || a?.seenDate || a?.datetime || a?.date || null;
}

function toIso(dt: string | null): string | null {
  if (!dt) return null;
  if (/^\d{14}$/.test(dt)) {
    const y = dt.slice(0, 4);
    const m = dt.slice(4, 6);
    const d = dt.slice(6, 8);
    const hh = dt.slice(8, 10);
    const mm = dt.slice(10, 12);
    const ss = dt.slice(12, 14);
    return `${y}-${m}-${d}T${hh}:${mm}:${ss}Z`;
  }
  const t = Date.parse(dt);
  return isNaN(t) ? null : new Date(t).toISOString();
}

function parseStooqDaily(csv: string): SeriesPoint[] {
  const lines = csv.trim().split(/\r?\n/);
  const out: SeriesPoint[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    if (parts.length < 5) continue;
    const date = parts[0];
    const close = Number(parts[4]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (!isFinite(close)) continue;
    out.push({ date, close });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

function findIndexOnOrAfter(series: Array<{ date: string }>, date: string) {
  let lo = 0,
    hi = series.length - 1,
    ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].date >= date) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

function pctChange(a: number, b: number) {
  return ((b - a) / a) * 100;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => {
    const m: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return m[c] || c;
  });
}
