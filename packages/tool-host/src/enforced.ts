import {readFileSync,realpathSync,statSync} from 'node:fs';
import {relative,resolve,isAbsolute,dirname} from 'node:path';
import {KernelError} from '../../contracts/src/index.js';
import {ProcessToolHost} from './index.js';
import type {LinuxBubblewrapSandbox} from './sandbox.js';

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
  if(!path.startsWith('/')||path.includes('\${c}')||path.includes('\${c}')
    ||path.includes('\${c}')||(path!=='/'&&segments.some(part=>!part||part==='.'||part==='..')))
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
  const millicores=Math.floor(quota*1000/period);
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
