import 'dotenv/config'
import express from "express"
import cors from "cors"
import OpenAI from "openai"
import axios from "axios"
import Tesseract from "tesseract.js"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { exec } from "child_process"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
app.use(cors())
app.use(express.json())

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

app.get("/", (req,res)=>{
  res.send("Lumux AI backend activo 🚀")
})

/* OCR IMAGEN */

async function readImageOCR(url){

  try{

    const response = await axios.get(url,{responseType:"arraybuffer"})

    const result = await Tesseract.recognize(
      Buffer.from(response.data),
      "spa"
    )

    return result?.data?.text || ""

  }catch(err){

    console.log("Error OCR imagen:",err.message)
    return ""

  }
}

/* OCR PDF */

async function readPdfOCR(url){

  try{

    const pdfPath = path.join(__dirname,"temp.pdf")
    const imgPath = path.join(__dirname,"temp.png")

    const response = await axios.get(url,{responseType:"arraybuffer"})
    fs.writeFileSync(pdfPath,response.data)

    await new Promise((resolve,reject)=>{

      exec(
        `pdftoppm -png -singlefile ${pdfPath} temp`,
        {cwd:__dirname},
        (error)=>{
          if(error) reject(error)
          else resolve()
        }
      )

    })

    const imageBuffer = fs.readFileSync(imgPath)

    const result = await Tesseract.recognize(
      imageBuffer,
      "spa"
    )

    fs.unlinkSync(pdfPath)
    fs.unlinkSync(imgPath)

    return result?.data?.text || ""

  }catch(err){

    console.log("Error leyendo PDF:",err.message)
    return ""

  }
}

/* LIMPIAR NUMEROS */

function cleanNumber(n){

  return parseFloat(
    n.replace(/\./g,"").replace(",",".")
  )

}

/* EXTRAER DATOS */

function extractEnergyData(text){

  if(!text) return {consumo:null,potencia:null,precio:null,dias:null}

  let consumo=null
  let potencia=null
  let precio=null
  let dias=null

  /* CONSUMO TOTAL (prioridad) */

  const consumoTotal=text.match(/consumo\s+total[^0-9]*([\d.,]+)\s*kwh/i)

  if(consumoTotal){
    consumo=cleanNumber(consumoTotal[1])
  }

  /* SUMA CONSUMOS SI NO HAY TOTAL */

  if(!consumo){

    let total=0

    const consumos=text.match(/([\d.,]+)\s*kwh/gi)

    if(consumos){

      consumos.forEach(c=>{

        const val=cleanNumber(c)

        if(val>0 && val<100000){
          total+=val
        }

      })

      if(total>0) consumo=total

    }

  }

  /* POTENCIA */

  const potencias=text.match(/([\d.,]+)\s*kW/gi)

  if(potencias){

    potencias.forEach(p=>{

      const val=cleanNumber(p)

      if(val>1 && val<20){
        potencia=val
      }

    })

  }

  /* DIAS */

  const dias1=text.match(/(\d+)\s*d[ií]as/i)
  const dias2=text.match(/DIAS FACTURADOS[:\s]*(\d+)/i)

  if(dias1) dias=parseInt(dias1[1])
  else if(dias2) dias=parseInt(dias2[1])

  /* PRECIO TOTAL */

  const total1=text.match(/TOTAL\s*IMPORTE\s*FACTURA[^0-9]*([\d.,]+)\s?€/i)
  const total2=text.match(/TOTAL[^0-9]{0,10}([\d.,]+)\s?€/i)

  if(total1){
    precio=cleanNumber(total1[1])
  }
  else if(total2){
    precio=cleanNumber(total2[1])
  }

  return {consumo,potencia,precio,dias}

}

/* CALCULO AHORRO */

function calcularAhorro(consumo,potencia,dias,precioActual){

  const energia = consumo * 0.111
  const potenciaCoste = potencia * dias * 0.17

  let subtotal = energia + potenciaCoste

  subtotal = subtotal * 1.0511269632

  const totalLumux = subtotal * 1.21

  const ahorroFactura = precioActual - totalLumux
  const ahorroAnual = ahorroFactura * 12

  return{
    totalLumux,
    ahorroFactura,
    ahorroAnual
  }

}

/* ENDPOINT */

app.post("/chat", async (req,res)=>{

  try{

    const input=req.body.message

    console.log("INPUT RECIBIDO:",input)

    if(!input){
      return res.json({reply:"No he recibido ningún dato."})
    }

    let text=""

    if(typeof input==="string" && input.startsWith("http")){

      console.log("FACTURA DETECTADA")

      if(input.includes(".pdf")){
        text=await readPdfOCR(input)
      }
      else{
        text=await readImageOCR(input)
      }

      console.log("TEXTO OCR:",text)

      if(!text || text.length<20){

        return res.json({
          reply:"No he podido leer correctamente la factura."
        })

      }

      const {consumo,potencia,precio,dias}=extractEnergyData(text)

      console.log("DATOS EXTRAIDOS:",{consumo,potencia,precio,dias})

      if(!consumo || !precio || !potencia || !dias){

        return res.json({
          reply:"No he podido analizar correctamente la factura."
        })

      }

      const {totalLumux,ahorroFactura,ahorroAnual}=calcularAhorro(consumo,potencia,dias,precio)

      let reply=""

      if(ahorroAnual<40){

        reply=`
He analizado tu factura 🔎

Consumo: ${consumo.toFixed(2)} kWh
Potencia: ${potencia} kW
Periodo: ${dias} días

Total factura actual: ${precio.toFixed(2)} €

Actualmente tu tarifa ya está bastante optimizada.

Te avisaremos si detectamos una bajada de precios que pueda beneficiarte.
`

      }else{

        reply=`
He analizado tu factura 🔎

Consumo: ${consumo.toFixed(2)} kWh
Potencia: ${potencia} kW
Periodo: ${dias} días

Total factura actual: ${precio.toFixed(2)} €

Con Lumux pagarías aproximadamente:

${totalLumux.toFixed(2)} €

💰 Ahorro en esta factura: ${ahorroFactura.toFixed(2)} €
💰 Ahorro anual estimado: ${ahorroAnual.toFixed(2)} €

¿Quieres saber qué compañía puede aplicarte este ahorro?
`

      }

      return res.json({reply})

    }

    const response=await client.responses.create({
      model:"gpt-4o-mini",
      input:input
    })

    const reply=response.output_text

    return res.json({reply})

  }

  catch(err){

    console.error("ERROR:",err)

    return res.json({
      reply:"Ha ocurrido un problema analizando la factura."
    })

  }

})

const PORT=process.env.PORT || 3000

app.listen(PORT,()=>{
  console.log("Servidor Lumux AI activo en puerto",PORT)
})