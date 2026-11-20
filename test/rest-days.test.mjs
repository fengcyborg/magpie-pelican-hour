import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Archive } from '../archive.mjs';
import { createScheduler } from '../monitor.mjs';
import { serveGallery } from '../gallery.mjs';
import { dayType, midnight, sampleMinutes, validRestSchedule } from '../rest-days.mjs';

// These fixtures describe mainland Chinese working dates in the Shanghai time zone.
process.env.TZ = 'Asia/Shanghai';
const beijing = value => Date.parse(value + '+08:00');
const quiet = {enabled:true, start:1320, end:420};
const even = {enabled:true, count:4, distribution:'even', times:[]};
const id = 'a'.repeat(20);
const account = {id, name:'测试账号', present:true, enabled:true};

test('national holidays, make-up Sundays, weekends and local midnight', () => {
  expect(dayType(beijing('2026-09-20T10:00')).label).toBe('调休补班日');
  expect(dayType(beijing('2027-02-05T00:00')).rest).toBe(true);
  expect(dayType(beijing('2027-02-14T00:00')).rest).toBe(false);
  expect(dayType(beijing('2026-11-20T23:59')).rest).toBe(false);
  expect(dayType(beijing('2026-11-21T00:00')).rest).toBe(true);
  expect(dayType(beijing('2028-01-01T08:00')).official).toBe(false);
});

test('stable, per-account stratified samples; both quiet window shapes', () => {
  const date = midnight(beijing('2026-11-21T17:00'));
  for (const q of [quiet, {enabled:true,start:570,end:780}, {enabled:false}]) {
    const allowed = Array.from({length:1440}, (_,i)=>i).filter(m=>!q.enabled ||
      (q.start>q.end ? m>=q.end && m<q.start : m<q.start || m>=q.end));
    const points = sampleMinutes(even,q,date,id);
    expect(points).toEqual(sampleMinutes(even,q,date,id));
    expect(points).not.toEqual(sampleMinutes(even,q,date,'b'.repeat(20)));
    points.forEach((m,i)=>{
      expect(allowed.indexOf(m)).toBeGreaterThanOrEqual(Math.floor(i*allowed.length/4));
      expect(allowed.indexOf(m)).toBeLessThan(Math.floor((i+1)*allowed.length/4));
    });
  }
  const fixed = times=>({...even,distribution:'custom',count:times.length,times});
  expect(validRestSchedule(fixed([420,660,1319]),quiet)).toBe(true);
  for(const invalid of [fixed([419,660]),fixed([1320]),fixed([570,570]),fixed([]),{...even,count:9}])
    expect(validRestSchedule(invalid,quiet)).toBe(false);
  expect(validRestSchedule(even,{enabled:true,start:721,end:720})).toBe(false);
});

test('dispatch, archive, restart and edit timing with two appointments in one hour', async () => {
  const root=mkdtempSync(join(tmpdir(),'pelican-sampling-'));
  let archive=new Archive(root), now=beijing('2026-11-20T22:10'), calls=0;
  const custom = times=>({enabled:true,count:times.length,distribution:'custom',times});
  const fake=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){
    calls++;return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',
      text:'<html><body><svg viewBox="0 0 1 1"></svg></body></html>'}]}]},
      {headers:{'x-magpie-provider':'codex','x-magpie-model':'codex/gpt-6.2-astra'}});
  }});
  const gateway={addr:'127.0.0.1:'+fake.port};
  const scheduler=()=>createScheduler(archive,async()=>[{account,login:id}],()=>now);
  let dispatch=scheduler(),gallery;
  const waitDone=async n=>{
    for(let i=0;i<200 && [...archive.records.values()].filter(r=>r.status==='success').length<n;i++)await Bun.sleep(5);
    expect(calls).toBe(n);expect([...archive.records.values()].filter(r=>r.status==='success').length).toBe(n);
  };
  try{
    archive.saveInfo({calendar:{region:'CN',overrides:{}},accounts:[account]});
    expect(archive.setQuietHours(quiet,now,custom([540,542,1260]))).toBe(true);
    expect(archive.info.nextByAccount[id]).toBe(beijing('2026-11-21T09:00'));
    now=beijing('2026-11-21T06:50');await dispatch(gateway);expect(calls).toBe(0);
    now=beijing('2026-11-21T09:00');await dispatch(gateway);await waitDone(1);
    dispatch.dispose();archive=new Archive(root);dispatch=scheduler();
    await dispatch(gateway);expect(calls).toBe(1);
    expect(archive.info.nextByAccount[id]).toBe(beijing('2026-11-21T09:02'));
    now=beijing('2026-11-21T09:02');await dispatch(gateway);await waitDone(2);
    const r=[...archive.records.values()][0];expect(r.trigger).toBe('rest-sample');
    gallery=serveGallery(archive,{port:0,hostname:'127.0.0.1'});
    for(const asset of [r.original,r.svg,r.responseText]){
      expect((await fetch('http://127.0.0.1:'+gallery.port+asset)).status).toBe(200);
    }
    expect(archive.setQuietHours(quiet,now,custom([600,660]))).toBe(true);
    expect(archive.info.nextByAccount[id]).toBe(beijing('2026-11-22T10:00'));
    archive.setMonitoringPaused(id,true,now);expect(archive.info.nextByAccount[id]).toBeUndefined();
    archive.setMonitoringPaused(id,false,now);await dispatch(gateway);await waitDone(3);
    expect([...archive.records.values()].at(-1).trigger).toBe('resume');
    now=beijing('2026-11-22T12:15');await dispatch(gateway);expect(calls).toBe(3);
    const monday=archive.info.nextByAccount[id];
    expect(midnight(monday)).toBe(beijing('2026-11-23T00:00'));expect(dayType(monday).rest).toBe(false);
    expect(new Date(monday).getUTCMinutes()).toBeGreaterThan(0);
    archive.setQuietHours(quiet,now,{...even,enabled:false});
    expect(midnight(archive.info.nextByAccount[id])).toBe(midnight(now));
  }finally{dispatch.dispose();gallery?.stop(true);fake.stop(true);rmSync(root,{recursive:true,force:true});}
});

test('each enabled account receives its entire independent plan on a rest day', async () => {
  const root=mkdtempSync(join(tmpdir(),'pelican-sampling-'));
  const archive=new Archive(root);
  const saturday=beijing('2026-11-21T00:00');
  const accounts=[account,{...account,id:'b'.repeat(20)}];
  let now=saturday;
  const entries=accounts.map(a=>({account:a,login:a.id}));
  const fake=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){
    return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',
      text:'<html><svg></svg></html>'}]}]}, {headers:{'x-magpie-provider':'codex','x-magpie-model':'codex/gpt-6.2-astra'}});
  }});
  const dispatch=createScheduler(archive,async()=>entries,()=>now);
  try{
    archive.saveInfo({accounts});
    archive.setQuietHours(quiet,now,even);
    const preview=archive.status(now).accounts;
    for(let i=0;i<8;i++){
      now=Math.min(...Object.values(archive.info.nextByAccount));
      if(midnight(now)!==saturday)break;
      await dispatch({addr:'127.0.0.1:'+fake.port});
      for(let j=0;j<100&&[...archive.records.values()].some(r=>r.status==='running');j++)await Bun.sleep(5);
    }
    for(const a of preview){
      const runs=[...archive.records.values()].filter(r=>r.accountId===a.id);
      expect(runs.map(r=>(Date.parse(r.startedAt)-saturday)/60000)).toEqual(a.restSampleMinutes);
      expect(runs.every(r=>r.status==='success' && r.trigger==='rest-sample')).toBe(true);
      expect(midnight(archive.info.nextByAccount[a.id])).toBe(beijing('2026-11-22T00:00'));
    }
  }finally{dispatch.dispose();fake.stop(true);rmSync(root,{recursive:true,force:true});}
});
