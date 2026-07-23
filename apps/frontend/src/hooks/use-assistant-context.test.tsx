import { act, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AssistantContextProvider,
  useAssistantContext,
  useAssistantTarget,
} from './use-assistant-context';

const libraryState = vi.hoisted(() => ({ currentLibraryId: 'library-1' as string | null }));

vi.mock('./use-libraries', () => ({
  useCurrentLibraryId: () => libraryState.currentLibraryId,
}));

function Target({
  modelIds = [],
  importSessionIds = [],
}: {
  modelIds?: string[];
  importSessionIds?: string[];
}) {
  useAssistantTarget({ modelIds, importSessionIds });
  return null;
}

function ContextProbe() {
  const context = useAssistantContext();
  return <output aria-label="assistant targets">{JSON.stringify(context)}</output>;
}

function Harness() {
  const [showSecond, setShowSecond] = useState(true);
  return (
    <AssistantContextProvider>
      <Target modelIds={['model-1', 'model-2']} importSessionIds={['upload-1']} />
      {showSecond && <Target modelIds={['model-2', 'model-3']} importSessionIds={['upload-2']} />}
      <button type="button" onClick={() => setShowSecond(false)}>Remove second target</button>
      <ContextProbe />
    </AssistantContextProvider>
  );
}

function readContext() {
  return JSON.parse(screen.getByLabelText('assistant targets').textContent ?? '{}') as {
    modelIds: string[];
    importSessionIds: string[];
  };
}

describe('AssistantContextProvider', () => {
  beforeEach(() => {
    libraryState.currentLibraryId = 'library-1';
  });

  it('should combine current-page targets without duplicates and unregister unmounted targets', () => {
    render(<Harness />);

    expect(readContext()).toEqual({
      modelIds: ['model-1', 'model-2', 'model-3'],
      importSessionIds: ['upload-1', 'upload-2'],
    });

    act(() => screen.getByRole('button', { name: 'Remove second target' }).click());
    expect(readContext()).toEqual({
      modelIds: ['model-1', 'model-2'],
      importSessionIds: ['upload-1'],
    });
  });

  it('should cap each target kind to the API context boundary', () => {
    const ids = Array.from({ length: 30 }, (_, index) => `target-${index}`);
    render(
      <AssistantContextProvider>
        <Target modelIds={ids} importSessionIds={ids} />
        <ContextProbe />
      </AssistantContextProvider>,
    );

    expect(readContext().modelIds).toEqual(ids.slice(0, 25));
    expect(readContext().importSessionIds).toEqual(ids.slice(0, 25));
  });
});
