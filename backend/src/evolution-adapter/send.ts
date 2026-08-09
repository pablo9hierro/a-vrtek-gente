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
  const res = await fetch(`${url.replace(/\/$/, '')}/message/sendText/${instance}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: apiKey },
    body: JSON.stringify({ number: phone, text }),
  })
  if (!res.ok) {
    console.warn(`evolution api retornou ${res.status} pra ${phone}: ${await res.text()}`)
  }
}
