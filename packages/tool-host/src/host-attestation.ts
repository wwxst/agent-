import {readFileSync,readlinkSync,realpathSync} from 'node:fs';
import {KernelError} from '../../contracts/src/index.js';

export type HostNamespace='mount'|'network'|'pid'|'user';
export type NamespaceEvidence=Readonly<Record<HostNamespace,string>>;
export interface KernelHostIdentity {
  readonly pid:number;
  readonly startTicks:string;
  readonly namespaces:NamespaceEvidence;
}
export interface AttestationRequest {
  readonly launcherPid:number;
  readonly workerPath:string;
  readonly nodePath:string;
  readonly databasePath:string;
  readonly claimedNamespaces:unknown;
}
const namespaces:{readonly [K in HostNamespace]:string}={
  mount:'mnt',network:'net',pid:'pid',user:'user',
};
function reject():never{
  throw new KernelError('HOST_IDENTITY_UNVERIFIED',
    'Cannot prove Tool Host worker process and namespace ancestry');
}
const path=(pid:number,suffix:string):string=>`/proc/${pid}/${suffix}`;
function proc(pid:number,suffix:string):string{
  if(!Number.isSafeInteger(pid)||pid<1)return reject();
  try{return readFileSync(path(pid,suffix),'utf8');}
  catch{return reject();}
}
function ns(pid:number):NamespaceEvidence{
  const result={} as Record<HostNamespace,string>;
  for(const [name,linux] of Object.entries(namespaces) as [HostNamespace,string][]){
    let value:string;
    try{value=readlinkSync(path(pid,'ns/'+linux));}
    catch{return reject();}
    if(!/^\w+:\[\d+\]$/.test(value))return reject();
    result[name]=value;
  }
  return result;
}
function startTicks(pid:number):string{
  const stat=proc(pid,'stat');
  // comm (field 2) may contain spaces and ')', so split after LAST ') '.
  const end=stat.lastIndexOf(') ');
  if(end<2)return reject();
  const fields=stat.slice(end+2).trim().split(/\s+/);
  // after comm: field 3 is index 0, starttime is field 22 -> index 19.
  const start=fields[19];
  if(!start||!/^\d+$/.test(start))return reject();
  return start;
}
function argv(pid:number):string[]{
  const raw=proc(pid,'cmdline');
  if(!raw.endsWith('\0')||raw.length>32768)return reject();
  return raw.slice(0,-1).split('\0');
}
function children(pid:number):number[]{
  const raw=proc(pid,`task/${pid}/children`).trim();
  if(!raw)return [];
  const parts=raw.split(/\s+/);
  if(parts.length>48)return reject();
  return parts.map(v=>{
    const n=Number(v);
    if(!/^[1-9][0-9]*$/.test(v)||!Number.isSafeInteger(n))return reject();
    return n;
  });
}
function equivalent(a:NamespaceEvidence,b:NamespaceEvidence):boolean{
  return (Object.keys(namespaces) as HostNamespace[]).every(k=>a[k]===b[k]);
}
export function validateClaimedNamespaces(value:unknown):NamespaceEvidence{
  if(!value||typeof value!=='object'||Array.isArray(value))return reject();
  const source=value as Record<string,unknown>;
  const result={} as Record<HostNamespace,string>;
  for(const key of Object.keys(namespaces) as HostNamespace[]){
    if(typeof source[key]!=='string'||!/^\w+:\[\d+\]$/.test(source[key] as string))
      return reject();
    result[key]=source[key] as string;
  }
  if(Object.keys(source).length!==4)return reject();
  return result;
}

/**
 * Parent reads /proc itself; a READY packet is only an untrusted hint.
 * Descendant ancestry, exact trusted Node executable/worker argv,
 * namespace inodes and PID incarnation are all verified against the kernel.
 * Fail if no worker or more than one matching worker is discovered.
 */
export function attestSandboxWorker(req:AttestationRequest):KernelHostIdentity{
  if(process.platform!=='linux')return reject();
  const claimed=validateClaimedNamespaces(req.claimedNamespaces);
  if(!Number.isSafeInteger(req.launcherPid)||req.launcherPid<1)return reject();
  let expectedNode:string,expectedWorker:string,expectedDatabase:string;
  try{
    expectedNode=realpathSync(req.nodePath);
    expectedWorker=realpathSync(req.workerPath);
    expectedDatabase=realpathSync(req.databasePath);
  }catch{return reject();}
  // The caller owns this ChildProcess PID; a reused PID is still protected by
  // child process lifetime + a later worker starttime recheck.
  const queue=[req.launcherPid],seen=new Set<number>();
  const matching:KernelHostIdentity[]=[];
  while(queue.length){
    const pid=queue.shift()!;
    if(seen.has(pid)||seen.size>=48)return reject();
    seen.add(pid);
    const line=argv(pid);
    let exe:string;
    try{exe=readlinkSync(path(pid,'exe'));}catch{return reject();}
    if(exe===expectedNode && line.length===3
       && line[1]===expectedWorker&&line[2]===expectedDatabase){
      matching.push({pid,startTicks:startTicks(pid),namespaces:ns(pid)});
    }
    if(matching.length>1)return reject();
    if(seen.size>=48 && queue.length)return reject();
    queue.push(...children(pid));
  }
  if(matching.length!==1)return reject();
  const worker=matching[0]!,parent=ns(process.pid);
  if(!equivalent(worker.namespaces,claimed))return reject();
  for(const name of Object.keys(namespaces) as HostNamespace[]){
    if(worker.namespaces[name]===parent[name])return reject();
  }
  return worker;
}

/** Protect every ToolCall against exit/PID reuse or post-READY namespace changes. */
export function assertWorkerIdentity(identity:KernelHostIdentity):void{
  if(!Number.isSafeInteger(identity.pid)||identity.pid<1)return reject();
  if(startTicks(identity.pid)!==identity.startTicks ||
    !equivalent(ns(identity.pid),identity.namespaces))return reject();
}
