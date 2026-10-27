import { KernelError, type KernelEvent } from '../../contracts/src/index.js';
import { createHash } from 'node:crypto';

export interface TurnBinding {
  readonly commandId: string;
  readonly turnId: string;
  readonly acceptedSeq: number;
  readonly boundSeq: number;
  readonly text: string;
}
function corrupt(reason: string): never { throw new KernelError('CORRUPT_COMMAND_DISPATCH',reason); }
const obj=(v:unknown):v is Record<string,unknown>=>v!==null && typeof v==='object' && !Array.isArray(v);

/**
 * Pure log auditor. A binding is inseparable from initial Turn admission:
 * command.turn_bound, turn.queued, user.message, turn.started are adjacent.
 * A bind is NEVER evidence that a model step or a tool was executed.
 */
export function inspectTurnBindings(events: readonly KernelEvent[]): readonly TurnBinding[] {
  const acks=new Map<string,{seq:number,kind:string}>();
  const ids=new Set<string>();
  const turns=new Set<string>();
  const result:TurnBinding[]=[];
  for(let i=0;i<events.length;i++){
    const e=events[i]!;
    if(e.type==='command.accepted'){
      if(e.turnId!==undefined || !obj(e.data)
        || typeof e.data.commandId!=='string' || typeof e.data.kind!=='string'
        || acks.has(e.data.commandId)) corrupt('Invalid or repeated command ACK');
      acks.set(e.data.commandId,{seq:e.seq,kind:e.data.kind});
    } else if(e.type==='command.turn_bound'){
      if(e.turnId!==undefined || !obj(e.data)) corrupt('Binding must be session-scoped');
      const {commandId,turnId,acceptedSeq,textHash}=e.data;
      if(typeof commandId!=='string' || typeof turnId!=='string'
        || !Number.isSafeInteger(acceptedSeq) || ids.has(commandId) || turns.has(turnId))
        corrupt('Invalid or duplicate command binding');
      const ack=acks.get(commandId);
      if(!ack || ack.kind!=='turn.run' || ack.seq!==acceptedSeq)
        corrupt('Command binding lacks trusted turn.run ACK');
      const queued=events[i+1],user=events[i+2],started=events[i+3];
      if(!queued || queued.seq!==e.seq+1 || queued.type!=='turn.queued'
        || queued.turnId!==turnId || !obj(queued.data) || queued.data.commandId!==commandId
        || !user || user.seq!==e.seq+2 || user.type!=='user.message' || user.turnId!==turnId
        || !obj(user.data) || typeof user.data.text!=='string' || !user.data.text.trim()
        || !started || started.seq!==e.seq+3 || started.type!=='turn.started'
        || started.turnId!==turnId || !obj(started.data) || started.data.commandId!==commandId)
        corrupt('Binding and Turn admission must be one adjacent four-event batch');
      if(typeof textHash!=='string' || textHash!==createHash('sha256').update(user.data.text).digest('hex'))
        corrupt('Turn admission user text differs from bound fingerprint');
      ids.add(commandId);turns.add(turnId);
      result.push({commandId,turnId,acceptedSeq:acceptedSeq as number,
        boundSeq:e.seq,text:user.data.text});
    }
  }
  return result;
}
