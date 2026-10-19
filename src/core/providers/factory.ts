import { createAnthropic } from '@ai-sdk/anthropic'
import { createGroq } from '@ai-sdk/groq'
import { createGoogle } from '@ai-sdk/google'
import { createXai } from '@ai-sdk/xai'
import type { LanguageModel } from 'ai'
import type { ModelInfo } from '@shared/types'
import type { KeySource } from './keys'
import { GroqKeyPool } from './keys'

export class MissingKeyError extends Error {
  constructor(readonly provider: ModelInfo['provider']) {
    super(`No API key configured for ${provider}`)
  }
}

export class ModelFactory {
  readonly groqPool: GroqKeyPool

  constructor(private readonly keys: KeySource) {
    this.groqPool = new GroqKeyPool(keys)
  }

  create(info: ModelInfo): { model: LanguageModel; key: string } {
    const key = info.provider === 'groq' ? this.groqPool.pick() : this.keys.keysFor(info.provider)[0]
    if (!key) throw new MissingKeyError(info.provider)
    switch (info.provider) {
      case 'anthropic':
        return { model: createAnthropic({ apiKey: key, headers: this.keys.headersFor?.('anthropic') })(info.model), key }
      case 'groq':
        return { model: createGroq({ apiKey: key })(info.model), key }
      case 'google':
        return { model: createGoogle({ apiKey: key })(info.model), key }
      case 'xai':
        return { model: createXai({ apiKey: key })(info.model), key }
    }
  }
}
