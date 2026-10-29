import {readFileSync,realpathSync,statSync,accessSync,constants,statfsSync} from 'node:fs';
import {relative,resolve,isAbsolute,dirname} from 'node:path';
import {KernelError} from '../../contracts/src/index.js';
import {ProcessToolHost} from './index.js';
import type {LinuxBubblewrapSandbox} from './sandbox.js';
import {buildHostSeccompBpf} from './seccomp.js';

/**
 * The two resource-gated deployment factories are security-boundary APIs,
 * unlike the deliberately backward-compatible ProcessToolHost constructor.
 * They must never accept an unfiltered Worker or a user-supplied internal
 * cgroup launch descriptor.
 */
export function assertEnforcedSandboxPolicy(sandbox:LinuxBubblewrapSandbox):void{
  if(!sandbox || sandbox.seccompPolicy!=='network-and-privilege-deny-v1')
    throw new KernelError('HOST_SECCOMP_UNAVAILABLE',
      'An explicit, verified seccomp profile is required by the enforced Tool Host');
  if(Object.prototype.hasOwnProperty.call(sandbox,'dedicatedCgroup'))
    throw new KernelError('HOST_INVALID_OPTIONS',
      'Dedicated cgroup launch metadata may only be created by the trusted factory');
  // Verify the Linux architecture and deterministic profile BEFORE probing
  // cgroup state or starting any process. There is no weaker fallback.
  buildHostSeccompBpf(sandbox.seccompPolicy);
}

export interface CgroupBudget {
  readonly maxMemoryBytes:number;
  readonly maxPids:number;
  /** CPU quota in millicores (1000 = one logical CPU). */
  readonly maxCpuMillicores:number;
}
export interface AttestedCgroupLimits {
  readonly relativePath:string;
  readonly memoryBytes:number;
  readonly pids:number;
  readonly cpuMillicores:number;
}
export interface EnforcedToolHostOptions {
  readonly databasePath:string;
  readonly sandbox:LinuxBubblewrapSandbox;
  /** The effective parent cgroup must already enforce limits no higher than these. */
  readonly requiredBudget:CgroupBudget;
  readonly timeoutMs?:number;
}
function unavailable(detail:string):never{
  throw new KernelError('HOST_CGROUP_UNAVAILABLE',detail);
}
function denied(detail:string):never{
  throw new KernelError('HOST_CGROUP_BUDGET_UNSATISFIED',detail);
}
function within(root:string,target:string):boolean{
  const rel=relative(root,target);
  return rel===''||(!rel.startsWith('..')&&!isAbsolute(rel));
}
export function readUnifiedCgroupPath(procText:string):string{
  const rows=procText.trim().split('\n').filter(s=>s.length>0);
  const groups=rows.filter(row=>row.startsWith('0::'));
  if(groups.length!==1)return unavailable('Missing or ambiguous unified cgroup membership');
  const path=groups[0]!.slice(3);
  const segments=path.slice(1).split('/');
  const invalidControl=[...path].some(ch=>{
    const code=ch.charCodeAt(0);
    return code===0 || code===10 || code===13;
  });
  if(!path.startsWith('/')||invalidControl
    ||(path!=='/'&&segments.some(part=>!part||part==='.'||part==='..')))
    return unavailable('Non-canonical cgroup membership path');
  return path;
}
function bound(content:string):number{
  const value=content.trim();
  if(value==='max')return Infinity;
  if(!/^(0|[1-9][0-9]*)$/.test(value))return unavailable('Malformed cgroup numeric limit');
  const result=Number(value);
  if(!Number.isSafeInteger(result)||result<1)return unavailable('Invalid cgroup numeric limit');
  return result;
}
function cpuLimit(text:string):number{
  const match=/^(max|[1-9][0-9]*) ([1-9][0-9]*)$/.exec(text.trim());
  if(!match)return unavailable('Malformed CPU quota');
  if(match[1]==='max')return Infinity;
  const quota=bound(match[1]!);
  const period=bound(match[2]!);
  const millicores=Math.ceil(quota*1000/period);
  if(!Number.isSafeInteger(millicores)||millicores<1)return unavailable('Invalid CPU quota ratio');
  return millicores;
}
function validateBudget(budget:CgroupBudget):void{
  if(!budget || !Number.isSafeInteger(budget.maxMemoryBytes)
    ||budget.maxMemoryBytes<16*1024*1024||budget.maxMemoryBytes>64*1024*1024*1024
    ||!Number.isSafeInteger(budget.maxPids)||budget.maxPids<1||budget.maxPids>4096
    ||!Number.isSafeInteger(budget.maxCpuMillicores)
    ||budget.maxCpuMillicores<10||budget.maxCpuMillicores>128000)
    denied('Invalid required cgroup budget');
}

/** Purely for integration/fault fixtures. Production always uses literal /proc and /sys. */
export function inspectCgroupV2From(procText:string,mountRoot:string):AttestedCgroupLimits{
  const relativePath=readUnifiedCgroupPath(procText);
  let root:string;
  try{
    root=realpathSync(mountRoot);
    if(!statSync(root).isDirectory())return unavailable('Cgroup mount is not a directory');
  }catch{return unavailable('Cgroup mount not accessible');}
  let location:string;
  try{
    location=realpathSync(resolve(root,'.'+relativePath));
    if(!within(root,location))return unavailable('Cgroup path escaped root');
    if(!statSync(location).isDirectory())return unavailable('Cgroup is not a directory');
  }catch{return unavailable('Active cgroup not mounted');}
  let memory=Infinity,pids=Infinity,cpu=Infinity;
  while(true){
    try{
      memory=Math.min(memory,bound(readFileSync(resolve(location,'memory.max'),'utf8')));
      pids=Math.min(pids,bound(readFileSync(resolve(location,'pids.max'),'utf8')));
      cpu=Math.min(cpu,cpuLimit(readFileSync(resolve(location,'cpu.max'),'utf8')));
    }catch(error){
      if(error instanceof KernelError)throw error;
      return unavailable('Mandatory cgroup v2 controllers inaccessible');
    }
    if(location===root)break;
    const next=dirname(location);
    if(!within(root,next)||next===location)return unavailable('Unbounded cgroup ancestor');
    location=next;
  }
  if(!Number.isFinite(memory)||!Number.isFinite(pids)||!Number.isFinite(cpu))
    return unavailable('Unbounded inherited memory, PID or CPU controller');
  return {relativePath,memoryBytes:memory,pids,cpuMillicores:cpu};
}

/**
 * Check that an already-enforced aggregate quota satisfies the trusted
 * deployment ceiling. This never creates or writes a cgroup; no "dry-run"
 * outcome authorizes a worker.
 */
export function assertInheritedCgroupBudget(limits:AttestedCgroupLimits,budget:CgroupBudget):void{
  validateBudget(budget);
  if(!limits || !Number.isSafeInteger(limits.memoryBytes)
    ||!Number.isSafeInteger(limits.pids)||!Number.isSafeInteger(limits.cpuMillicores)
    ||limits.memoryBytes<1||limits.pids<1||limits.cpuMillicores<1)
    denied('Missing trustworthy finite cgroup controller measurements');
  if(limits.memoryBytes>budget.maxMemoryBytes || limits.pids>budget.maxPids
    ||limits.cpuMillicores>budget.maxCpuMillicores)
    denied('Cgroup is not bounded by required aggregate limits');
}

/**
 * A trusted supervisor pre-creates an EMPTY LEAF cgroup with DIRECT finite
 * CPU/memory/PID ceilings. Never accept a parent/ancestor limit as a worker
 * budget, and never kill or overwrite a populated cgroup.
 */
export function assertDedicatedCgroupReady(
  parentRelativePath:string,leafRelativePath:string,budget:CgroupBudget,
  mountRoot:string='/sys/fs/cgroup',
):AttestedCgroupLimits {
  validateBudget(budget);
  const parent=readUnifiedCgroupPath('0::'+parentRelativePath);
  const leaf=readUnifiedCgroupPath('0::'+leafRelativePath);
  if(parent==='/' ? leaf==='/' : !leaf.startsWith(parent+'/'))
    denied('Worker must be in a distinct descendant of the controller cgroup');
  let root:string,leafDir:string;
  try {
    root=realpathSync(mountRoot);
    leafDir=realpathSync(resolve(root,'.'+leaf));
    if(!within(root,leafDir)||!statSync(leafDir).isDirectory())
      return unavailable('Worker cgroup escapes trusted root');
  }catch{return unavailable('Dedicated cgroup leaf unavailable');}
  // Only the leaf's OWN control files matter for a dedicated budget.
  const own=inspectCgroupV2From('0::/',leafDir);
  assertInheritedCgroupBudget(own,budget);
  try {
    const populated=readFileSync(resolve(leafDir,'cgroup.events'),'utf8');
    if(!/^populated 0$/m.test(populated))
      denied('Dedicated cgroup has existing processes or descendants');
    if(readFileSync(resolve(leafDir,'cgroup.procs'),'utf8').trim()!=='')
      denied('Dedicated cgroup is not empty');
    accessSync(resolve(leafDir,'cgroup.procs'),constants.W_OK);
    accessSync(resolve(leafDir,'cgroup.kill'),constants.W_OK);
  }catch(error){
    if(error instanceof KernelError)throw error;
    return unavailable('Cgroup migration or kill privilege not delegated');
  }
  return {...own,relativePath:leaf};
}

/**
 * Re-attest an already-started, kernel-identified Worker against its own
 * dedicated cgroup. This is NOT an admission check for an arbitrary PID:
 * ProcessToolHost first checks trusted process ancestry/starttime/namespaces.
 *
 * Tests may provide synthetic proc/cgroup roots. Production callers MUST use
 * the literal default Linux procfs and cgroup2fs mounts.
 */
export function assertDedicatedWorkerCgroup(
  workerPid:number,expectedLeaf:string,budget:CgroupBudget,
  mountRoot:string='/sys/fs/cgroup',procRoot:string='/proc',
):AttestedCgroupLimits{
  validateBudget(budget);
  if(!Number.isSafeInteger(workerPid)||workerPid<1)
    return unavailable('Verified Worker PID unavailable for cgroup validation');
  const leaf=readUnifiedCgroupPath('0::'+expectedLeaf);
  if(leaf==='/')return unavailable('Dedicated Worker cannot share root cgroup');
  let current:string;
  try{
    current=readUnifiedCgroupPath(readFileSync(
      resolve(procRoot,String(workerPid),'cgroup'),'utf8'));
  }catch(error){
    if(error instanceof KernelError)throw error;
    return unavailable('Cannot read verified Worker cgroup membership');
  }
  if(current!==leaf)
    denied('Verified Worker is not in its assigned dedicated cgroup');
  let root:string,leafDir:string;
  try{
    root=realpathSync(mountRoot);
    if(!statSync(root).isDirectory())return unavailable('Cgroup mount unavailable');
    // Only test fixtures can opt out of the production cgroup2fs check.
    if(mountRoot==='/sys/fs/cgroup' && statfsSync(root).type!==0x63677270)
      return unavailable('Verified cgroup2fs required');
    leafDir=realpathSync(resolve(root,'.'+leaf));
    if(!within(root,leafDir)||!statSync(leafDir).isDirectory())
      return unavailable('Verified Worker cgroup escaped mount');
  }catch{
    return unavailable('Verified Worker dedicated cgroup is inaccessible');
  }
  // Re-read the leaf's OWN limits: inherited ancestor quotas alone cannot
  // satisfy a dedicated Worker budget after Supervisor configuration drift.
  const direct=inspectCgroupV2From('0::/',leafDir);
  assertInheritedCgroupBudget(direct,budget);
  return {...direct,relativePath:leaf};
}

export interface DedicatedToolHostOptions extends EnforcedToolHostOptions {
  /** Pre-created EMPTY leaf strictly below this process's cgroup. */
  readonly dedicatedCgroupRelativePath:string;
}

/**
 * This entry never migrates the controller. A trusted in-repo launch helper
 * migrates ITSELF before starting bwrap. cgroup.kill ends the whole subtree.
 * No privileged cgroup setup is silently attempted.
 */
export async function startDedicatedToolHost(options:DedicatedToolHostOptions):Promise<{
  readonly host:ProcessToolHost;
  readonly limits:AttestedCgroupLimits;
}>{
  if(!options||!options.sandbox||!options.requiredBudget
    ||typeof options.databasePath!=='string'||!options.databasePath.trim()
    ||typeof options.dedicatedCgroupRelativePath!=='string')
    denied('Dedicated cgroup, sandbox and budget are mandatory');
  validateBudget(options.requiredBudget);
  assertEnforcedSandboxPolicy(options.sandbox);
  if(process.platform!=='linux')return unavailable('Linux-only dedicated Tool Host');
  const root='/sys/fs/cgroup';
  try{
    if(statfsSync(root).type!==0x63677270)return unavailable('Unified cgroup v2 filesystem required');
  }catch{return unavailable('Cgroup v2 filesystem inaccessible');}
  const parent=readUnifiedCgroupPath(readFileSync('/proc/self/cgroup','utf8'));
  const limits=assertDedicatedCgroupReady(parent,options.dedicatedCgroupRelativePath,
    options.requiredBudget);
  const sandbox:LinuxBubblewrapSandbox={...options.sandbox,
    dedicatedCgroup:{relativePath:limits.relativePath,budget:options.requiredBudget}};
  const host=new ProcessToolHost(options.databasePath,options.timeoutMs??4000,sandbox);
  try{
    await host.waitUntilReady();
    const pid=host.pid;
    if(!pid || !Number.isSafeInteger(pid))return unavailable('Host launcher PID unavailable');
    const current=readUnifiedCgroupPath(readFileSync('/proc/'+pid+'/cgroup','utf8'));
    if(current!==limits.relativePath)return unavailable('Dedicated launcher did not join the correct cgroup');
    const workerPid=host.verifiedWorkerPid;
    if(!workerPid)return unavailable('Verified Worker PID unavailable');
    // The launcher and the actual isolated Worker must BOTH be in this leaf;
    // a READY packet or a bounded launcher alone is not sufficient.
    assertDedicatedWorkerCgroup(workerPid,limits.relativePath,options.requiredBudget);
    return {host,limits};
  }catch(error){host.close();throw error;}
}

/** Read the CURRENT process's kernel-enforced aggregate cgroup quota. */
export function inspectCurrentCgroupV2():AttestedCgroupLimits{
  if(process.platform!=='linux')return unavailable('Linux cgroup v2 required');
  let procText:string;
  try{procText=readFileSync('/proc/self/cgroup','utf8');}
  catch{return unavailable('Cannot inspect cgroup membership');}
  return inspectCgroupV2From(procText,'/sys/fs/cgroup');
}

/**
 * Supported secure deployment entry: fail before creating a worker unless
 * the deployment has ALREADY placed this process in a bounded cgroup v2.
 * The launched Bubblewrap process INHERITS that same kernel quota. This is
 * an aggregate quota shared with the controller, NOT a dedicated worker cgroup.
 */
export async function startEnforcedToolHost(options:EnforcedToolHostOptions):Promise<{
  readonly host:ProcessToolHost;
  readonly limits:AttestedCgroupLimits;
}>{
  if(!options || !options.sandbox || !options.requiredBudget
    || typeof options.databasePath!=='string'||!options.databasePath.trim())
    denied('A Bubblewrap sandbox and cgroup budget are mandatory');
  validateBudget(options.requiredBudget);
  assertEnforcedSandboxPolicy(options.sandbox);
  const limits=inspectCurrentCgroupV2();
  assertInheritedCgroupBudget(limits,options.requiredBudget);
  const host=new ProcessToolHost(options.databasePath,options.timeoutMs??4000,options.sandbox);
  try{
    await host.waitUntilReady();
    const pid=host.pid;
    if(!pid || !Number.isSafeInteger(pid))return unavailable('Host launcher PID unavailable');
    const childPath=readUnifiedCgroupPath(readFileSync('/proc/'+pid+'/cgroup','utf8'));
    if(childPath!==limits.relativePath)return unavailable('Host launcher escaped parent cgroup');
    return {host,limits};
  }catch(error){host.close();throw error;}
}
