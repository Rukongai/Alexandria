import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import type { AiChatResponse, AiProvider } from '@alexandria/shared';
import { useState } from 'react';

vi.mock('../../api/ai', () => ({
  applyAiProposal: vi.fn(),
  listAiProviders: vi.fn(),
  sendAiChat: vi.fn(),
}));

import { applyAiProposal, listAiProviders, sendAiChat } from '../../api/ai';
import { AssistantBubble } from './AssistantBubble';
import { AssistantContextProvider, useAssistantTarget } from '../../hooks/use-assistant-context';

const provider: AiProvider = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Test provider',
  baseUrl: 'https://provider.example/v1',
  model: 'test-model',
  isDefault: true,
  hasApiKey: true,
  apiKeyHint: '••••1234',
  createdAt: '2026-07-21T10:00:00.000Z',
  updatedAt: '2026-07-21T10:00:00.000Z',
};

const chatResponse: AiChatResponse = {
  message: 'I prepared a preview for you.',
  sources: [],
  proposal: {
    proposalId: '22222222-2222-4222-8222-222222222222',
    summary: 'Rename Dragon',
    expiresAt: '2026-07-21T12:15:00.000Z',
    changes: [{
      type: 'update_model',
      modelId: '33333333-3333-4333-8333-333333333333',
      modelName: 'Dragon',
      patch: { name: 'Crimson Dragon' },
    }],
  },
};

function LibrarySwitchHarness() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate('/lib/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')}>
        Switch library
      </button>
      <button type="button" onClick={() => navigate('/lib/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')}>
        Return to first library
      </button>
      <AssistantBubble />
    </>
  );
}

function TargetedAssistant() {
  useAssistantTarget({
    modelIds: ['33333333-3333-4333-8333-333333333333'],
    importSessionIds: ['44444444-4444-4444-8444-444444444444'],
  });
  return <AssistantBubble />;
}

function TargetSwitchHarness() {
  const [modelId, setModelId] = useState('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  useAssistantTarget({ modelIds: [modelId] });
  return (
    <>
      <button
        type="button"
        onClick={() => setModelId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')}
      >
        Switch target
      </button>
      <AssistantBubble />
    </>
  );
}

function renderAssistant(withLibrarySwitch = false, withTargets = false) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/lib/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']}>
        {withLibrarySwitch ? (
          <LibrarySwitchHarness />
        ) : withTargets ? (
          <AssistantContextProvider><TargetedAssistant /></AssistantContextProvider>
        ) : (
          <AssistantBubble />
        )}
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderTargetSwitchAssistant() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/lib/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']}>
        <AssistantContextProvider><TargetSwitchHarness /></AssistantContextProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AssistantBubble proposal approval', () => {
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listAiProviders).mockResolvedValue({ data: [provider], meta: null, errors: null });
    vi.mocked(sendAiChat).mockResolvedValue({ data: chatResponse, meta: null, errors: null });
    vi.mocked(applyAiProposal).mockResolvedValue({
      data: {
        proposalId: chatResponse.proposal!.proposalId,
        status: 'applied',
        changedModelIds: ['33333333-3333-4333-8333-333333333333'],
        changedImportSessionIds: [],
      },
      meta: null,
      errors: null,
    });
  });

  it('should never auto-apply a proposal returned by chat', async () => {
    renderAssistant();
    fireEvent.click(screen.getByRole('button', { name: 'Open assistant' }));

    const messageBox = await screen.findByRole('textbox', { name: 'Message the assistant' });
    await waitFor(() => expect(messageBox).toBeEnabled());
    fireEvent.change(messageBox, { target: { value: 'Rename the dragon' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByText('Rename Dragon')).toBeInTheDocument();
    expect(screen.getByText('name: Crimson Dragon')).toBeInTheDocument();
    expect(applyAiProposal).not.toHaveBeenCalled();
  });

  it('populates starter tasks without sending them automatically', async () => {
    renderAssistant();
    fireEvent.click(screen.getByRole('button', { name: 'Open assistant' }));

    await screen.findByRole('button', { name: 'Fill metadata' });
    fireEvent.click(screen.getByRole('button', { name: 'Fill metadata' }));

    expect(screen.getByRole('textbox', { name: 'Message the assistant' })).toHaveValue(
      'Fill out relevant metadata from the model file and filename.',
    );
    expect(sendAiChat).not.toHaveBeenCalled();
  });

  it('sends the current model and upload targets with the chat request', async () => {
    renderAssistant(false, true);
    fireEvent.click(screen.getByRole('button', { name: 'Open assistant' }));

    expect(await screen.findByText('Using 1 model and 1 upload')).toBeVisible();
    const messageBox = screen.getByRole('textbox', { name: 'Message the assistant' });
    await waitFor(() => expect(messageBox).toBeEnabled());
    fireEvent.change(messageBox, { target: { value: 'Organize these' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(sendAiChat).toHaveBeenCalledWith(
      expect.objectContaining({
        context: {
          modelIds: ['33333333-3333-4333-8333-333333333333'],
          importSessionIds: ['44444444-4444-4444-8444-444444444444'],
        },
      }),
      expect.any(AbortSignal),
    ));
  });

  it('should call apply with only the stored proposal id after an explicit click', async () => {
    renderAssistant();
    fireEvent.click(screen.getByRole('button', { name: 'Open assistant' }));

    const messageBox = await screen.findByRole('textbox', { name: 'Message the assistant' });
    await waitFor(() => expect(messageBox).toBeEnabled());
    fireEvent.change(messageBox, { target: { value: 'Rename the dragon' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    const applyButton = await screen.findByRole('button', { name: 'Apply changes' });
    expect(applyAiProposal).not.toHaveBeenCalled();
    fireEvent.click(applyButton);

    await waitFor(() => {
      expect(applyAiProposal).toHaveBeenCalledWith(chatResponse.proposal!.proposalId);
    });
    expect(applyAiProposal).toHaveBeenCalledTimes(1);
  });

  it('should discard an in-flight response when the active library changes', async () => {
    let resolveChat!: (value: { data: AiChatResponse; meta: null; errors: null }) => void;
    let chatSignal: AbortSignal | undefined;
    vi.mocked(sendAiChat).mockImplementation((_request, signal) => new Promise((resolve) => {
      chatSignal = signal;
      resolveChat = resolve;
    }));
    renderAssistant(true);
    fireEvent.click(screen.getByRole('button', { name: 'Open assistant' }));

    const messageBox = await screen.findByRole('textbox', { name: 'Message the assistant' });
    await waitFor(() => expect(messageBox).toBeEnabled());
    fireEvent.change(messageBox, { target: { value: 'Prepare changes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(sendAiChat).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Switch library' }));
    expect(chatSignal?.aborted).toBe(true);
    expect(await screen.findByText('What can I help organize?')).toBeInTheDocument();
    expect(screen.queryByText('Prepare changes')).not.toBeInTheDocument();

    await act(async () => {
      resolveChat({ data: chatResponse, meta: null, errors: null });
      await Promise.resolve();
    });

    expect(screen.queryByText(chatResponse.message)).not.toBeInTheDocument();
    expect(screen.queryByText('Rename Dragon')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply changes' })).not.toBeInTheDocument();
  });

  it('aborts and suppresses an in-flight response when the target changes in the same library', async () => {
    let resolveChat!: (value: { data: AiChatResponse; meta: null; errors: null }) => void;
    let chatSignal: AbortSignal | undefined;
    vi.mocked(sendAiChat).mockImplementation((_request, signal) => new Promise((resolve) => {
      chatSignal = signal;
      resolveChat = resolve;
    }));
    renderTargetSwitchAssistant();
    fireEvent.click(screen.getByRole('button', { name: 'Open assistant' }));

    const messageBox = await screen.findByRole('textbox', { name: 'Message the assistant' });
    await waitFor(() => expect(messageBox).toBeEnabled());
    fireEvent.change(messageBox, { target: { value: 'Describe target A' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(sendAiChat).toHaveBeenCalledWith(
      expect.objectContaining({
        context: {
          modelIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
          importSessionIds: [],
        },
      }),
      expect.any(AbortSignal),
    ));

    fireEvent.click(screen.getByRole('button', { name: 'Switch target' }));
    await waitFor(() => expect(chatSignal?.aborted).toBe(true));
    expect(await screen.findByText('What can I help organize?')).toBeInTheDocument();
    expect(screen.queryByText('Describe target A')).not.toBeInTheDocument();

    await act(async () => {
      resolveChat({ data: chatResponse, meta: null, errors: null });
      await Promise.resolve();
    });
    expect(screen.queryByText(chatResponse.message)).not.toBeInTheDocument();
    expect(screen.queryByText('Rename Dragon')).not.toBeInTheDocument();
  });

  it('should abort an in-flight request when the conversation is reset', async () => {
    let chatSignal: AbortSignal | undefined;
    vi.mocked(sendAiChat).mockImplementation((_request, signal) => new Promise((_resolve, reject) => {
      chatSignal = signal;
      signal?.addEventListener('abort', () => reject(new DOMException('Request aborted', 'AbortError')));
    }));
    renderAssistant();
    fireEvent.click(screen.getByRole('button', { name: 'Open assistant' }));

    const messageBox = await screen.findByRole('textbox', { name: 'Message the assistant' });
    await waitFor(() => expect(messageBox).toBeEnabled());
    fireEvent.change(messageBox, { target: { value: 'Prepare changes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(sendAiChat).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Start a new conversation' }));
    expect(chatSignal?.aborted).toBe(true);
    expect(await screen.findByText('What can I help organize?')).toBeInTheDocument();
    expect(screen.queryByText('Request aborted')).not.toBeInTheDocument();
  });

  it('should abort an in-flight request when the assistant unmounts', async () => {
    let chatSignal: AbortSignal | undefined;
    vi.mocked(sendAiChat).mockImplementation((_request, signal) => new Promise((_resolve, reject) => {
      chatSignal = signal;
      signal?.addEventListener('abort', () => reject(new DOMException('Request aborted', 'AbortError')));
    }));
    const { unmount } = renderAssistant();
    fireEvent.click(screen.getByRole('button', { name: 'Open assistant' }));

    const messageBox = await screen.findByRole('textbox', { name: 'Message the assistant' });
    await waitFor(() => expect(messageBox).toBeEnabled());
    fireEvent.change(messageBox, { target: { value: 'Prepare changes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(sendAiChat).toHaveBeenCalledTimes(1));

    unmount();
    expect(chatSignal?.aborted).toBe(true);
  });

  it('should remove old proposals permanently when switching libraries', async () => {
    renderAssistant(true);
    fireEvent.click(screen.getByRole('button', { name: 'Open assistant' }));

    const messageBox = await screen.findByRole('textbox', { name: 'Message the assistant' });
    await waitFor(() => expect(messageBox).toBeEnabled());
    fireEvent.change(messageBox, { target: { value: 'Rename the dragon' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText('Rename Dragon')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Switch library' }));
    expect(screen.queryByText('Rename Dragon')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply changes' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Return to first library' }));
    expect(await screen.findByText('What can I help organize?')).toBeInTheDocument();
    expect(screen.queryByText('Rename Dragon')).not.toBeInTheDocument();
    expect(applyAiProposal).not.toHaveBeenCalled();
  });
});
