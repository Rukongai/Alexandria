import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  AiProvider,
  AiProviderModel,
  CreateAiProviderRequest,
  UpdateAiProviderRequest,
} from '@alexandria/shared';
import { CheckCircle2, Loader2, RefreshCw, Search } from 'lucide-react';
import {
  createAiProvider,
  listAiProviderModels,
  testAiProvider,
  updateAiProvider,
} from '../../api/ai';
import { useToast } from '../../hooks/use-toast';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';

interface ProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider?: AiProvider;
}

export function ProviderDialog({ open, onOpenChange, provider }: ProviderDialogProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const isEdit = Boolean(provider);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [discoveredModels, setDiscoveredModels] = useState<AiProviderModel[]>([]);

  useEffect(() => {
    if (!open) return;
    setName(provider?.name ?? '');
    setBaseUrl(provider?.baseUrl ?? '');
    setApiKey('');
    setModel(provider?.model ?? '');
    setIsDefault(provider?.isDefault ?? false);
    setDiscoveredModels([]);
  }, [open, provider]);

  const saveMutation = useMutation({
    mutationFn: () => {
      if (provider) {
        const data: UpdateAiProviderRequest = {
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          model: model.trim(),
          isDefault,
        };
        // An empty secret means “keep the stored key”; it must not be sent as
        // an empty value because that would overwrite provider credentials.
        if (apiKey.trim()) data.apiKey = apiKey.trim();
        return updateAiProvider(provider.id, data);
      }

      const data: CreateAiProviderRequest = {
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        isDefault,
      };
      if (apiKey.trim()) data.apiKey = apiKey.trim();
      return createAiProvider(data);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['ai-providers'] });
      toast({ title: provider ? 'Provider updated' : 'Provider created' });
      onOpenChange(false);
    },
    onError: (error) => {
      toast({
        title: 'Could not save provider',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
    },
  });

  const testMutation = useMutation({
    mutationFn: () => testAiProvider(provider!.id),
    onSuccess: (response) => {
      toast({
        title: 'Connection successful',
        description: `${response.data.modelCount} model${response.data.modelCount === 1 ? '' : 's'} available.`,
      });
    },
    onError: (error) => {
      toast({
        title: 'Connection failed',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
    },
  });

  const modelsMutation = useMutation({
    mutationFn: () => listAiProviderModels(provider!.id),
    onSuccess: (response) => setDiscoveredModels(response.data),
    onError: (error) => {
      toast({
        title: 'Could not discover models',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
    },
  });

  const canSave = Boolean(name.trim() && baseUrl.trim() && model.trim());

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (canSave) saveMutation.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit AI provider' : 'Add AI provider'}</DialogTitle>
          <DialogDescription>
            Configure an OpenAI-compatible API. Credentials are stored securely and are never displayed again.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="provider-name">Name</Label>
              <Input
                id="provider-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Local server"
                autoFocus
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="provider-model">Model</Label>
              <Input
                id="provider-model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="Model identifier"
                required
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="provider-base-url">Base URL</Label>
            <Input
              id="provider-base-url"
              type="url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://provider.example/v1"
              required
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="provider-api-key">API key</Label>
            <Input
              id="provider-api-key"
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={isEdit && provider?.hasApiKey ? 'Leave blank to keep the current key' : 'Optional if your provider does not require one'}
              autoComplete="new-password"
            />
            {isEdit && provider?.hasApiKey && (
              <p className="text-xs text-muted-foreground">A key is saved. Leave this blank to preserve it.</p>
            )}
          </div>

          <Checkbox
            id="provider-default"
            checked={isDefault}
            onChange={(event) => setIsDefault(event.target.checked)}
            label="Use as default provider"
          />

          <div className="rounded-xl border bg-muted/20 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!provider || testMutation.isPending}
                onClick={() => testMutation.mutate()}
              >
                {testMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
                Test connection
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!provider || modelsMutation.isPending}
                onClick={() => modelsMutation.mutate()}
              >
                {modelsMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Search className="mr-1.5 h-3.5 w-3.5" />}
                Discover models
              </Button>
              {!provider && <span className="text-xs text-muted-foreground">Save the provider before testing or discovery.</span>}
              {testMutation.isSuccess && (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Connected
                </span>
              )}
            </div>

            {discoveredModels.length > 0 && (
              <div className="mt-3 max-h-40 overflow-y-auto rounded-lg border bg-background p-1" aria-label="Discovered models">
                {discoveredModels.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setModel(item.id)}
                    className="flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="truncate font-mono text-xs">{item.id}</span>
                    {item.ownedBy && <span className="shrink-0 text-xs text-muted-foreground">{item.ownedBy}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saveMutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave || saveMutation.isPending}>
              {saveMutation.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Add provider'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
