import { NextResponse } from "next/server";

export const runtime = "nodejs";

const PROXY = "https://nameless-paper-1be6.chrisdmuggie.workers.dev";
const KEY = process.env.TWELVE_API_KEY;

let cache:any=null;
let cacheTime=0;

export async function GET(){

if(cache && Date.now()-cacheTime<300000){
return NextResponse.json(cache)
}

const today=new Date().toISOString().slice(0,10)

const quoteQuery=
"https://api.gdeltproject.org/api/v2/doc/doc"+
`?query=${encodeURIComponent("trump")}`+
`&mode=artlist&format=json&sort=datedesc&maxrecords=50`

const quoteFetch=await fetch(`${PROXY}/?url=${encodeURIComponent(quoteQuery)}`)
const quoteJson=await quoteFetch.json().catch(()=>null)

const articles=(quoteJson?.articles||[])

const quotes=articles
.slice(0,10)
.map((a:any)=>({
text:(a.title||"").slice(0,140),
datetime:a.seendate||a.date
}))
.filter((q:any)=>q.text)

const uniqueQuotes=Array.from(new Map(quotes.map((q:any)=>[q.text,q])).values()).slice(0,5)

const spyUrl=
`https://api.twelvedata.com/time_series?symbol=SPY&interval=1h&outputsize=24&apikey=${KEY}`

const spyFetch=await fetch(spyUrl)
const spyJson=await spyFetch.json().catch(()=>null)

const bars=(spyJson?.values||[]).map((b:any)=>({
time:b.datetime,
close:Number(b.close)
})).reverse()

const result={
quotes:uniqueQuotes,
spy:bars
}

cache=result
cacheTime=Date.now()

return NextResponse.json(result)

}