"use client"

import {useEffect,useState} from "react"
import {Line} from "react-chartjs-2"
import {
Chart as ChartJS,
LinearScale,
PointElement,
LineElement,
Tooltip,
Legend
} from "chart.js"

ChartJS.register(
LinearScale,
PointElement,
LineElement,
Tooltip,
Legend
)

export default function Page(){

const [data,setData]=useState<any>(null)

useEffect(()=>{
fetch("/api/today")
.then(r=>r.json())
.then(setData)
},[])

if(!data)return <main style={{padding:24}}>Loading...</main>

const labels=data.spy.map((b:any)=>b.time)
const closes=data.spy.map((b:any)=>b.close)

const chartData={
labels,
datasets:[{
label:"SPY Today (Hourly)",
data:closes,
borderWidth:2,
pointRadius:0
}]
}

return(
<main style={{padding:24,fontFamily:"system-ui"}}>

<h2>Top Trump Quotes Today</h2>

{data.quotes.map((q:any,i:number)=>(
<div key={i} style={{marginBottom:8}}>
<b>{i+1}.</b> {q.text}
</div>
))}

<div style={{marginTop:24}}>
<Line data={chartData}/>
</div>

</main>
)

}
