import { NextResponse } from "next/server";

export const runtime = "nodejs";

const PROXY = "https://nameless-paper-1be6.chrisdmuggie.workers.dev";
const KEY = process.env.TWELVE_API_KEY;

// cache 2 minutes so refreshes don't hammer APIs
let cache: any = null;
let cacheTime = 0;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";

  if (!force && cache && Date.now() - cacheTime < 120000) {
    return NextResponse.json(cache);
  }

  // Hard fail if key is missing (otherwise you'll get empty spy and no clue why)
  if (!KEY) {
    const out = {
      ok: false,
      error: "Missing TWELVE_API_KEY env var in Vercel. Add it then redeploy.",
      debug: {
        haveKey: false,
      },
      quotes: [],
      spy: [],
    };
    cache = out;
    cacheTime = Date.now();
    return NextResponse.json(out, { status: 500 });
  }

  // ---- 1) Quotes today (Milestone B - simple)
  // Pull a small list of recent Trump articles and use their titles as quote placeholders for now.
  // (Milestone C will replace this with true quote extraction + virality ranking.)
  const gdeltUrl =
    "https://api.gdeltproject.org/api/v2/doc/doc" +
    `?query=${encodeURIComponent("trump")}` +
    `&mode=artlist&format=json&sort=datedesc&maxrecords=50`;

  const gdeltProxied = `${PROXY}/?url=${encodeURIComponent(gdeltUrl)}`;

  let gdeltStatus: number | null = null;
  let gdeltText = "";
  let gdeltJson: any = null;

  try {
    const r = await fetch(gdeltProxied);
    gdeltStatus = r.status;
    gdeltText = await r.text();
    try {
      gdeltJson = JSON.parse(gdeltText);
    } catch {
      gdeltJson = null;
    }
  } catch (e: any) {
    // keep going; we’ll return debug
  }

  const articles = Array.isArray(gdeltJson?.articles) ? gdeltJson.articles : [];
  const rawQuotes = articles.slice(0, 20).map((a: any) => ({
    text: String(a?.title ?? "").trim().slice(0, 180),
    datetime: a?.seendate || a?.date || a?.datetime || null,
    url: a?.url || null,
  }));

  // de-dup by text
  const quotes = Array.from(new Map(rawQuotes.filter(q => q.text).map((q: any) => [q.text, q])).values()).slice(0, 5);

  // ---- 2) SPY intraday hourly (Milestone A)
  // Use Twelve Data time_series. "1h" interval. Output size large enough for "today" in any TZ.
  const tdUrl =
    `https://api.twelvedata.com/time_series` +
    `?symbol=SPY&interval=1h&outputsize=120&apikey=${encodeURIComponent(KEY)}`;

  let tdStatus: number | null = null;
  let tdText = "";
  let tdJson: any = null;

  try {
    const r = await fetch(tdUrl);
    tdStatus = r.status;
    tdText = await r.text();
    try {
      tdJson = JSON.parse(tdText);
    } catch {
      tdJson = null;
    }
  } catch (e: any) {
    // keep going; we’ll return debug
  }

  // Twelve Data returns {status:"error", message:"..."} when key missing/invalid or rate limited
  const tdValues = Array.isArray(tdJson?.values) ? tdJson.values : [];

  // Keep only "today" in America/New_York (your timezone)
  const spy = filterToTodayNY(tdValues).map((b: any) => ({
    time: b.datetime,          // string from Twelve Data
    close: Number(b.close),
  })).filter((p: any) => isFinite(p.close));

  const out = {
    ok: true,
    quotes,
    spy,
    debug: {
      haveKey: true,
      gdelt: {
        url: gdeltUrl,
        proxied: gdeltProxied,
        status: gdeltStatus,
        articlesCount: articles.length,
        preview: gdeltText ? gdeltText.slice(0, 120) : "",
      },
      twelvedata: {
        url: tdUrl.replace(KEY, "***"),
        status: tdStatus,
        hasValues: Array.isArray(tdJson?.values),
        valuesCount: tdValues.length,
        tdStatusField: tdJson?.status,
        tdMessage: tdJson?.message,
        preview: tdText ? tdText.slice(0, 160) : "",
      },
      note:
        "If spy is empty, check debug.twelvedata.tdMessage. If quotes empty, check debug.gdelt.preview/status.",
    },
  };

  cache = out;
  cacheTime = Date.now();

  return NextResponse.json(out);
}

// --- Helpers

function filterToTodayNY(values: any[]) {
  // values is reverse-chronological in Twelve Data
  // datetime format usually "YYYY-MM-DD HH:MM:SS"
  // We'll keep those that match today's date in America/New_York.
  const now = new Date();
  const nyDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  // nyDate like "2026-02-19"
  return values.filter((v: any) => String(v?.datetime ?? "").startsWith(nyDate));
}
