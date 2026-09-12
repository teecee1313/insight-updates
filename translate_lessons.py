#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
translate_lessons.py — translate the Insight Trading lessons into another language.

  python3 translate_lessons.py --lang zh --name "Simplified Chinese"
  python3 translate_lessons.py --lang vi --name "Vietnamese" --only zero,volume0   # a subset

Reads lessons/en.json (extract it once with --extract from the app's index.html),
sends ONE lesson at a time to Claude with a fixed glossary, validates that the
shape came back intact (same steps, same quiz, same correct-answer index), and
writes lessons/<lang>.json incrementally — so it can be stopped and resumed, and
a partial file is already usable by the app (untranslated lessons fall back to
English, and the picker says how many are done).

Needs: pip install anthropic · ANTHROPIC_API_KEY in the environment.
Cost: ~60k tokens in + ~60k out per full language on claude-sonnet-4-6 — about a
dollar a language. Have a native reader spot-check two or three lessons before
testers see it.
"""
import os, re, sys, json, time, argparse

GLOSSARY = """Keep these EXACTLY as written (do not translate, do not transliterate):
- product names: Insight Trading, Insight Simple, PN Edge, Watch Score, Starter, Advanced, Simple (the three tabs)
- evidence tiers, always upper-case Latin: SOLID, PROMISING, TOO EARLY, NO EDGE
- signal names keep their emoji and English label with your translation in brackets the FIRST time each appears in a lesson, English-only after that: 🚀 Breakout, 🕵️ Informed?, 🏦 Big money?, ⤴ MA cross, 📉 Quiet selling?, 🥇 Vol record, 🔷 Block day, 🧑‍💼 Director ✓, 🕵️ Quiet climbers
- preset names: 🛡 Defender, ⚖ All-rounder, ⚡ Hunter
- ASX, ticker codes (BHP, CBA, WOW, CSL…), ETF codes (VAS, A200, STW, IOZ), form names (Appendix 3Y, 603, 604, 605)
- every number, percentage, dollar figure, date, and every emoji
Translate naturally for a beginner — plain words, not textbook finance. Australian context stays Australian (the ASX, Sydney time, dollars)."""

SYSTEM = """You translate an educational app's share-market lessons from English into {name}.
You will receive ONE lesson as JSON. Return the SAME JSON object with these fields translated: "title" (keep the leading number and the " · " separator), each step's heading (steps[n][0]) and body (steps[n][1]), and every quiz "q", "a" option, and "why".
Never change: "id", "mins", "c", the ORDER or COUNT of steps, quiz questions or answer options.
The bodies contain HTML and inline <svg> diagrams. Keep every tag, attribute, class, style and coordinate byte-for-byte. Translate only human-readable text: text between tags, and the text inside SVG <text>…</text> elements — those are diagram labels with fixed space, so keep each label no longer than the English (abbreviate rather than overflow). Keep HTML entities (&amp; &#8217; etc.) valid.
{glossary}
Output ONLY the JSON object — no preamble, no markdown fences, no commentary."""

def extract(index_html, out):
    h = open(index_html, encoding='utf-8').read()
    i = h.find('const LESSONS=['); j = h.find('];', i)
    L = json.loads(h[i + len('const LESSONS='):j + 1])
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    json.dump(L, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f'extracted {len(L)} lessons → {out}')

def shape_ok(src, out):
    try:
        if out['id'] != src['id'] or len(out['steps']) != len(src['steps']): return 'id/steps'
        for a, b in zip(src['steps'], out['steps']):
            if len(b) != 2 or not b[0] or not b[1]: return 'step shape'
            if a[1].count('<svg') != b[1].count('<svg') or a[1].count('</text>') != b[1].count('</text>'): return 'svg markup changed'
        sq, oq = src.get('quiz') or [], out.get('quiz') or []
        if len(sq) != len(oq): return 'quiz count'
        for a, b in zip(sq, oq):
            if len(a['a']) != len(b['a']) or a['c'] != b['c'] or not b['q'] or not b.get('why'): return 'quiz shape'
        return ''
    except Exception as e:
        return 'exception ' + str(e)[:60]

def translate_one(client, model, lesson, name):
    msg = client.messages.create(model=model, max_tokens=16000, temperature=0,
        system=SYSTEM.format(name=name, glossary=GLOSSARY),
        messages=[{'role': 'user', 'content': json.dumps(lesson, ensure_ascii=False)}])
    txt = ''.join(b.text for b in msg.content if getattr(b, 'type', '') == 'text').strip()
    txt = re.sub(r'^```(?:json)?\s*|\s*```$', '', txt)
    return json.loads(txt)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--lang', help='file code, e.g. zh, vi, it, el, hi')
    ap.add_argument('--name', help='language name as Claude should understand it, e.g. "Simplified Chinese"')
    ap.add_argument('--src', default='lessons/en.json')
    ap.add_argument('--only', default='', help='comma-separated lesson ids to (re)do')
    ap.add_argument('--model', default='claude-sonnet-4-6')
    ap.add_argument('--extract', metavar='INDEX_HTML', help='extract lessons/en.json from the app and exit')
    a = ap.parse_args()
    if a.extract: extract(a.extract, a.src); return
    if not (a.lang and a.name): ap.error('--lang and --name are required')
    try:
        import anthropic
    except ImportError:
        sys.exit('pip install anthropic   (and set ANTHROPIC_API_KEY)')
    if not os.environ.get('ANTHROPIC_API_KEY'): sys.exit('set ANTHROPIC_API_KEY first')
    client = anthropic.Anthropic()
    src = json.load(open(a.src, encoding='utf-8'))
    out_path = f'lessons/{a.lang}.json'
    done = {}
    if os.path.exists(out_path):
        try:
            prev = json.load(open(out_path, encoding='utf-8'))
            done = {l['id']: l for l in (prev.get('lessons') if isinstance(prev, dict) else prev)}
        except Exception: done = {}
    only = set(x for x in a.only.split(',') if x)
    todo = [l for l in src if (l['id'] in only) or (not only and l['id'] not in done)]
    print(f'{a.lang} ({a.name}): {len(done)} already done, {len(todo)} to translate')
    for n, lesson in enumerate(todo, 1):
        for attempt in range(1, 4):
            try:
                out = translate_one(client, a.model, lesson, a.name)
                bad = shape_ok(lesson, out)
                if bad: raise ValueError('shape check failed: ' + bad)
                done[lesson['id']] = out
                break
            except Exception as e:
                print(f'  {lesson["id"]}: attempt {attempt} failed — {str(e)[:120]}')
                time.sleep(3 * attempt)
        else:
            print(f'  {lesson["id"]}: GIVING UP (left English)'); continue
        ordered = [done[l['id']] for l in src if l['id'] in done]
        json.dump({'lang': a.lang, 'name': a.name, 'total': len(src), 'lessons': ordered},
                  open(out_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        print(f'  [{n}/{len(todo)}] {lesson["id"]} ✓  ({len(ordered)}/{len(src)} in file)')
    print(f'done → {out_path}')

if __name__ == '__main__':
    main()
