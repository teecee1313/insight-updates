#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make_simple.py — build INSIGHT SIMPLE from the current customer build.

One source, a second front door (Tony, 12 Sep 2026: "another program alongside
this that has maybe our top 4 auto settings, top 20, PN report and any other key
reports" — without forking the code). Reads the customer index.html + app.js and
writes a locked-Starter copy for a separate insight-simple GitHub Pages repo:

  • Starter mode LOCKED — setAppMode() always resolves to 'simple'; the
    Starter/Advanced switch and "More tools" button are hidden.
  • Six screens only: ☀️ Starter Today brief (already the top of the page),
    🏆 Strongest Today, 🎯 Tonight's picks (the proven lane), 💰 PN Edge
    (best evidence), 🕵️ Quiet climbers (server /foot), 💼 My portfolio.
  • version suffix -open → -simple · update check → insight-simple/update.json
  • header chip 🌱 SIMPLE with a one-click ✉ feedback mailto
  • storage namespaced SIMPLE_asxScreener… (same isolation as the beta), the
    pnAnalyser price cache shared (warm loads).

Usage:  make_simple.py [SRC_DIR] [OUT_DIR] [PUBLIC_URL]
        defaults /root, /root/simple, https://teecee1313.github.io/insight-updates/simple/
        (served from the customer repo's simple/ folder — no second repo needed)
Re-run after every release. Idempotent — refuses to run on a build that is
already -simple.
"""
import os, re, sys, json

SRC_DIR = sys.argv[1] if len(sys.argv) > 1 else '/root'
OUT_DIR = sys.argv[2] if len(sys.argv) > 2 else '/root/simple'
SIMPLE_URL = sys.argv[3] if len(sys.argv) > 3 else 'https://teecee1313.github.io/insight-updates/simple/'
FEEDBACK = 'tonycotton13@gmail.com'

def die(msg): print('✗ ' + msg); sys.exit(1)

html = open(os.path.join(SRC_DIR, 'index.html'), encoding='utf-8').read()
js = open(os.path.join(SRC_DIR, 'app.js'), encoding='utf-8').read()

# ── version ─────────────────────────────────────────────────────────────────
m = re.search(r"APP_VERSION='(\d{4}\.\d{2}\.\d{2}-\d+)-open'", js)
if not m: die('could not find APP_VERSION with -open suffix in app.js')
ver = m.group(1)
js = js.replace("APP_VERSION='" + ver + "-open'", "APP_VERSION='" + ver + "-simple'", 1)
html = html.replace('app.js?v=' + ver + '-open', 'app.js?v=' + ver + '-simple')

# ── update channel ──────────────────────────────────────────────────────────
OLD_UPD = "const UPDATE_CHECK_URL='https://teecee1313.github.io/insight-updates/update.json'"
if OLD_UPD not in js: die('UPDATE_CHECK_URL anchor not found')
js = js.replace(OLD_UPD, "const UPDATE_CHECK_URL='" + SIMPLE_URL + "update.json'", 1)

# ── storage isolation (same rule as make_beta) ──────────────────────────────
n_ls = js.count("'asxScreener")
if n_ls == 0: die('no asxScreener keys found to namespace')
js = js.replace("'asxScreener", "'SIMPLE_asxScreener")
js = js.replace("'pnmaVersions'", "'SIMPLE_pnmaVersions'")

# ── lock Starter mode ───────────────────────────────────────────────────────
OLD_MODE = "function setAppMode(mode){\n  const lite = mode==='lite';"
if OLD_MODE not in js: die('setAppMode anchor not found')
js = js.replace(OLD_MODE, "function setAppMode(mode){\n  if(window._SIMPLE_LOCK)mode='lite';   /* make_simple: the Simple tab is the whole product here */\n  const lite = mode==='lite';", 1)
js = "window._SIMPLE_LOCK=true; /* built by make_simple.py — Starter locked */\n" + js

# (v864+: the Simple tab, its five cards and simpleQuietClimbers() live in the app itself)

# ── hide the switch, "more tools", quick plans ─────────────────────────────
CSS = ('<style id="simpleLock">#modeBar,.simple-more,#quickPlansRow,#quickPlansRowAdv{display:none!important}'
       '.simple-load-hint{font-size:12px}</style>')
# v864+: the app's own Simple tab does the hiding; the lock above just pins it
if '</head>' not in html: die('</head> not found')
html = html.replace('</head>', CSS + '\n</head>', 1)

# ── SIMPLE chip (matched by shape, as make_beta learned in v455) ───────────
_m = re.search(r'<span id="appVer"[^>]*></span>', html)
if not _m: die('header appVer anchor not found')
ANCHOR = _m.group(0)
CHIP = ANCHOR + ('\n    <span id="simpleTag" title="Insight Simple — the six essentials, nothing else. Ideas or anything confusing? Use the feedback link." '
                 'style="font-size:8px;font-weight:800;letter-spacing:1px;color:#5fd18a;border:1px solid #5fd18a;border-radius:4px;padding:1px 6px;background:rgba(95,209,138,.10);white-space:nowrap;">'
                 '🌱 SIMPLE · <a href="mailto:' + FEEDBACK + '?subject=Insight%20Simple%20feedback%20v' + ver + '" style="color:#5fd18a;">✉ feedback</a></span>')
html = html.replace(ANCHOR, CHIP, 1)

os.makedirs(OUT_DIR, exist_ok=True)
# v865+: the lessons/<lang>.json translations are fetched relative to the page — carry them along
import shutil
if os.path.isdir(os.path.join(SRC_DIR, 'lessons')):
    if os.path.isdir(os.path.join(OUT_DIR, 'lessons')): shutil.rmtree(os.path.join(OUT_DIR, 'lessons'))
    shutil.copytree(os.path.join(SRC_DIR, 'lessons'), os.path.join(OUT_DIR, 'lessons'))
open(os.path.join(OUT_DIR, 'index.html'), 'w', encoding='utf-8').write(html)
open(os.path.join(OUT_DIR, 'app.js'), 'w', encoding='utf-8').write(js)
upd = {"version": ver, "url": SIMPLE_URL,
       "notes": "Insight Simple " + ver + " — six screens: Starter Today, Strongest Today, Tonight's picks, PN Edge, Quiet climbers and your portfolio. Anything confusing: use the ✉ feedback link top-left."}
open(os.path.join(OUT_DIR, 'update.json'), 'w', encoding='utf-8').write(json.dumps(upd, indent=2, ensure_ascii=False) + '\n')
print(f"✓ simple build written: {OUT_DIR}/index.html ({len(html):,} chars) + app.js ({len(js):,} chars) + update.json · version {ver}-simple · {n_ls} storage keys namespaced")
