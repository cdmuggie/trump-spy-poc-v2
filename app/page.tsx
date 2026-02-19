"use client";

import { useMemo, useState } from "react";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
} from "chart.js";
import { Line } from "react-chartjs-2";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend
);

type ApiResp =
  | {
      ok: true;
      query: string;
      earliest: {
        datetime: string;
        title: string;
        url: string;
      };
      spy: {
        eventTradingDate: string;
        retPrevToEventPct?: number;
        retEventToNextPct?: number;
      };
      series: Array<{ date: string; close: number }>;
    }
  | { ok: false; error: string };

export default function Page() {
  const [quote, setQuote] = useState("We will build the wall");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<ApiResp | null>(null);

  async function run() {
    setLoading(true);
    setData(null);
    try {
      const r = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quote }),
      });
      const j = (await r.json()) as ApiResp;
      setData(j);
    } catch (e: any) {
      setData({ ok: false, error: e?.message || "Request failed" });
    } finally {
      setLoading(false);
    }
  }

  const chartData = useMemo(() => {
    if (!data || !("ok" in data) || !data.ok) return null;
    return {
      labels: data.series.map((p) => p.date),
      datasets: [
        {
          label: "SPY Close (daily)",
          data: data.series.map((p) => p.close),
          borderWidth: 2,
          pointRadius: 0,
        },
      ],
    };
  }, [data]);

  return (
    <main style={{ padding: 24, fontFamily: "system-ui" }}>
      <h2>Trump Quote → Earliest Publish Time → SPY Move (POC)</h2>

      <textarea
        value={quote}
        onChange={(e) => setQuote(e.target.value)}
        rows={3}
        style={{ width: 500, padding: 10 }}
      />

      <br /><br />

      <button onClick={run} disabled={loading}>
        {loading ? "Running…" : "Analyze"}
      </button>

      {!data ? null : data.ok ? (
        <>
          <p>
            <b>Earliest publish:</b>{" "}
            {new Date(data.earliest.datetime).toString()}
          </p>
          <p>
            <a href={data.earliest.url} target="_blank">
              {data.earliest.title || data.earliest.url}
            </a>
          </p>
          <p>
            Prev → Event: {fmtPct(data.spy.retPrevToEventPct)} <br />
            Event → Next: {fmtPct(data.spy.retEventToNextPct)}
          </p>

          <div style={{ maxWidth: 900 }}>
            {chartData ? <Line data={chartData} /> : null}
          </div>
        </>
      ) : (
        <p style={{ color: "red" }}>{data.error}</p>
      )}
    </main>
  );
}

function fmtPct(v?: number) {
  if (typeof v !== "number" || !isFinite(v)) return "n/a";
  return `${v.toFixed(2)}%`;
}