export interface GatewayRequest {
  id: string
  tenantId: string
  apiKeyId: string
  model: string
  endpoint: 'chat' | 'embed' | 'rerank' | 'batch' | 'files' | 'models'
  stream: boolean
}

export interface Usage {
  input: number
  output: number
  cachedRead: number
  cachedWrite: number
}

export interface ProviderResult {
  response: Response
  provider: string
  status: 'ok' | 'client_error' | 'provider_error' | 'timeout' | 'refused'
  usage: Usage
  costUsd: number
  latencyMs: number
  ttftMs?: number
  providerRequestId?: string
  errorCode?: string
  routing?: { pool: string; attempt: number; fallbackFrom?: string }
}
