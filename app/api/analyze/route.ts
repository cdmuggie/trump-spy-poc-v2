import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const quoteRaw = String(body?.quote ?? "").trim();
    if (!quoteRaw) {
      return NextResponse.json({ ok: false, error: "Missing quote" });
    }

    const phrase = quoteRaw.replace(/\s+/g, " ").slice(0, 240);
    const q = `("${phrase}") (trump OR "donald trump")`;

    const gdeltUrl =
      "https://api.gdeltproject.org/api/v2/doc/doc" +
      `?query=${encodeURIComponent(q)}` +
      `&mode=artlist&format=json&sort=dateasc&maxrecords=10`;

    const gRes = await fetch(gdeltUrl);
    const gJson = await gRes.json();

    const earliest = gJson.articles?.[0];
    if (!earliest) {
      return NextResponse.json({ ok: false, error: "No article found." });
    }

    const earliestIso = toIso(
      earliest.seendate ||
      earliest.seenDate ||
      earliest.datetime ||
      earliest.date
    );

    const csvUrl = "https://stooq.com/q/d/l/?s=spy.us&i=d";
    const cRes = await fetch(csvUrl);
    const csvText = await cRes.text();

    const seriesAll = parseStooqDaily(csvText);

    const eventDate = earliestIso.slice(0, 10);
    const eventIdx = findIndexOnOrAfter(seriesAll, eventDate);

    const prev = seriesAll[eventIdx - 1];
    const evt = seriesAll[eventIdx];
    const next = seriesAll[eventIdx + 1];

    const start = Math.max(0, eventIdx - 10);
    const end = Math.min(seriesAll.length, eventIdx + 11);
    const windowSeries = seriesAll.slice(start, end);

    return NextResponse.json({
      ok: true,
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
    return NextResponse.json({ ok: false, error: e?.message || "Error" });
  }
}

function toIso(dt: string): string {
  if (/^\d{14}$/.test(dt)) {
    const y = dt.slice(0, 4);
    const m = dt.slice(4, 6);
    const d = dt.slice(6, 8);
    const hh = dt.slice(8, 10);
    const mm = dt.slice(10, 12);
    const ss = dt.slice(12, 14);
    return `${y}-${m}-${d}T${hh}:${mm}:${ss}Z`;
  }
  return new Date(dt).toISOString();
}

function parseStooqDaily(csv: string) {
  const lines = csv.trim().split(/\r?\n/);
  const out: any[] = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(",");
    if (p.length < 5) continue;
    out.push({ date: p[0], close: Number(p[4]) });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

function findIndexOnOrAfter(series: any[], date: string) {
  for (let i = 0; i < series.length; i++) {
    if (series[i].date >= date) return i;
  }
  return 1;
}

function pctChange(a: number, b: number) {
  return ((b - a) / a) * 100;

}
