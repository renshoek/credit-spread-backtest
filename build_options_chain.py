#!/usr/bin/env python3
"""
build_options_chain.py  —  OptionsDX SPY EOD preprocessor
==========================================================

USAGE
    python3 build_options_chain.py /path/to/options/root
    python3 build_options_chain.py /path/to/options/root --out /path/to/options_chain.json

OUTPUT
    options_chain.json  (place in same folder as index.html)

FOLDER STRUCTURE EXPECTED
    root/2010/spy_eod_201001.txt ... spy_eod_201012.txt
    root/2011/spy_eod_201101.txt ...
    ...
    root/2022/Q1/spy_eod_202201.txt ...    ← quarter subfolders OK
    root/2022/Q2/spy_eod_202204.txt ...

ENTRY / EXPIRY / MID-TRADE LOGIC
    For each month M:
        entry_date  = first trading day of M           (from file M)
        expiry_date = 3rd Friday of M+1                (~45 DTE)
        mid_date    = closest trading day to expiry-21d (~21 DTE remaining)
                      looked up in file M+1 (where that date lives)

    Three put snapshots stored per month:
        entry  — actual bid/ask/mid/iv at entry date    (used for opening)
        mid    — actual bid/ask/mid/iv at ~21 DTE left  (used for early exit sim)
        [expiry settlement price comes from SPY.csv, not options data]

OUTPUT FORMAT
    {
      "meta": { ... },
      "chain": {
        "2011-01": {
          "entry_date":  "2011-01-03",
          "expiry_date": "2011-02-18",
          "mid_date":    "2011-01-28",
          "mid_dte":     21,
          "underlying":  127.05,
          "dte":         46,
          "puts": [
            {
              "strike":  127.0,
              "otm_pct": 0.0,
              "entry":   {"bid":2.84,"ask":2.86,"mid":2.85,"iv":0.1545,"spot":127.0},
              "mid":     {"bid":0.95,"ask":0.97,"mid":0.96,"iv":0.1201,"spot":128.5},
            },
            ...
          ]
        }, ...
      }
    }

HOW BACKTEST USES IT
    - Entry:     interpolate puts[n].entry.mid for opening premium
    - Mid exit:  interpolate puts[n].mid.mid  for closing at ~21 DTE
    - Settlement: SPY actual close on expiry_date (from SPY.csv as before)
"""

import os, sys, csv, json, datetime

MAX_OTM_PCT = 25.0   # keep strikes 0–25% OTM based on ENTRY spot
MIN_BID     = 0.01   # filter zero-bid illiquid rows
MID_DTE_TARGET = 21  # target DTE remaining for mid-trade snapshot


def third_friday(year, month):
    d = datetime.date(year, month, 1)
    fridays = [d + datetime.timedelta(i) for i in range(31)
               if (d + datetime.timedelta(i)).month == month
               and (d + datetime.timedelta(i)).weekday() == 4]
    return fridays[2] if len(fridays) >= 3 else (fridays[-1] if fridays else None)


def next_month(year, month):
    return (year + 1, 1) if month == 12 else (year, month + 1)


def find_all_files(root):
    found = {}
    for dirpath, _, filenames in os.walk(root):
        for fname in filenames:
            fl = fname.lower()
            if fl.startswith('spy_eod_') and fl.endswith('.txt'):
                ym = fl[8:14]
                if len(ym) == 6 and ym.isdigit():
                    y, m = int(ym[:4]), int(ym[4:])
                    found[(y, m)] = os.path.join(dirpath, fname)
    return found


def parse_snapshot(filepath, quote_date_str, expiry_str, entry_spot=None):
    """
    Extract all puts for a specific quote_date + expiry combo from a file.
    Returns (spot, puts_list) or (None, []).
    If entry_spot provided, OTM% is computed relative to entry_spot (for mid snapshot
    so strikes line up with entry strikes).
    """
    underlying, puts = None, []
    try:
        with open(filepath, encoding='utf-8', errors='replace') as f:
            reader = csv.reader(f)
            headers = [h.strip().strip('[]') for h in next(reader)]
            idx = {h: i for i, h in enumerate(headers)}
            iv_col = idx.get('P_IV')

            for req in ['QUOTE_DATE','EXPIRE_DATE','UNDERLYING_LAST','STRIKE','P_BID','P_ASK']:
                if req not in idx:
                    return None, []

            for row in reader:
                if len(row) <= max(idx.values()): continue
                if row[idx['QUOTE_DATE']].strip()  != quote_date_str: continue
                if row[idx['EXPIRE_DATE']].strip()  != expiry_str:    continue
                try:
                    spot   = float(row[idx['UNDERLYING_LAST']].strip())
                    strike = float(row[idx['STRIKE']].strip())
                    pbid   = float(row[idx['P_BID']].strip() or 0)
                    pask   = float(row[idx['P_ASK']].strip() or 0)
                except ValueError:
                    continue

                ref_spot = entry_spot if entry_spot else spot
                if strike > ref_spot * 1.001: continue        # skip ITM vs entry
                otm_pct = (ref_spot - strike) / ref_spot * 100
                if otm_pct > MAX_OTM_PCT: continue
                if pbid < MIN_BID:        continue

                iv = None
                if iv_col is not None:
                    try:
                        v = float(row[iv_col].strip() or 0)
                        iv = round(v, 5) if v > 0.01 else None
                    except (ValueError, TypeError):
                        pass

                if underlying is None:
                    underlying = spot

                puts.append({
                    'strike':  round(strike, 2),
                    'otm_pct': round(otm_pct, 3),
                    'bid':     round(pbid, 4),
                    'ask':     round(pask, 4),
                    'mid':     round((pbid + pask) / 2.0, 4) if pask > pbid else round(pbid, 4),
                    'iv':      iv,
                    'spot':    round(spot, 2),
                })
    except Exception as e:
        print(f"  ERROR parsing {filepath}: {e}")
        return None, []

    puts.sort(key=lambda x: x['strike'], reverse=True)
    return underlying, puts


def with_fallback(filepath, date_target, expiry_str, entry_spot=None):
    """Try date_target, then scan ±5 weekdays to handle holidays/gaps."""
    for delta in [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5]:
        d = date_target + datetime.timedelta(days=delta)
        if d.weekday() >= 5: continue
        d_str = d.strftime('%Y-%m-%d')
        u, puts = parse_snapshot(filepath, d_str, expiry_str, entry_spot)
        if u and puts:
            return d_str, u, puts
    return None, None, []


def merge_snapshots(entry_puts, mid_puts):
    """
    Merge entry and mid puts by strike into unified list.
    Result: [{ strike, otm_pct, entry:{...}, mid:{...} }, ...]
    Only keeps strikes present in ENTRY (mid snapshot may have different spot).
    """
    mid_by_strike = {p['strike']: p for p in mid_puts}
    merged = []
    for ep in entry_puts:
        strike = ep['strike']
        mp = mid_by_strike.get(strike)
        row = {
            'strike':  strike,
            'otm_pct': ep['otm_pct'],
            'entry': {
                'bid': ep['bid'], 'ask': ep['ask'],
                'mid': ep['mid'], 'iv':  ep['iv'],
                'spot': ep['spot'],
            },
        }
        if mp:
            row['mid'] = {
                'bid': mp['bid'], 'ask': mp['ask'],
                'mid': mp['mid'], 'iv':  mp['iv'],
                'spot': mp['spot'],
            }
        # If no mid data for this strike, leave 'mid' absent
        merged.append(row)
    return merged


def main():
    if len(sys.argv) < 2:
        print("USAGE: python3 build_options_chain.py /path/to/options/root [--out out.json]")
        sys.exit(1)

    root     = sys.argv[1]
    out_path = 'options_chain.json'
    if '--out' in sys.argv:
        out_path = sys.argv[sys.argv.index('--out') + 1]

    if not os.path.isdir(root):
        print(f"ERROR: '{root}' is not a directory"); sys.exit(1)

    files = find_all_files(root)
    if not files:
        print("ERROR: no spy_eod_YYYYMM.txt files found"); sys.exit(1)

    all_ym = sorted(files)
    print(f"Found {len(all_ym)} files: "
          f"{all_ym[0][0]}-{all_ym[0][1]:02d} to {all_ym[-1][0]}-{all_ym[-1][1]:02d}\n")

    chain, ok, skip = {}, 0, 0

    for (ey, em) in all_ym:
        ny, nm       = next_month(ey, em)
        expiry_date  = third_friday(ny, nm)
        if expiry_date is None:
            print(f"  SKIP {ey}-{em:02d}: can't compute expiry"); skip += 1; continue

        expiry_str   = expiry_date.strftime('%Y-%m-%d')
        entry_target = datetime.date(ey, em, 1)
        month_key    = f"{ey}-{em:02d}"

        print(f"{month_key}  expiry={expiry_str}  ", end='', flush=True)

        # ── ENTRY snapshot (day 1 of month M, from file M) ──
        entry_file = files.get((ey, em))
        used_entry, entry_underlying, entry_puts = with_fallback(
            entry_file, entry_target, expiry_str)

        if not entry_puts:
            print("→ NO ENTRY DATA"); skip += 1; continue

        dte = (expiry_date - datetime.date.fromisoformat(used_entry)).days

        # ── MID snapshot (~21 DTE remaining) ──
        # expiry-21d always falls in the entry month (M), not M+1.
        # e.g. expiry=Feb-19, mid=Jan-29 → still in January's file.
        # Fallback to M+1 file only if mid date somehow crosses into next month.
        mid_target = expiry_date - datetime.timedelta(days=MID_DTE_TARGET)
        used_mid, mid_underlying, mid_puts_raw = None, None, []

        mid_file_primary = files.get((mid_target.year, mid_target.month))
        if mid_file_primary:
            used_mid, mid_underlying, mid_puts_raw = with_fallback(
                mid_file_primary, mid_target, expiry_str, entry_spot=entry_underlying)

        # Fallback: try adjacent month file if primary failed
        if not mid_puts_raw:
            mid_file_fallback = files.get((ny, nm))
            if mid_file_fallback and mid_file_fallback != mid_file_primary:
                used_mid, mid_underlying, mid_puts_raw = with_fallback(
                    mid_file_fallback, mid_target, expiry_str, entry_spot=entry_underlying)

        mid_dte = (expiry_date - datetime.date.fromisoformat(used_mid)).days if used_mid else None

        # ── Merge ──
        puts = merge_snapshots(entry_puts, mid_puts_raw)

        mid_coverage = f"mid={used_mid}(DTE={mid_dte})" if used_mid else "mid=NONE"
        shifted = " [holiday]" if used_entry != entry_target.strftime('%Y-%m-%d') else ""
        print(f"→ {len(puts):3d} puts  entry={used_entry}  DTE={dte}  "
              f"{mid_coverage}  S={entry_underlying:.2f}{shifted}")

        chain[month_key] = {
            'entry_date':    used_entry,
            'expiry_date':   expiry_str,
            'mid_date':      used_mid,
            'mid_dte':       mid_dte,
            'underlying':    round(entry_underlying, 4),
            'dte':           dte,
            'puts':          puts,
        }
        ok += 1

    print(f"\n{'='*60}")
    mid_ok = sum(1 for v in chain.values() if v['mid_date'])
    print(f"Done: {ok} months OK, {skip} skipped")
    print(f"Mid snapshots: {mid_ok}/{ok} months have ~21 DTE data\n")

    with open(out_path, 'w') as f:
        json.dump({
            'meta': {
                'generated':    datetime.datetime.now().isoformat(),
                'months':       ok,
                'source':       'OptionsDX SPY EOD',
                'entry_logic':  'First trading day of month M, expiry = 3rd Friday of M+1 (~45 DTE)',
                'mid_logic':    f'Closest trading day to expiry-{MID_DTE_TARGET}d (~{MID_DTE_TARGET} DTE remaining)',
                'otm_range':    f'0–{MAX_OTM_PCT}% OTM, P_BID > {MIN_BID}',
                'put_format':   'Each put has entry:{bid,ask,mid,iv,spot} and mid:{...} snapshots',
                'note':         'Engine interpolates linearly between nearest strikes at each snapshot.',
            },
            'chain': chain,
        }, f, separators=(',', ':'))

    size_kb = os.path.getsize(out_path) / 1024
    print(f"Written: {out_path}  ({size_kb:.0f} KB)")

    if chain:
        keys = sorted(chain.keys())
        print(f"Coverage: {keys[0]} → {keys[-1]}\n")
        print("Sample (5–8% OTM entry/mid mids):")
        for k in keys[:3]:
            e = chain[k]
            sample = [(p['otm_pct'], p['entry']['mid'],
                       p['mid']['mid'] if 'mid' in p else None)
                      for p in e['puts'] if 4 < p['otm_pct'] < 9][:3]
            for otm, emid, mmid in sample:
                mid_str = f"→mid {mmid:.3f}" if mmid else "→mid N/A"
                print(f"  {k}  {otm:.1f}%OTM  entry {emid:.3f} {mid_str}")

if __name__ == '__main__':
    main()
