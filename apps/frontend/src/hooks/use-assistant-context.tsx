import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useCurrentLibraryId } from './use-libraries';

export interface AssistantTargetContext {
  modelIds: string[];
  importSessionIds: string[];
}

interface RegisteredTarget extends AssistantTargetContext {
  libraryId: string | null;
}

interface AssistantContextValue extends AssistantTargetContext {
  registerTarget: (registrationId: string, target: RegisteredTarget | null) => void;
}

const EMPTY_CONTEXT: AssistantContextValue = {
  modelIds: [],
  importSessionIds: [],
  registerTarget: () => {},
};

const AssistantContext = createContext<AssistantContextValue>(EMPTY_CONTEXT);

function sameTarget(left: RegisteredTarget | undefined, right: RegisteredTarget): boolean {
  return left?.libraryId === right.libraryId
    && left.modelIds.join('\0') === right.modelIds.join('\0')
    && left.importSessionIds.join('\0') === right.importSessionIds.join('\0');
}

export function AssistantContextProvider({ children }: { children: ReactNode }) {
  const currentLibraryId = useCurrentLibraryId();
  const [registrations, setRegistrations] = useState<Map<string, RegisteredTarget>>(new Map());

  const registerTarget = useCallback((registrationId: string, target: RegisteredTarget | null) => {
    setRegistrations((current) => {
      if (target && sameTarget(current.get(registrationId), target)) return current;
      if (!target && !current.has(registrationId)) return current;

      const next = new Map(current);
      if (target) next.set(registrationId, target);
      else next.delete(registrationId);
      return next;
    });
  }, []);

  const value = useMemo<AssistantContextValue>(() => {
    const modelIds = new Set<string>();
    const importSessionIds = new Set<string>();

    for (const target of registrations.values()) {
      if (target.libraryId !== currentLibraryId) continue;
      target.modelIds.forEach((id) => modelIds.add(id));
      target.importSessionIds.forEach((id) => importSessionIds.add(id));
    }

    return {
      modelIds: Array.from(modelIds).slice(0, 25),
      importSessionIds: Array.from(importSessionIds).slice(0, 25),
      registerTarget,
    };
  }, [currentLibraryId, registerTarget, registrations]);

  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
}

export function useAssistantContext(): AssistantTargetContext {
  const { modelIds, importSessionIds } = useContext(AssistantContext);
  return { modelIds, importSessionIds };
}

/** Register the entities the assistant should treat as the current page target. */
export function useAssistantTarget(target: Partial<AssistantTargetContext>) {
  const registrationId = useId();
  const currentLibraryId = useCurrentLibraryId();
  const { registerTarget } = useContext(AssistantContext);
  const modelKey = (target.modelIds ?? []).join('\0');
  const importSessionKey = (target.importSessionIds ?? []).join('\0');

  useEffect(() => {
    registerTarget(registrationId, {
      libraryId: currentLibraryId,
      modelIds: modelKey ? modelKey.split('\0') : [],
      importSessionIds: importSessionKey ? importSessionKey.split('\0') : [],
    });
    return () => registerTarget(registrationId, null);
  }, [currentLibraryId, importSessionKey, modelKey, registerTarget, registrationId]);
}
