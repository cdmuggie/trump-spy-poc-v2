import { NextResponse } from "next/server";

export const runtime = "nodejs";

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
  // Mobile-friendly debug endpoint:
  // https://YOUR.vercel.app/api/analyze?q=border%20wall
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") || "border wall").trim();

  const result = await analyze(q);

  const jsonText = JSON.stringify(result, null, 2);
  return new Response(
    `<!doctype html><meta charset="utf-8">
<pre style="white-space:pre-wrap;word-break:break-word;font:14px/1.4 system-ui;color:#111;background:#fff;padding:12px;margin:0">
${escapeHtml(jsonText)}
</pre>`,
    {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    }
  );
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const quoteRaw = String(body?.quote ?? "").trim();
    if (!quoteRaw) {
      return NextResponse.json({ ok: false, error: "Missing quote" }, { status: 400 });
    }

    const result = await analyze(quoteRaw);

    // Always JSON; never let Next.js return an HTML error page to the client
    const status = result.ok ? 200 : (result.httpStatus ?? 500);
    return NextResponse.json(result, {
      status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "Bad request", httpStatus: 400 },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
}

async function analyze(input: string): Promise<any> {
  // Wrap everything so client never sees HTML
  try {
    // Normalize smart quotes, whitespace
    const normalized = input
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/\s+/g, " ")
      .slice(0, 240);

    // Escape quotes for query string
    const safe = normalized.replace(/"/g, '\\"');

    // IMPORTANT: no parentheses -> avoids GDELT returning plain-text "Parentheses..."
    // Phrase match + keyword trump for relevance
    const query = `"${safe}" trump`;

    const gdeltUrl =
      "https://api.gdeltproject.org/api/v2/doc/doc" +
      `?query=${encodeURIComponent(query)}` +
      `&mode=artlist&format=json&sort=dateasc&maxrecords=50`;

    const gdeltRes = await fetch(gdeltUrl, {
      headers: { "User-Agent": "trump-spy-poc/1.0" },
    });
    const gdeltStatus = gdeltRes.status;
    const gdeltText = await gdeltRes.text();

    let gdeltJson: any;
    try {
      gdeltJson = JSON.parse(gdeltText);
    } catch {
      return {
        ok: false,
        httpStatus: 502,
        error: `GDELT returned non-JSON (status ${gdeltStatus}).`,
        debug: {
          input,
          normalized,
          query,
          gdeltStatus,
          gdeltPreview: gdeltText.slice(0, 200),
        },
      };
    }

    const articles: GdeltArticle[] = Array.isArray(gdeltJson?.articles) ? gdeltJson.articles : [];
    if (!articles.length) {
      return {
        ok: false,
        httpStatus: 404,
        error: "No matching articles found in GDELT for that phrase.",
        debug: { input, normalized, query, gdeltStatus },
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

    // SPY daily history from Stooq (no key)
    const stooqUrl = "https://stooq.com/q/d/l/?s=spy.us&i=d";
    const stooqRes = await fetch(stooqUrl);
    const stooqStatus = stooqRes.status;
    const csvText = await stooqRes.text();

    // If Stooq returns HTML (rare), don’t try to parse as CSV
    if (csvText.trim().startsWith("<")) {
      return {
        ok: false,
        httpStatus: 502,
        error: `Stooq returned non-CSV (status ${stooqStatus}).`,
        debug: { stooqStatus, stooqPreview: csvText.slice(0, 200) },
      };
    }

    const seriesAll = parseStooqDaily(csvText);
    if (seriesAll.length < 30) {
      return {
        ok: false,
        httpStatus: 500,
        error: "Stooq returned too little data.",
        debug: { stooqStatus, seriesLen: seriesAll.length },
      };
    }

    const eventDate = earliestIso.slice(0, 10);
    const eventIdx = findIndexOnOrAfter(seriesAll, eventDate);
    if (eventIdx < 1) {
      return {
        ok: false,
        httpStatus: 500,
        error: "Could not align event date to SPY trading data.",
        debug: { earliestIso, eventDate, seriesLen: seriesAll.length },
      };
    }

    const prev = seriesAll[eventIdx - 1];
    const evt = seriesAll[eventIdx];
    const next = seriesAll[eventIdx + 1];

    const start = Math.max(0, eventIdx - 10);
    const end = Math.min(seriesAll.length, eventIdx + 11);
    const windowSeries = seriesAll.slice(start, end);

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
      series: windowSeries,
      debug: {
        gdeltStatus,
        stooqStatus,
      },
    };
  } catch (e: any) {
    return {
      ok: false,
      httpStatus: 500,
      error: e?.message || "Server error",
    };
  }
}

function getBestDate(a: any): string | null {
  return a?.seendate || a?.seenDate || a?.datetime || a?.date || null;
}

function toIso(dt: string | null): string | null {
  if (!dt) return null;

  // GDELT often uses YYYYMMDDhhmmss
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
  if (!isNaN(t)) return new Date(t).toISOString();

  return null;
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
    const m: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return m[c] || c;
  });
}
