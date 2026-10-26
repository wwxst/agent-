import {KernelError, type ContextMessage, type ModelStepRequest} from '../../contracts/src/index.js';

/** Deterministic serialized-character admission. This is NOT a model tokenizer or a token guarantee. */
export interface ContextBudget {
  readonly maxSerializedCharacters: number;
}
export interface ContextAdmission {
  readonly serializedCharacters: number;
  readonly limit: number;
}
export function admitContext(messages: readonly ContextMessage[], step: ModelStepRequest, budget: ContextBudget): ContextAdmission {
  const {maxSerializedCharacters: limit} = budget;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new KernelError('INVALID_CONTEXT_BUDGET', 'Invalid serialized context budget');
  // Tool definitions count: model instructions and schemas consume context too.
  const serializedCharacters = JSON.stringify({messages, tools:step.tools}).length;
  if (serializedCharacters > limit) {
    throw new KernelError('CONTEXT_BUDGET_EXCEEDED', 'Serialized model context exceeds configured character ceiling');
  }
  return {serializedCharacters, limit};
}
