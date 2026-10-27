import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { KernelError, ConflictError } from '../../contracts/src/index.js';
import type { ManagedSessionRunner } from '../../session-runtime/src/index.js';
import { SqliteCommandDispatcher } from '../../command-dispatcher/src/index.js';
import { SqliteCommandInbox } from '../../command-inbox/src/index.js';
import { ControlKeyring, type ControlAuthorizer, type ControlPrincipalConfig, type ControlPermission } from './auth.js';
import { SqliteControlAuthority, type RuntimeAuthorizationGrant } from './authority.js';

const MAX_BODY = 70*1024;
const ROUTE=/^\/v1\/sessions\/([A-Za-z0-9_-]{1,128})\/commands(?:\/([A-Za-z0-9_-]{1,128})(\/dispatch)?)?$/;

export interface ControlServerOptions {
  readonly runner: ManagedSessionRunner;
  readonly databasePath: string;
  /** Legacy ephemeral keyring; mutually exclusive with durable authority. */
  readonly principals?: readonly ControlPrincipalConfig[];
  /** Explicitly seeded and managed out-of-band, persisted across restarts. */
  readonly authority?: ControlAuthorizer;
  /** 0 selects an ephemeral port. Always binds IPv4 loopback only. */
  readonly port?: number;
}
export interface RunningControlServer {
  readonly origin: string;
  close(): Promise<void>;
}
function send(res:ServerResponse,status:number,body:Record<string,unknown>):void{
  if(res.headersSent || res.destroyed)return;
  res.writeHead(status,{
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store',
    'Pragma':'no-cache',
    'X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'no-referrer',
    'Connection':'close',
  });
  res.end(JSON.stringify(body));
}
function fail(res:ServerResponse,error:unknown):void{
  // Never echo exception messages, payloads, SQL, tokens or provider errors.
  if(error instanceof ConflictError)return send(res,409,{error:'CONFLICT'});
  if(error instanceof KernelError){
    const code=error.code;
    if(code==='UNAUTHENTICATED')return send(res,401,{error:'UNAUTHENTICATED'});
    if(code==='FORBIDDEN')return send(res,403,{error:'FORBIDDEN'});
    if(code==='UNKNOWN_COMMAND')return send(res,404,{error:'UNKNOWN_COMMAND'});
    if(code==='SESSION_BUSY'||code==='RECOVERY_REQUIRED'||code==='LEASE_LOST'
      ||code==='AUTHORIZATION_REVOKED')
      return send(res,409,{error:code});
    if(code==='INVALID_HTTP_BODY'||code==='INVALID_DISPATCH_PAYLOAD'||code==='INVALID_COMMAND'
      ||code==='INVALID_COMMAND_PAYLOAD'||code==='COMMAND_TOO_LARGE'||code==='UNSUPPORTED_COMMAND')
      return send(res,400,{error:code});
  }
  send(res,500,{error:'INTERNAL_ERROR'});
}
function plain(v:unknown):v is Record<string,unknown>{
  return !!v && typeof v==='object' && !Array.isArray(v) && Object.getPrototypeOf(v)===Object.prototype;
}
async function body(req:IncomingMessage):Promise<unknown>{
  const length=req.headers['content-length'];
  if(typeof length==='string' && (/[^0-9]/.test(length)||Number(length)>MAX_BODY))
    throw new KernelError('INVALID_HTTP_BODY','Oversize request body');
  if(req.headers['content-encoding'] && req.headers['content-encoding']!=='identity')
    throw new KernelError('INVALID_HTTP_BODY','Compressed requests unsupported');
  if(req.headers['content-type']!=='application/json')
    throw new KernelError('INVALID_HTTP_BODY','application/json required');
  let size=0;
  const chunks:Buffer[]=[];
  for await(const block of req){
    const buffer=Buffer.isBuffer(block)?block:Buffer.from(block as Uint8Array);
    size+=buffer.byteLength;
    if(size>MAX_BODY)throw new KernelError('INVALID_HTTP_BODY','Oversize request body');
    chunks.push(buffer);
  }
  if(size===0)throw new KernelError('INVALID_HTTP_BODY','Body required');
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;}
  catch{throw new KernelError('INVALID_HTTP_BODY','Malformed JSON body');}
}
function commandRequest(v:unknown):{expectedSeq:number;commandId:string;payload:{text:string}}{
  if(!plain(v) || Object.keys(v).sort().join(',')!=='commandId,expectedSeq,kind,payload'
    ||v.kind!=='turn.run' ||!Number.isSafeInteger(v.expectedSeq)
    ||(v.expectedSeq as number)<1
    ||typeof v.commandId!=='string' ||!/^[A-Za-z0-9_-]{1,128}$/.test(v.commandId)
    ||!plain(v.payload) ||Object.keys(v.payload).join(',')!=='text'
    ||typeof v.payload.text!=='string' ||!v.payload.text.trim() ||v.payload.text.length>32768)
    throw new KernelError('INVALID_HTTP_BODY','Expected turn.run command');
  return {expectedSeq:v.expectedSeq as number,commandId:v.commandId,payload:{text:v.payload.text}};
}
function safeDispatch(v: {sessionId:string;commandId:string;turnId:string;acceptedSeq:number;
  boundSeq:number;replayed:boolean;status:string}) {
  // Never serialize .text from the persisted binding or the model response.
  return {sessionId:v.sessionId,commandId:v.commandId,turnId:v.turnId,
    acceptedSeq:v.acceptedSeq,boundSeq:v.boundSeq,replayed:v.replayed,status:v.status};
}

/**
 * Opt-in HTTP adapter for trusted LOOPBACK clients; no remote binding, TLS,
 * CORS, cookies, tokens in URLs or automatic tool execution on a GET request.
 * Credentials grant only the explicitly scoped control-plane operation.
 */
export async function startLoopbackControlServer(options:ControlServerOptions):Promise<RunningControlServer>{
  if(!options.databasePath.trim())throw new KernelError('INVALID_CONTROL_CONFIG','Database path required');
  const port=options.port??0;
  if(!Number.isInteger(port)||port<0||port>65535)
    throw new KernelError('INVALID_CONTROL_CONFIG','Invalid loopback port');
  if((options.principals===undefined)===(options.authority===undefined))
    throw new KernelError('INVALID_CONTROL_CONFIG','Choose either principals or authority, not both');
  const auth:ControlAuthorizer=options.authority??new ControlKeyring(options.principals!);
  // Schema bootstrap happens exactly once before listening, never in GET.
  const bootstrapInbox=new SqliteCommandInbox(options.databasePath);
  try {
    const bootstrapDispatcher=new SqliteCommandDispatcher(options.databasePath);
    bootstrapDispatcher.close();
  } finally { bootstrapInbox.close(); }
  let boundPort=0;
  const server=createServer((req,res)=>{
    void (async()=>{
      if(req.headers.host!==`127.0.0.1:${boundPort}` || req.headers.origin!==undefined
        ||req.headers['access-control-request-method']!==undefined)
        return send(res,400,{error:'INVALID_REQUEST'});
      const parts=(req.url??'').match(ROUTE);
      if(!parts)return send(res,404,{error:'NOT_FOUND'});
      const sessionId=parts[1]!,commandId=parts[2],dispatch=parts[3];
      let permission:ControlPermission;
      if(req.method==='POST' && !commandId)permission='command.accept';
      else if(req.method==='POST' && commandId && dispatch)permission='command.dispatch';
      else if(req.method==='GET' && commandId && !dispatch)permission='command.inspect';
      else return send(res,405,{error:'METHOD_NOT_ALLOWED'});
      const authHeaders=req.rawHeaders.filter((value,i)=>i%2===0 && value.toLowerCase()==='authorization');
      // In durable mode even an invalid header attempt is audited before
      // an application operation can be reached; never expose a raw secret.
      if(authHeaders.length!==1){
        auth.authorize(null,sessionId,permission);
        throw new KernelError('UNAUTHENTICATED','Exactly one credential required');
      }
      // Durable mode captures a *version-bound* admission proof in the SAME
      // transaction as the credential decision, never from request JSON.
      let grant:RuntimeAuthorizationGrant|undefined;
      if(auth instanceof SqliteControlAuthority && permission==='command.dispatch')
        grant=auth.authorizeGrant(req.headers.authorization,sessionId,permission);
      else auth.authorize(req.headers.authorization,sessionId,permission);

      if(req.method==='GET'){
        if(req.headers['content-length'] || req.headers['transfer-encoding'])
          throw new KernelError('INVALID_HTTP_BODY','GET cannot carry a request body');
        const dispatcher=new SqliteCommandDispatcher(options.databasePath,{readOnly:true});
        try{
          const found=dispatcher.inspect(sessionId,commandId!);
          if(found)return send(res,200,{dispatch:safeDispatch(found)});
        }finally{dispatcher.close();}
        const inbox=new SqliteCommandInbox(options.databasePath,{readOnly:true});
        try{
          const accepted=inbox.inspectAccepted(sessionId,commandId!);
          if(accepted)return send(res,200,{command:{
            commandId:accepted.commandId,acceptedSeq:accepted.acceptedSeq,status:'accepted',
          }});
        }finally{inbox.close();}
        return send(res,404,{error:'UNKNOWN_COMMAND'});
      }
      if(commandId && dispatch){
        // POST dispatch deliberately has no body and returns status only.
        if(req.headers['content-length'] && req.headers['content-length']!=='0'
          ||req.headers['transfer-encoding'])throw new KernelError('INVALID_HTTP_BODY','Dispatch accepts no body');
        const dispatchGrant=grant;
        const result=await options.runner.dispatchCommand(sessionId,commandId,
          dispatchGrant&&auth instanceof SqliteControlAuthority
            ? ()=>auth.assertGrant(dispatchGrant) : undefined);
        return send(res,200,{dispatch:safeDispatch(result.dispatch)});
      }
      const data=commandRequest(await body(req));
      const accepted=await options.runner.acceptCommand(sessionId,data.expectedSeq,
        data.commandId,'turn.run',data.payload);
      return send(res,200,{command:{sessionId:accepted.sessionId,commandId:accepted.commandId,
        acceptedSeq:accepted.acceptedSeq,replayed:accepted.replayed,status:'accepted'}});
    })().catch(error=>fail(res,error));
  });
  server.headersTimeout=10000;
  server.requestTimeout=15000;
  server.keepAliveTimeout=1000;
  try{
    await new Promise<void>((resolve,reject)=>{
      server.once('error',reject);
      server.listen(port,'127.0.0.1',()=>{
        server.off('error',reject);
        const address=server.address();
        if(!address || typeof address==='string'){
          reject(new KernelError('INVALID_CONTROL_CONFIG','Loopback listen failed'));
          return;
        }
        boundPort=address.port;
        resolve();
      });
    });
  }catch(error){server.close();throw error;}
  return {origin:`http://127.0.0.1:${boundPort}`,close:()=>new Promise<void>((resolve,reject)=>{
    server.close(e=>e?reject(e):resolve());
    server.closeAllConnections();
  })};
}
