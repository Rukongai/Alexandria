import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useMatch } from 'react-router-dom';
import type { AiChatMessage, AiChatResponse } from '@alexandria/shared';
import {
  ArrowUp,
  Bot,
  ExternalLink,
  Loader2,
  MessageCircleMore,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react';
import { applyAiProposal, listAiProviders, sendAiChat } from '../../api/ai';
import { useLibraryPath } from '../../hooks/use-libraries';
import { useToast } from '../../hooks/use-toast';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { ScrollArea } from '../ui/scroll-area';
import { Select } from '../ui/select';
import { Textarea } from '../ui/textarea';
import { ProposalPreviewCard } from './ProposalPreviewCard';

interface ConversationMessage extends AiChatMessage {
  id: string;
  response?: AiChatResponse;
}

interface ChatMutationVariables {
  message: string;
  history: AiChatMessage[];
  providerId?: string;
  modelId?: string;
  libraryId: string | null;
  conversationVersion: number;
  signal: AbortSignal;
}

interface ApplyMutationVariables {
  proposalId: string;
  libraryId: string | null;
  conversationVersion: number;
}

const INVALIDATE_AFTER_APPLY = new Set([
  'model',
  'models',
  'model-files',
  'model-status',
  'metadata-fields',
  'field-values',
  'collection',
  'collections',
  'collection-models',
  'smart-preview',
  'smart-collections',
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function AssistantBubble() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [providerId, setProviderId] = useState('');
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const libraryMatch = useMatch('/lib/:libraryId/*');
  const currentLibraryId = libraryMatch?.params.libraryId ?? null;
  const [conversationLibraryId, setConversationLibraryId] = useState(currentLibraryId);
  const [dismissedProposals, setDismissedProposals] = useState<Set<string>>(new Set());
  const [appliedProposals, setAppliedProposals] = useState<Set<string>>(new Set());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const currentLibraryIdRef = useRef(currentLibraryId);
  const previousLibraryIdRef = useRef(currentLibraryId);
  const conversationVersionRef = useRef(0);
  const chatAbortControllerRef = useRef<AbortController | null>(null);
  const queryClient = useQueryClient();
  const modelMatch = useMatch('/lib/:libraryId/models/:id');
  const libPath = useLibraryPath();
  const { toast } = useToast();

  const providersQuery = useQuery({
    queryKey: ['ai-providers'],
    queryFn: () => listAiProviders().then((response) => response.data),
  });
  const providers = providersQuery.data ?? [];
  const activeProviderId = providerId || providers.find((provider) => provider.isDefault)?.id || providers[0]?.id || '';
  const conversationIsCurrent = conversationLibraryId === currentLibraryId;
  const visibleMessages = conversationIsCurrent ? messages : [];

  // Keep async completion guards synchronized during render. The visible
  // conversation is separately gated by conversationLibraryId, so content from
  // the previous library cannot flash during the route transition.
  currentLibraryIdRef.current = currentLibraryId;

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => textareaRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    messagesEndRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  }, [messages, open]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [open]);

  const chatMutation = useMutation({
    mutationFn: async (variables: ChatMutationVariables) => {
      return sendAiChat({
        message: variables.message,
        history: variables.history,
        providerId: variables.providerId,
        context: variables.modelId ? { modelId: variables.modelId } : undefined,
      }, variables.signal).then((response) => response.data);
    },
    onSuccess: (response, variables) => {
      if (
        variables.conversationVersion !== conversationVersionRef.current
        || variables.libraryId !== currentLibraryIdRef.current
      ) return;
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: response.message,
          response,
        },
      ]);
    },
    onSettled: (_data, _error, variables) => {
      if (chatAbortControllerRef.current?.signal === variables.signal) {
        chatAbortControllerRef.current = null;
      }
    },
  });

  const applyMutation = useMutation({
    mutationFn: (variables: ApplyMutationVariables) =>
      applyAiProposal(variables.proposalId).then((response) => response.data),
    onSuccess: async (result, variables) => {
      if (
        variables.conversationVersion !== conversationVersionRef.current
        || variables.libraryId !== currentLibraryIdRef.current
      ) return;
      setAppliedProposals((current) => new Set(current).add(result.proposalId));
      await queryClient.invalidateQueries({
        predicate: (query) => INVALIDATE_AFTER_APPLY.has(String(query.queryKey[0])),
      });
      toast({
        title: 'Changes applied',
        description: `${result.changedModelIds.length} model${result.changedModelIds.length === 1 ? '' : 's'} updated.`,
      });
    },
    onError: (error, variables) => {
      if (
        variables.conversationVersion !== conversationVersionRef.current
        || variables.libraryId !== currentLibraryIdRef.current
      ) return;
      toast({ title: 'Could not apply changes', description: errorMessage(error), variant: 'destructive' });
    },
  });

  useEffect(() => {
    if (previousLibraryIdRef.current === currentLibraryId) return;
    previousLibraryIdRef.current = currentLibraryId;
    conversationVersionRef.current += 1;
    chatAbortControllerRef.current?.abort();
    chatAbortControllerRef.current = null;
    setConversationLibraryId(currentLibraryId);
    setMessages([]);
    setDraft('');
    setDismissedProposals(new Set());
    setAppliedProposals(new Set());
    chatMutation.reset();
    applyMutation.reset();
  }, [currentLibraryId]);

  useEffect(() => () => {
    chatAbortControllerRef.current?.abort();
    chatAbortControllerRef.current = null;
  }, []);

  function submitMessage() {
    const message = draft.trim();
    if (!message || chatMutation.isPending || providers.length === 0) return;
    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role: 'user', content: message },
    ]);
    setDraft('');
    const controller = new AbortController();
    chatAbortControllerRef.current = controller;
    chatMutation.mutate({
      message,
      history: visibleMessages.map(({ role, content }) => ({ role, content })),
      providerId: activeProviderId || undefined,
      modelId: modelMatch?.params.id,
      libraryId: currentLibraryId,
      conversationVersion: conversationVersionRef.current,
      signal: controller.signal,
    });
  }

  function resetConversation() {
    conversationVersionRef.current += 1;
    chatAbortControllerRef.current?.abort();
    chatAbortControllerRef.current = null;
    setMessages([]);
    setDraft('');
    setDismissedProposals(new Set());
    setAppliedProposals(new Set());
    chatMutation.reset();
    applyMutation.reset();
    textareaRef.current?.focus();
  }

  return (
    <>
      {open && (
        <section
          id="alexandria-assistant-panel"
          role="dialog"
          aria-label="Alexandria assistant"
          className={cn(
            'fixed z-40 flex flex-col overflow-hidden border bg-background shadow-2xl',
            'inset-x-3 bottom-[5.5rem] top-3 rounded-2xl',
            'sm:inset-auto sm:bottom-24 sm:right-5 sm:h-[min(680px,calc(100vh-7rem))] sm:w-[420px] sm:rounded-2xl',
          )}
        >
          <header className="flex items-center justify-between border-b bg-muted/30 px-4 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm">
                <Sparkles className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-foreground">Alexandria Assistant</h2>
                <p className="truncate text-xs text-muted-foreground">
                  {modelMatch?.params.id ? 'Using the current model as context' : 'Ask about your library'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={resetConversation}
                disabled={visibleMessages.length === 0 && !chatMutation.isPending}
                aria-label="Start a new conversation"
              >
                <RotateCcw className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => setOpen(false)}
                aria-label="Close assistant"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </header>

          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-4 px-4 py-5" aria-live="polite">
              {providersQuery.isLoading ? (
                <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading providers…
                </div>
              ) : providersQuery.isError ? (
                <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-center">
                  <p className="text-sm font-medium">Providers could not be loaded.</p>
                  <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => providersQuery.refetch()}>
                    Try again
                  </Button>
                </div>
              ) : providers.length === 0 ? (
                <div className="mx-auto flex max-w-xs flex-col items-center py-12 text-center">
                  <div className="mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-muted">
                    <Bot className="h-6 w-6 text-muted-foreground" />
                  </div>
                  <h3 className="text-sm font-semibold">Connect an AI provider</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                    Add an OpenAI-compatible provider before starting a conversation.
                  </p>
                  <Link
                    to={libPath('/settings')}
                    onClick={() => setOpen(false)}
                    className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Configure providers <ExternalLink className="h-3.5 w-3.5" />
                  </Link>
                </div>
              ) : visibleMessages.length === 0 ? (
                <div className="mx-auto flex max-w-xs flex-col items-center py-12 text-center">
                  <div className="mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-primary/10">
                    <Sparkles className="h-6 w-6 text-primary" />
                  </div>
                  <h3 className="text-sm font-semibold">What can I help organize?</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                    Ask questions, find details, or preview changes to models and collections.
                  </p>
                </div>
              ) : (
                visibleMessages.map((message) => (
                  <div
                    key={message.id}
                    className={cn('flex', message.role === 'user' ? 'justify-end' : 'justify-start')}
                  >
                    <div className={cn('max-w-[88%]', message.role === 'user' ? 'rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-primary-foreground' : 'w-full')}>
                      {message.role === 'assistant' && (
                        <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                          <Sparkles className="h-3.5 w-3.5 text-primary" /> Assistant
                        </div>
                      )}
                      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{message.content}</p>

                      {message.response?.sources && message.response.sources.length > 0 && (
                        <div className="mt-3 grid gap-2">
                          {message.response.sources.map((source, index) => (
                            <a
                              key={`${source.url}-${index}`}
                              href={source.url}
                              target="_blank"
                              rel="noreferrer"
                              className="group flex overflow-hidden rounded-lg border bg-card transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              {source.imageUrl && (
                                <img src={source.imageUrl} alt="" className="h-16 w-16 shrink-0 object-cover" />
                              )}
                              <span className="min-w-0 p-2.5">
                                <span className="flex items-start gap-1 text-xs font-medium text-foreground group-hover:text-primary">
                                  <span className="line-clamp-1">{source.title}</span>
                                  <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" />
                                </span>
                                {source.snippet && <span className="mt-1 line-clamp-2 text-[11px] leading-snug text-muted-foreground">{source.snippet}</span>}
                              </span>
                            </a>
                          ))}
                        </div>
                      )}

                      {message.response?.proposal && !dismissedProposals.has(message.response.proposal.proposalId) && (
                        <ProposalPreviewCard
                          proposal={message.response.proposal}
                          isApplying={applyMutation.isPending}
                          isApplied={appliedProposals.has(message.response.proposal.proposalId)}
                          onApply={() => applyMutation.mutate({
                            proposalId: message.response!.proposal!.proposalId,
                            libraryId: currentLibraryId,
                            conversationVersion: conversationVersionRef.current,
                          })}
                          onDismiss={() => setDismissedProposals((current) => new Set(current).add(message.response!.proposal!.proposalId))}
                        />
                      )}
                    </div>
                  </div>
                ))
              )}

              {conversationIsCurrent && chatMutation.isPending && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span className="grid h-7 w-7 place-items-center rounded-lg bg-primary/10"><Sparkles className="h-3.5 w-3.5 text-primary" /></span>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
                </div>
              )}

              {conversationIsCurrent && chatMutation.isError && !isAbortError(chatMutation.error) && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
                  {errorMessage(chatMutation.error)}
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          </ScrollArea>

          <footer className="border-t bg-background p-3">
            {providers.length > 0 && (
              <div className="mb-2 flex items-center gap-2">
                <label htmlFor="assistant-provider" className="shrink-0 text-xs font-medium text-muted-foreground">Provider</label>
                <Select
                  id="assistant-provider"
                  value={activeProviderId}
                  onChange={(event) => setProviderId(event.target.value)}
                  className="h-8 text-xs"
                >
                  {providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>{provider.name} · {provider.model}</option>
                  ))}
                </Select>
              </div>
            )}
            <div className="relative">
              <Textarea
                ref={textareaRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    submitMessage();
                  }
                }}
                aria-label="Message the assistant"
                placeholder={providers.length === 0 ? 'Configure a provider to begin' : 'Ask about your library…'}
                disabled={providers.length === 0 || providersQuery.isLoading}
                rows={2}
                className="min-h-[64px] resize-none rounded-xl pr-12"
              />
              <Button
                type="button"
                size="icon"
                className="absolute bottom-2 right-2 h-8 w-8 rounded-lg"
                onClick={submitMessage}
                disabled={!draft.trim() || chatMutation.isPending || providers.length === 0}
                aria-label="Send message"
              >
                {chatMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
              </Button>
            </div>
            <p className="mt-1.5 text-center text-[10px] text-muted-foreground">Changes are always previewed and require approval.</p>
          </footer>
        </section>
      )}

      <Button
        type="button"
        size="icon"
        className="fixed bottom-5 right-5 z-40 h-14 w-14 rounded-2xl shadow-xl transition-transform hover:scale-105"
        onClick={() => setOpen((current) => !current)}
        aria-label={open ? 'Close assistant' : 'Open assistant'}
        aria-expanded={open}
        aria-controls="alexandria-assistant-panel"
      >
        {open ? <X className="h-5 w-5" /> : <MessageCircleMore className="h-6 w-6" />}
      </Button>
    </>
  );
}
