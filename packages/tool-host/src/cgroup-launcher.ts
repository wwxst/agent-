import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,realpathSync,statfsSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {assertInheritedCgroupBudget,inspectCgroupV2From,
  readUnifiedCgroupPath,type CgroupBudget} from './enforced.js';

function run():never{
  // This is a trusted in-repo launcher, NOT a general-purpose command runner.
  // It has no shell, dynamic imports, inherited env or forwarded Node options.
  // Executable and argv are solely supplied by ProcessToolHost after
  // buildBubblewrapLaunch validated the trusted sandbox config.
  const [leaf,budgetJson,executable,...argv]=process.argv.slice(2);
  if(process.platform!=='linux'||!leaf||!budgetJson||!executable||argv.length===0
    ||!isAbsolute(executable))process.exit(77);
  const parent=readUnifiedCgroupPath(readFileSync('/proc/self/cgroup','utf8'));
  const relativeLeaf=readUnifiedCgroupPath('0::'+leaf);
  if(parent==='/' ? relativeLeaf==='/' : !relativeLeaf.startsWith(parent+'/'))
    process.exit(77);
  const budget=JSON.parse(budgetJson) as CgroupBudget;
  const root=realpathSync('/sys/fs/cgroup');
  if(statfsSync(root).type!==0x63677270)process.exit(77); // cgroup2fs
  const target=realpathSync(resolve(root,'.'+relativeLeaf));
  const rel=relative(root,target);
  if(rel.startsWith('..')||isAbsolute(rel))process.exit(77);

  // Important ordering: kernel move SELF BEFORE spawning ANY Bubblewrap or
  // worker executable. A permission error aborts with no worker execution.
  writeFileSync(resolve(target,'cgroup.procs'),String(process.pid));
  const now=readUnifiedCgroupPath(readFileSync('/proc/self/cgroup','utf8'));
  if(now!==relativeLeaf)process.exit(77);
  assertInheritedCgroupBudget(inspectCgroupV2From('0::/',target),budget);
  const child=spawn(executable,argv,{
    env:{},stdio:'inherit',
  });
  child.on('error',()=>{process.exitCode=77;});
  child.on('exit',(code,signal)=>{
    process.exitCode=signal?77:(code??77);
  });
  // The sandbox uses --die-with-parent. If the launcher is killed, bwrap
  // itself receives the parent-death signal, and controller cgroup.kill
  // is the final hard-stop for the entire dedicated group.
  return undefined as never;
}
try{run();}
catch{process.exit(77);}
