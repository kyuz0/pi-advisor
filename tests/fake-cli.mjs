import { createInterface } from 'node:readline';
const mode = process.argv[2];
const emit = x => process.stdout.write(JSON.stringify(x)+'\n');
const answer = 'Use the numeric comparator. café';
const usage = {input_tokens:100,cached_input_tokens:20,cache_write_input_tokens:0,output_tokens:30,reasoning_output_tokens:10};
if (mode === 'quota') {
  createInterface({input:process.stdin}).on('line', line => {
    const e=JSON.parse(line);
    if(e.method==='initialize')emit({id:e.id,result:{}});
    else if(e.method==='initialized')return;
    else if(e.method==='account/read')emit({id:e.id,result:{account:{type:'chatgpt',email:'private@example.invalid'}}});
    else if(e.method==='account/rateLimits/read')emit({id:e.id,result:{rateLimits:{limitId:'codex',primary:{usedPercent:12,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+3600}}}});
    else {process.stderr.write('Unexpected RPC');process.exit(1);}
  });
} else if(mode==='hang') { process.stdin.resume(); emit({type:'thread.started',thread_id:'test-thread'}); setInterval(()=>{},1000); }
else {
 process.stdin.resume(); process.stdin.on('end',async()=>{
  if(mode==='oversize'){process.stdout.write('x'.repeat(100000));return;}
  emit({type:'thread.started',thread_id:'test-thread'});
  emit({type:'turn.started'});
  emit({type:'item.completed',item:{type:'error',message:'nonfatal warning'}});
  if(mode==='tool'){emit({type:'item.started',item:{type:'command_execution',command:'do not execute'}});setInterval(()=>{},1000);return;}
  const text=process.argv[3] ?? (mode==='bad-answer'?'not json':answer);
  const event=Buffer.from(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}})+'\n');
  if(mode==='no-message'){emit({type:'turn.completed',usage});return;}
  const split=event.indexOf(Buffer.from('é'))+1;
  process.stdout.write(event.subarray(0,split));await new Promise(r=>setTimeout(r,10));process.stdout.write(event.subarray(split));
  if(mode!=='no-terminal')emit({type:'turn.completed',usage});
  if(mode==='nonzero')process.exitCode=1;
 });
}
