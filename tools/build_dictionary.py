"""Build the offline dictionary from an ECDICT CSV. Usage: python build_dictionary.py ecdict.csv"""
import csv
import re
import sqlite3
import sys
from pathlib import Path

target = Path(__file__).resolve().parents[1] / "assets" / "dictionary.sqlite"
with sqlite3.connect(target.with_suffix(".new")) as db:
    db.executescript("""
        DROP TABLE IF EXISTS words;
        DROP TABLE IF EXISTS forms;
        CREATE TABLE words(word TEXT PRIMARY KEY, phonetic TEXT, meaning TEXT, lemma TEXT) WITHOUT ROWID;
        CREATE TABLE forms(form TEXT PRIMARY KEY, base TEXT) WITHOUT ROWID;
    """)
    with open(sys.argv[1], encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            word = r["word"].lower()
            if not re.fullmatch(r"[a-z]+(?:[-'][a-z]+)*", word) or not r["translation"]:
                continue
            forms = dict(part.split(":", 1) for part in r["exchange"].split("/") if ":" in part)
            db.execute("INSERT OR IGNORE INTO words VALUES(?,?,?,?)",
                       (word, r["phonetic"], r["translation"].replace("\\n", "\n"), forms.get("0", "")))
            for key in ("s", "3", "p", "d", "i", "r", "t"):
                if key in forms:
                    db.execute("INSERT OR IGNORE INTO forms VALUES(?,?)", (forms[key].lower(), word))
    print("Dictionary entries:", db.execute("SELECT count(*) FROM words").fetchone()[0])
db.close()
target.with_suffix(".new").replace(target)
