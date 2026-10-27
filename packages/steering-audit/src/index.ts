import { KernelError, type KernelEvent } from '../../contracts/src/index.js';

/**
 * Audits persisted steering without executing or replaying it.
 * A queued steer MUST be paired FIFO with an adjacent consumed+user.message
 * event pair before it can be considered model-context visible.
 */
export function inspectSteeringAudit(events: readonly KernelEvent[]): {unconsumedSteers:number} {
  const pending = new Map<string, string[]>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.type === 'turn.steer_queued') {
      const text = (e.data as {text?:unknown}|null)?.text;
      if (!e.turnId || typeof text !== 'string' || !text.trim()) {
        throw new KernelError('CORRUPT_EVENT_LOG','Invalid steering queue event');
      }
      const queue = pending.get(e.turnId) ?? [];
      queue.push(text);
      pending.set(e.turnId,queue);
    }
    if (e.type === 'turn.steer_consumed') {
      const queue = e.turnId ? pending.get(e.turnId) : undefined;
      if (!queue?.length) throw new KernelError('CORRUPT_EVENT_LOG','Steering consumed without queued input');
      const expected=queue.shift();
      const next=events[i+1];
      if(!next || next.seq!==e.seq+1 || next.turnId!==e.turnId
        || next.type!=='user.message'
        || (next.data as {text?:unknown}|null)?.text!==expected)
        throw new KernelError('CORRUPT_EVENT_LOG','Steering must atomically become a matching user message');
    }
  }
  return {unconsumedSteers:[...pending.values()].reduce((n,queue)=>n+queue.length,0)};
}
