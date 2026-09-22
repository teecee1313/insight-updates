#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
release_bump.py — bump the app to a new version in ONE step, so the three things
that must agree always do:

  app.js            APP_VERSION='DATE-N-open'      (and simple/app.js  -simple)
  index.html        <script src="app.js?v=DATE-N-open">   (and simple/index.html)
  update.json       "version": "DATE-N" + notes    (the self-updater compares this)

Why: v891-v914 bumped APP_VERSION alone. index.html kept loading app.js?v=890,
so phones were allowed to keep a saved older app.js - Tony's screenshots kept
showing the previous version after each fix. The ?v= tag is what tells a phone
the file is new.

usage: python3 release_bump.py <repo_dir> <new_number> "<release note>"
"""
import os, re, sys, json, datetime

def die(m): print('✗ '+m); sys.exit(1)
if len(sys.argv)!=4: die('usage: release_bump.py <repo_dir> <new_number> "<note>"')
R, N, NOTE = sys.argv[1], sys.argv[2], sys.argv[3]
if not N.isdigit(): die('new_number must be digits, e.g. 915')
today=datetime.date.today().strftime('%Y.%m.%d')
new=today+'-'+N
for app_f, idx_f, suf in (('app.js','index.html','-open'), ('simple/app.js','simple/index.html','-simple')):
    ap=os.path.join(R,app_f); ip=os.path.join(R,idx_f)
    if not os.path.exists(ap): continue
    a=open(ap,encoding='utf-8').read(); h=open(ip,encoding='utf-8').read()
    va=re.findall(r"APP_VERSION='(\d{4}\.\d{2}\.\d{2}-\d+)"+re.escape(suf)+"'",a)
    vi=re.findall(r'app\.js\?v=(\d{4}\.\d{2}\.\d{2}-\d+)'+re.escape(suf),h)
    if len(va)!=1 or len(vi)!=1: die(f'{app_f}/{idx_f}: expected one version each, found {va} / {vi}')
    a=a.replace("APP_VERSION='"+va[0]+suf+"'","APP_VERSION='"+new+suf+"'",1)
    h=h.replace('app.js?v='+vi[0]+suf,'app.js?v='+new+suf,1)
    open(ap,'w',encoding='utf-8').write(a); open(ip,'w',encoding='utf-8').write(h)
    print(f'  {app_f}: {va[0]}{suf} -> {new}{suf}   {idx_f}: app.js?v={vi[0]}{suf} -> {new}{suf}')
up=os.path.join(R,'update.json'); d=json.load(open(up,encoding='utf-8'))
d['version']=new; d['notes']=NOTE
open(up,'w',encoding='utf-8').write(json.dumps(d,indent=2,ensure_ascii=False)+'\n')
print(f'✓ release {new}: app.js, index.html and update.json all agree')
