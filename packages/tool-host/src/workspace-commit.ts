import {randomUUID} from 'node:crypto';
import {type Stats, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync,
  readSync, realpathSync, renameSync, statSync, unlinkSync,
  writeFileSync} from 'node:fs';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {KernelError} from '../../contracts/src/index.js';
import type {HostCall} from './ledger.js';
import {HostExecutionLedger} from './ledger.js';
import {validateWorkspacePatch,previewWorkspacePatch} from './workspace-patch.js';
import type {WorkspacePatchPreview} from './workspace-patch.js';

/**
 * Trusted-only, Linux-specific conditional file commit prototype.
 *
 * Not a model tool; no arbitrary shell/test runner; never call from an
 * untrusted extension. Assumes an exclusively owned Workspace with no
 * concurrent hostile filesystem mutator. Node path operations cannot supply
 * openat2/renameat2 fencing against adversarial parent-directory races.
 *
 * HostExecutionLedger binds a durable tool.intent before mutation; every
 * failure AFTER STARTED remains outcome_unknown until reconciliation.
 * Kernel tool.receipt emission is intentionally a separate caller duty.
 */
export interface WorkspaceCommitReceipt {
  readonly callId:string;
  readonly path:string;
  readonly baseSha256:string;
  readonly candidateSha256:string;
}
export type WorkspaceCommitAuthorization=(call:HostCall)=>void;
const MAX_FILE_BYTES=256*1024;
function fail(code:string,msg:string):never {throw new KernelError(code,msg);}
function inside(root:string,target:string):boolean{
  const rel=relative(root,target);
  return rel!==''&&!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel);
}
function mustRegular(path:string):Stats{
  const s=lstatSync(path) as Stats;
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)
    fail('WORKSPACE_UNSAFE_FILE','Refuse symlink, special file or hardlinked inode');
  if(typeof process.getuid==='function' && s.uid!==process.getuid())
    fail('WORKSPACE_UNSAFE_FILE','Workspace file is not owned by the trusted controller');
  if((s.mode & 0o7000)!==0)
    fail('WORKSPACE_UNSAFE_FILE','Special mode bits are not preserved');
  if(s.size>MAX_FILE_BYTES)fail('WORKSPACE_PATCH_TOO_LARGE','Source too large');
  return s;
}
function checkedTarget(root:string,path:string):{file:string;parent:string}{
  const pieces=path.split('/');
  let curr=root;
  for(const part of pieces.slice(0,-1)){
    curr=join(curr,part);
    const d=lstatSync(curr);
    if(!d.isDirectory()||d.isSymbolicLink())
      fail('WORKSPACE_UNSAFE_PATH','Parent must be a real directory');
  }
  const file=resolve(root,...pieces);
  const parent=dirname(file);
  if(!inside(root,file)||realpathSync(parent)!==parent)
    fail('WORKSPACE_UNSAFE_PATH','Resolved target is outside workspace');
  return {file,parent};
}
function readVersion(file:string):{text:string;stamp:Stats}{
  const before=mustRegular(file);
  const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const stamp=fstatSync(fd) as Stats;
    if(!stamp.isFile()||stamp.nlink!==1||stamp.dev!==before.dev||stamp.ino!==before.ino)
      fail('WORKSPACE_UNSAFE_FILE','Target changed between path and handle inspection');
    const b=Buffer.allocUnsafe(MAX_FILE_BYTES+1);
    const n=readSync(fd,b,0,b.length,0);
    if(n>MAX_FILE_BYTES)fail('WORKSPACE_PATCH_TOO_LARGE','Source too large');
    const after=fstatSync(fd) as Stats;
    if(after.dev!==stamp.dev||after.ino!==stamp.ino||after.size!==n
      ||after.mtimeMs!==stamp.mtimeMs)
      fail('WORKSPACE_UNSAFE_FILE','File changed while being read');
    const decoder=new TextDecoder('utf-8',{fatal:true});
    let text:string;
    try{text=decoder.decode(b.subarray(0,n));}
    catch{return fail('WORKSPACE_UNSAFE_FILE','Only valid UTF-8 files can be patched');}
    return {text,stamp};
  }finally{closeSync(fd);}
}
function sameIdentity(a:Stats,b:Stats):boolean{
  return a.dev===b.dev&&a.ino===b.ino&&a.mode===b.mode&&a.uid===b.uid
    &&a.gid===b.gid&&a.nlink===b.nlink;
}
function syncDirectory(dir:string):void{
  const fd=openSync(dir,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{fsyncSync(fd);}finally{closeSync(fd);}
}
export class TrustedWorkspaceCommitController {
  private readonly root:string;
  private readonly ledger:HostExecutionLedger;
  constructor(databasePath:string,workspaceRoot:string,
    private readonly authorize:WorkspaceCommitAuthorization){
    if(process.platform!=='linux')
      fail('WORKSPACE_PLATFORM_UNSUPPORTED','Trusted commit prototype currently requires Linux');
    if(typeof authorize!=='function')
      fail('WORKSPACE_AUTH_REQUIRED','A trusted authorization callback is mandatory');
    const root=realpathSync(workspaceRoot);
    if(!isAbsolute(root)||!statSync(root).isDirectory())
      fail('WORKSPACE_INVALID_ROOT','Workspace must be an existing directory');
    const db=realpathSync(databasePath);
    if(db===root||inside(root,db))
      fail('WORKSPACE_INVALID_ROOT','Host database and workspace must be separate trust roots');
    this.root=root;
    this.ledger=new HostExecutionLedger(databasePath);
  }
  close():void {this.ledger.close();}
  inspect(sessionId:string){return this.ledger.inspect(sessionId);}

  /**
   * Preview a version-pinned patch without durable admission or filesystem mutation.
   * This is a trusted review operation, not permission to commit.
   */
  preview(input:unknown):WorkspacePatchPreview{
    const patch=validateWorkspacePatch(input);
    const {file}=checkedTarget(this.root,patch.path);
    return previewWorkspacePatch(readVersion(file).text,patch);
  }
  /**
   * Call only after a trusted coordinator has persisted a matching assistant
   * message and exactly one tool.intent under the same fenced WriterLease.
   *
   * A crash after atomic rename but before ledger.finish leaves STARTED;
   * duplicates are denied and must be reconciled externally.
   */
  commit(call:HostCall,signal:AbortSignal):WorkspaceCommitReceipt{
    if(call.name!=='workspace.patch')fail('WORKSPACE_TOOL_DENIED','Only workspace.patch is accepted');
    if(signal.aborted)fail('WORKSPACE_CANCELLED','Cancelled before commit admission');
    const patch=validateWorkspacePatch(call.input);
    this.authorize(call);
    const {file,parent}=checkedTarget(this.root,patch.path);
    const initial=readVersion(file);
    const preview=previewWorkspacePatch(initial.text,patch);
    // Persistent intent and live lease are both checked in the same BEGIN
    // IMMEDIATE transaction BEFORE any mutating syscall.
    this.ledger.begin(call);
    let temporary:string|undefined;
    try{
      if(signal.aborted)fail('WORKSPACE_CANCELLED','Cancelled after durable STARTED');
      const fresh=readVersion(file);
      if(!sameIdentity(initial.stamp,fresh.stamp)||fresh.text!==initial.text)
        fail('WORKSPACE_PATCH_STALE_BASE','Target changed before applying patch');
      this.authorize(call);
      const name='.'+basename(file)+'.agent-'+randomUUID()+'.tmp';
      temporary=join(parent,name);
      const fd=openSync(temporary,
        constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
      try{
        writeFileSync(fd,preview.candidate,'utf8');
        fchmodSync(fd,initial.stamp.mode&0o777);
        fsyncSync(fd);
      }finally{closeSync(fd);}
      if(signal.aborted)fail('WORKSPACE_CANCELLED','Cancelled before atomic rename');
      const preRename=readVersion(file);
      if(!sameIdentity(initial.stamp,preRename.stamp)||preRename.text!==initial.text)
        fail('WORKSPACE_PATCH_STALE_BASE','Target changed before atomic rename');
      // Lease recheck + rename + Host receipt update are serialized under
      // the same short SQLite BEGIN IMMEDIATE critical section.
      this.ledger.finishSuccessWithEffect(call,preview.candidateSha256,()=>{
        this.authorize(call);
        renameSync(temporary!,file);
        temporary=undefined;
        syncDirectory(parent);
        // A revocation after mutation keeps STARTED and yields UNKNOWN.
        this.authorize(call);
      });
      return {
        callId:call.callId,path:patch.path,baseSha256:preview.baseSha256,
        candidateSha256:preview.candidateSha256,
      };
    }catch(err){
      // Intentionally no automatic failed receipt: a write may have happened,
      // e.g. rename succeeded but directory fsync or lease/finish failed.
      const reason=err instanceof Error?err.message:String(err);
      throw new KernelError('TOOL_OUTCOME_UNKNOWN',
        'Durable Workspace claim requires reconciliation: '+reason);
    }finally{
      if(temporary){try{unlinkSync(temporary);}catch{/* cleanup is best effort */}}
    }
  }
}
