import { useMemo, useReducer } from 'react';
import type { RuleNode, RuleCondition, RuleFieldRef, RuleOperator } from '@alexandria/shared';

// ---------------------------------------------------------------------------
// Draft tree — the same shape as the persisted RuleNode plus a stable `_id` on
// every node for React keys and id-keyed edits. `_id` is ephemeral and stripped
// by toDefinition() before the tree is sent to the API.
// ---------------------------------------------------------------------------

export interface DraftCondition {
  _id: string;
  kind: 'condition';
  field: RuleFieldRef;
  operator: RuleOperator;
  value: string | null;
}

export interface DraftGroup {
  _id: string;
  kind: 'group';
  op: 'and' | 'or';
  children: DraftNode[];
}

export type DraftNode = DraftGroup | DraftCondition;

function newId(): string {
  return crypto.randomUUID();
}

/** A sensible default condition for a freshly added row. */
function defaultCondition(): DraftCondition {
  return { _id: newId(), kind: 'condition', field: { source: 'builtin', field: 'name' }, operator: 'contains', value: '' };
}

function toDraft(node: RuleNode): DraftNode {
  if (node.kind === 'condition') {
    return { _id: newId(), ...node };
  }
  return { _id: newId(), kind: 'group', op: node.op, children: node.children.map(toDraft) };
}

function stripNode(node: DraftNode): RuleNode {
  if (node.kind === 'condition') {
    return { kind: 'condition', field: node.field, operator: node.operator, value: node.value };
  }
  return { kind: 'group', op: node.op, children: node.children.map(stripNode) };
}

/** The group-nesting depth of a node (root group = 1), keyed by id. */
export function depthOf(root: DraftGroup, id: string): number {
  const find = (node: DraftNode, groupDepth: number): number | null => {
    if (node._id === id) return groupDepth;
    if (node.kind === 'group') {
      for (const child of node.children) {
        const r = find(child, child.kind === 'group' ? groupDepth + 1 : groupDepth);
        if (r !== null) return r;
      }
    }
    return null;
  };
  return find(root, 1) ?? 1;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

type Action =
  | { type: 'updateCondition'; id: string; patch: Partial<Omit<DraftCondition, '_id' | 'kind'>> }
  | { type: 'setGroupOp'; id: string; op: 'and' | 'or' }
  | { type: 'addCondition'; groupId: string }
  | { type: 'addGroup'; groupId: string }
  | { type: 'remove'; id: string }
  | { type: 'reset'; tree: DraftGroup };

/** Recursively map a node, applying fn to the node with matching id. */
function mapNode(node: DraftNode, id: string, fn: (n: DraftNode) => DraftNode): DraftNode {
  if (node._id === id) return fn(node);
  if (node.kind === 'group') {
    return { ...node, children: node.children.map((c) => mapNode(c, id, fn)) };
  }
  return node;
}

/** Recursively remove the node with matching id (never removes the root). */
function removeNode(node: DraftGroup, id: string): DraftGroup {
  return {
    ...node,
    children: node.children
      .filter((c) => c._id !== id)
      .map((c) => (c.kind === 'group' ? removeNode(c, id) : c)),
  };
}

function reducer(state: DraftGroup, action: Action): DraftGroup {
  switch (action.type) {
    case 'reset':
      return action.tree;
    case 'updateCondition':
      return mapNode(state, action.id, (n) =>
        n.kind === 'condition' ? { ...n, ...action.patch } : n,
      ) as DraftGroup;
    case 'setGroupOp':
      return mapNode(state, action.id, (n) => (n.kind === 'group' ? { ...n, op: action.op } : n)) as DraftGroup;
    case 'addCondition':
      return mapNode(state, action.groupId, (n) =>
        n.kind === 'group' ? { ...n, children: [...n.children, defaultCondition()] } : n,
      ) as DraftGroup;
    case 'addGroup':
      return mapNode(state, action.groupId, (n) =>
        n.kind === 'group'
          ? { ...n, children: [...n.children, { _id: newId(), kind: 'group', op: 'and', children: [defaultCondition()] }] }
          : n,
      ) as DraftGroup;
    case 'remove':
      return removeNode(state, action.id);
    default:
      return state;
  }
}

function initRoot(initial?: RuleNode): DraftGroup {
  if (initial && initial.kind === 'group') return toDraft(initial) as DraftGroup;
  if (initial && initial.kind === 'condition') {
    return { _id: newId(), kind: 'group', op: 'and', children: [toDraft(initial)] };
  }
  return { _id: newId(), kind: 'group', op: 'and', children: [] };
}

/**
 * Local draft state for the smart-collection composer. The rule tree is too
 * nested for the URL, so it lives here; the persisted definition is derived via
 * `definition`.
 */
export function useSmartCollectionDraft(initial?: RuleNode) {
  const [tree, dispatch] = useReducer(reducer, initial, initRoot);

  const definition = useMemo<RuleNode>(() => stripNode(tree), [tree]);

  return {
    tree,
    definition,
    updateCondition: (id: string, patch: Partial<Omit<DraftCondition, '_id' | 'kind'>>) =>
      dispatch({ type: 'updateCondition', id, patch }),
    setGroupOp: (id: string, op: 'and' | 'or') => dispatch({ type: 'setGroupOp', id, op }),
    addCondition: (groupId: string) => dispatch({ type: 'addCondition', groupId }),
    addGroup: (groupId: string) => dispatch({ type: 'addGroup', groupId }),
    remove: (id: string) => dispatch({ type: 'remove', id }),
    reset: (node: RuleNode) => dispatch({ type: 'reset', tree: initRoot(node) }),
  };
}

export { defaultCondition, stripNode as draftToDefinition };
