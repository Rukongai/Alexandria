import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AiProvider } from '@alexandria/shared';
import { updateAiProvider } from '../../api/ai';
import { ProviderDialog } from './ProviderDialog';

vi.mock('../../api/ai', () => ({
  createAiProvider: vi.fn(),
  listAiProviderModels: vi.fn(),
  testAiProvider: vi.fn(),
  updateAiProvider: vi.fn(),
}));

const provider: AiProvider = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Local AI',
  baseUrl: 'http://localhost:11434/v1',
  model: 'library-model',
  isDefault: true,
  hasApiKey: true,
  apiKeyHint: '••••1234',
  createdAt: '2026-07-21T12:00:00.000Z',
  updatedAt: '2026-07-21T12:00:00.000Z',
};

function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ProviderDialog open onOpenChange={vi.fn()} provider={provider} />
    </QueryClientProvider>,
  );
}

describe('ProviderDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(updateAiProvider).mockResolvedValue({
      data: provider,
      meta: null,
      errors: null,
    });
  });

  it('should preserve the stored API key when the edit secret field is blank', async () => {
    const user = userEvent.setup();
    renderDialog();

    expect(screen.getByLabelText('API key')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateAiProvider).toHaveBeenCalledTimes(1));
    expect(updateAiProvider).toHaveBeenCalledWith(provider.id, {
      name: provider.name,
      baseUrl: provider.baseUrl,
      model: provider.model,
      isDefault: true,
    });
    expect(vi.mocked(updateAiProvider).mock.calls[0][1]).not.toHaveProperty('apiKey');
  });
});
