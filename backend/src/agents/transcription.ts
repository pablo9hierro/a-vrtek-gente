/**
 * Transcrição de mensagens de voz recebidas no WhatsApp. Sempre tenta
 * OpenAI (gpt-4o-transcribe) primeiro; se falhar (rede, rate limit, chave
 * ausente/errada), cai pro Gemini (multimodal, aceita áudio direto).
 *
 * Chaves de PLATAFORMA (OPENAI_API_KEY / GEMINI_API_KEY no ambiente do
 * serviço) — não vêm da config do tenant (`ai_provider`/`anthropic_api_key`
 * em assistant_config), porque transcrição é uma capacidade de
 * infraestrutura sempre disponível, independente de qual provedor o
 * lojista escolheu pra conversa em si.
 */

const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions'
const OPENAI_TRANSCRIBE_MODEL = 'gpt-4o-transcribe'
const GEMINI_TRANSCRIBE_MODEL = 'gemini-3.7-flash'
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TRANSCRIBE_MODEL}:generateContent`

function extensionFor(mimetype: string): string {
  if (mimetype.includes('ogg')) return 'ogg'
  if (mimetype.includes('mp4') || mimetype.includes('m4a')) return 'mp4'
  if (mimetype.includes('mpeg') || mimetype.includes('mp3')) return 'mp3'
  if (mimetype.includes('wav')) return 'wav'
  if (mimetype.includes('webm')) return 'webm'
  return 'ogg' // formato padrão de nota de voz do WhatsApp (opus em contêiner ogg)
}

async function transcribeWithOpenAI(base64: string, mimetype: string): Promise<string> {
  const key = process.env.OPENAI_API_KEY?.trim()
  if (!key) throw new Error('OPENAI_API_KEY não configurada')

  const buffer = Buffer.from(base64, 'base64')
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: mimetype }), `audio.${extensionFor(mimetype)}`)
  form.append('model', OPENAI_TRANSCRIBE_MODEL)
  form.append('language', 'pt')

  const res = await fetch(OPENAI_TRANSCRIBE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`OpenAI transcription ${res.status}: ${body}`)
  }
  const data = (await res.json()) as { text?: string }
  const text = data.text?.trim()
  if (!text) throw new Error('OpenAI transcription retornou vazio')
  return text
}

async function transcribeWithGemini(base64: string, mimetype: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY?.trim()
  if (!key) throw new Error('GEMINI_API_KEY não configurada')

  const res = await fetch(`${GEMINI_URL}?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              text: 'Transcreva literalmente o áudio a seguir, em português do Brasil. Responda APENAS com o texto transcrito, sem comentários, sem aspas, sem formatação adicional.',
            },
            { inlineData: { mimeType: mimetype, data: base64 } },
          ],
        },
      ],
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Gemini transcription ${res.status}: ${body}`)
  }
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[]
  }
  const text = data.candidates?.[0]?.content?.parts
    ?.map((p) => p.text ?? '')
    .join('')
    .trim()
  if (!text) throw new Error('Gemini transcription retornou vazio')
  return text
}

/**
 * Transcreve o áudio (base64 + mimetype, já baixado do Evolution API pelo
 * ecommerce-api). Nunca lança — retorna `null` se OpenAI E Gemini falharem
 * os dois, pra quem chamou decidir o que fazer (hoje: loga e ignora a
 * mensagem, igual qualquer outro tipo de mídia ainda não suportado).
 */
export async function transcribeAudio(base64: string, mimetype: string): Promise<string | null> {
  try {
    return await transcribeWithOpenAI(base64, mimetype)
  } catch (openaiErr) {
    console.warn('transcrição via OpenAI falhou, tentando fallback Gemini:', openaiErr)
    try {
      return await transcribeWithGemini(base64, mimetype)
    } catch (geminiErr) {
      console.error('transcrição via Gemini (fallback) também falhou:', geminiErr)
      return null
    }
  }
}
