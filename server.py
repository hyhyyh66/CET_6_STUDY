"""Local CET-6 reading notebook. Run with the included Windows Python runtime."""
import argparse
import asyncio
from contextlib import closing
from datetime import datetime
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import json
import html
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import tempfile
import time
from urllib.parse import urlsplit, urlencode
from urllib.request import urlopen
import webbrowser

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get("CET6_DATA", ROOT / "data")) / "study.sqlite"
DICT = ROOT / "assets" / "dictionary.sqlite"
WORD = re.compile(r"[A-Za-z]+(?:['’\-][A-Za-z]+)*")
LIMIT = 20 * 1024 * 1024
MAX_TEXT = 1000000
SPEECH_VOICES = {
    "en-US-AriaNeural": "Aria · 美式女声",
    "en-US-GuyNeural": "Guy · 美式男声",
    "en-GB-SoniaNeural": "Sonia · 英式女声",
    "en-GB-RyanNeural": "Ryan · 英式男声",
}
SPEECH_RATES = {"0.7": "-30%", "0.85": "-15%", "1": "+0%", "1.2": "+20%"}


@lru_cache(maxsize=64)
def speech_audio(text, voice, rate):
    async def generate():
        import edge_tts
        audio = bytearray()
        stream = edge_tts.Communicate(text, voice, rate=rate, connect_timeout=10, receive_timeout=20)
        async with asyncio.timeout(45):
            async for chunk in stream.stream():
                if chunk["type"] == "audio":
                    audio.extend(chunk["data"])
        if not audio:
            raise RuntimeError("Empty speech audio")
        return bytes(audio)

    try:
        return asyncio.run(generate())
    except TimeoutError as exc:
        raise Problem("Edge TTS 响应超时，请检查网络后重试。", 504) from exc
    except Exception as exc:
        raise Problem("Edge TTS 暂时无法生成语音，请检查网络或稍后重试。", 502) from exc


class Problem(Exception):
    def __init__(self, message, status=400):
        self.status = status
        super().__init__(message)


@lru_cache(maxsize=512)
def translate_sentence(text):
    # MyMemory accepts at most 500 UTF-8 bytes per request.
    segments = []
    while len(text.encode("utf-8")) > 500:
        end = len(text.encode("utf-8")[:500].decode("utf-8", errors="ignore"))
        boundary = max(text.rfind(separator, 0, end) for separator in " ,;:")
        if boundary > end // 2:
            end = boundary + 1
        segments.append(text[:end].strip())
        text = text[end:].lstrip()
    segments.append(text)
    translated = []
    deadline = time.monotonic() + 40
    try:
        for segment in segments:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError()
            url = "https://api.mymemory.translated.net/get?" + urlencode({"q": segment, "langpair": "en|zh-CN"})
            with urlopen(url, timeout=min(15, remaining)) as response:
                result = json.load(response)
            status = str(result.get("responseStatus"))
            if result.get("quotaFinished") or status in ("403", "429"):
                raise Problem("MyMemory 翻译额度已用完或请求受限，请稍后再试。", 429)
            translation = result.get("responseData", {}).get("translatedText")
            if status != "200" or not isinstance(translation, str) or not translation.strip():
                raise Problem("MyMemory 暂时无法翻译这句话，请稍后重试。", 502)
            translated.append(html.unescape(translation))
        return "".join(translated)
    except Problem:
        raise
    except TimeoutError as exc:
        raise Problem("翻译超时，请检查网络后重试。", 504) from exc
    except Exception as exc:
        raise Problem("无法连接 MyMemory 翻译服务，请检查网络后重试。", 502) from exc


def connect():
    db = sqlite3.connect(DATA, timeout=8)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    return db


def setup():
    DATA.parent.mkdir(parents=True, exist_ok=True)
    with closing(connect()) as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS articles(
            id INTEGER PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'draft', updated TEXT NOT NULL, version INTEGER DEFAULT 0);
        -- Old article links and requests must never point at a later import.
        CREATE TABLE IF NOT EXISTS article_sequence(singleton INTEGER PRIMARY KEY CHECK(singleton=1), last_id INTEGER NOT NULL);
        INSERT OR IGNORE INTO article_sequence SELECT 1, COALESCE(MAX(id), 0) FROM articles;
        CREATE TABLE IF NOT EXISTS sentences(
            id INTEGER PRIMARY KEY, article INTEGER NOT NULL REFERENCES articles(id),
            para INTEGER NOT NULL, text TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS by_article ON sentences(article,id);
        CREATE TABLE IF NOT EXISTS import_requests(
            request_id TEXT PRIMARY KEY,
            article INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE);
        CREATE TABLE IF NOT EXISTS marks(
            sentence INTEGER NOT NULL REFERENCES sentences(id), token INTEGER NOT NULL,
            word TEXT NOT NULL, lemma TEXT NOT NULL, phonetic TEXT NOT NULL, meaning TEXT NOT NULL,
            PRIMARY KEY(sentence,token));
        """)


def paragraphs(raw):
    text = raw.replace("\r\n", "\n").replace("\r", "\n").replace("\u00ad", "")
    text = re.sub(r"([a-z]{2,})-\n(?=[a-z])", r"\1", text)
    # Keep paragraph breaks, question numbers, answer options and short headings.
    blocks = []
    current = ""
    for raw_line in text.split("\n"):
        line = " ".join(raw_line.split())
        boundary = re.match(r"^(?:[A-H][.)]|\([A-H]\)|\d{1,3}[.)]|Passage\s+\w+|Questions?\s+\d+)\s*", line)
        if current and (not line or boundary or re.search(r'''[.!?。！？]["'”’)]?$''', current)
                        or (len(current) < 65 and current.istitle())):
            blocks.append(current)
            current = ""
        if line:
            current = (current + " " + line).strip()
    if current:
        blocks.append(current)
    return blocks


def split_sentences(paragraph):
    start = 0
    for boundary in re.finditer(r'''[.!?。！？]+["'”’)\]]*(?:\s+|$)''', paragraph):
        end = boundary.end()
        prefix = paragraph[start:end].rstrip()
        if re.search(r"(?:\b(?:Mr|Ms|Mrs|Dr|Prof|St|vs|e\.g|i\.e)|(?:\b[A-Z]\.)+[A-Z])\.$", prefix, re.I):
            continue
        if re.fullmatch(r"(?:[A-H]|\d{1,3})\.", prefix):
            continue
        yield prefix
        start = end
    if paragraph[start:].strip():
        yield paragraph[start:].strip()


def extract(kind, data):
    if kind == "txt":
        for encoding in (("utf-16",) if data.startswith((b"\xff\xfe", b"\xfe\xff")) else ("utf-8-sig", "gb18030", "cp1252")):
            try:
                text = data.decode(encoding)
                break
            except UnicodeDecodeError:
                continue
        else:
            raise Problem("无法识别 TXT 编码，请另存为 UTF-8 后导入。")
        if "\0" in text:
            raise Problem("文件包含二进制内容，请选择纯文本 TXT。")
    elif kind == "pdf":
        if b"%PDF-" not in data[:1024]:
            raise Problem("文件内容无法识别为 PDF。")
        converter = Path(r"D:\DEV\Git\Git\mingw64\bin\pdftotext.exe")
        converter = str(converter) if converter.is_file() else shutil.which("pdftotext")
        try:
            if converter:
                with tempfile.TemporaryDirectory() as folder:
                    path = Path(folder) / "reading.pdf"
                    path.write_bytes(data)
                    result = subprocess.run([converter, "-enc", "UTF-8", str(path), "-"],
                                            capture_output=True, timeout=45, check=True,
                                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                    text = result.stdout.decode("utf-8-sig")
            else:
                from pypdf import PdfReader
                text = "\n\n".join(p.extract_text() or "" for p in PdfReader(BytesIO(data)).pages)
        except Exception as exc:
            raise Problem("提取 PDF 失败，请确认文件能打开且已解除密码保护。") from exc
        text = text.replace("\r\n", "\n")
        # A page turn can fall inside a sentence or a hyphenated word.
        text = re.sub(r"[^\S\f]*\f[^\S\f]*", "\n", text)
        # Join soft line wraps before letting the user check the reading order.
        text = "\n\n".join(paragraphs(text))
    else:
        raise Problem("请选择 TXT 或 PDF 文件。")
    if not text.strip():
        raise Problem("没有提取到文字。扫描版 PDF 请先做 OCR，再导入。")
    if len(text) > MAX_TEXT:
        raise Problem("文章超过 100 万字符，请拆成较短的阅读材料。")
    return text.strip()


def lookup(word):
    key = word.lower().replace("’", "'")
    with closing(sqlite3.connect(DICT.as_uri() + "?mode=ro", uri=True)) as db:
        row = db.execute("SELECT phonetic,meaning,lemma FROM words WHERE word=?", (key,)).fetchone()
        form = db.execute("SELECT base FROM forms WHERE form=?", (key,)).fetchone()
        base = (row and row[2].split(",")[0]) or (form and form[0]) or key
        base_row = db.execute("SELECT phonetic,meaning FROM words WHERE word=?", (base,)).fetchone()
        meaning = row[1] if row else ""
        if base != key and base_row and base_row[1] != meaning:
            meaning = (meaning + "\n" if meaning else "") + base + " · " + base_row[1]
        return base, row[0] if row else "", meaning


def article(db, aid):
    row = db.execute("SELECT * FROM articles WHERE id=?", (aid,)).fetchone()
    if not row:
        raise Problem("找不到这篇文章。", 404)
    return dict(row)


def marks(db, aid):
    query = """SELECT m.* FROM marks m JOIN sentences s ON s.id=m.sentence
               WHERE s.article=? ORDER BY m.sentence,m.token"""
    return [dict(r) for r in db.execute(query, (aid,))]


def now():
    return datetime.now().isoformat(timespec="seconds")


def write(db, path, body):
    db.execute("BEGIN IMMEDIATE")
    if path == "/api/articles":
        request_id = body.get("requestId")
        if request_id is not None:
            if not isinstance(request_id, str) or not re.fullmatch(r"[a-zA-Z0-9-]{1,100}", request_id):
                raise Problem("无效的导入请求。")
            existing = db.execute("SELECT article FROM import_requests WHERE request_id=?", (request_id,)).fetchone()
            if existing:
                return {"id": existing[0]}
        title, kind, text = body.get("title"), body.get("kind"), body.get("text")
        if not isinstance(title, str) or not title.strip() or len(title) > 300 or kind not in ("txt", "pdf"):
            raise Problem("请填写有效的文章标题并选择文件。")
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
            raise Problem("正文需要包含 1 到 100 万个字符。")
        aid = db.execute("UPDATE article_sequence SET last_id=last_id+1 RETURNING last_id").fetchone()[0]
        db.execute("INSERT INTO articles(id,title,kind,updated) VALUES(?,?,?,?)",
                   (aid, title.strip(), kind, now()))
        db.executemany("INSERT INTO sentences(article,para,text) VALUES(?,?,?)",
                       ((aid, p, s) for p, block in enumerate(paragraphs(text)) for s in split_sentences(block)))
        if request_id is not None:
            db.execute("INSERT INTO import_requests VALUES(?,?)", (request_id, aid))
        return {"id": aid}
    match = re.fullmatch(r"/api/articles/(\d+)/(mark|remove|edit|submit|delete)", path)
    if not match:
        raise Problem("找不到请求的操作。", 404)
    aid, action = int(match[1]), match[2]
    doc = article(db, aid)
    if action == "delete":
        if body.get("version") != doc["version"]:
            raise Problem("这篇材料已有更新，请刷新书桌后再删除。", 409)
        db.execute("DELETE FROM marks WHERE sentence IN (SELECT id FROM sentences WHERE article=?)", (aid,))
        db.execute("DELETE FROM sentences WHERE article=?", (aid,))
        db.execute("DELETE FROM articles WHERE id=?", (aid,))
        return {"id": aid}
    if body.get("version") != doc["version"]:
        raise Problem("笔记已更新，请重新打开文章后操作。", 409)
    if action == "submit":
        db.execute("UPDATE articles SET state='submitted' WHERE id=?", (aid,))
    else:
        sid, idx = body.get("sentence"), body.get("token")
        sent = db.execute("SELECT text FROM sentences WHERE id=? AND article=?", (sid, aid)).fetchone()
        if not sent or type(idx) is not int or idx < 0:
            raise Problem("请选择正文里的单词。")
        words = WORD.findall(sent[0])
        if idx >= len(words):
            raise Problem("无效的单词位置。")
        if action == "mark":
            word = words[idx]
            lemma, phonetic, meaning = lookup(word)
            db.execute("INSERT OR IGNORE INTO marks VALUES(?,?,?,?,?,?)",
                       (sid, idx, word, lemma, phonetic, meaning))
        elif action == "edit":
            meaning = body.get("meaning")
            if not isinstance(meaning, str) or not meaning.strip() or len(meaning) > 8000:
                raise Problem("请填写 1 到 8000 字的释义。")
            db.execute("UPDATE marks SET meaning=? WHERE sentence=? AND token=?", (meaning.strip(), sid, idx))
        else:
            db.execute("DELETE FROM marks WHERE sentence=? AND token=?", (sid, idx))
    db.execute("UPDATE articles SET version=version+1,updated=? WHERE id=?", (now(), aid))
    return {"version": doc["version"] + 1, "marks": marks(db, aid)}


class Handler(BaseHTTPRequestHandler):
    def send(self, data, mime="application/json", status=200):
        if mime == "application/json":
            data = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", mime + ("; charset=utf-8" if mime.startswith(("text/", "application/json")) else ""))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def serve(self, method):
        path = urlsplit(self.path).path
        try:
            if self.headers.get("Host") != self.server.address_string:
                raise Problem("仅允许本机访问。", 403)
            if method == "POST":
                origin = self.headers.get("Origin")
                if (origin and origin != "http://" + self.server.address_string) or self.headers.get("X-Notebook") != "1":
                    raise Problem("仅允许从本机阅读页操作。", 403)
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= LIMIT:
                    raise Problem("文件大小应在 20 MB 以内。")
                data = self.rfile.read(size)
                if path.startswith("/api/extract/"):
                    return self.send({"text": extract(path.split("/")[-1], data)})
                if path == "/api/translate":
                    body = json.loads(data)
                    if not isinstance(body, dict):
                        raise Problem("无效的翻译请求。")
                    text = body.get("text")
                    if not isinstance(text, str) or not 0 < len(text.strip()) <= 5000:
                        raise Problem("每次请选择 1 到 5000 字符的句子。")
                    return self.send({"translation": translate_sentence(text.strip()), "provider": "MyMemory"})
                if path == "/api/speech":
                    body = json.loads(data)
                    if not isinstance(body, dict):
                        raise Problem("无效的朗读请求。")
                    text, voice, rate = body.get("text"), body.get("voice"), body.get("rate")
                    if not isinstance(text, str) or not 0 < len(text.strip()) <= 5000:
                        raise Problem("每次请选择 1 到 5000 字符的句子或单词。")
                    if not isinstance(voice, str) or voice not in SPEECH_VOICES:
                        raise Problem("请选择可用的 Edge TTS 英语语音。")
                    if not isinstance(rate, str) or rate not in SPEECH_RATES:
                        raise Problem("请选择可用的朗读语速。")
                    return self.send(speech_audio(text.strip(), voice, SPEECH_RATES[rate]), "audio/mpeg")
                with closing(connect()) as db, db:
                    result = write(db, path, json.loads(data))
                return self.send(result)
            if path == "/api/health":
                return self.send({"app": "cet6-reading-notebook", "project": str(ROOT), "data": str(DATA)})
            if path == "/api/voices":
                return self.send([{"id": key, "name": value} for key, value in SPEECH_VOICES.items()])
            files = {"/": ("index.html", "text/html"), "/app.js": ("app.js", "text/javascript"),
                     "/style.css": ("style.css", "text/css"), "/speech.js": ("speech.js", "text/javascript")}
            if path in files:
                name, mime = files[path]
                return self.send((ROOT / "web" / name).read_bytes(), mime)
            with closing(connect()) as db:
                db.execute("BEGIN")
                if path == "/api/articles":
                    query = """SELECT a.*,count(m.token) AS count FROM articles a LEFT JOIN sentences s
                               ON s.article=a.id LEFT JOIN marks m ON m.sentence=s.id
                               GROUP BY a.id ORDER BY a.updated DESC,a.id DESC"""
                    return self.send([dict(r) for r in db.execute(query)])
                if path == "/api/review":
                    query = """SELECT s.*,a.title FROM sentences s JOIN articles a ON a.id=s.article
                               WHERE a.state='submitted' AND EXISTS(SELECT 1 FROM marks m WHERE m.sentence=s.id)
                               ORDER BY a.updated DESC,a.id DESC,s.id"""
                    rows = []
                    for r in db.execute(query):
                        entries = db.execute("SELECT * FROM marks WHERE sentence=? ORDER BY token", (r["id"],))
                        rows.append({**dict(r), "marks": [dict(m) for m in entries]})
                    return self.send(rows)
                match = re.fullmatch(r"/api/articles/(\d+)", path)
                if match:
                    aid = int(match[1])
                    doc = article(db, aid)
                    doc["sentences"] = [dict(r) for r in db.execute("SELECT * FROM sentences WHERE article=? ORDER BY id", (aid,))]
                    doc["marks"] = marks(db, aid)
                    return self.send(doc)
            raise Problem("未找到。", 404)
        except Problem as exc:
            self.send({"error": str(exc)}, status=exc.status)
        except (ValueError, UnicodeError):
            self.send({"error": "请求内容格式有误。"}, status=400)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            import traceback
            traceback.print_exc()
            self.send({"error": "操作失败，请检查服务窗口并重试。"}, status=500)

    def do_GET(self):
        self.serve("GET")

    def do_POST(self):
        self.serve("POST")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--open", action="store_true")
    args = parser.parse_args()
    if not DICT.is_file():
        raise SystemExit("Offline dictionary missing: " + str(DICT))
    setup()
    for port in range(args.port, args.port + 10):
        address = f"127.0.0.1:{port}"
        url = "http://" + address
        try:
            server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            try:
                with urlopen(url + "/api/health", timeout=1) as response:
                    info = json.load(response)
                if info.get("project") == str(ROOT) and info.get("data") == str(DATA):
                    if args.open:
                        webbrowser.open(url)
                    raise SystemExit(0)
            except (ValueError, OSError):
                continue
    else:
        raise SystemExit("No available local port.")
    server.address_string = address
    print(f"CET-6 Reading Notebook  {url}\nClose this window to stop.", flush=True)
    if args.open:
        webbrowser.open(url)
    server.serve_forever()
