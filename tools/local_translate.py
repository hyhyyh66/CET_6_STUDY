"""Optional LibreTranslate 1.9.6 trial, isolated from the bundled app runtime."""
import argparse
import os
from pathlib import Path
import subprocess
import sys
import threading
from unittest.mock import patch
from wsgiref.simple_server import make_server

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / "local-translation"
for key, folder in (("XDG_DATA_HOME", "data"), ("XDG_CONFIG_HOME", "config"), ("XDG_CACHE_HOME", "cache")):
    os.environ[key] = str(LOCAL / folder)
os.environ["ARGOS_PACKAGES_DIR"] = str(LOCAL / "models")
os.environ["ARGOS_DEVICE_TYPE"] = "cpu"
os.environ["ARGOS_CHUNK_TYPE"] = "MINISBD"
os.environ["ARGOS_INTER_THREADS"] = "1"
os.environ["ARGOS_INTRA_THREADS"] = "4"


def install():
    import shutil
    from urllib.request import Request, urlopen
    from argostranslate import package, translate
    archive = LOCAL / "en-zh.argosmodel"
    if not archive.exists():
        temporary = archive.with_suffix(".download")
        print("Downloading English-Chinese model...", flush=True)
        request = Request("https://argos-net.com/v1/translate-en_zh-1_9.argosmodel", headers={"User-Agent": "Mozilla/5.0"})
        with urlopen(request, timeout=60) as response, temporary.open("wb") as target:
            shutil.copyfileobj(response, target)
        temporary.replace(archive)
    package.install_from_path(archive)
    # First translation downloads/caches the English MiniSBD model as needed.
    print(translate.translate("Reading helps us learn new words.", "en", "zh"), flush=True)
    (LOCAL / "ready").write_text("libretranslate==1.9.6\nen-zh==1.9\n", encoding="utf-8")
    print("Local translation is ready.", flush=True)


def create_local_app():
    from argostranslate import package
    if not (LOCAL / "ready").is_file() or not any(
        p.from_code == "en" and p.to_code == "zh" for p in package.get_installed_packages()
    ):
        raise RuntimeError("Run tools/setup_local_translation.ps1 first.")
    from libretranslate.main import get_parser
    from libretranslate.app import create_app
    args = get_parser().parse_args([
        "--load-only", "en,zh", "--disable-web-ui", "--disable-files-translation",
        "--frontend-language-source", "en", "--frontend-language-target", "zh",
        "--char-limit", "5000",
    ])
    # In pinned 1.9.6, boot downloads models whenever fewer than two are
    # installed. Our one-way model is intentional; install is explicit above.
    with patch("libretranslate.init.boot"):
        app = create_app(args)
    return app


def run(serve_only=False):
    print("Loading local English-Chinese translator...", flush=True)
    app = create_local_app()
    with make_server("127.0.0.1", 0, app) as service:
        url = f"http://127.0.0.1:{service.server_port}"
        print("LIBRETRANSLATE " + url, flush=True)
        if serve_only:
            service.serve_forever()
            return
        threading.Thread(target=service.serve_forever, daemon=True).start()
        child = None
        try:
            child = subprocess.Popen(
                [str(ROOT / "runtime" / "python.exe"), "-X", "utf8", str(ROOT / "server.py"), "--port", "8875", "--open"],
                cwd=ROOT, env={**os.environ, "CET6_TRANSLATION_URL": url},
            )
            return child.wait()
        finally:
            if child is not None and child.poll() is None:
                child.terminate()
                child.wait(timeout=10)
            service.shutdown()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--install", action="store_true")
    parser.add_argument("--serve-only", action="store_true")
    options = parser.parse_args()
    LOCAL.mkdir(parents=True, exist_ok=True)
    os.chdir(LOCAL)
    try:
        sys.exit(install() if options.install else run(options.serve_only))
    except KeyboardInterrupt:
        pass
