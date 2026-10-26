import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {SQLiteEventStore} from '../packages/event-store-sqlite/src/index.js';
import {AgentKernel} from '../packages/kernel-core/src/index.js';
import {FakeProvider} from '../packages/model-providers/src/fake.js';
import {ToolRegistry} from '../packages/tool-scheduler/src/index.js';
import {ConflictError, type EventDraft, type ProviderEvent} from '../packages/contracts/src/index.js';

function temporary(): {path: string; cleanup(): void} {
  const dir=mkdtempSync(join(tmpdir(),'agent-kernel-m2-'));
  return {path:join(dir,'journal.db'),cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}
const sessionEvent: EventDraft = {type:'session.created',data:{}};
const done = (text='ok'): ProviderEvent => ({type:'message_complete',finishReason:'stop',message:{role:'assistant',text,toolCalls:[]}});

/** Disk reopening proves process-independent read, not true power-loss durability. */
test('M2 SQLite: session and model history survive close/reopen, with no tool replay',async()=>{
  const fs=temporary();
  try {
    const store=new SQLiteEventStore(fs.path);
    const kernel=new AgentKernel(store,new FakeProvider([[done('first')]]),new ToolRegistry());
    const s=await kernel.createSession('persistent');
    assert.equal((await kernel.runTurn(s,'hello','one')).status,'completed');
    const prior=await kernel.readEvents(s);
    store.close();
    const reopened=new SQLiteEventStore(fs.path);
    let calls=0;
    const provider={id:'after-reopen',async *stream(messages:readonly import('../packages/contracts/src/index.js').ContextMessage[]){
      calls++;assert.deepEqual(messages.map(x=>x.role),['user','assistant','user']);
      yield done('second');
    }};
    const resumed=new AgentKernel(reopened,provider,new ToolRegistry());
    assert.equal(await resumed.resumeSession(s),s);
    assert.equal((await resumed.runTurn(s,'follow up','two')).status,'completed');
    const events=await reopened.read(s);
    assert.equal(calls,1);
    assert.deepEqual(events.slice(0,prior.length),prior);
    assert.deepEqual(events.map(e=>e.seq),events.map((_,i)=>i+1));
    reopened.close();
  } finally { fs.cleanup(); }
});

test('M2 SQLite: cursor reads a stable monotone session sequence',async()=>{
  const fs=temporary();
  try{const store=new SQLiteEventStore(fs.path);
    await store.append('s',0,[sessionEvent]);
    await store.append('s',1,[{type:'user.message',turnId:'t',data:{text:'ok'}},{type:'turn.completed',turnId:'t',data:{}}]);
    assert.deepEqual((await store.read('s',1)).map(e=>e.seq),[2,3]);
    await assert.rejects(store.read('s',-1),{code:'INVALID_CURSOR'});
    store.close();
  }finally{fs.cleanup();}
});

test('M2 SQLite: two independent connections reject stale CAS append',async()=>{
  const fs=temporary();
  try{const a=new SQLiteEventStore(fs.path),b=new SQLiteEventStore(fs.path);
    await a.append('s',0,[sessionEvent]);
    await a.append('s',1,[{type:'user.message',data:{text:'from A'}}]);
    await assert.rejects(b.append('s',1,[{type:'user.message',data:{text:'from B'}}]),ConflictError);
    assert.equal((await b.read('s')).length,2);
    a.close();b.close();
  }finally{fs.cleanup();}
});

test('M2 SQLite: mid-batch SQL failure rolls back every event and seq',async()=>{
  const fs=temporary();
  try{const store=new SQLiteEventStore(fs.path);
    await store.append('s',0,[sessionEvent]);
    const raw=new DatabaseSync(fs.path);
    raw.exec("CREATE TRIGGER fail_item BEFORE INSERT ON events WHEN NEW.type='turn.started' BEGIN SELECT RAISE(ABORT,'injected failure'); END;");
    await assert.rejects(store.append('s',1,[{type:'turn.queued',turnId:'t',data:{}},{type:'turn.started',turnId:'t',data:{}}]));
    assert.equal((await store.read('s')).length,1);
    raw.exec('DROP TRIGGER fail_item');raw.close();
    const committed=await store.append('s',1,[{type:'turn.queued',turnId:'t',data:{}}]);
    assert.equal(committed[0]?.seq,2);store.close();
  }finally{fs.cleanup();}
});

test('M2 SQLite: invalid first batch rolls back newly created session',async()=>{
  const fs=temporary();
  try{const store=new SQLiteEventStore(fs.path);
    await assert.rejects(store.append('s',0,[sessionEvent,sessionEvent]),{code:'INVALID_EVENT_WRITE'});
    assert.equal((await store.read('s')).length,0);
    assert.equal((await store.append('s',0,[sessionEvent]))[0]?.seq,1);
    store.close();
  }finally{fs.cleanup();}
});

test('M2 SQLite: command acceptance is atomically written once with related events',async()=>{
  const fs=temporary();
  try{const store=new SQLiteEventStore(fs.path);
    await store.append('s',0,[sessionEvent]);
    const r=await store.acceptCommand('s',1,'request-1','turn.start',{prompt:'hi'},[{type:'user.message',data:{text:'hi'}}]);
    assert.equal(r.replayed,false);assert.equal(r.acceptedSeq,2);assert.equal(r.lastSeq,3);
    const events=await store.read('s');
    assert.deepEqual(events.map(e=>e.type),['session.created','command.accepted','user.message']);
    assert.equal((events[1]?.data as {commandId:string}).commandId,'request-1');
    store.close();
  }finally{fs.cleanup();}
});

test('M2 SQLite: command replay after reopening returns original receipt without new events',async()=>{
  const fs=temporary();
  try{let store=new SQLiteEventStore(fs.path);
    await store.append('s',0,[sessionEvent]);
    const first=await store.acceptCommand('s',1,'id','turn.start',{obj:{a:1,b:2}});
    store.close();store=new SQLiteEventStore(fs.path);
    const second=await store.acceptCommand('s',1,'id','turn.start',{obj:{b:2,a:1}},[{type:'user.message',data:{text:'should not append'}}]);
    assert.deepEqual(second,{...first,replayed:true});
    assert.equal((await store.read('s')).length,2);
    store.close();
  }finally{fs.cleanup();}
});

test('M2 SQLite: same command ID with changed payload fails instead of executing twice',async()=>{
  const fs=temporary();
  try{const store=new SQLiteEventStore(fs.path);
    await store.append('s',0,[sessionEvent]);
    await store.acceptCommand('s',1,'id','turn.start',{prompt:'allowed'});
    await assert.rejects(store.acceptCommand('s',1,'id','turn.start',{prompt:'changed'}),ConflictError);
    assert.equal((await store.read('s')).length,2);store.close();
  }finally{fs.cleanup();}
});

test('M2 SQLite: a new command with stale expected sequence is rejected',async()=>{
  const fs=temporary();
  try{const store=new SQLiteEventStore(fs.path);
    await store.append('s',0,[sessionEvent]);
    await store.acceptCommand('s',1,'id','turn.start',{prompt:'ok'});
    await assert.rejects(store.acceptCommand('s',1,'next','turn.start',{prompt:'new'}),ConflictError);
    assert.equal((await store.read('s')).length,2);store.close();
  }finally{fs.cleanup();}
});

test('M2 SQLite: command journal and events both roll back on injected SQL error',async()=>{
  const fs=temporary();
  try{const store=new SQLiteEventStore(fs.path);
    await store.append('s',0,[sessionEvent]);
    const raw=new DatabaseSync(fs.path);
    raw.exec("CREATE TRIGGER fail_command BEFORE INSERT ON commands BEGIN SELECT RAISE(ABORT,'fail insert command'); END;");
    await assert.rejects(store.acceptCommand('s',1,'id','turn.start',{text:'hello'}));
    assert.equal((await store.read('s')).length,1);
    raw.exec('DROP TRIGGER fail_command');raw.close();
    assert.equal((await store.acceptCommand('s',1,'id','turn.start',{text:'hello'})).acceptedSeq,2);
    store.close();
  }finally{fs.cleanup();}
});

test('M2 SQLite: two writers replay one committed command rather than conflicting on old seq',async()=>{
  const fs=temporary();
  try{const a=new SQLiteEventStore(fs.path),b=new SQLiteEventStore(fs.path);
    await a.append('s',0,[sessionEvent]);
    const first=await a.acceptCommand('s',1,'same','input',{x:1});
    const replay=await b.acceptCommand('s',1,'same','input',{x:1});
    assert.equal(first.replayed,false);assert.equal(replay.replayed,true);
    assert.equal((await b.read('s')).length,2);
    a.close();b.close();
  }finally{fs.cleanup();}
});

test('M2 SQLite: event content rejects circular, unsupported and oversized inputs',async()=>{
  const fs=temporary();
  try{const store=new SQLiteEventStore(fs.path);
    await store.append('s',0,[sessionEvent]);
    const cycle:Record<string,unknown>={};cycle.self=cycle;
    for(const data of [cycle,{x:undefined},{x:NaN},{date:new Date()},'a'.repeat(1024*1024+1)]) {
      await assert.rejects(store.append('s',1,[{type:'user.message',data}]));
    }
    assert.equal((await store.read('s')).length,1);store.close();
  }finally{fs.cleanup();}
});

test('M2 SQLite: injected corrupt JSON is detected rather than silently skipped',async()=>{
  const fs=temporary();
  try{const store=new SQLiteEventStore(fs.path);
    await store.append('s',0,[sessionEvent]);
    const raw=new DatabaseSync(fs.path);
    raw.prepare('UPDATE events SET data_json=? WHERE session_id=?').run('{','s');raw.close();
    await assert.rejects(store.read('s'),{code:'CORRUPT_SESSION_JOURNAL'});
    store.close();
  }finally{fs.cleanup();}
});

test('M2 SQLite: a durable accepted command outside Turn is valid for safe resume',async()=>{
  const fs=temporary();
  try{const s=new SQLiteEventStore(fs.path);
    await s.append('s',0,[sessionEvent]);
    await s.acceptCommand('s',1,'cmd','noop',{foo:'bar'});
    s.close();
    const reopened=new SQLiteEventStore(fs.path);
    const kernel=new AgentKernel(reopened,new FakeProvider([[done()]]),new ToolRegistry());
    assert.equal(await kernel.resumeSession('s'),'s');
    assert.equal((await kernel.runTurn('s','question')).status,'completed');
    reopened.close();
  }finally{fs.cleanup();}
});

test('M2 SQLite: cannot append first non-session event or resurrect closed store',async()=>{
  const fs=temporary();
  try{const store=new SQLiteEventStore(fs.path);
    await assert.rejects(store.append('s',0,[{type:'turn.started',data:{}}]),ConflictError);
    store.close();store.close();
    await assert.rejects(store.read('s'),{code:'STORE_CLOSED'});
  }finally{fs.cleanup();}
});

test('M2 SQLite: committed command survives writer SIGKILL after ACK, with no duplicate commit', {skip:process.platform === 'win32'}, async()=>{
  const {spawn} = await import('node:child_process');
  const fs=temporary();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const childCode = `
      import {SQLiteEventStore} from './dist/packages/event-store-sqlite/src/index.js';
      const journal = new SQLiteEventStore(process.env.M2_TEST_DB);
      await journal.append('crash',0,[{type:'session.created',data:{}}]);
      await journal.acceptCommand('crash',1,'client-req','turn.start',{question:'hello'});
      process.stdout.write('COMMITTED\\n');
      setInterval(() => {}, 2000);
    `;
    child=spawn(process.execPath,['--input-type=module','-e',childCode],{
      cwd:process.cwd(),env:{...process.env,M2_TEST_DB:fs.path},stdio:['ignore','pipe','pipe'],
    });
    const activeChild=child;
    let stdout='';
    const committed= new Promise<void>((resolve,reject)=>{
      activeChild.stdout!.on('data',(b:Buffer)=>{ stdout+=b.toString(); if(stdout.includes('COMMITTED\n')) resolve(); });
      activeChild.on('error',reject);
      activeChild.on('exit',(code,signal)=>reject(new Error(`Child terminated before commit ACK: ${code}/${signal}`)));
    });
    let timeout:NodeJS.Timeout|undefined;
    await Promise.race([committed,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Child did not commit in time')),8000);})]);
    if(timeout)clearTimeout(timeout);
    assert.equal(activeChild.kill('SIGKILL'),true);
    await new Promise<void>(resolve=>activeChild.once('exit',()=>resolve()));
    const store=new SQLiteEventStore(fs.path);
    const all=await store.read('crash');
    assert.deepEqual(all.map(e=>e.type),['session.created','command.accepted']);
    const again=await store.acceptCommand('crash',1,'client-req','turn.start',{question:'hello'});
    assert.equal(again.replayed,true);
    assert.equal((await store.read('crash')).length,2);
    store.close();
  }finally{ if(child && child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');fs.cleanup(); }
});
