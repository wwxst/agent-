import {accessSync, constants, realpathSync, statSync, lstatSync, readlinkSync} from 'node:fs';
import {isAbsolute, relative, dirname} from 'node:path';
import {KernelError} from '../../contracts/src/index.js';

/**
 * Strict Linux-only namespace launch. This API is for TRUSTED host configuration,
 * never model input. No shell is involved; argv is passed directly to spawn().
 */
export interface LinuxBubblewrapSandbox {
  readonly binaryPath:string;
  /**
   * Explicit system library/runtime directories needed for Node dynamic linking.
   * No automatic bind of the host root, /home, /proc, /var, or /etc.
   */
  readonly runtimeReadOnlyDirectories:readonly string[];
}
export interface BubblewrapLaunch {
  readonly executable:string;
  readonly argv:readonly string[];
}
function fail():never{
  throw new KernelError('HOST_SANDBOX_UNAVAILABLE','Required Linux OS sandbox unavailable or misconfigured');
}
function realDirectory(path:string):string{
  if(typeof path!=='string'||!isAbsolute(path)||!path.trim())return fail();
  try{
    const actual=realpathSync(path);
    if(!statSync(actual).isDirectory()||actual==='/')return fail();
    return actual;
  }catch{return fail();}
}
function within(path:string,folder:string):boolean{
  const rel=relative(folder,path);
  return rel==='' || (!rel.startsWith('..')&&!isAbsolute(rel));
}
function disjoint(a:string,b:string):boolean{return !within(a,b)&&!within(b,a);}

/** No fallbacks: caller must have installed bwrap and enabled user namespaces. */
export function buildBubblewrapLaunch(
  sandbox:LinuxBubblewrapSandbox,
  databasePath:string,
  compiledRoot:string,
  workerPath:string,
  nodeBinary:string=process.execPath,
):BubblewrapLaunch{
  if(process.platform!=='linux')return fail();
  if(!sandbox||typeof sandbox.binaryPath!=='string'
    ||!isAbsolute(sandbox.binaryPath)||!Array.isArray(sandbox.runtimeReadOnlyDirectories)
    ||sandbox.runtimeReadOnlyDirectories.length<1||sandbox.runtimeReadOnlyDirectories.length>16)
    return fail();
  let binary:string,node:string,worker:string,db:string;
  try{
    binary=realpathSync(sandbox.binaryPath);
    node=realpathSync(nodeBinary);
    worker=realpathSync(workerPath);
    db=realpathSync(databasePath);
    accessSync(binary,constants.X_OK);
    accessSync(node,constants.X_OK);
    if(!statSync(binary).isFile()||!statSync(node).isFile()
      ||!statSync(worker).isFile()||!statSync(db).isFile())return fail();
  }catch{return fail();}
  const app=realDirectory(compiledRoot);
  const dbDir=realDirectory(dirname(db));
  if(!disjoint(app,dbDir))return fail();
  const runtime=sandbox.runtimeReadOnlyDirectories.map(realDirectory);
  // Never let a caller accidentally import host control files / devices,
  // procfs, sockets, user home or the temporary workspace into the worker.
  const sensitive=['/proc','/sys','/dev','/run','/tmp','/home','/root','/var','/etc'];
  if(runtime.some(path=>sensitive.some(secret=>!disjoint(path,secret))))return fail();
  if(!runtime.some(path=>within(node,path)))return fail();
  for(let i=0;i<runtime.length;i++){
    if(!disjoint(runtime[i]!,dbDir)||!disjoint(runtime[i]!,app)
      ||runtime.some((v,j)=>i!==j&&!disjoint(v,runtime[i]!)))return fail();
  }
  if(!within(worker,app))return fail();
  // Linux root is an empty private mount namespace. Only the explicit RO
  // runtime/code and dedicated RW SQLite directory are exposed to the child.
  const argv:string[]=[
    '--die-with-parent','--new-session','--unshare-all',
    // bwrap's "--unshare-all" may treat user namespaces as best-effort.
    // The explicit flag removes that fallback; unsupported hosts must fail.
    '--unshare-user','--cap-drop','ALL',
    '--clearenv','--setenv','AGENT_HOST_STDIO','1',
    '--setenv','HOME','/tmp','--setenv','TMPDIR','/tmp',
    '--proc','/proc','--dev','/dev','--tmpfs','/tmp',
  ];
  for(const path of runtime)argv.push('--ro-bind',path,path);
  // On merged-/usr Linux distributions the ELF loader still references
  // /lib64 or /lib. Recreate ONLY system aliases whose targets are already
  // inside an explicitly allowlisted read-only mount (never expose /).
  for(const alias of ['/bin','/lib','/lib64','/sbin']){
    try{
      if(!lstatSync(alias).isSymbolicLink())continue;
      const target=realpathSync(alias);
      if(!runtime.some(root=>within(target,root)))continue;
      const raw=readlinkSync(alias);
      argv.push('--symlink',raw,alias);
    }catch{/* Missing optional compatibility alias. */}
  }
  argv.push('--ro-bind',app,app,'--bind',dbDir,dbDir,
    '--chdir',app,'--',node,worker,db);
  return {executable:binary,argv};
}
