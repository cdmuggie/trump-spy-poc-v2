"use client";

import { useMemo, useState } from "react";
import {
  Chart as ChartJS,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
  Filler,
} from "chart.js";
import { Line } from "react-chartjs-2";

ChartJS.register(LinearScale, PointElement, LineElement, Tooltip, Legend, Filler);

type ApiOk = {
  ok: true;
  earliest: { datetime: string; title: string; url: string };
  spy: {
    eventTradingDate: string;
    retPrevToEventPct?: number;
    retEventToNextPct?: number;
  };
  series: Array<{ date: string; close: number }>;
  debug?: any;
};

type ApiErr = { ok: false; error: string; httpStatus?: number; debug?: any };
type ApiResp = ApiOk | ApiErr;

export default function Page() {
  const [quote, setQuote] = useState("border wall");
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

  const chartModel = useMemo(() => {
    if (!data || !data.ok) return null;

    const series = data.series ?? [];
    if (series.length === 0) return null;

    const eventDate = data.spy?.eventTradingDate;
    const eventIdx = eventDate ? series.findIndex((p) => p.date === eventDate) : -1;

    const closes = series.map((p) => p.close);
    const yMin = Math.min(...closes);
    const yMax = Math.max(...closes);

    // Plot SPY as (x=index, y=close) using a linear x-scale
    const spyPoints = series.map((p, i) => ({ x: i, y: p.close }));

    // Vertical line dataset at eventIdx (two points same x, different y)
    const vline =
      eventIdx >= 0
        ? [
            { x: eventIdx, y: yMin },
            { x: eventIdx, y: yMax },
          ]
        : [];

    const labelsByIndex = series.map((p) => p.date);

    return {
      labelsByIndex,
      eventIdx,
      yMin,
      yMax,
      chartData: {
        datasets: [
          {
            label: "SPY Close (daily)",
            data: spyPoints as any,
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.2,
          },
          ...(eventIdx >= 0
            ? [
                {
                  label: `Earliest publish → trading day (${eventDate})`,
                  data: vline as any,
                  borderWidth: 2,
                  pointRadius: 0,
                },
              ]
            : []),
        ],
      },
      chartOptions: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          tooltip: {
            callbacks: {
              title: (items: any[]) => {
                const it = items?.[0];
                const idx = typeof it?.parsed?.x === "number" ? it.parsed.x : it?.dataIndex;
                const d = labelsByIndex[idx] ?? "";
                return d ? `Date: ${d}` : "";
              },
            },
          },
          legend: {
            display: true,
          },
        },
        scales: {
          x: {
            type: "linear" as const,
            ticks: {
              callback: (value: any) => {
                const idx = Math.round(Number(value));
                const d = labelsByIndex[idx];
                // Show fewer labels to avoid clutter
                if (!d) return "";
                return idx % 2 === 0 ? d : "";
              },
              maxRotation: 0,
              autoSkip: false,
            },
          },
          y: {
            type: "linear" as const,
            ticks: {
              callback: (v: any) => String(v),
            },
          },
        },
      },
    };
  }, [data]);

  return (
    <main style={{ padding: 24, fontFamily: "system-ui", color: "#111", background: "#fff" }}>
      <h2>Quote → Earliest Publish Time → SPY Move (POC)</h2>

      <textarea
        value={quote}
        onChange={(e) => setQuote(e.target.value)}
        rows={2}
        style={{
          width: "min(680px, 100%)",
          padding: 10,
          fontSize: 14,
          color: "#111",
          background: "#fff",
          border: "1px solid #ccc",
          borderRadius: 8,
        }}
      />

      <div style={{ marginTop: 10 }}>
        <button onClick={run} disabled={loading || !quote.trim()} style={{ padding: "10px 14px" }}>
          {loading ? "Running…" : "Analyze"}
        </button>
      </div>

      {!data ? null : data.ok ? (
        <>
          <div style={{ marginTop: 16, padding: 12, border: "1px solid #ddd", borderRadius: 10 }}>
            <div>
              <b>Earliest publish time:</b> {new Date(data.earliest.datetime).toString()}
            </div>
            <div style={{ marginTop: 6 }}>
              <b>Earliest article:</b>{" "}
              <a href={data.earliest.url} target="_blank" rel="noreferrer">
                {data.earliest.title || data.earliest.url}
              </a>
            </div>
            <div style={{ marginTop: 8 }}>
              <b>Event trading day (plotted line):</b> {data.spy.eventTradingDate}
            </div>
            <div style={{ marginTop: 8 }}>
              <b>SPY move:</b>
              <ul>
                <li>Prev close → Event close: {fmtPct(data.spy.retPrevToEventPct)}</li>
                <li>Event close → Next close: {fmtPct(data.spy.retEventToNextPct)}</li>
              </ul>
            </div>
          </div>

          <div style={{ marginTop: 18, maxWidth: 1100 }}>
            {chartModel ? <Line data={chartModel.chartData as any} options={chartModel.chartOptions as any} /> : null}
          </div>
        </>
      ) : (
        <div style={{ marginTop: 16, color: "crimson" }}>
          <b>Error:</b> {data.error}
        </div>
      )}
    </main>
  );
}

function fmtPct(v?: number) {
  if (typeof v !== "number" || !isFinite(v)) return "n/a";
  return `${v.toFixed(2)}%`;
}
