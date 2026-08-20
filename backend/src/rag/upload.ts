import { Router } from 'express'
import multer from 'multer'
import { pool } from '../db/pool.js'
import { checkAssistantAccess } from '../services/access.js'
import { internalAuthGate } from '../services/internalAuth.js'

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } })

export const ragRouter = Router()

async function betaGate(req: any, res: any, next: any) {
  const access = await checkAssistantAccess(String(req.params.tenantSlug || ''))
  if (!access.allowed) {
    res.status(404).json({ error: 'reason' in access ? access.reason : 'Assistente IA não disponível pra essa loja.' })
    return
  }
  next()
}

ragRouter.use('/:tenantSlug/rag', internalAuthGate)

ragRouter.get('/:tenantSlug/rag/documents', betaGate, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, filename, mime_type, status, error_message, created_at
     FROM assistant_ia.rag_documents WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [req.params.tenantSlug],
  )
  res.json(rows)
})

ragRouter.delete('/:tenantSlug/rag/documents/:id', betaGate, async (req, res) => {
  await pool.query(`DELETE FROM assistant_ia.rag_documents WHERE id = $1 AND tenant_id = $2`, [
    req.params.id,
    req.params.tenantSlug,
  ])
  res.json({ ok: true })
})

ragRouter.post('/:tenantSlug/rag/documents', betaGate, upload.single('file'), async (req, res) => {
  const tenantSlug = req.params.tenantSlug
  const file = req.file
  if (!file) {
    res.status(400).json({ error: 'Nenhum arquivo enviado.' })
    return
  }

  const docRes = await pool.query<{ id: string }>(
    `INSERT INTO assistant_ia.rag_documents (tenant_id, filename, mime_type, status)
     VALUES ($1, $2, $3, 'processando') RETURNING id`,
    [tenantSlug, file.originalname, file.mimetype],
  )
  const documentId = docRes.rows[0].id

  try {
    const text = await extractText(file)
    const chunks = chunkText(text, 1200)
    for (let i = 0; i < chunks.length; i++) {
      await pool.query(
        `INSERT INTO assistant_ia.rag_chunks (tenant_id, document_id, content, chunk_index) VALUES ($1, $2, $3, $4)`,
        [tenantSlug, documentId, chunks[i], i],
      )
    }
    await pool.query(`UPDATE assistant_ia.rag_documents SET status = 'pronto' WHERE id = $1`, [documentId])
    res.json({ id: documentId, status: 'pronto', chunks: chunks.length })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await pool.query(`UPDATE assistant_ia.rag_documents SET status = 'erro', error_message = $2 WHERE id = $1`, [
      documentId,
      message,
    ])
    res.status(500).json({ error: 'Falha ao processar o arquivo.', detail: message })
  }
})

async function extractText(file: Express.Multer.File): Promise<string> {
  if (file.mimetype === 'application/pdf') {
    const pdfParse = (await import('pdf-parse')).default
    const data = await pdfParse(file.buffer)
    return data.text
  }
  if (
    file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    file.originalname.endsWith('.docx')
  ) {
    const mammoth = await import('mammoth')
    const { value } = await mammoth.extractRawText({ buffer: file.buffer })
    return value
  }
  // TXT, CSV, conversas exportadas, ou qualquer outro texto simples
  return file.buffer.toString('utf-8')
}

function chunkText(text: string, size: number): string[] {
  const clean = text.replace(/\s+/g, ' ').trim()
  const chunks: string[] = []
  for (let i = 0; i < clean.length; i += size) {
    chunks.push(clean.slice(i, i + size))
  }
  return chunks.length > 0 ? chunks : [clean]
}
