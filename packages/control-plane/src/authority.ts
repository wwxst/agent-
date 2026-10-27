import {createHash, timingSafeEqual} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {ConflictError,KernelError} from '../../contracts/src/index.js';
import type {ControlPermission,ControlPrincipalConfig} from './auth.js';

type Decision='allowed'|'unauthenticated'|'forbidden';
type Action='authorize'|'recheck'|'bootstrap'|'rotate'|'revoke';
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const token=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{43}$/.test(v)
  &&Buffer.from(v,'base64url').length===32
  &&Buffer.from(v,'base64url').toString('base64url')===v;
const digest=(v:string)=>createHash('sha256').update(v,'utf8').digest('hex');
const permissions=['command.accept','command.dispatch','command.inspect'];
function validate(c:ControlPrincipalConfig):void {
  if(!id(c.principalId)||!token(c.bearerToken)
    ||!Array.isArray(c.sessionIds)||c.sessionIds.length<1||c.sessionIds.length>256
    ||!c.sessionIds.every(id)||new Set(c.sessionIds).size!==c.sessionIds.length
    ||!Array.isArray(c.permissions)||c.permissions.length<1||c.permissions.length>3
    ||!c.permissions.every(p=>permissions.includes(p))
    ||new Set(c.permissions).size!==c.permissions.length)
    throw new KernelError('INVALID_CONTROL_CONFIG','Invalid durable control principal configuration');
}
export interface AuthorityAuditRow {
  readonly seq:number;
  readonly action:Action;
  readonly decision:Decision;
  readonly principalId:string|null;
  readonly sessionId:string|null;
  readonly permission:string|null;
  readonly credentialVersion:number|null;
  readonly atMs:number;
}
/**
 * Created only by the trusted authenticated HTTP ingress. A grant is never
 * accepted from request JSON and is not a capability for calling an API.
 */
export interface RuntimeAuthorizationGrant {
  readonly principalId:string;
  readonly credentialVersion:number;
  readonly sessionId:string;
  readonly permission:ControlPermission;
}
export interface AuthorityCredential {
  readonly principalId:string;
  readonly version:number;
  readonly revoked:boolean;
  readonly sessionIds:readonly string[];
  readonly permissions:readonly ControlPermission[];
}

/**
 * Durable local authority. Only trusted application bootstrap/admin code may
 * call bootstrap/rotate/revoke; never expose those methods over bearer HTTP.
 * All request decisions (including denied credentials) are COMMITTED before
 * callers may invoke the runner. No request payload or token is ever audited.
 */
export class SqliteControlAuthority {
  private readonly db:DatabaseSync;
  constructor(path:string){
    if(typeof path!=='string'||!path.trim())throw new KernelError('INVALID_CONTROL_CONFIG','DB path required');
    this.db=new DatabaseSync(path,{timeout:5000});
    try{
      this.db.exec('PRAGMA journal_mode=WAL');
      this.db.exec('PRAGMA synchronous=FULL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS control_credentials(
          principal_id TEXT PRIMARY KEY,
          token_digest TEXT NOT NULL UNIQUE CHECK(length(token_digest)=64),
          session_ids_json TEXT NOT NULL,
          permissions_json TEXT NOT NULL,
          credential_version INTEGER NOT NULL CHECK(credential_version>0),
          revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN(0,1))
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS control_credential_history(
          token_digest TEXT PRIMARY KEY CHECK(length(token_digest)=64),
          principal_id TEXT NOT NULL
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS control_authorization_audit(
          audit_seq INTEGER PRIMARY KEY AUTOINCREMENT,
          action TEXT NOT NULL,
          decision TEXT NOT NULL,
          principal_id TEXT,
          session_id TEXT,
          permission TEXT,
          credential_version INTEGER,
          at_ms INTEGER NOT NULL
        );
      `);
    }catch(error){this.db.close();throw error;}
  }
  private transact<T>(fn:()=>T):T{
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const result=fn();
      this.db.exec('COMMIT');
      return result;
    }catch(error){
      if(this.db.isTransaction)this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private audit(action:Action,decision:Decision,principalId:string|null,
    sessionId:string|null,permission:string|null,version:number|null):void{
    this.db.prepare(`
      INSERT INTO control_authorization_audit
        (action,decision,principal_id,session_id,permission,credential_version,at_ms)
      VALUES(?,?,?,?,?,?,CAST(unixepoch('subsec')*1000 AS INTEGER))
    `).run(action,decision,principalId,sessionId,permission,version);
  }
  /**
   * One-time trusted out-of-band enrollment. Re-running against any enrolled
   * DB FAILS; it must not resurrect a revoked credential after restart.
   */
  bootstrap(configs:readonly ControlPrincipalConfig[]):void{
    if(!Array.isArray(configs)||configs.length===0||configs.length>128)
      throw new KernelError('INVALID_CONTROL_CONFIG','Invalid bootstrap principal count');
    const ids=new Set<string>(),secrets=new Set<string>();
    for(const config of configs){
      validate(config);
      const h=digest(config.bearerToken);
      if(ids.has(config.principalId)||secrets.has(h))
        throw new KernelError('INVALID_CONTROL_CONFIG','Duplicate principal or credential');
      ids.add(config.principalId);secrets.add(h);
    }
    this.transact(()=>{
      const previous=this.db.prepare('SELECT COUNT(*) AS n FROM control_credential_history').get();
      if(Number(previous?.n)!==0)throw new KernelError('AUTHORITY_ALREADY_BOOTSTRAPPED','Existing trust root must not be overwritten');
      const insert=this.db.prepare(`
        INSERT INTO control_credentials(principal_id,token_digest,session_ids_json,permissions_json,credential_version,revoked)
        VALUES(?,?,?,?,1,0)`);
      const history=this.db.prepare('INSERT INTO control_credential_history(token_digest,principal_id) VALUES(?,?)');
      for(const config of configs){
        const h=digest(config.bearerToken);
        insert.run(config.principalId,h,JSON.stringify([...config.sessionIds]),
          JSON.stringify([...config.permissions]));
        history.run(h,config.principalId);
        this.audit('bootstrap','allowed',config.principalId,null,null,1);
      }
    });
  }
  /**
   * Auth is checked against current committed DB rows, never a stale in-memory
   * key list. Both allowed and denied decisions must durably commit; failure to
   * write audit means NO authorization.
   */
  authorize(header:unknown,sessionId:string,permission:ControlPermission):string {
    return this.authorizeGrant(header,sessionId,permission).principalId;
  }
  authorizeGrant(header:unknown,sessionId:string,permission:ControlPermission):RuntimeAuthorizationGrant{
    if(!id(sessionId)||!permissions.includes(permission))
      throw new KernelError('INVALID_CONTROL_CONFIG','Unrecognized operation or session ID');
    const candidate=typeof header==='string' && /^Bearer [A-Za-z0-9_-]{43}$/.test(header)
      &&token(header.slice(7))?digest(header.slice(7)):null;
    const decision=this.transact(()=>{
      const rows=this.db.prepare(`
        SELECT principal_id,token_digest,session_ids_json,permissions_json,credential_version,revoked
        FROM control_credentials ORDER BY principal_id
      `).all();
      let matched:(typeof rows)[number]|undefined;
      if(candidate){
        const input=Buffer.from(candidate,'hex');
        for(const row of rows){
          const saved=row.token_digest;
          if(typeof saved!=='string'||!/^[a-f0-9]{64}$/.test(saved))
            throw new KernelError('CORRUPT_AUTHORITY','Credential digest corrupted');
          if(timingSafeEqual(input,Buffer.from(saved,'hex')))matched=row;
        }
      }
      const pid=(matched?.principal_id as string|undefined)??null;
      const version=(matched?.credential_version as number|undefined)??null;
      let outcome:Decision='unauthenticated';
      if(matched && matched.revoked===0){
        const sessions=JSON.parse(matched.session_ids_json as string) as unknown;
        const allowed=JSON.parse(matched.permissions_json as string) as unknown;
        if(!Array.isArray(sessions)||!Array.isArray(allowed)
          ||!sessions.every(id)||!allowed.every(p=>permissions.includes(p)))
          throw new KernelError('CORRUPT_AUTHORITY','Authority scope malformed');
        outcome=sessions.includes(sessionId) && allowed.includes(permission)?'allowed':'forbidden';
      }
      this.audit('authorize',outcome,pid,sessionId,permission,version);
      return {outcome,principalId:pid,version};
    });
    if(decision.outcome==='unauthenticated')
      throw new KernelError('UNAUTHENTICATED','Bearer credential not active');
    if(decision.outcome==='forbidden')
      throw new KernelError('FORBIDDEN','Credential lacks scope');
    return {principalId:decision.principalId!,credentialVersion:decision.version!,
      sessionId,permission};
  }
  /**
   * Recheck the *same* committed credential version for a previously authorized
   * Turn. Each check is a transactionally recorded decision, fail-closed on
   * storage errors. No reauthentication using a bearer token is performed.
   */
  assertGrant(grant:Readonly<RuntimeAuthorizationGrant>):void{
    if(!id(grant.principalId)||!id(grant.sessionId)
      ||!permissions.includes(grant.permission)
      ||!Number.isSafeInteger(grant.credentialVersion)||grant.credentialVersion<1)
      throw new KernelError('INVALID_CONTROL_CONFIG','Malformed internal authorization grant');
    const allowed=this.transact(()=>{
      const row=this.db.prepare(`
        SELECT credential_version,revoked,session_ids_json,permissions_json
        FROM control_credentials WHERE principal_id=?
      `).get(grant.principalId);
      let permitted=false;
      if(row){
        const sessions=JSON.parse(row.session_ids_json as string) as unknown;
        const allowedPermissions=JSON.parse(row.permissions_json as string) as unknown;
        if(!Array.isArray(sessions)||!Array.isArray(allowedPermissions)
          ||!sessions.every(id)||!allowedPermissions.every(p=>permissions.includes(p)))
          throw new KernelError('CORRUPT_AUTHORITY','Authority scope malformed');
        permitted=row.revoked===0&&row.credential_version===grant.credentialVersion
          &&sessions.includes(grant.sessionId)
          &&allowedPermissions.includes(grant.permission);
      }
      this.audit('recheck',permitted?'allowed':'forbidden',grant.principalId,
        grant.sessionId,grant.permission,grant.credentialVersion);
      return permitted;
    });
    if(!allowed)throw new KernelError('AUTHORIZATION_REVOKED','Execution authorization has changed');
  }
  /**
   * Trusted local admin only. Rotation retains exact existing scopes.
   * Old token and even previously revoked/historical tokens are never reusable.
   */
  rotate(principalId:string,expectedVersion:number,newToken:string):AuthorityCredential{
    if(!id(principalId)||!Number.isSafeInteger(expectedVersion)||expectedVersion<1||!token(newToken))
      throw new KernelError('INVALID_CONTROL_CONFIG','Invalid rotation arguments');
    return this.transact(()=>{
      const row=this.db.prepare('SELECT * FROM control_credentials WHERE principal_id=?').get(principalId);
      if(!row||row.revoked!==0)throw new KernelError('CREDENTIAL_REVOKED','Credential unavailable');
      if(row.credential_version!==expectedVersion)throw new ConflictError('Stale credential revision');
      const h=digest(newToken);
      if(this.db.prepare('SELECT 1 FROM control_credential_history WHERE token_digest=?').get(h))
        throw new KernelError('TOKEN_REUSE_FORBIDDEN','Historical credentials cannot be reused');
      const next=expectedVersion+1;
      if(!Number.isSafeInteger(next))throw new KernelError('CREDENTIAL_VERSION_EXHAUSTED','Version overflow');
      this.db.prepare('INSERT INTO control_credential_history(token_digest,principal_id) VALUES(?,?)').run(h,principalId);
      this.db.prepare('UPDATE control_credentials SET token_digest=?,credential_version=? WHERE principal_id=?')
        .run(h,next,principalId);
      this.audit('rotate','allowed',principalId,null,null,next);
      return {principalId,version:next,revoked:false,
        sessionIds:JSON.parse(row.session_ids_json as string) as string[],
        permissions:JSON.parse(row.permissions_json as string) as ControlPermission[]};
    });
  }
  /** Permanent for this principal ID: no reactivation or token reuse. */
  revoke(principalId:string,expectedVersion:number):AuthorityCredential {
    if(!id(principalId)||!Number.isSafeInteger(expectedVersion)||expectedVersion<1)
      throw new KernelError('INVALID_CONTROL_CONFIG','Invalid revocation arguments');
    return this.transact(()=>{
      const row=this.db.prepare('SELECT * FROM control_credentials WHERE principal_id=?').get(principalId);
      if(!row||row.revoked!==0)throw new KernelError('CREDENTIAL_REVOKED','Principal not active');
      if(row.credential_version!==expectedVersion)throw new ConflictError('Stale credential revision');
      const next=expectedVersion+1;
      if(!Number.isSafeInteger(next))throw new KernelError('CREDENTIAL_VERSION_EXHAUSTED','Version overflow');
      this.db.prepare('UPDATE control_credentials SET revoked=1,credential_version=? WHERE principal_id=?')
        .run(next,principalId);
      this.audit('revoke','allowed',principalId,null,null,next);
      return {principalId,version:next,revoked:true,
        sessionIds:JSON.parse(row.session_ids_json as string) as string[],
        permissions:JSON.parse(row.permissions_json as string) as ControlPermission[]};
    });
  }
  inspect(principalId:string):AuthorityCredential|undefined{
    if(!id(principalId))throw new KernelError('INVALID_CONTROL_CONFIG','Invalid principal ID');
    const row=this.db.prepare('SELECT * FROM control_credentials WHERE principal_id=?').get(principalId);
    if(!row)return undefined;
    return {principalId,version:row.credential_version as number,revoked:row.revoked===1,
      sessionIds:JSON.parse(row.session_ids_json as string) as string[],
      permissions:JSON.parse(row.permissions_json as string) as ControlPermission[]};
  }
  auditLog():readonly AuthorityAuditRow[]{
    return this.db.prepare(`
      SELECT audit_seq,action,decision,principal_id,session_id,permission,credential_version,at_ms
      FROM control_authorization_audit ORDER BY audit_seq
    `).all().map(row=>({
      seq:row.audit_seq as number,action:row.action as Action,decision:row.decision as Decision,
      principalId:row.principal_id as string|null,sessionId:row.session_id as string|null,
      permission:row.permission as string|null,credentialVersion:row.credential_version as number|null,
      atMs:row.at_ms as number,
    }));
  }
  close():void{this.db.close();}
}
