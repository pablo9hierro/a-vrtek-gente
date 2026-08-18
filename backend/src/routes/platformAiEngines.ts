import { Router } from 'express'
import { internalAuthGate } from '../services/internalAuth.js'
import {
  listAllPlatformEngines,
  createPlatformEngine,
  updatePlatformEngine,
  deletePlatformEngine,
  reorderPlatformEngines,
  type PlatformAiProvider,
} from '../agents/platformEngines.js'

export const platformAiEnginesRouter = Router()

// Mesmo gate de x-internal-key usado pras rotas de config/RAG/conversas —
// só o ufersin/backend (autenticado via AuthSuperadmin do lado dele) chama
// aqui, nunca o navegador direto. Ver internalAuth.ts.
platformAiEnginesRouter.use('/ai-engines', internalAuthGate)

const VALID_PROVIDERS: PlatformAiProvider[] = ['anthropic', 'openai', 'openrouter']

platformAiEnginesRouter.get('/ai-engines', async (_req, res) => {
  res.json(await listAllPlatformEngines())
})

platformAiEnginesRouter.post('/ai-engines', async (req, res) => {
  const { label, provider, model } = req.body as { label?: string; provider?: string; model?: string }
  if (!label?.trim() || !model?.trim() || !VALID_PROVIDERS.includes(provider as PlatformAiProvider)) {
    res.status(400).json({ error: 'label, provider (anthropic|openai|openrouter) e model são obrigatórios' })
    return
  }
  res.status(201).json(await createPlatformEngine(label.trim(), provider as PlatformAiProvider, model.trim()))
})

platformAiEnginesRouter.put('/ai-engines/order', async (req, res) => {
  const { ids } = req.body as { ids?: string[] }
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: 'ids (array, ordem desejada) é obrigatório' })
    return
  }
  res.json(await reorderPlatformEngines(ids))
})

platformAiEnginesRouter.put('/ai-engines/:id', async (req, res) => {
  const { label, model, enabled } = req.body as { label?: string; model?: string; enabled?: boolean }
  const updated = await updatePlatformEngine(req.params.id, { label, model, enabled })
  if (!updated) {
    res.status(404).json({ error: 'motor não encontrado' })
    return
  }
  res.json(updated)
})

platformAiEnginesRouter.delete('/ai-engines/:id', async (req, res) => {
  await deletePlatformEngine(req.params.id)
  res.status(204).end()
})
