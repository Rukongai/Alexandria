import * as React from 'react';

export type ToastVariant = 'default' | 'destructive';

export interface Toast {
  id: string;
  title?: string;
  description?: string;
  variant?: ToastVariant;
  duration?: number;
}

type ToastAction =
  | { type: 'ADD'; toast: Toast }
  | { type: 'REMOVE'; id: string };

interface ToastState {
  toasts: Toast[];
}

const TOAST_LIMIT = 5;
const TOAST_REMOVE_DELAY = 4000;

function toastReducer(state: ToastState, action: ToastAction): ToastState {
  switch (action.type) {
    case 'ADD':
      return {
        toasts: [action.toast, ...state.toasts].slice(0, TOAST_LIMIT),
      };
    case 'REMOVE':
      return {
        toasts: state.toasts.filter((t) => t.id !== action.id),
      };
  }
}

// Module-level state so toasts work outside React tree
let listeners: Array<(state: ToastState) => void> = [];
let memoryState: ToastState = { toasts: [] };

function dispatch(action: ToastAction) {
  memoryState = toastReducer(memoryState, action);
  listeners.forEach((listener) => listener(memoryState));
}

let count = 0;
function genId() {
  count = (count + 1) % Number.MAX_SAFE_INTEGER;
  return count.toString();
}

function toast(options: Omit<Toast, 'id'>) {
  const id = genId();
  const duration = options.duration ?? TOAST_REMOVE_DELAY;

  dispatch({ type: 'ADD', toast: { ...options, id } });

  setTimeout(() => {
    dispatch({ type: 'REMOVE', id });
  }, duration);

  return id;
}

function useToast() {
  const [state, setState] = React.useState<ToastState>(memoryState);

  React.useEffect(() => {
    listeners.push(setState);
    return () => {
      listeners = listeners.filter((l) => l !== setState);
    };
  }, []);

  return {
    toasts: state.toasts,
    toast,
    dismiss: (id: string) => dispatch({ type: 'REMOVE', id }),
  };
}

export { useToast, toast };
