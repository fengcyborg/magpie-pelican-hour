"""Regenerate the offline national calendars with python-holidays 0.109."""
import json
from pathlib import Path
import holidays

if holidays.__version__ != "0.109":
    raise RuntimeError("Install holidays==0.109 to reproduce this dataset")

regions = {}
for region in sorted(holidays.list_supported_countries(include_aliases=False)):
    if region == "CN":
        continue  # rest-days.mjs carries the published mainland holiday and make-up schedule.
    calendar = holidays.country_holidays(region, years=range(2026, 2029), expand=False)
    years = {}
    for year in range(2026, 2029):
        days = sorted(date.month * 100 + date.day for date in calendar if date.year == year)
        work = sorted(date.month * 100 + date.day for date in calendar.weekend_workdays if date.year == year)
        if days:
            years[year] = {"rest": days, "work": work}
    if years:
        regions[region] = {"weekend": sorted((day + 1) % 7 for day in calendar.weekend), "years": years}

path = Path(__file__).with_name("calendars.json")
path.write_text("{\n" + ",\n".join(f'  "{key}": ' + json.dumps(value, separators=(",", ":"))
                               for key, value in regions.items()) + "\n}\n")
