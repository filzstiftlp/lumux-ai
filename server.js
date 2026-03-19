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
  "spa+eng",
  {
    tessedit_char_whitelist: "0123456789.,€kWhkW/:- "
  }
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
        `pdftoppm -png ${pdfPath} temp`,
        {cwd:__dirname},
        (error)=>{
          if(error) reject(error)
          else resolve()
        }
      )

    })

    let textTotal = ""

const files = fs.readdirSync(__dirname).filter(f => f.startsWith("temp-") && f.endsWith(".png"))

for(const file of files){

  const imageBuffer = fs.readFileSync(path.join(__dirname,file))

  const result = await Tesseract.recognize(
    imageBuffer,
    "spa+eng",
    {
      tessedit_char_whitelist: "0123456789.,€kWhkW/:- "
    }
  )

  textTotal += "\n" + (result?.data?.text || "")

  fs.unlinkSync(path.join(__dirname,file))
}

fs.unlinkSync(pdfPath)

return textTotal

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

  text = text.toLowerCase()

  let consumo=null
  let potencia=null
  let precio=null
  let dias=null

  /* -------------------------
     1. CONSUMO (MEJORADO)
  --------------------------*/
// 🔥 FIX IBERDROLA (consumo total)
const consumoIberdrola = text.match(/consumo\s+total[^0-9]{0,50}([\d.,]+)\s*kwh/i)

if(consumoIberdrola){
  consumo = cleanNumber(consumoIberdrola[1])
}
  // Caso ideal: "consumo total"
  const consumoTotal = text.match(/consumo\s*(total)?[^0-9]{0,30}([\d.,]+)\s*kwh/i)

  if(consumoTotal){
    consumo = cleanNumber(consumoTotal[2])
  }

  // Caso real: suma de periodos (P1, P2, P3...)
  if(!consumo){

    const lineas = text.split("\n")

    let suma = 0

    lineas.forEach(line => {

      if(
        line.includes("kwh") &&
        (
          line.includes("p1") ||
          line.includes("p2") ||
          line.includes("p3") ||
          line.includes("periodo") ||
          line.includes("punta") ||
          line.includes("valle")
        )
      ){

        const match = line.match(/([\d.,]+)\s*kwh/)

        if(match){
          const val = cleanNumber(match[1])

          if(val > 0 && val < 20000){
            suma += val
          }
        }

      }

    })

    if(suma > 0){
      consumo = suma
    }

  }

  // Fallback bruto (último recurso)
  if(!consumo){

    const matches = [...text.matchAll(/([\d.,]+)\s*kwh/gi)]

    let max = 0

    matches.forEach(m=>{
      const val = cleanNumber(m[1])
      if(val > max && val < 20000){
        max = val
      }
    })

    if(max > 0){
      consumo = max
    }

  }

  /* -------------------------
     2. POTENCIA (MEJORADO)
  --------------------------*/

  const potenciaMatch = text.match(/potencia\s*(contratada)?[^0-9]{0,20}([\d.,]+)\s*kW/i)

  if(potenciaMatch){
    potencia = cleanNumber(potenciaMatch[2])
  }

  if(!potencia){

    const matches = [...text.matchAll(/([\d.,]+)\s*kW/gi)]

    let posibles = []

    matches.forEach(m=>{
      const val = cleanNumber(m[1])

      // filtramos valores realistas de potencia doméstica
      if(val >= 1 && val <= 15){
        posibles.push(val)
      }
    })

    if(posibles.length){
      potencia = Math.min(...posibles)
    }

  }

  /* -------------------------
     3. DÍAS FACTURADOS
  --------------------------*/

  // 🔥 FIX REAL dias facturados
const diasFacturados = text.match(/dias\s*facturados[^0-9]{0,10}(\d{1,3})/i)

if(diasFacturados){
  dias = parseInt(diasFacturados[1])
}

// fallback
if(!dias){

  const fechas = text.match(/(\d{2}\/\d{2}\/\d{4})/g)

  if(fechas && fechas.length >= 2){
    const inicio = new Date(fechas[0])
    const fin = new Date(fechas[1])

    const diff = Math.abs((fin - inicio) / (1000*60*60*24))

    if(diff > 0 && diff < 100){
      dias = Math.round(diff)
    }
  }

}

  /* -------------------------
     4. PRECIO TOTAL
  --------------------------*/

  const totalPatterns = [
    /total\s*importe\s*factura[^0-9]*([\d.,]+)\s?€/i,
    /importe\s*total[^0-9]*([\d.,]+)\s?€/i,
    /total[^0-9]{0,15}([\d.,]+)\s?€/i
  ]

  for(const pattern of totalPatterns){
    const match = text.match(pattern)
    if(match){
      precio = cleanNumber(match[1])
      break
    }
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
    reply:"Estamos actualizando nuestra herramienta 🛠️🙂\n\nEn breve uno de nuestros agentes revisará tu factura y te enviará tu ahorro exacto."
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