/**
 * Cliente HTTP pra ENVIAR mensagens via Evolution API — mesma instância que
 * o Resolutoo já usa pra loja (nenhuma conexão/QR code novo). Espelha
 * exatamente o formato usado em ecommerce/backend/src/whatsapp.rs
 * (POST {EVOLUTION_API_URL}/message/sendText/{instance}), pra reaproveitar
 * a mesma instância já conectada pela loja sem duplicar nada.
 */
export async function sendWhatsappMessage(instance: string, phone: string, text: string): Promise<void> {
  const url = process.env.EVOLUTION_API_URL
  const apiKey = process.env.EVOLUTION_API_KEY
  if (!url || !apiKey) {
    console.log(`[evolution não configurado] pra ${phone} via ${instance}: ${text}`)
    return
  }
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/message/sendText/${instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: apiKey },
      body: JSON.stringify({ number: phone, text }),
    })
    if (!res.ok) {
      console.warn(`evolution api retornou ${res.status} pra ${phone} via ${instance}: ${await res.text()}`)
      return
    }
    console.log(`evolution api enviou com sucesso pra ${phone} via ${instance}`)
  } catch (e) {
    console.error(`falha ao chamar evolution api pra ${phone} via ${instance}:`, e)
  }
}

/**
 * Manda um PIN de localização de verdade (mensagem nativa do WhatsApp),
 * não um link de texto — usado pela tool de localização da loja do
 * Assistente IA. Mesmo padrão de endpoint/erro de `sendWhatsappMessage`.
 */
export async function sendWhatsappLocation(
  instance: string,
  phone: string,
  lat: number,
  lng: number,
  name: string,
  address: string,
): Promise<boolean> {
  const url = process.env.EVOLUTION_API_URL
  const apiKey = process.env.EVOLUTION_API_KEY
  if (!url || !apiKey) {
    console.log(`[evolution não configurado] localização pra ${phone} via ${instance}: ${lat},${lng}`)
    return false
  }
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/message/sendLocation/${instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: apiKey },
      body: JSON.stringify({ number: phone, latitude: lat, longitude: lng, name, address }),
    })
    if (!res.ok) {
      console.warn(`evolution api (location) retornou ${res.status} pra ${phone} via ${instance}: ${await res.text()}`)
      return false
    }
    console.log(`evolution api enviou localização com sucesso pra ${phone} via ${instance}`)
    return true
  } catch (e) {
    console.error(`falha ao chamar evolution api (location) pra ${phone} via ${instance}:`, e)
    return false
  }
}
