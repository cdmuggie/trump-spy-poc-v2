import { NextResponse } from "next/server";

export const runtime = "nodejs";

type GdeltArticle = {
  url?: string;
  title?: string;
  seendate?: string;
  seenDate?: string;
  date?: string;
  datetime?: string;
};

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const quoteRaw = String(body?.quote ?? "").trim();
    if (!quoteRaw) {
      return NextResponse.json({ ok: false, error: "Missing quote" }, { status: 400 });
    }

    // Normalize quotes + whitespace
    const normalized = quoteRaw
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/\s+/g, " ")
      .slice(0, 240);

    const safe = normalized.replace(/"/g, '\\"');

    // NO parentheses. Simple query.
    const q = `"${safe}" trump`;

    const gdeltUrl =
      "https://api.gdeltproject.org/api/v2/doc/doc" +
      `?query=${encodeURIComponent(q)}` +
      `&mode=artlist&format=json&sort=dateasc&maxrecords=50`;

    const gRes = await fetch(gdeltUrl, { headers: { "User-Agent": "trump-spy-poc/1.0" } });
    const gdeltText = await gRes.text();

    let gJson: any;
    try {
      gJson = JSON.parse(gdeltText);
    } catch {
      return NextResponse.json(
        { ok: false, error: `GDELT returned non-JSON: ${gdeltText.slice(0, 200)}` },
        { status: 502 }
      );
    }

    const articles: GdeltArticle[] = Array.isArray(gJson?.articles) ? gJson.articles : [];
    if (!articles.length) {
      return NextResponse.json(
        { ok: false, error: "No matching articles found in GDELT for that phrase." },
        { status: 404 }
      );
    }

    const earliest = articles[0];
    const earliestIso = toIso(getBestDate(earliest));
    if (!earliestIso) {
      return NextResponse.json({ ok: false, error: "Could not parse earliest publish datetime." }, { status: 500 });
    }

    // SPY daily history from Stooq
    const csvUrl = "https://stooq.com/q/d/l/?s=spy.us&i=d";
    const cRes = await fetch(csvUrl);
    if (!cRes.ok) {
      return NextResponse.json({ ok: false, error: `Stooq request failed (${cRes.status})` }, { status: 502 });
    }
    const csvText = await cRes.text();

    const seriesAll = parseStooqDaily(csvText);
    if (seriesAll.length < 30) {
      return NextResponse.json({ ok: false, error: "Stooq returned too little data." }, { status: 500 });
    }

    const eventDate = earliestIso.slice(0, 10);
    const eventIdx = findIndexOnOrAfter(seriesAll, eventDate);
    if (eventIdx < 1) {
      return NextResponse.json({ ok: false, error: "Could not align event date to SPY trading data." }, { status: 500 });
    }

    const prev = seriesAll[eventIdx - 1];
    const evt = seriesAll[eventIdx];
    const next = seriesAll[eventIdx + 1];

    const start = Math.max(0, eventIdx - 10);
    const end = Math.min(seriesAll.length, eventIdx + 11);
    const windowSeries = seriesAll.slice(start, end);

    return NextResponse.json({
      ok: true,
      query: q,
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
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Server error" }, { status: 500 });
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

function parseStooqDaily(csv: string): Array<{ date: string; close: number }> {
  const lines = csv.trim().split(/\r?\n/);
  const out: Array<{ date: string; close: number }> = [];
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
