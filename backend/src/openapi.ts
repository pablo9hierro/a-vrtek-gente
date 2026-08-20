/**
 * Documentação estática da API deste serviço (a-vrtek-gente). Backend
 * headless por trás de dois produtos: o assistente do ramo eletrônica
 * (nativo do plano) e o add-on de assistente do ramo ecommerce — o
 * mesmo contrato serve os dois, o que muda é o `vertical` resolvido por
 * tenant (ver services/access.ts). Documentado em OpenAPI pra permitir
 * qualquer cliente (não só o painel Node/React do Resolutoo) consumir
 * essa API no futuro produto "assistente via WhatsApp puro".
 */
export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'a-vrtek-gente — Assistant IA API',
    version: '1.0.0',
    description:
      'Backend headless do assistente de IA usado pelos ramos eletrônica (nativo do plano) e ecommerce (acessório pago) do Resolutoo. Autenticação entre serviços via header `x-internal-key`; o webhook do WhatsApp é chamado só pelo ecommerce-api.',
  },
  servers: [{ url: 'https://assistant-ia-production.up.railway.app' }],
  tags: [
    { name: 'Config', description: 'Configuração do assistente por tenant (prompt, gatilhos, agenda).' },
    { name: 'Conversas', description: 'Histórico e controle de conversas do WhatsApp por tenant.' },
    { name: 'RAG', description: 'Documentos de exemplo de atendimento (contexto adicional pro assistente).' },
    { name: 'Webhook', description: 'Recebe eventos encaminhados pelo ecommerce-api (Evolution API).' },
    { name: 'Plataforma', description: 'Administração de motores de IA (superadmin, não por tenant).' },
  ],
  components: {
    securitySchemes: {
      internalKey: {
        type: 'apiKey',
        in: 'header',
        name: 'x-internal-key',
        description: 'Chave compartilhada entre ufersin/backend e este serviço — nunca exposta ao navegador do lojista.',
      },
    },
    schemas: {
      AssistantConfig: {
        type: 'object',
        properties: {
          tenant_id: { type: 'string', example: 'vrtech' },
          enabled: { type: 'boolean' },
          prompt_interpreter: { type: 'string', description: 'Único prompt editável pelo lojista — contexto de negócio/tom de voz.' },
          start_keywords: { type: 'array', items: { type: 'string' } },
          end_keywords: { type: 'array', items: { type: 'string' } },
          window_timeout_minutes: { type: 'integer', example: 30 },
          message_batch_window_seconds: { type: 'integer', example: 8 },
          min_response_chars: { type: 'integer', example: 150 },
          max_response_chars: { type: 'integer', example: 300 },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },
      Conversation: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          phone: { type: 'string' },
          customer_name: { type: 'string', nullable: true },
          status: { type: 'string' },
          assistant_enabled: { type: 'boolean' },
          human_override: { type: 'boolean' },
          started_at: { type: 'string', format: 'date-time' },
          last_message_at: { type: 'string', format: 'date-time' },
          closed_at: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      Error: {
        type: 'object',
        properties: { error: { type: 'string' } },
      },
    },
  },
  security: [{ internalKey: [] }],
  paths: {
    '/health': {
      get: {
        tags: ['Config'],
        summary: 'Healthcheck',
        security: [],
        responses: { '200': { description: 'Serviço no ar' } },
      },
    },
    '/api/tenants/{tenantSlug}/config': {
      get: {
        tags: ['Config'],
        summary: 'Lê a config do assistente de um tenant',
        description: 'Retorna 404 se o tenant não tem acesso ao assistente (ecommerce sem add-on ativo, ou tenant inexistente).',
        parameters: [{ name: 'tenantSlug', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Config atual (ou defaults se nunca configurado)', content: { 'application/json': { schema: { $ref: '#/components/schemas/AssistantConfig' } } } },
          '404': { description: 'Sem acesso ao assistente', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      put: {
        tags: ['Config'],
        summary: 'Salva a config do assistente de um tenant',
        description: 'Para tenants do ramo eletrônica, dispara write-through pro backend próprio do vrtech (mantém o pipeline local em sincronia).',
        parameters: [{ name: 'tenantSlug', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/AssistantConfig' } } } },
        responses: {
          '200': { description: 'Config salva', content: { 'application/json': { schema: { $ref: '#/components/schemas/AssistantConfig' } } } },
          '404': { description: 'Sem acesso ao assistente', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/tenants/{tenantSlug}/conversations': {
      get: {
        tags: ['Conversas'],
        summary: 'Lista conversas do tenant',
        parameters: [{ name: 'tenantSlug', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Lista de conversas', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Conversation' } } } } } },
      },
    },
    '/api/tenants/{tenantSlug}/conversations/{id}/messages': {
      get: {
        tags: ['Conversas'],
        summary: 'Lista mensagens de uma conversa',
        parameters: [
          { name: 'tenantSlug', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Mensagens da conversa' } },
      },
    },
    '/api/tenants/{tenantSlug}/conversations/{id}': {
      delete: {
        tags: ['Conversas'],
        summary: 'Apaga uma conversa e seu histórico',
        parameters: [
          { name: 'tenantSlug', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Apagada' } },
      },
    },
    '/api/tenants/{tenantSlug}/conversations/{id}/assistant-enabled': {
      put: {
        tags: ['Conversas'],
        summary: 'Liga/desliga o assistente numa conversa específica',
        description: 'Permite o lojista assumir manualmente o atendimento de um cliente (human override) sem desligar o assistente pra loja toda.',
        parameters: [
          { name: 'tenantSlug', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { assistant_enabled: { type: 'boolean' } } } } } },
        responses: { '200': { description: 'Atualizado' } },
      },
    },
    '/api/tenants/{tenantSlug}/rag/documents': {
      get: {
        tags: ['RAG'],
        summary: 'Lista documentos de exemplo de atendimento do tenant',
        parameters: [{ name: 'tenantSlug', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Lista de documentos' } },
      },
      post: {
        tags: ['RAG'],
        summary: 'Envia um novo documento de exemplo de atendimento',
        parameters: [{ name: 'tenantSlug', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } } } },
        responses: { '200': { description: 'Documento processado e indexado' } },
      },
    },
    '/api/tenants/{tenantSlug}/rag/documents/{id}': {
      delete: {
        tags: ['RAG'],
        summary: 'Remove um documento de exemplo',
        parameters: [
          { name: 'tenantSlug', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Removido' } },
      },
    },
    '/api/platform/ai-engines': {
      get: { tags: ['Plataforma'], summary: 'Lista os motores de IA disponíveis (ranking do superadmin)', responses: { '200': { description: 'Lista de motores' } } },
      post: { tags: ['Plataforma'], summary: 'Cadastra um novo motor de IA', responses: { '200': { description: 'Criado' } } },
    },
    '/api/platform/ai-engines/order': {
      put: { tags: ['Plataforma'], summary: 'Reordena o ranking de motores de IA', responses: { '200': { description: 'Reordenado' } } },
    },
    '/api/platform/ai-engines/{id}': {
      put: { tags: ['Plataforma'], summary: 'Atualiza um motor de IA', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Atualizado' } } },
      delete: { tags: ['Plataforma'], summary: 'Remove um motor de IA', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Removido' } } },
    },
    '/webhook/evolution': {
      post: {
        tags: ['Webhook'],
        summary: 'Recebe mensagem encaminhada pelo ecommerce-api (Evolution API)',
        description: 'Não é chamado diretamente pelo WhatsApp — o ecommerce-api recebe o evento bruto da Evolution API e encaminha pra cá já normalizado. Loteia mensagens em sequência do mesmo cliente numa janela de 3s antes de rodar o pipeline.',
        security: [],
        responses: { '200': { description: 'Aceito (processamento pode ser assíncrono/batched)' } },
      },
    },
  },
}
