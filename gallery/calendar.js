let calendarBase = '', calendarMonth = '', calendarRequest = '', monthDays = [];
let dateOverrides = {};
const regionSelect = $('calendar-region');
function regionName(region) {
  try { return new Intl.DisplayNames([locale], {type:'region'}).of(region); }
  catch { return region; }
}
function renderRegions(data) {
  const value = regionSelect.value || data.calendar.region;
  const options = data.regions.map(id => [id, regionName(id)]).sort((a,b) => a[1].localeCompare(b[1],locale));
  regionSelect.replaceChildren(new Option(t('跟随语言')+' · '+regionName(data.autoRegion),'auto'),
    ...options.map(([id,name]) => new Option(name,id)));
  regionSelect.value = value;
}
function monthDate(month, offset = 0) {
  const [year,m] = month.split('-').map(Number);
  return new Date(Date.UTC(year,m-1+offset,1,12));
}
function calendarSettings(data) {
  if (!regionSelect.options.length) renderRegions(data);
  const saved = JSON.stringify(data.calendar);
  if (!quietEdited && saved !== calendarBase) {
    calendarBase = saved;
    dateOverrides = {...data.calendar.overrides};
    regionSelect.value = data.calendar.region;
  }
  if (!calendarMonth) calendarMonth = data.todayKey.slice(0,7);
  const region = regionSelect.value === 'auto' ? data.autoRegion : regionSelect.value;
  $('calendar-caption').textContent = t('地区日历 · {region}',{region:regionName(region || data.calendarRegion)});
  if (!data.calendarDay.official) $('calendar-caption').textContent += ' · '+t('未收录该地区或年份的节假日，按周末安排。');
  if ($('calendar-editor').open) loadMonth();
}
function drawMonth() {
  const month = monthDate(calendarMonth);
  const format = options => new Intl.DateTimeFormat(locale,{...options,timeZone:'UTC'});
  $('month-title').textContent = format({year:'numeric',month:'long'}).format(month);
  $('month-prev').disabled = calendarMonth <= dataset.todayKey.slice(0,7);
  const formatter = format({weekday:'short'});
  const region = regionSelect.value === 'auto' ? dataset.autoRegion : regionSelect.value;
  const calendarLocale = new Intl.Locale(locale,{region});
  const first = (calendarLocale.getWeekInfo?.() || calendarLocale.weekInfo)?.firstDay % 7 || 0;
  const grid = $('calendar-grid');
  const nodes = Array.from({length:7},(_,i) => {
    const el = document.createElement('span');
    el.className='weekday';
    el.textContent=formatter.format(Date.UTC(2024,0,7+first+i));
    return el;
  });
  for (let i=0;i<(7+month.getUTCDay()-first)%7;i++) nodes.push(document.createElement('span'));
  for (const day of monthDays) {
    const override = dateOverrides[day.date];
    const rest = override ? override === 'rest' : day.rest;
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.date = day.date;
    button.dataset.rest = String(rest);
    button.classList.toggle('custom-day',Boolean(override));
    button.textContent = Number(day.date.slice(-2));
    const label = t(override ? (rest?'自定休息日':'自定工作日') : day.label);
    button.title = day.date+' · '+label;
    button.setAttribute('aria-label',button.title);
    button.setAttribute('aria-pressed',String(rest));
    if (day.date===dataset.todayKey) button.setAttribute('aria-current','date');
    button.disabled = day.date < dataset.todayKey;
    nodes.push(button);
  }
  const focus = grid.contains(document.activeElement) && document.activeElement.dataset.date;
  grid.replaceChildren(...nodes);
  if (focus) grid.querySelector('[data-date="'+focus+'"]')?.focus({preventScroll:true});
  $('month-warning').hidden = !monthDays.length || monthDays[0].official;
}
async function loadMonth() {
  if (!dataset || !$('calendar-editor').open) return;
  const query = new URLSearchParams({month:calendarMonth,region:regionSelect.value});
  if (snapshot) query.set('view',snapshot.dataset.view);
  const key = query.toString()+'|'+dataset.autoRegion;
  if (key === calendarRequest) return;
  calendarRequest=key;monthDays=[];drawMonth();
  $('calendar-retry').hidden=true;
  try {
    const res = await fetch('./api/calendar?'+query,{credentials:'omit',signal:AbortSignal.timeout(5000)});
    if (!res.ok) throw Error(String(res.status));
    const dates = await res.json();
    if (calendarRequest!==key) return;
    monthDays=dates;drawMonth();
  } catch {
    if (calendarRequest===key) {calendarRequest='';$('calendar-retry').hidden=false;}
  }
}
$('calendar-editor').addEventListener('toggle',loadMonth);
$('calendar-retry').addEventListener('click',loadMonth);
regionSelect.addEventListener('change',()=>{calendarSettings(dataset);});
for (const [id,offset] of [['month-prev',-1],['month-next',1]]) {
  $(id).addEventListener('click',()=>{calendarMonth=monthDate(calendarMonth,offset).toISOString().slice(0,7);loadMonth();});
}
$('calendar-grid').addEventListener('click',e=>{
  const key=e.target.closest('button')?.dataset.date;
  const day=monthDays.find(d=>d.date===key);
  if (!day || key<dataset.todayKey) return;
  if (dateOverrides[key]) delete dateOverrides[key];
  else dateOverrides[key]=day.rest?'work':'rest';
  markQuietEdited();drawMonth();
});
