import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Archive, quietWindow } from '../archive.mjs';
import { dayType, dateKey, localMinute, midnight, sampleMinutes, validCalendar } from '../rest-days.mjs';

test('local dates, regional holidays and manual overrides survive a restart', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/New_York';
  const root = mkdtempSync(join(tmpdir(), 'pelican-calendar-'));
  try {
    const now = new Date(2026,10,25,23,58).getTime();
    const next = new Date(2026,10,26,9).getTime();
    expect(dateKey(now)).toBe('2026-11-25');
    expect(dayType(next,'US').rest).toBe(true); // Thanksgiving
    expect(dayType(next,'JP').rest).toBe(false);
    const id = 'a'.repeat(20);
    const store = new Archive(root);
    store.saveInfo({accounts:[{id,enabled:true,present:true}]});
    store.setLanguage('en','en-US',now);
    const quiet = {enabled:true,start:22*60,end:7*60};
    const samples = {enabled:true,count:1,distribution:'custom',times:[540]};
    expect(store.setQuietHours(quiet,now,samples)).toBe(true);
    expect(store.info.nextByAccount[id]).toBe(next);
    const config={region:'JP',overrides:{'2026-11-26':'rest','2026-11-28':'work'}};
    expect(store.setQuietHours(quiet,now,samples,config)).toBe(true);
    store.setLanguage('de','de-AT',now);
    const restored=new Archive(root);
    expect(restored.calendarRegion()).toBe('JP');
    expect(restored.classify(next).label).toBe('自定休息日');
    expect(restored.classify(new Date(2026,10,28)).rest).toBe(false);
    expect(restored.info.nextByAccount[id]).toBe(next);
    expect(restored.setQuietHours(quiet,now,samples,{region:'JP',overrides:{}})).toBe(true);
    expect(restored.info.nextByAccount[id]).not.toBe(next);
    expect(validCalendar({region:'JP',overrides:{'2027-02-30':'rest'}})).toBe(false);
    expect(validCalendar({region:'JP',overrides:{'2027-02-28':'invalid'}})).toBe(false);
  } finally {
    if(previous===undefined) delete process.env.TZ; else process.env.TZ=previous;
    rmSync(root,{recursive:true,force:true});
  }
});
test('spring gaps omit nonexistent appointments and both repeated hours respect quiet time', () => {
  const previous=process.env.TZ;
  process.env.TZ='America/New_York';
  try {
    const spring=midnight(Date.parse('2027-03-14T05:00:00Z'));
    expect(localMinute(spring,1440)-spring).toBe(23*3600000);
    const quiet={enabled:false,start:0,end:1};
    expect(sampleMinutes({distribution:'custom',times:[150,210]},quiet,spring,'a')).toEqual([210]);
    const fold={enabled:true,start:75,end:105};
    for(const hour of [5,6]){
      const now=Date.UTC(2026,10,1,hour,30);
      expect(quietWindow(fold,now)).toEqual({start:now-15*60000,end:now+15*60000});
    }
  } finally {if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;}
});
