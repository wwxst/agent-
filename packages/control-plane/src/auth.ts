import { createHash, timingSafeEqual } from 'node:crypto';
import { KernelError } from '../../contracts/src/index.js';

export type ControlPermission = 'command.accept' | 'command.dispatch' | 'command.inspect';
export interface ControlAuthorizer {
  authorize(header:unknown,sessionId:string,permission:ControlPermission):string;
}
export interface ControlPrincipalConfig {
  readonly principalId: string;
  /** 32 random bytes, encoded with base64url. Configure out of band; never log. */
  readonly bearerToken: string;
  /** Explicit allowlist; '*' and an empty array never authorize sessions. */
  readonly sessionIds: readonly string[];
  readonly permissions: readonly ControlPermission[];
}
interface Principal {
  readonly id: string;
  readonly digest: Buffer;
  readonly sessions: ReadonlySet<string>;
  readonly permissions: ReadonlySet<ControlPermission>;
}
const validId=(v:unknown)=>typeof v==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const validToken=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{43}$/.test(v)
  && Buffer.from(v,'base64url').length===32
  && Buffer.from(v,'base64url').toString('base64url')===v;
const hash=(v:string)=>createHash('sha256').update(v,'utf8').digest();

/**
 * In-memory, explicitly configured bearer credential gate. No impersonation
 * from user payload; authorization is decided BEFORE opening any DB handle.
 * Keys are never persisted or included in error responses.
 */
export class ControlKeyring {
  private readonly principals: readonly Principal[];
  constructor(configs:readonly ControlPrincipalConfig[]) {
    if(configs.length===0 || configs.length>128)
      throw new KernelError('INVALID_CONTROL_CONFIG','At least one bounded credential is required');
    const principals:Principal[]=[];
    const ids=new Set<string>(), digests=new Set<string>();
    for(const config of configs){
      if(!validId(config.principalId) || ids.has(config.principalId)
        || !validToken(config.bearerToken)
        || !Array.isArray(config.sessionIds) || config.sessionIds.length===0
        || config.sessionIds.length>256 || !config.sessionIds.every(validId)
        || new Set(config.sessionIds).size!==config.sessionIds.length
        || !Array.isArray(config.permissions)||config.permissions.length===0
        || config.permissions.length>3
        || !config.permissions.every(p=>['command.accept','command.dispatch','command.inspect'].includes(p))
        || new Set(config.permissions).size!==config.permissions.length)
        throw new KernelError('INVALID_CONTROL_CONFIG','Invalid principal, token, session scope or permissions');
      const digest=hash(config.bearerToken);
      if(digests.has(digest.toString('hex')))
        throw new KernelError('INVALID_CONTROL_CONFIG','Duplicate credential is not allowed');
      ids.add(config.principalId);digests.add(digest.toString('hex'));
      principals.push({id:config.principalId,digest,sessions:new Set(config.sessionIds),
        permissions:new Set(config.permissions)});
    }
    this.principals=principals;
  }
  authorize(header:unknown,sessionId:string,permission:ControlPermission):string {
    // Don't tolerate comma-joined credentials, whitespace variants, or UTF-8
    // confusables. A malformed or missing header has the same public result.
    if(typeof header!=='string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(header))
      throw new KernelError('UNAUTHENTICATED','Bearer credential required');
    const secret=header.slice(7);
    if(!validToken(secret))throw new KernelError('UNAUTHENTICATED','Invalid bearer credential');
    const digest=hash(secret);
    let matched:Principal|undefined;
    // Every credential is compared in constant-time; no early-exit on matches.
    for(const candidate of this.principals){
      if(timingSafeEqual(digest,candidate.digest))matched=candidate;
    }
    if(!matched)throw new KernelError('UNAUTHENTICATED','Invalid bearer credential');
    if(!matched.sessions.has(sessionId) || !matched.permissions.has(permission))
      throw new KernelError('FORBIDDEN','Insufficient session scope or permission');
    return matched.id;
  }
}
