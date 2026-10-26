import type { ProviderName } from '../types.js';

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: ProviderName,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
