import {
  closeSync,constants,fsyncSync,mkdtempSync,openSync,rmdirSync,
  unlinkSync,writeSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {KernelError} from '../../contracts/src/index.js';

/**
 * Narrow Linux/x86-64 seccomp policy. It intentionally keeps clone, execve,
 * read, write, SQLite IO and libuv startup syscalls available. The worker
 * remains restricted to read.echo/read.sleep by its independent Host allowlist.
 */
export type HostSeccompPolicy='network-and-privilege-deny-v1';
const BPF_LD_W_ABS=0x20;
const BPF_JEQ_K=0x15;
const BPF_JSET_K=0x45;
const BPF_RET_K=0x06;
const AUDIT_ARCH_X86_64=0xc000003e;
const SECCOMP_RET_KILL_PROCESS=0x80000000;
const SECCOMP_RET_ALLOW=0x7fff0000;
const SECCOMP_RET_ERRNO_EPERM=0x00050001;

// Linux x86_64 syscall ABI only. NEVER apply numbers on an unknown
// architecture or silently use a weakened filter.
export const HOST_DENIED_SYSCALLS_X86_64=Object.freeze({
  socket:41,connect:42,accept:43,sendto:44,sendmsg:46,bind:49,
  listen:50,socketpair:53,recvmsg:47,accept4:288,
  recvmmsg:299,sendmmsg:307,
  ptrace:101,pivot_root:155,mount:165,umount2:166,
  reboot:169,init_module:175,delete_module:176,
  add_key:248,request_key:249,keyctl:250,
  unshare:272,perf_event_open:298,
  name_to_handle_at:303,open_by_handle_at:304,
  setns:308,process_vm_writev:311,finit_module:313,
  kexec_load:246,kexec_file_load:320,
  bpf:321,userfaultfd:323,
  io_uring_setup:425,io_uring_enter:426,io_uring_register:427,
});
interface FilterInstruction{
  readonly op:number;readonly jt:number;readonly jf:number;readonly value:number;
}
const ins=(op:number,jt:number,jf:number,value:number):FilterInstruction=>
  ({op,jt,jf,value});
export function seccompBpfInstructions():readonly FilterInstruction[]{
  const denied=[...new Set(Object.values(HOST_DENIED_SYSCALLS_X86_64))].sort((a,b)=>a-b);
  return [
    // struct seccomp_data.arch at offset 4; reject compat ABIs outright.
    ins(BPF_LD_W_ABS,0,0,4),
    ins(BPF_JEQ_K,1,0,AUDIT_ARCH_X86_64),
    ins(BPF_RET_K,0,0,SECCOMP_RET_KILL_PROCESS),
    // struct seccomp_data.nr at offset 0, prohibit x32 syscall-bit bypass.
    ins(BPF_LD_W_ABS,0,0,0),
    ins(BPF_JSET_K,0,1,0x40000000),
    ins(BPF_RET_K,0,0,SECCOMP_RET_KILL_PROCESS),
    ...denied.flatMap(value=>[
      ins(BPF_JEQ_K,0,1,value),
      ins(BPF_RET_K,0,0,SECCOMP_RET_ERRNO_EPERM),
    ]),
    ins(BPF_RET_K,0,0,SECCOMP_RET_ALLOW),
  ];
}
export function buildHostSeccompBpf(
  policy:HostSeccompPolicy='network-and-privilege-deny-v1',
):Buffer{
  if(process.platform!=='linux'||process.arch!=='x64'
    ||policy!=='network-and-privilege-deny-v1')
    throw new KernelError('HOST_SECCOMP_UNAVAILABLE',
      'Linux x86_64 verified seccomp profile required');
  const program=seccompBpfInstructions();
  if(program.length<10||program.length>=4096)
    throw new KernelError('HOST_SECCOMP_UNAVAILABLE','Invalid seccomp filter length');
  const output=Buffer.alloc(program.length*8);
  for(const [i,instruction] of program.entries()){
    const offset=i*8;
    output.writeUInt16LE(instruction.op,offset);
    output.writeUInt8(instruction.jt,offset+2);
    output.writeUInt8(instruction.jf,offset+3);
    output.writeUInt32LE(instruction.value>>>0,offset+4);
  }
  return output;
}

/**
 * Produce anonymous already-open filter fd. The path is unlinked BEFORE
 * spawn; child inherits descriptor 3, never a mutable pathname. The caller
 * MUST close fd immediately after spawn, including error cases.
 */
export function openHostSeccompFilter(
  policy:HostSeccompPolicy,
):number{
  const program=buildHostSeccompBpf(policy);
  let dir:string|undefined,file:string|undefined,fd:number|undefined;
  try{
    dir=mkdtempSync(join(tmpdir(),'kernel-seccomp-'));
    file=join(dir,'filter.bpf');
    fd=openSync(file,constants.O_CREAT|constants.O_EXCL|constants.O_RDWR,0o600);
    // Positioned write leaves inherited shared-file offset at ZERO for bwrap.
    const count=writeSync(fd,program,0,program.length,0);
    if(count!==program.length)throw Error('Short seccomp filter write');
    fsyncSync(fd);
    unlinkSync(file);file=undefined;
    rmdirSync(dir);dir=undefined;
    return fd;
  }catch{
    if(fd!==undefined)try{closeSync(fd);}catch{/* preserve fail-closed */}
    throw new KernelError('HOST_SECCOMP_UNAVAILABLE',
      'Could not securely initialize anonymous seccomp program');
  }finally{
    if(file)try{unlinkSync(file);}catch{/* cleanup best effort */}
    if(dir)try{rmdirSync(dir);}catch{/* cleanup best effort */}
  }
}
