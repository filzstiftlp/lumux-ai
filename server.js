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
function extractCliente(text){

  const lineas = text.split("\n")

  let nombre = ""
  let direccion = ""

  for(let i=0;i<lineas.length;i++){

    if(
  lineas[i].match(/^[A-Z\s]{5,}$/)
){
  nombre = lineas[i].trim()
}
    if(
      lineas[i].includes("direccion") ||
      lineas[i].includes("prje") ||
      lineas[i].includes("calle")
    ){
      direccion = lineas[i].trim()
    }

  }

  return {nombre,direccion}
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
  // 🔥 PRIORIDAD ABSOLUTA: "energia consumida XXX kWh"
// 🔥 MÉTODO ROBUSTO REAL (como CalculaTuLuz)
if(!consumo){

  const lineas = text.split("\n")

  for(const line of lineas){

    if(line.includes("consumida") && line.includes("kwh")){

      const match = line.match(/([\d.,]+)\s*kwh/)

      if(match){
        consumo = cleanNumber(match[1])
        break
      }

    }

  }

}
  let potencia=null
  let precio=null
  let dias=null

  /* -------------------------
     1. CONSUMO (MEJORADO)
  --------------------------*/
// 🔥 FIX IBERDROLA (consumo total)
const consumoIberdrola = text.match(/consumo\s+total[^0-9]{0,50}([\d.,]+)\s*kwh/i)

if(!consumo && consumoIberdrola){
  consumo = cleanNumber(consumoIberdrola[1])
}
  // Caso ideal: "consumo total"
  const consumoTotal = text.match(/consumo\s*(total)?[^0-9]{0,30}([\d.,]+)\s*kwh/i)

  if(!consumo && consumoTotal){
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
   3. DÍAS FACTURADOS (DOBLE MÉTODO)
--------------------------*/

let diasTexto = null
let diasFechas = null

const lineas = text.split("\n")

// 🔹 1. SACAR DIAS DESDE TEXTO (mejorado)
for(let i = 0; i < lineas.length; i++){

  if(
    lineas[i].includes("dias facturados") ||
    lineas[i].includes("días facturados")
  ){

    // PRIORIDAD: siguiente línea (evita el "3")
    if(lineas[i+1]){
      const matchNext = lineas[i+1].match(/\b(\d{1,3})\b/)
      if(matchNext){
        diasTexto = parseInt(matchNext[1])
      }
    }

    // fallback: misma línea (solo si no hay otra opción)
    if(!diasTexto){
  const matchLine = lineas[i].match(/\b(\d{2,3})\b/)
  if(matchLine){
    diasTexto = parseInt(matchLine[1])
  }
}

    break
  }
}

// 🔹 2. CALCULAR DIAS DESDE FECHAS (MÉTODO PRO)
const fechas = text.match(/(\d{2}\/\d{2}\/\d{4})/g)

if(fechas && fechas.length >= 2){

  const inicio = new Date(fechas[0])
  const fin = new Date(fechas[1])

  const diff = Math.abs((fin - inicio) / (1000*60*60*24))

  // +1 porque cuenta ambos días (inicio y fin)
  diasFechas = Math.round(diff) + 1
}

// 🔹 3. DECISIÓN FINAL (INTELIGENTE)

// Caso ideal: coinciden
if(diasTexto && diasFechas && Math.abs(diasTexto - diasFechas) <= 3){
  dias = diasTexto
}

// Si solo uno existe
else if(diasTexto){
  dias = diasTexto
}
else if(diasFechas){
  dias = diasFechas
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

  // 🔹 ENERGÍA
  const energia = consumo * 0.11

  // 🔹 POTENCIA
  const potenciaCoste = potencia * dias * 0.177

  // 🔹 BASE
  let subtotal = energia + potenciaCoste

  // 🔹 IMPUESTO ELÉCTRICO (5%)
  subtotal = subtotal * 1.05

  // 🔹 IVA (21%)
  const totalLumux = subtotal * 1.21

  // 🔹 AHORRO
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
    
const inputLimpio = input.trim()
    if(typeof input==="string" && inputLimpio.startsWith("http")){

      console.log("FACTURA DETECTADA")

      if(inputLimpio.includes(".pdf")){
        text=await readPdfOCR(inputLimpio)
      }
      else{
        text=await readImageOCR(inputLimpio)
      }

      console.log("TEXTO OCR:",text)

      if(!text || text.length<20){

        return res.json({
          reply:"No he podido leer correctamente la factura."
        })

      }

      const {consumo,potencia,precio,dias}=extractEnergyData(text)
      const {nombre,direccion}=extractCliente(text)
      const nombreFinal = nombre || "Cliente"
const direccionFinal = direccion || "Dirección no disponible"

      console.log("DATOS EXTRAIDOS:",{consumo,potencia,precio,dias})
console.log("CHECK DATOS:", {
  consumo,
  potencia,
  precio,
  dias,
  tipos: {
    consumo: typeof consumo,
    potencia: typeof potencia,
    precio: typeof precio,
    dias: typeof dias
  }
})
console.log("ANTES DEL IF CRÍTICO:", {
  consumo,
  potencia,
  precio,
  dias
})
      if(
  consumo === null || isNaN(consumo) ||
  precio === null || isNaN(precio) ||
  potencia === null || isNaN(potencia) ||
  dias === null || isNaN(dias)
){
  console.log("⚠️ DATOS INCOMPLETOS")

  return res.json({
    reply:"No he podido analizar bien la factura. ¿Puedes enviarla de nuevo?"
  })
}

      let {totalLumux,ahorroFactura,ahorroAnual}=calcularAhorro(consumo,potencia,dias,precio)
      console.log("TIPOS AHORRO:", {
  totalLumux,
  ahorroFactura,
  ahorroAnual,
  tipos: {
    totalLumux: typeof totalLumux,
    ahorroFactura: typeof ahorroFactura,
    ahorroAnual: typeof ahorroAnual
  }
})

// 🔥 PROTECCIÓN TOTAL
if(isNaN(totalLumux) || isNaN(ahorroFactura) || isNaN(ahorroAnual)){
  console.log("ERROR CALCULO NaN")
  return res.json({
    reply:"Estamos actualizando nuestra herramienta 🛠️🙂\n\nEn breve uno de nuestros agentes revisará tu factura y te enviará tu ahorro exacto."
  })
}

      let reply=""

      if(ahorroFactura > 5){

  // 🔥 MENSAJE CON AHORRO
  reply=`
📍 ${nombreFinal}
📍 ${direccionFinal}

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

}else{

  // 🔹 MENSAJE SIN AHORRO
  reply=`
${nombreFinal}
${direccionFinal}

He analizado tu factura 🔎

Consumo: ${consumo.toFixed(2)} kWh
Potencia: ${potencia} kW
Periodo: ${dias} días

Total factura actual: ${precio.toFixed(2)} €

Actualmente tu tarifa ya está bastante optimizada.

Te avisaremos si detectamos una bajada de precios que pueda beneficiarte.
`

}
      console.log("CALCULO FINAL:", {
  consumo,
  potencia,
  dias,
  precio,
  totalLumux,
  ahorroFactura,
  ahorroAnual
})
console.log("RESPUESTA ENVIADA A MANYCHAT:", reply)
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