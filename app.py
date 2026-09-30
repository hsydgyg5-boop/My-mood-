import os
import json
import subprocess
import re
from urllib.parse import quote, unquote
import sys
import hashlib
import secrets
import time
import threading
import requests
import shutil
import zipfile
import signal
import psutil
import socket
import tempfile
import ast
import shlex
import unicodedata
from datetime import datetime, timedelta
from flask import Flask, send_from_directory, send_file, request, jsonify, session, redirect, make_response, Response

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# التخزين الدائم: نستخدم مسار Railway Volume إذا كان موجوداً.
# مهم: لا نستخدم db.json الموجود داخل المشروع كمصدر لبيانات المستخدمين.
DATA_DIR = (os.environ.get("MAZAGI_DATA_DIR") or
            os.environ.get("RAILWAY_VOLUME_MOUNT_PATH") or
            "/data")
try:
    os.makedirs(DATA_DIR, exist_ok=True)
except Exception:
    DATA_DIR = BASE_DIR
USERS_DIR = os.path.join(DATA_DIR, "USERS")
os.makedirs(USERS_DIR, exist_ok=True)

# مجلد PHP
PHP_DIR = os.path.join(DATA_DIR, "php_files")
os.makedirs(PHP_DIR, exist_ok=True)

app = Flask(__name__, static_folder=BASE_DIR)
app.secret_key = "MERO_HOST_STABLE_SECRET_2026_XK9"
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(days=30)
app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'

# ============== بيانات المسؤول ==============
ADMIN_USERNAME = "zzmmkj"
ADMIN_PASSWORD_RAW = "AASS1122@@"

# ============== إعدادات البوت والإشعارات ==============
BOT_TOKEN = os.environ.get("BOT_TOKEN", "").strip()
BOT_USERNAME = os.environ.get("BOT_USERNAME", "@sjsjjskbbot")
ADMIN_TELEGRAM_ID = 8394089237
ADMIN_TELEGRAM_USERNAME = "@zzmmkj"

# ============== دوال الإشعارات ==============
def notify_admin(message: str):
    try:
        requests.post(
            f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
            json={"chat_id": ADMIN_TELEGRAM_ID, "text": message, "parse_mode": "Markdown"},
            timeout=10
        )
    except Exception:
        pass

def notify_user(telegram_id: str, message: str):
    if not telegram_id:
        return
    try:
        requests.post(
            f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
            json={"chat_id": telegram_id, "text": message, "parse_mode": "Markdown"},
            timeout=10
        )
    except Exception:
        pass

def get_user_telegram_id(username: str):
    user = db["users"].get(username)
    if user:
        return user.get("telegram_id")
    return None

def get_pending_users_list():
    pending = []
    for username, data in db["users"].items():
        if data.get("status") == "pending" and username != ADMIN_USERNAME:
            pending.append({
                "username": username,
                "created_at": data.get("created_at"),
                "telegram_id": data.get("telegram_id")
            })
    return pending

# ============== قاعدة البيانات ==============
DB_FILE = os.path.join(DATA_DIR, "db.json")
BUNDLED_DB_FILE = os.path.join(BASE_DIR, "db.json")

def load_db():
    # القاعدة الدائمة هي الأساس. إذا لم توجد، نستخدم فقط لقطة portable_data/db.json إن وُجدت.
    # وجود DB_FILE يعني أن بيانات Railway الحالية لها الأولوية ولا يتم استبدالها.
    if not os.path.exists(DB_FILE):
        portable_db = os.path.join(BASE_DIR, "portable_data", "db.json")
        if os.path.exists(portable_db):
            try:
                os.makedirs(os.path.dirname(DB_FILE), exist_ok=True)
                shutil.copy2(portable_db, DB_FILE)
            except Exception:
                pass
    if os.path.exists(DB_FILE):
        try:
            with open(DB_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
                # ضمان وجود بنية قاعدة البيانات والخطط الافتراضية حتى لو كانت db.json جديدة أو فارغة.
                default_plans = {
                    "free": {"name": "🎁 مجاني", "storage": 512000, "ram": 256, "cpu": 0.5, "max_servers": 2, "price": 0},
                    "4gb": {"name": "💎 4 جيجا", "storage": 4096000, "ram": 1024, "cpu": 1, "max_servers": 5, "price": 5},
                    "10gb": {"name": "💎 10 جيجا", "storage": 10240000, "ram": 2048, "cpu": 2, "max_servers": 10, "price": 10},
                    "40gb": {"name": "💎 40 جيجا", "storage": 40960000, "ram": 4096, "cpu": 4, "max_servers": 20, "price": 25}
                }
                data.setdefault("users", {})
                data.setdefault("servers", {})
                data.setdefault("logs", [])
                data.setdefault("plans", {})
                for plan_id, plan_data in default_plans.items():
                    data["plans"].setdefault(plan_id, plan_data)

                # إصلاح حساب الأدمن تلقائياً إذا كانت قاعدة البيانات القديمة لا تحتويه.
                # لا يتم حذف أو تعديل أي مستخدم موجود.
                if ADMIN_USERNAME not in data.get("users", {}):
                    admin_hash = hashlib.sha256(ADMIN_PASSWORD_RAW.encode()).hexdigest()
                    data.setdefault("users", {})[ADMIN_USERNAME] = {
                        "password": admin_hash,
                        "is_admin": True,
                        "created_at": str(datetime.now()),
                        "max_servers": 999999,
                        "expiry_days": 3650,
                        "last_login": None,
                        "telegram_id": None,
                        "api_key": None,
                        "storage_limit": 10240,
                        "plan": "admin",
                        "status": "approved"
                    }
                    save_db(data)
                else:
                    # ضمان صلاحيات الأدمن بدون تغيير كلمة مرور الحساب الموجود.
                    data["users"][ADMIN_USERNAME]["is_admin"] = True
                    data["users"][ADMIN_USERNAME].setdefault("status", "approved")
                return data
        except Exception:
            pass
    admin_hash = hashlib.sha256(ADMIN_PASSWORD_RAW.encode()).hexdigest()
    default_db = {
        "users": {
            ADMIN_USERNAME: {
                "password": admin_hash,
                "is_admin": True,
                "created_at": str(datetime.now()),
                "max_servers": 999999,
                "expiry_days": 3650,
                "last_login": None,
                "telegram_id": None,
                "api_key": None,
                "storage_limit": 10240,
                "plan": "admin",
                "status": "approved"
            }
        },
        "servers": {},
        "logs": [],
        "plans": {
            "free": {"name": "🎁 مجاني", "storage": 512000, "ram": 256, "cpu": 0.5, "max_servers": 2, "price": 0},
            "4gb": {"name": "💎 4 جيجا", "storage": 4096000, "ram": 1024, "cpu": 1, "max_servers": 5, "price": 5},
            "10gb": {"name": "💎 10 جيجا", "storage": 10240000, "ram": 2048, "cpu": 2, "max_servers": 10, "price": 10},
            "40gb": {"name": "💎 40 جيجا", "storage": 40960000, "ram": 4096, "cpu": 4, "max_servers": 20, "price": 25}
        }
    }
    save_db(default_db)
    return default_db

def save_db(db_data):
    try:
        os.makedirs(os.path.dirname(DB_FILE), exist_ok=True)
        tmp_file = DB_FILE + '.tmp'
        with open(tmp_file, 'w', encoding='utf-8') as f:
            json.dump(db_data, f, indent=4, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_file, DB_FILE)
        # نسخة داخل المشروع للاحتفاظ بلقطة من قاعدة البيانات عند نقل/رفع المشروع.
        # لا تُستخدم إذا كانت قاعدة /data موجودة، ولا تستبدلها أبداً.
        try:
            portable_dir = os.path.join(BASE_DIR, "portable_data")
            os.makedirs(portable_dir, exist_ok=True)
            portable_tmp = os.path.join(portable_dir, "db.json.tmp")
            with open(portable_tmp, 'w', encoding='utf-8') as pf:
                json.dump(db_data, pf, indent=4, ensure_ascii=False)
                pf.flush(); os.fsync(pf.fileno())
            os.replace(portable_tmp, os.path.join(portable_dir, "db.json"))
        except Exception:
            pass
        return True
    except Exception as e:
        print(f"❌ خطأ في حفظ DB: {e}")
        return False

def safe_user_filename(filename):
    """يحافظ على الأسماء العربية/Unicode ويمنع مسارات الهروب."""
    if not filename:
        return ''
    name = unicodedata.normalize('NFC', str(filename)).replace('\\', '/').split('/')[-1]
    name = ''.join(ch for ch in name if ch >= ' ' and ch not in '\x7f')
    if name in ('', '.', '..') or '..' in name:
        return ''
    return name[:255]

def safe_child_path(base, name):
    """مسار آمن لملف/مجلد داخل مجلد السيرفر."""
    clean = safe_user_filename(name)
    if not clean:
        return None
    base_abs = os.path.abspath(base)
    path_abs = os.path.abspath(os.path.join(base_abs, clean))
    if os.path.commonpath([base_abs, path_abs]) != base_abs:
        return None
    return path_abs

def safe_relative_path(base, name):
    """مسار آمن يسمح بمجلدات فرعية مثل ملفات ZIP المفكوكة، بدون path traversal."""
    if not name:
        return None
    raw = unicodedata.normalize('NFC', str(name)).replace('\\', '/')
    parts = []
    for part in raw.split('/'):
        part = ''.join(ch for ch in part if ch >= ' ' and ch not in '\x7f')
        if part in ('', '.'):
            continue
        if part == '..':
            return None
        parts.append(part)
    if not parts:
        return None
    base_abs = os.path.abspath(base)
    path_abs = os.path.abspath(os.path.join(base_abs, *parts))
    if os.path.commonpath([base_abs, path_abs]) != base_abs:
        return None
    return path_abs

db = load_db()

def _backup_current_db_once():
    """ينشئ نسخة احتياطية غير مدمرة من قاعدة البيانات الحالية قبل أي إصلاح."""
    try:
        if not os.path.exists(DB_FILE):
            return
        backup_dir = os.path.join(DATA_DIR, "backups")
        os.makedirs(backup_dir, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        target = os.path.join(backup_dir, f"db_before_update_{stamp}.json")
        if not os.path.exists(target):
            shutil.copy2(DB_FILE, target)
    except Exception as exc:
        print(f"⚠️ تعذر إنشاء نسخة DB احتياطية: {exc}")

def _safe_server_dir(owner, folder):
    owner = safe_user_filename(owner)
    folder = safe_user_filename(folder)
    if not owner or not folder:
        return None
    return os.path.join(USERS_DIR, owner, "SERVERS", folder)

def _copy_tree_if_needed(src, dst):
    try:
        if not src or not os.path.exists(src) or os.path.exists(dst):
            return False
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if os.path.isdir(src):
            shutil.copytree(src, dst, dirs_exist_ok=True)
        else:
            shutil.copy2(src, dst)
        return True
    except Exception as exc:
        print(f"⚠️ تعذر استرجاع الملفات من {src}: {exc}")
        return False

def migrate_server_storage():
    """يربط السيرفرات القديمة بمسار /data بدون حذف أي ملف.
    إذا كانت الملفات ما زالت في المسار القديم، يتم نسخها إلى التخزين الدائم.
    """
    changed = False
    for folder, srv in db.get("servers", {}).items():
        owner = srv.get("owner")
        persistent = _safe_server_dir(owner, folder)
        if not persistent:
            continue
        os.makedirs(os.path.dirname(persistent), exist_ok=True)
        current = srv.get("path") or ""
        if os.path.abspath(current) != os.path.abspath(persistent):
            candidates = [current,
                          os.path.join(BASE_DIR, "USERS", str(owner), "SERVERS", str(folder)),
                          os.path.join("/app", "USERS", str(owner), "SERVERS", str(folder))]
            for candidate in candidates:
                if candidate and os.path.exists(candidate):
                    _copy_tree_if_needed(candidate, persistent)
                    break
            srv["path"] = persistent
            changed = True
        else:
            os.makedirs(persistent, exist_ok=True)
    if changed:
        save_db(db)

_backup_current_db_once()
migrate_server_storage()

# ============== كشف تلقائي لنوع السيرفر ==============
def auto_detect_server_type(srv_path: str, srv: dict):
    """كشف تلقائي لنوع السيرفر من الملفات الموجودة"""
    if not os.path.exists(srv_path):
        return
    
    try:
        files = os.listdir(srv_path)
        php_files = [f for f in files if f.endswith('.php')]
        js_files = [f for f in files if f.endswith('.js')]
        py_files = [f for f in files if f.endswith('.py')]
        
        if php_files:
            changed = srv.get("type") != "PHP" or not srv.get("startup_file") or not os.path.exists(os.path.join(srv_path, srv.get("startup_file", "")))
            if changed:
                srv["type"] = "PHP"; srv["startup_file"] = srv.get("startup_file") if srv.get("startup_file") in php_files else php_files[0]; save_db(db)
                return True
        if js_files:
            changed = srv.get("type") != "Node.js" or not srv.get("startup_file") or not os.path.exists(os.path.join(srv_path, srv.get("startup_file", "")))
            if changed:
                srv["type"] = "Node.js"; srv["startup_file"] = srv.get("startup_file") if srv.get("startup_file") in js_files else js_files[0]; save_db(db)
                return True
        if py_files:
            changed = srv.get("type") != "Python" or not srv.get("startup_file") or not os.path.exists(os.path.join(srv_path, srv.get("startup_file", "")))
            if changed:
                srv["type"] = "Python"; srv["startup_file"] = srv.get("startup_file") if srv.get("startup_file") in py_files else py_files[0]; save_db(db)
                return True
    except Exception as e:
        print(f"⚠️ خطأ في الكشف التلقائي: {e}")
    
    return False

# ============== تصحيح تلقائي لأنواع السيرفرات ==============
def fix_server_types():
    """تصحيح تلقائي للسيرفرات اللي نوعها غلط"""
    updated = False
    for folder, srv in db["servers"].items():
        srv_path = srv.get("path", "")
        if os.path.exists(srv_path):
            try:
                files = os.listdir(srv_path)
                php_files = [f for f in files if f.endswith('.php')]
                js_files = [f for f in files if f.endswith('.js')]
                py_files = [f for f in files if f.endswith('.py')]
                
                if php_files and srv.get("type") != "PHP":
                    srv["type"] = "PHP"
                    if not srv.get("startup_file"):
                        srv["startup_file"] = php_files[0]
                    updated = True
                    print(f"✅ تم تصحيح نوع السيرفر {srv['name']} إلى PHP")
                elif js_files and srv.get("type") != "Node.js":
                    srv["type"] = "Node.js"
                    if not srv.get("startup_file"):
                        srv["startup_file"] = js_files[0]
                    updated = True
                    print(f"✅ تم تصحيح نوع السيرفر {srv['name']} إلى Node.js")
                elif py_files and srv.get("type") != "Python":
                    srv["type"] = "Python"
                    if not srv.get("startup_file"):
                        srv["startup_file"] = py_files[0]
                    updated = True
                    print(f"✅ تم تصحيح نوع السيرفر {srv['name']} إلى Python")
            except Exception:
                pass
    if updated:
        save_db(db)
        print("✅ تم حفظ التغييرات في قاعدة البيانات")

fix_server_types()

# ============== تشغيل شامل واكتشاف المنفذ ==============
SUPPORTED_SERVER_TYPES = ("Python", "Node.js", "PHP", "Ruby", "Java", "Go", "Rust", "Static")
COMMON_WEB_PORTS = (3000, 4000, 5000, 5173, 8000, 8001, 8080, 8081, 8088, 8888, 9000)

def detect_project_type(srv_path: str):
    try:
        names = set()
        for root, dirs, files in os.walk(srv_path):
            depth = os.path.relpath(root, srv_path).count(os.sep)
            if depth > 2:
                dirs[:] = []
                continue
            names.update(n.lower() for n in files)
    except Exception:
        return "Python"
    if "package.json" in names or any(n.endswith(('.js','.mjs','.cjs')) for n in names): return "Node.js"
    if "composer.json" in names or any(n.endswith('.php') for n in names): return "PHP"
    if "cargo.toml" in names or any(n.endswith('.rs') for n in names): return "Rust"
    if "go.mod" in names or any(n.endswith('.go') for n in names): return "Go"
    if any(n in names for n in ('pom.xml','build.gradle','build.gradle.kts')) or any(n.endswith('.java') for n in names): return "Java"
    if "gemfile" in names or any(n.endswith('.rb') for n in names): return "Ruby"
    if any(n.endswith(('.html','.htm')) for n in names): return "Static"
    if any(n.endswith('.py') for n in names): return "Python"
    return "Python"

def detect_main_file(srv_path: str, server_type: str) -> str:
    if server_type == "Node.js":
        pkg=os.path.join(srv_path,'package.json')
        if os.path.exists(pkg):
            try:
                data=json.load(open(pkg,encoding='utf-8'))
                main=data.get('main','')
                if main and os.path.exists(os.path.join(srv_path,main)): return main
            except Exception: pass
        for c in ['index.js','index.mjs','server.js','app.js','main.js','bot.js']:
            if os.path.exists(os.path.join(srv_path,c)): return c
        return next((f for f in os.listdir(srv_path) if f.endswith(('.js','.mjs','.cjs'))),'')
    if server_type == "PHP":
        for c in ['index.php','main.php','app.php','start.php','run.php','bot.php']:
            if os.path.exists(os.path.join(srv_path,c)): return c
        return next((f for f in os.listdir(srv_path) if f.endswith('.php')),'')
    if server_type == "Ruby":
        for c in ['config.ru','app.rb','server.rb','main.rb','index.rb']:
            if os.path.exists(os.path.join(srv_path,c)): return c
        return next((f for f in os.listdir(srv_path) if f.endswith('.rb')),'')
    if server_type == "Java":
        for c in ['pom.xml','build.gradle','build.gradle.kts']:
            if os.path.exists(os.path.join(srv_path,c)): return c
        return next((f for f in os.listdir(srv_path) if f.endswith('.java')),'')
    if server_type == "Go":
        return 'go.mod' if os.path.exists(os.path.join(srv_path,'go.mod')) else next((f for f in os.listdir(srv_path) if f.endswith('.go')),'')
    if server_type == "Rust":
        return 'Cargo.toml' if os.path.exists(os.path.join(srv_path,'Cargo.toml')) else next((f for f in os.listdir(srv_path) if f.endswith('.rs')),'')
    if server_type == "Static":
        for c in ['index.html','index.htm','home.html']:
            if os.path.exists(os.path.join(srv_path,c)): return c
        return next((f for f in os.listdir(srv_path) if f.endswith(('.html','.htm'))),'')
    for c in ['main.py','app.py','server.py','index.py','run.py','start.py','bot.py']:
        if os.path.exists(os.path.join(srv_path,c)): return c
    return next((f for f in os.listdir(srv_path) if f.endswith('.py')),'')

def _list_process_ports(pid):
    ports=set()
    try:
        root=psutil.Process(pid); procs=[root]+root.children(recursive=True)
        for proc in procs:
            try: conns=proc.net_connections(kind='inet')
            except Exception: conns=[]
            for c in conns:
                if getattr(c,'status',None)==psutil.CONN_LISTEN and getattr(c,'laddr',None):
                    if getattr(c.laddr,'port',None): ports.add(int(c.laddr.port))
    except Exception: pass
    return ports

def _port_is_open(port):
    try:
        with socket.create_connection(('127.0.0.1',int(port)),timeout=.25): return True
    except Exception: return False

def discover_running_port(pid, preferred=None, timeout=25):
    deadline=time.time()+timeout
    while time.time()<deadline:
        candidates=set(_list_process_ports(pid))
        if preferred: candidates.add(int(preferred))
        for port in sorted(candidates):
            if _port_is_open(port): return port
        try:
            if not psutil.Process(pid).is_running(): return None
        except Exception: return None
        time.sleep(.5)
    return None

PORT_RANGE_START=8100
PORT_RANGE_END=9100

def get_assigned_port():
    used={srv.get('port') for srv in db.get('servers',{}).values() if srv.get('port')}
    for port in range(PORT_RANGE_START,PORT_RANGE_END):
        if port not in used and not _port_is_open(port): return port
    return PORT_RANGE_START

# ============== تثبيت تلقائي للمكتبات ==============
# أسماء الاستيراد الشائعة التي تختلف عن اسم الحزمة في PyPI.
PYTHON_PACKAGE_MAP = {
    "telebot": "pyTelegramBotAPI",
    "telegram": "python-telegram-bot",
    "bs4": "beautifulsoup4",
    "Crypto": "pycryptodome",
    "PIL": "Pillow",
    "cv2": "opencv-python",
    "dotenv": "python-dotenv",
    "yaml": "PyYAML",
    "dns": "dnspython",
    "jwt": "PyJWT",
    "google": "google-api-python-client",
    "googleapiclient": "google-api-python-client",
    "selenium": "selenium",
    "discord": "discord.py",
    "discord_webhook": "discord-webhook",
    "flask": "Flask",
    "fastapi": "fastapi",
    "uvicorn": "uvicorn",
    "aiohttp": "aiohttp",
    "httpx": "httpx",
    "bs4": "beautifulsoup4",
    "lxml": "lxml",
    "pandas": "pandas",
    "numpy": "numpy",
    "openpyxl": "openpyxl",
    "qrcode": "qrcode",
    "rich": "rich",
    "colorama": "colorama",
    "fake_useragent": "fake-useragent",
    "user_agent": "user-agent",
    "jwt": "PyJWT",
    "cryptography": "cryptography",
}

PYTHON_STDLIB = set(getattr(sys, "stdlib_module_names", set())) | {
    "__future__", "typing_extensions"
}


def _python_imports_from_file(py_file):
    """استخراج أسماء المكتبات الخارجية من ملف Python بدون تشغيله."""
    modules = set()
    try:
        with open(py_file, "r", encoding="utf-8", errors="ignore") as f:
            tree = ast.parse(f.read(), filename=py_file)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    modules.add(alias.name.split('.')[0])
            elif isinstance(node, ast.ImportFrom) and node.module:
                modules.add(node.module.split('.')[0])
    except Exception:
        # إذا كان الملف فيه خطأ صياغة، التشغيل نفسه سيعرض الخطأ للمستخدم.
        return set()
    return modules


def detect_python_packages(srv_path):
    """يحدد المكتبات الخارجية من كل ملفات .py الموجودة في السيرفر."""
    imports = set()
    for root, dirs, files in os.walk(srv_path):
        # لا نفحص البيئة الافتراضية أو مجلدات cache.
        dirs[:] = [d for d in dirs if d not in {".venv", "venv", "__pycache__", ".git"}]
        for name in files:
            if name.endswith(".py"):
                imports.update(_python_imports_from_file(os.path.join(root, name)))

    local_modules = set()
    for root, dirs, files in os.walk(srv_path):
        dirs[:] = [d for d in dirs if d not in {".venv", "venv", "__pycache__", ".git"}]
        for name in files:
            if name.endswith(".py"):
                local_modules.add(name[:-3])
        for d in dirs:
            if os.path.exists(os.path.join(root, d, "__init__.py")):
                local_modules.add(d)

    packages = []
    for module in sorted(imports):
        if module in PYTHON_STDLIB or module in local_modules:
            continue
        packages.append(PYTHON_PACKAGE_MAP.get(module, module))
    # إزالة التكرار مع الحفاظ على الترتيب.
    return list(dict.fromkeys(packages))


def ensure_python_environment(srv_path, log_file=None):
    """ينشئ .venv داخل السيرفر ويثبت المكتبات تلقائياً.
    إذا كان المستخدم رفع requirements.txt نستخدمه كما هو؛ وإلا ننشئه تلقائياً من imports.
    """
    try:
        venv_dir = os.path.join(srv_path, ".venv")
        venv_python = os.path.join(venv_dir, "Scripts", "python.exe") if os.name == "nt" else os.path.join(venv_dir, "bin", "python")

        if not os.path.exists(venv_python):
            if log_file:
                log_file.write("\n🧰 إنشاء بيئة Python خاصة بالسيرفر...\n")
                log_file.flush()
            subprocess.run([sys.executable, "-m", "venv", venv_dir], cwd=srv_path, stdout=log_file or subprocess.DEVNULL, stderr=subprocess.STDOUT, timeout=120, check=False)

        if not os.path.exists(venv_python):
            # fallback إذا venv غير متاح في بيئة الاستضافة.
            venv_python = sys.executable

        req_file = os.path.join(srv_path, "requirements.txt")
        generated = False
        if not os.path.exists(req_file):
            packages = detect_python_packages(srv_path)
            with open(req_file, "w", encoding="utf-8") as rf:
                rf.write("\n".join(packages) + ("\n" if packages else ""))
            generated = True
            if log_file:
                log_file.write(f"📦 تم إنشاء requirements.txt تلقائياً ({len(packages)} مكتبة)\n")
                if packages:
                    log_file.write("   " + ", ".join(packages) + "\n")
                log_file.flush()

        # إذا كان الملف موجوداً وفارغاً، لا نثبت شيئاً.
        try:
            with open(req_file, "r", encoding="utf-8", errors="ignore") as rf:
                has_requirements = bool(rf.read().strip())
        except Exception:
            has_requirements = False

        if has_requirements:
            if log_file:
                log_file.write("📦 تثبيت مكتبات Python تلقائياً...\n")
                log_file.flush()
            cmd = [venv_python, "-m", "pip", "install", "--disable-pip-version-check", "-r", req_file]
            proc = subprocess.run(cmd, cwd=srv_path, stdout=log_file or subprocess.DEVNULL, stderr=subprocess.STDOUT, timeout=300, check=False)
            if log_file:
                log_file.write("✅ اكتمل تثبيت المكتبات\n" if proc.returncode == 0 else "⚠️ بعض المكتبات لم تثبت بنجاح\n")
                log_file.flush()
        return venv_python
    except Exception as e:
        if log_file:
            log_file.write(f"\n⚠️ التثبيت التلقائي: {e}\n")
            log_file.flush()
        return sys.executable


def auto_install_deps(srv_path: str, server_type: str, log_file):
    try:
        if server_type == "Node.js":
            pkg = os.path.join(srv_path, "package.json")
            if os.path.exists(pkg):
                log_file.write("\n📦 تثبيت node_modules تلقائياً...\n")
                log_file.flush()
                proc = subprocess.Popen(["npm", "install"], cwd=srv_path, stdout=log_file, stderr=subprocess.STDOUT, env=os.environ.copy())
                proc.wait(timeout=300)
                log_file.write("✅ تم تثبيت node_modules\n" if proc.returncode == 0 else "⚠️ فشل npm install\n")
        elif server_type == "Python":
            ensure_python_environment(srv_path, log_file)
        elif server_type == "PHP":
            composer_json = os.path.join(srv_path, "composer.json")
            if os.path.exists(composer_json):
                log_file.write("\n📦 تثبيت PHP dependencies تلقائياً...\n")
                log_file.flush()
                proc = subprocess.Popen(["composer", "install", "--no-dev", "--prefer-dist"], cwd=srv_path, stdout=log_file, stderr=subprocess.STDOUT, env=os.environ.copy())
                proc.wait(timeout=300)
                log_file.write("✅ تم تثبيت PHP dependencies\n" if proc.returncode == 0 else "⚠️ فشل composer install\n")
    except Exception as e:
        log_file.write(f"\n⚠️ تثبيت تلقائي: {e}\n")
    log_file.flush()

# ============== تشغيل السيرفر ==============
def start_server_process(folder):
    srv=db['servers'].get(folder)
    if not srv: return False,'السيرفر غير موجود'
    srv_path=srv.get('path','')
    if not os.path.isdir(srv_path): return False,'مجلد المشروع غير موجود'
    detected=detect_project_type(srv_path)
    if not srv.get('type') or srv.get('type')=='Python': srv['type']=detected
    server_type=srv.get('type','Python')
    main_file=srv.get('startup_file') or detect_main_file(srv_path,server_type)
    srv['startup_file']=main_file
    if server_type=='Static':
        if not main_file: return False,'لا يوجد ملف HTML'
        srv.update(status='Running',pid=None,port=None,start_time=time.time())
        save_db(db); return True,'✅ تم تشغيل الموقع الثابت'
    if not main_file: return False,f'لا يوجد ملف تشغيل لـ {server_type}'
    file_path=os.path.join(srv_path,main_file)
    if server_type not in ('Java','Go','Rust') and not os.path.exists(file_path): return False,f"الملف '{main_file}' غير موجود"
    preferred=srv.get('port') or get_assigned_port(); srv['port']=preferred
    log_path=os.path.join(srv_path,'out.log'); error_path=os.path.join(srv_path,'errors.log')
    log_file=open(log_path,'a',encoding='utf-8'); log_file.write(f"\n{'='*60}\n🚀 بدء التشغيل {datetime.now()}\n📁 {main_file}\n🔌 المنفذ المطلوب: {preferred}\n🏷 النوع: {server_type}\n{'='*60}\n"); log_file.flush()
    env=os.environ.copy(); env.update(PORT=str(preferred),SERVER_PORT=str(preferred),HOST='0.0.0.0',HOSTNAME='0.0.0.0')
    try:
        if server_type=='Node.js':
            pkg=os.path.join(srv_path,'package.json')
            use_npm=False
            if os.path.exists(pkg):
                try: use_npm=bool(json.load(open(pkg,encoding='utf-8')).get('scripts',{}).get('start'))
                except Exception: pass
            cmd=['npm','run','start'] if use_npm else ['node',main_file]
        elif server_type=='PHP': cmd=['php','-S',f'0.0.0.0:{preferred}','-t',srv_path]
        elif server_type=='Ruby': cmd=['bundle','exec','rackup','-o','0.0.0.0','-p',str(preferred)] if main_file=='config.ru' and shutil.which('bundle') else ['ruby',main_file]
        elif server_type=='Java':
            if os.path.exists(os.path.join(srv_path,'mvnw')): cmd=['./mvnw','spring-boot:run']
            elif os.path.exists(os.path.join(srv_path,'gradlew')): cmd=['./gradlew','bootRun']
            elif shutil.which('mvn') and os.path.exists(os.path.join(srv_path,'pom.xml')): cmd=['mvn','spring-boot:run']
            elif shutil.which('gradle') and os.path.exists(os.path.join(srv_path,'build.gradle')): cmd=['gradle','bootRun']
            else:
                jf=main_file if main_file.endswith('.java') else next((x for x in os.listdir(srv_path) if x.endswith('.java')),'')
                if not jf: return False,'لا يوجد مشروع Java قابل للتشغيل'
                cls=os.path.splitext(jf)[0]; cmd=['sh','-lc',f'javac {shlex.quote(jf)} && java {shlex.quote(cls)}']
        elif server_type=='Go': cmd=['go','run','.'] if os.path.exists(os.path.join(srv_path,'go.mod')) else ['go','run',main_file]
        elif server_type=='Rust': cmd=['cargo','run','--release']
        else:
            with open(log_path,'a',encoding='utf-8') as dep_log: python_bin=ensure_python_environment(srv_path,dep_log)
            cmd=[python_bin,'-u',main_file]
        proc=subprocess.Popen(cmd,cwd=srv_path,stdout=log_file,stderr=open(error_path,'a',encoding='utf-8'),env=env,preexec_fn=os.setsid if hasattr(os,'setsid') else None)
        srv.update(pid=proc.pid,status='Starting',start_time=time.time()); save_db(db)
        def settle():
            actual=discover_running_port(proc.pid,preferred,30)
            try:
                if actual:
                    srv.update(port=actual,status='Running')
                    with open(log_path,'a',encoding='utf-8') as lf: lf.write(f'\n✅ الموقع يستمع فعلياً على المنفذ {actual}\n')
                elif proc.poll() is not None:
                    srv.update(status='Stopped',pid=None)
                    with open(log_path,'a',encoding='utf-8') as lf: lf.write(f'\n❌ انتهت العملية برمز {proc.returncode}; راجع errors.log\n')
                else:
                    srv['status']='Running'
                    with open(log_path,'a',encoding='utf-8') as lf: lf.write('\nℹ️ العملية تعمل لكن لم يتم اكتشاف منفذ HTTP.\n')
                save_db(db)
            except Exception: pass
        threading.Thread(target=settle,daemon=True).start()
        return True,'🚀 بدأ التشغيل — يتم اكتشاف المنفذ الحقيقي تلقائياً'
    except FileNotFoundError:
        srv.update(status='Stopped',pid=None); save_db(db); return False,f'❌ المشغّل غير موجود لهذا النوع: {server_type}'
    except Exception as e:
        srv.update(status='Stopped',pid=None); save_db(db)
        try: log_file.write(f'\n❌ خطأ: {e}\n')
        except Exception: pass
        return False,str(e)

def stop_server_process(folder):
    srv = db["servers"].get(folder)
    if not srv:
        return
    if srv.get("pid"):
        try:
            p = psutil.Process(srv["pid"])
            if hasattr(os, 'killpg'):
                try:
                    os.killpg(os.getpgid(p.pid), signal.SIGTERM)
                except Exception:
                    pass
            for child in p.children(recursive=True):
                child.kill()
            p.kill()
        except Exception:
            pass
    srv["status"] = "Stopped"
    srv["pid"] = None
    save_db(db)

def restart_server(folder):
    stop_server_process(folder)
    time.sleep(2)
    start_server_process(folder)

# ============== مراقبة العمليات ==============
def process_monitor():
    while True:
        try:
            for folder, srv in list(db["servers"].items()):
                if srv.get("type") != "Static" and srv.get("status") == "Running" and srv.get("pid"):
                    try:
                        p = psutil.Process(srv["pid"])
                        if not p.is_running() or p.status() == psutil.STATUS_ZOMBIE:
                            restart_server(folder)
                    except psutil.NoSuchProcess:
                        restart_server(folder)
                    except Exception:
                        pass
        except Exception:
            pass
        time.sleep(15)

threading.Thread(target=process_monitor, daemon=True).start()

# ============== دوال مساعدة ==============
def get_current_user():
    if "username" in session:
        return db["users"].get(session["username"])
    return None

def get_user_servers_dir(username):
    path = os.path.join(USERS_DIR, username, "SERVERS")
    os.makedirs(path, exist_ok=True)
    return path

def is_admin(username):
    if username == ADMIN_USERNAME:
        return True
    u = db["users"].get(username)
    return u.get("is_admin", False) if u else False

def get_public_ip():
    try:
        return requests.get('https://api.ipify.org', timeout=3).text
    except Exception:
        return "127.0.0.1"

def generate_api_key():
    return secrets.token_urlsafe(32)

def get_user_by_api_key(api_key):
    for username, udata in db["users"].items():
        if udata.get("api_key") == api_key:
            return username, udata
    return None, None

def uptime_str(start_time):
    if not start_time:
        return "0 ثانية"
    diff = time.time() - start_time
    days = int(diff // 86400)
    hours = int((diff % 86400) // 3600)
    mins = int((diff % 3600) // 60)
    parts = []
    if days > 0: parts.append(f"{days} يوم")
    if hours > 0: parts.append(f"{hours} ساعة")
    if mins > 0: parts.append(f"{mins} دقيقة")
    return " و ".join(parts) if parts else "أقل من دقيقة"

def _check_admin_access():
    if "username" in session and is_admin(session["username"]):
        return True
    api_key = None
    if request.is_json:
        try:
            api_key = request.get_json().get("api_key")
        except Exception:
            pass
    if not api_key:
        api_key = request.args.get("api_key")
    if api_key:
        username, user = get_user_by_api_key(api_key)
        if username and is_admin(username):
            return True
    return False

# ============== الصفحات ==============
@app.route('/')
def home():
    if 'username' not in session:
        return redirect('/login')
    return redirect('/dashboard')

@app.route('/login')
def login_page():
    if 'username' in session:
        return redirect('/')
    return send_from_directory(BASE_DIR, 'login.html')

@app.route('/dashboard')
def dashboard():
    if 'username' not in session:
        return redirect('/login')
    return send_from_directory(BASE_DIR, 'index.html')

@app.route('/admin')
def admin_panel():
    if 'username' not in session or not is_admin(session['username']):
        return redirect('/login')
    return send_from_directory(BASE_DIR, 'admin_panel.html')

# ============== API المصادقة ==============
@app.route('/api/register', methods=['POST'])
def api_register():
    data = request.get_json()
    username = data.get("username", "").strip()
    password = data.get("password", "").strip()
    telegram_id = data.get("telegram_id", "").strip()

    if not username or not password:
        return jsonify({"success": False, "message": "جميع الحقول مطلوبة"})
    if len(username) < 3:
        return jsonify({"success": False, "message": "اسم المستخدم 3 أحرف على الأقل"})
    if len(password) < 4:
        return jsonify({"success": False, "message": "كلمة المرور 4 أحرف على الأقل"})
    if username in db["users"]:
        return jsonify({"success": False, "message": "اسم المستخدم موجود بالفعل"})
    if username == ADMIN_USERNAME:
        return jsonify({"success": False, "message": "لا يمكن استخدام هذا الاسم"})

    db["users"][username] = {
        "password": hashlib.sha256(password.encode()).hexdigest(),
        "is_admin": False,
        "created_at": str(datetime.now()),
        "max_servers": db["plans"]["free"]["max_servers"],
        "expiry_days": 365,
        "last_login": None,
        "telegram_id": telegram_id if telegram_id else None,
        "api_key": None,
        "storage_limit": db["plans"]["free"]["storage"],
        "plan": "free",
        "status": "pending"
    }
    save_db(db)

    user_dir = os.path.join(USERS_DIR, username)
    os.makedirs(user_dir, exist_ok=True)
    os.makedirs(os.path.join(user_dir, "SERVERS"), exist_ok=True)

    admin_msg = (
        f"🔔 *طلب تسجيل جديد في مزاجي!*\n"
        f"👤 المستخدم: `{username}`\n"
        f"📅 {datetime.now().strftime('%Y-%m-%d %H:%M')}\n"
        f"📱 تليجرام: {telegram_id or 'غير مرتبط'}\n\n"
        f"للقبول: `/approve_{username}`\n"
        f"للرفض: `/reject_{username}`"
    )
    threading.Thread(
        target=notify_admin,
        args=(admin_msg,),
        daemon=True
    ).start()

    return jsonify({
        "success": True,
        "message": "✅ تم إرسال طلب التسجيل للمطور. سيتم إعلامك عند الموافقة."
    })

@app.route('/api/login', methods=['POST'])
def api_login():
    data = request.get_json()
    username = data.get("username", "").strip()
    password = data.get("password", "").strip()

    if username == ADMIN_USERNAME and password == ADMIN_PASSWORD_RAW:
        session.clear()
        session['username'] = username
        session.permanent = True
        db["users"][ADMIN_USERNAME]["last_login"] = str(datetime.now())
        save_db(db)
        return jsonify({"success": True, "redirect": "/dashboard", "is_admin": True})

    user = db["users"].get(username)
    if not user:
        return jsonify({"success": False, "message": "المستخدم غير موجود"})
    
    if user.get("status") == "pending":
        return jsonify({"success": False, "message": "⏳ حسابك في انتظار موافقة المطور"})
    if user.get("status") == "rejected":
        return jsonify({"success": False, "message": "❌ تم رفض حسابك من قبل المطور"})
    
    if user["password"] == hashlib.sha256(password.encode()).hexdigest():
        session.clear()
        session['username'] = username
        session.permanent = True
        user["last_login"] = str(datetime.now())
        save_db(db)
        return jsonify({"success": True, "redirect": "/dashboard", "is_admin": False})

    return jsonify({"success": False, "message": "بيانات غير صحيحة"})

@app.route('/api/logout', methods=['GET', 'POST'])
def api_logout():
    session.clear()
    response = make_response(jsonify({"success": True}))
    response.set_cookie('session', '', expires=0)
    return response

@app.route('/api/current_user')
def api_current_user():
    if "username" in session:
        u = db["users"].get(session["username"])
        if u:
            return jsonify({
                "success": True,
                "username": session["username"],
                "is_admin": u.get("is_admin", False) or session["username"] == ADMIN_USERNAME,
                "plan": u.get("plan", "free"),
                "status": u.get("status", "approved")
            })
    return jsonify({"success": False})

# ============== دوال قبول ورفض المستخدمين ==============
@app.route('/api/admin/approve-user', methods=['POST'])
def approve_user():
    if 'username' not in session or not is_admin(session['username']):
        return jsonify({"success": False, "message": "غير مصرح"}), 403
    
    data = request.get_json()
    username = data.get("username", "").strip()
    
    if not username:
        return jsonify({"success": False, "message": "اسم المستخدم مطلوب"})
    
    if username not in db["users"]:
        return jsonify({"success": False, "message": "المستخدم غير موجود"})
    
    user = db["users"][username]
    user["status"] = "approved"
    save_db(db)
    
    tg_id = user.get("telegram_id")
    if tg_id:
        msg = (
            f"🎉 *تم قبول حسابك في مزاجي!*\n"
            f"👤 المستخدم: `{username}`\n"
            f"✅ يمكنك الآن تسجيل الدخول واستخدام خدماتنا.\n\n"
            f"🔗 {ADMIN_TELEGRAM_USERNAME}"
        )
        threading.Thread(target=notify_user, args=(tg_id, msg), daemon=True).start()
    
    notify_admin(f"✅ تم قبول المستخدم `{username}`")
    
    return jsonify({"success": True, "message": f"✅ تم قبول المستخدم {username}"})

@app.route('/api/admin/reject-user', methods=['POST'])
def reject_user():
    if 'username' not in session or not is_admin(session['username']):
        return jsonify({"success": False, "message": "غير مصرح"}), 403
    
    data = request.get_json()
    username = data.get("username", "").strip()
    
    if not username:
        return jsonify({"success": False, "message": "اسم المستخدم مطلوب"})
    
    if username not in db["users"]:
        return jsonify({"success": False, "message": "المستخدم غير موجود"})
    
    user = db["users"][username]
    user["status"] = "rejected"
    save_db(db)
    
    tg_id = user.get("telegram_id")
    if tg_id:
        msg = (
            f"❌ *تم رفض حسابك في مزاجي*\n"
            f"👤 المستخدم: `{username}`\n"
            f"للتواصل مع الدعم: {ADMIN_TELEGRAM_USERNAME}"
        )
        threading.Thread(target=notify_user, args=(tg_id, msg), daemon=True).start()
    
    notify_admin(f"❌ تم رفض المستخدم `{username}`")
    
    return jsonify({"success": True, "message": f"❌ تم رفض المستخدم {username}"})

@app.route('/api/admin/pending-users', methods=['GET'])
def get_pending_users():
    if 'username' not in session or not is_admin(session['username']):
        return jsonify({"success": False, "message": "غير مصرح"}), 403
    
    pending = []
    for username, data in db["users"].items():
        if data.get("status") == "pending" and username != ADMIN_USERNAME:
            pending.append({
                "username": username,
                "created_at": data.get("created_at"),
                "telegram_id": data.get("telegram_id"),
                "plan": data.get("plan", "free")
            })
    
    return jsonify({"success": True, "users": pending})

# ============== أوامر البوت للقبول والرفض ==============
@app.route('/webhook', methods=['POST'])
def telegram_webhook():
    data = request.get_json()
    
    if 'message' not in data:
        return jsonify({"status": "ok"})
    
    msg = data['message']
    chat_id = msg.get('chat', {}).get('id')
    text = msg.get('text', '').strip()
    
    if str(chat_id) != str(ADMIN_TELEGRAM_ID):
        return jsonify({"status": "ok"})
    
    if text.startswith('/approve_'):
        username = text.replace('/approve_', '').strip()
        if username in db["users"] and db["users"][username].get("status") == "pending":
            db["users"][username]["status"] = "approved"
            save_db(db)
            
            tg_id = db["users"][username].get("telegram_id")
            if tg_id:
                msg = (
                    f"🎉 *تم قبول حسابك في مزاجي!*\n"
                    f"👤 المستخدم: `{username}`\n"
                    f"✅ يمكنك الآن تسجيل الدخول."
                )
                threading.Thread(target=notify_user, args=(tg_id, msg), daemon=True).start()
            
            requests.post(
                f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
                json={"chat_id": chat_id, "text": f"✅ تم قبول المستخدم `{username}`"},
                timeout=10
            )
        else:
            requests.post(
                f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
                json={"chat_id": chat_id, "text": f"❌ المستخدم `{username}` غير موجود أو غير معلق"},
                timeout=10
            )
    
    elif text.startswith('/reject_'):
        username = text.replace('/reject_', '').strip()
        if username in db["users"] and db["users"][username].get("status") == "pending":
            db["users"][username]["status"] = "rejected"
            save_db(db)
            
            tg_id = db["users"][username].get("telegram_id")
            if tg_id:
                msg = (
                    f"❌ *تم رفض حسابك في مزاجي*\n"
                    f"👤 المستخدم: `{username}`\n"
                    f"للتواصل مع الدعم: {ADMIN_TELEGRAM_USERNAME}"
                )
                threading.Thread(target=notify_user, args=(tg_id, msg), daemon=True).start()
            
            requests.post(
                f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
                json={"chat_id": chat_id, "text": f"❌ تم رفض المستخدم `{username}`"},
                timeout=10
            )
        else:
            requests.post(
                f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
                json={"chat_id": chat_id, "text": f"❌ المستخدم `{username}` غير موجود أو غير معلق"},
                timeout=10
            )
    
    return jsonify({"status": "ok"})

@app.route('/api/bot/set_webhook', methods=['GET', 'POST'])
def set_webhook():
    base_url = request.host_url.rstrip('/')
    webhook_url = f"{base_url}/webhook"
    
    try:
        response = requests.post(
            f"https://api.telegram.org/bot{BOT_TOKEN}/setWebhook",
            json={"url": webhook_url}
        )
        return jsonify(response.json())
    except Exception as e:
        return jsonify({"success": False, "message": str(e)})

# ============== API Key ==============
@app.route('/api/create_api_key', methods=['POST'])
def create_api_key():
    if 'username' not in session:
        return jsonify({"success": False, "message": "غير مصرح"}), 401
    username = session['username']
    new_key = generate_api_key()
    db["users"][username]["api_key"] = new_key
    save_db(db)
    return jsonify({"success": True, "api_key": new_key, "message": "تم إنشاء مفتاح API"})

@app.route('/api/link_telegram', methods=['POST'])
def link_telegram():
    if 'username' not in session:
        return jsonify({"success": False, "message": "غير مصرح"}), 401
    data = request.get_json()
    tg_id = str(data.get('telegram_id', ''))
    if not tg_id:
        return jsonify({"success": False, "message": "معرف تليجرام مطلوب"})
    db["users"][session['username']]["telegram_id"] = tg_id
    save_db(db)
    return jsonify({"success": True, "message": "تم ربط حساب التليجرام"})

# ============== API الخطط ==============
@app.route('/api/plans')
def get_plans():
    return jsonify({"success": True, "plans": db.get("plans", {})})

@app.route('/api/user/upgrade', methods=['POST'])
def upgrade_plan():
    if 'username' not in session:
        return jsonify({"success": False, "message": "غير مصرح"}), 401
    data = request.get_json()
    plan_id = data.get("plan_id")
    if not plan_id or plan_id not in db.get("plans", {}):
        return jsonify({"success": False, "message": "خطة غير موجودة"})
    
    plan = db["plans"][plan_id]
    username = session['username']
    user = db["users"][username]
    
    user["plan"] = plan_id
    user["max_servers"] = plan["max_servers"]
    user["storage_limit"] = plan["storage"]
    
    save_db(db)
    
    threading.Thread(
        target=notify_admin,
        args=(
            f"💎 *ترقية خطة جديدة!*\n"
            f"👤 المستخدم: `{username}`\n"
            f"📦 الخطة: {plan['name']}\n"
            f"💰 السعر: {plan['price']}$",
        ),
        daemon=True
    ).start()
    
    return jsonify({"success": True, "message": f"✅ تم ترقية حسابك إلى {plan['name']}"})

# ============== API الإدارة - المستخدمون ==============
@app.route('/api/admin/users')
def admin_users():
    if not _check_admin_access():
        return jsonify({"success": False}), 403
    users_list = []
    for uname, udata in db["users"].items():
        users_list.append({
            "username": uname,
            "is_admin": udata.get("is_admin", False),
            "created_at": udata.get("created_at"),
            "last_login": udata.get("last_login"),
            "max_servers": udata.get("max_servers", 1),
            "expiry_days": udata.get("expiry_days", 365),
            "telegram_id": udata.get("telegram_id"),
            "api_key": udata.get("api_key"),
            "plan": udata.get("plan", "free"),
            "status": udata.get("status", "approved")
        })
    return jsonify({"success": True, "users": users_list})

@app.route('/api/admin/create-user', methods=['POST'])
def admin_create_user():
    if not _check_admin_access():
        return jsonify({"success": False}), 403
    data = request.get_json()
    username = data.get("username", "").strip()
    password = data.get("password", "").strip()
    max_servers = int(data.get("max_servers", 2))
    expiry_days = int(data.get("expiry_days", 365))
    if not username or not password:
        return jsonify({"success": False, "message": "جميع الحقول مطلوبة"})
    if username in db["users"]:
        return jsonify({"success": False, "message": "المستخدم موجود"})
    db["users"][username] = {
        "password": hashlib.sha256(password.encode()).hexdigest(),
        "is_admin": False,
        "created_at": str(datetime.now()),
        "max_servers": max_servers,
        "expiry_days": expiry_days,
        "last_login": None,
        "telegram_id": None,
        "api_key": None,
        "storage_limit": 512000,
        "plan": "free",
        "status": "approved"
    }
    save_db(db)
    user_dir = os.path.join(USERS_DIR, username)
    os.makedirs(user_dir, exist_ok=True)
    os.makedirs(os.path.join(user_dir, "SERVERS"), exist_ok=True)
    return jsonify({"success": True, "message": "✅ تم إنشاء الحساب"})

@app.route('/api/admin/delete-user', methods=['POST'])
def admin_delete_user():
    if not _check_admin_access():
        return jsonify({"success": False}), 403
    data = request.get_json()
    username = data.get("username", "").strip()
    if not username or username == ADMIN_USERNAME:
        return jsonify({"success": False, "message": "لا يمكن حذف هذا المستخدم"})
    if username in db["users"]:
        for fid in [fid for fid, srv in db["servers"].items() if srv["owner"] == username]:
            stop_server_process(fid)
            if os.path.exists(db["servers"][fid]["path"]):
                shutil.rmtree(db["servers"][fid]["path"], ignore_errors=True)
            del db["servers"][fid]
        user_dir = os.path.join(USERS_DIR, username)
        if os.path.exists(user_dir):
            shutil.rmtree(user_dir, ignore_errors=True)
        del db["users"][username]
        save_db(db)
        return jsonify({"success": True, "message": f"🗑 تم حذف المستخدم {username}"})
    return jsonify({"success": False, "message": "المستخدم غير موجود"})

@app.route('/api/admin/update-user', methods=['POST'])
def admin_update_user():
    if not _check_admin_access():
        return jsonify({"success": False}), 403
    data = request.get_json()
    username = data.get("username", "").strip()
    if username not in db["users"]:
        return jsonify({"success": False, "message": "المستخدم غير موجود"})
    u = db["users"][username]
    if "max_servers" in data:
        u["max_servers"] = int(data["max_servers"])
    if "expiry_days" in data:
        u["expiry_days"] = int(data["expiry_days"])
    if "is_admin" in data:
        u["is_admin"] = bool(data["is_admin"])
    if "storage_limit" in data:
        u["storage_limit"] = int(data["storage_limit"])
    save_db(db)
    return jsonify({"success": True, "message": f"✅ تم تحديث {username}"})

# ============== API النظام ==============
@app.route('/api/system/metrics')
def get_metrics():
    return jsonify({
        "cpu": psutil.cpu_percent(),
        "memory": psutil.virtual_memory().percent,
        "disk": psutil.disk_usage('/').percent
    })

@app.route('/api/ping', methods=['GET', 'POST'])
def ping():
    return jsonify({"status": "pong", "timestamp": str(datetime.now())})

# ============== السيرفرات ==============

# ============== زر فتح السيرفر: بوت تليجرام أو موقع ==============
def find_telegram_bot_token(srv_path: str):
    """يبحث عن توكن بوت تليجرام داخل ملفات السيرفر بدون تغيير الملفات."""
    token_re = re.compile(r'(?<![A-Za-z0-9:_-])\d{6,12}:[A-Za-z0-9_-]{30,50}(?![A-Za-z0-9_-])')
    skip_ext = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.zip', '.pyc', '.db', '.sqlite', '.sqlite3'}
    try:
        for root, dirs, files in os.walk(srv_path):
            dirs[:] = [d for d in dirs if d not in {'.venv', 'venv', 'node_modules', '__pycache__'}]
            for filename in files:
                if os.path.splitext(filename)[1].lower() in skip_ext:
                    continue
                path = os.path.join(root, filename)
                try:
                    if os.path.getsize(path) > 2 * 1024 * 1024:
                        continue
                    with open(path, 'r', encoding='utf-8', errors='ignore') as fh:
                        text = fh.read()
                    match = token_re.search(text)
                    if match:
                        return match.group(0)
                except Exception:
                    continue
    except Exception:
        pass
    return None

def get_server_open_url(folder: str, srv: dict):
    token=find_telegram_bot_token(srv.get('path',''))
    if token:
        try:
            tg=requests.get(f'https://api.telegram.org/bot{token}/getMe',timeout=8).json(); username=(tg.get('result') or {}).get('username')
            if username: return {'kind':'telegram','url':f'https://t.me/{username}','label':'فتح'}
        except Exception: pass
    return {'kind':'website','url':f"{request.host_url.rstrip('/')}/site/{quote(folder,safe='')}/",'label':'فتح'}

@app.route('/api/server/open/<folder>')
def server_open(folder):
    if 'username' not in session: return jsonify({'success':False,'message':'غير مصرح'}),401
    srv=db['servers'].get(folder)
    if not srv or srv.get('owner')!=session['username']: return jsonify({'success':False,'message':'غير مصرح'}),403
    return jsonify({'success':True,**get_server_open_url(folder,srv)})

def _rewrite_site_html(html,prefix):
    # Root-relative attributes
    pat=r'(?P<a>(?:href|src|action|poster|data-src|data-href)\s*=\s*["\'])/(?P<p>(?!/)[^"\']*)'
    html=re.sub(pat,lambda m:m.group('a')+prefix+'/'+m.group('p'),html,flags=re.I)
    html=re.sub(r'url\(\s*(["\']?)/(?!/)',lambda m:'url('+m.group(1)+prefix+'/',html,flags=re.I)
    p=json.dumps(prefix)
    bridge="""<script>(function(){const P=%s;function R(u){try{if(typeof u!=='string')return u;if(u[0]=='/'&&u.slice(0,2)!=='//'&&!u.startsWith(P+'/'))return P+u}catch(e){}return u}const F=window.fetch;window.fetch=function(i,o){if(typeof i==='string')i=R(i);return F.call(this,i,o)};const O=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){arguments[1]=R(u);return O.apply(this,arguments)};})();</script>""" % p
    low=html.lower(); idx=low.find('</head>')
    return html[:idx]+bridge+html[idx:] if idx>=0 else bridge+html

def _proxy_headers(upstream,prefix):
    out=[]
    for k,v in upstream.headers.items():
        kl=k.lower()
        if kl in {'content-encoding','content-length','transfer-encoding','connection'}: continue
        if kl=='location' and v.startswith('/') and not v.startswith(prefix+'/'): v=prefix+v
        if kl=='set-cookie': v=re.sub(r'(?i)(?:;\s*)?Path=/', '; Path='+prefix+'/', v)
        out.append((k,v))
    return out

@app.route('/site/<folder>/',defaults={'subpath':''},methods=['GET','POST','PUT','PATCH','DELETE','OPTIONS','HEAD'])
@app.route('/site/<folder>/<path:subpath>',methods=['GET','POST','PUT','PATCH','DELETE','OPTIONS','HEAD'])
def proxy_user_site(folder,subpath):
    folder=unquote(folder); srv=db['servers'].get(folder)
    if not srv: return 'الموقع غير موجود',404
    if srv.get('owner')!=session.get('username'): return 'غير مصرح',403
    prefix='/site/'+quote(folder,safe='')
    if srv.get('type')=='Static':
        base=os.path.abspath(srv.get('path','')); rel=subpath or srv.get('startup_file') or 'index.html'; target=safe_relative_path(base,rel)
        if not target or not os.path.isfile(target): return 'الملف غير موجود',404
        try:
            from mimetypes import guess_type; ctype=guess_type(target)[0] or ''
            if 'text/html' in ctype:
                html=open(target,'r',encoding='utf-8',errors='ignore').read(); return Response(_rewrite_site_html(html,prefix),content_type='text/html; charset=utf-8')
        except Exception: pass
        return send_file(target)
    if srv.get('status') not in ('Running','Starting'): return 'الموقع متوقف حالياً. شغّل السيرفر ثم اضغط فتح مرة أخرى.',503
    port=srv.get('port')
    if not port: return 'لم يتم اكتشاف منفذ HTTP لهذا المشروع. إذا كان المشروع بوتاً فقط فلا يوجد موقع لفتحه.',503
    target_path='/'+subpath
    if request.query_string: target_path+='?'+request.query_string.decode('utf-8',errors='ignore')
    try:
        upstream=requests.request(request.method,f'http://127.0.0.1:{int(port)}{target_path}',headers={k:v for k,v in request.headers.items() if k.lower() not in {'host','content-length'}},data=request.get_data(),cookies=request.cookies,allow_redirects=False,timeout=45,stream=True)
        headers=_proxy_headers(upstream,prefix); ctype=upstream.headers.get('Content-Type','')
        if 'text/html' in ctype:
            raw=upstream.content.decode(upstream.encoding or 'utf-8',errors='replace'); return Response(_rewrite_site_html(raw,prefix),status=upstream.status_code,headers=headers,content_type='text/html; charset=utf-8')
        return Response(upstream.iter_content(chunk_size=8192),status=upstream.status_code,headers=headers)
    except Exception as e: return f'تعذر فتح الموقع: {e}',502

@app.route('/api/servers')
def list_servers():
    if "username" not in session:
        return jsonify({"success": False}), 401
    user_servers = []
    total_disk_used_mb = 0.0
    for folder, srv in db["servers"].items():
        if srv["owner"] == session["username"]:
            disk_used = 0
            if os.path.exists(srv["path"]):
                try:
                    for root, dirs, files in os.walk(srv["path"]):
                        for f in files:
                            fp = os.path.join(root, f)
                            try:
                                disk_used += os.path.getsize(fp)
                            except Exception:
                                pass
                except Exception:
                    pass
            disk_used_mb = round(disk_used / (1024 * 1024), 2)
            total_disk_used_mb += disk_used_mb
            user_servers.append({
                "folder": folder,
                "title": srv["name"],
                "subtitle": f"سيرفر {srv.get('type', 'Python')}",
                "type": srv.get("type", "Python"),
                "startup_file": srv.get("startup_file", ""),
                "status": srv.get("status", "Stopped"),
                "uptime": uptime_str(srv.get("start_time")) if srv.get("status") == "Running" else "0 ثانية",
                "port": srv.get("port", "N/A"),
                "plan": srv.get("plan", "free"),
                "storage_limit": srv.get("storage_limit", 100),
                "ram_limit": srv.get("ram_limit", 256),
                "cpu_limit": srv.get("cpu_limit", 0.5),
                "disk_used": disk_used_mb,
                "can_open": bool(srv.get("port")),
                "open_kind": "telegram" if find_telegram_bot_token(srv.get("path", "")) else "website"
            })
    user = db["users"].get(session["username"], {})
    return jsonify({
        "success": True,
        "servers": user_servers,
        "stats": {
            "used": len(user_servers),
            "total": user.get("max_servers", 2),
            "expiry": user.get("expiry_days", 365),
            "disk_used": round(total_disk_used_mb, 2),
            "disk_total": user.get("storage_limit", 512000),
        }
    })

@app.route('/api/server/add', methods=['POST'])
def add_server():
    if "username" not in session:
        return jsonify({"success": False, "message": "غير مصرح"}), 401
    user = db["users"].get(session["username"])
    if not user:
        return jsonify({"success": False, "message": "مستخدم غير موجود"})
    
    user_srv_count = len([s for s in db["servers"].values() if s["owner"] == session["username"]])
    if user_srv_count >= user.get("max_servers", 2):
        return jsonify({"success": False, "message": f"وصلت للحد الأقصى ({user.get('max_servers', 2)}) سيرفر."})
    
    data = request.get_json()
    name = data.get("name", "").strip()
    if not name:
        return jsonify({"success": False, "message": "الرجاء إدخال اسم للسيرفر"})
    
    server_type = data.get("server_type", "Python")
    if server_type not in ("Python", "Node.js", "PHP"):
        server_type = "Python"
    
    plan_id = user.get("plan", "free")
    plan = db["plans"].get(plan_id, db["plans"]["free"])
    
    folder = f"{session['username']}_{re.sub(r'[^a-zA-Z0-9]', '', name)}_{int(time.time())}"
    path = os.path.join(get_user_servers_dir(session["username"]), folder)
    os.makedirs(path, exist_ok=True)
    assigned_port = get_assigned_port()
    
    db["servers"][folder] = {
        "name": name,
        "owner": session["username"],
        "path": path,
        "type": server_type,
        "status": "Stopped",
        "created_at": str(datetime.now()),
        "startup_file": "",
        "pid": None,
        "port": assigned_port,
        "plan": plan_id,
        "storage_limit": plan["storage"],
        "ram_limit": plan["ram"],
        "cpu_limit": plan["cpu"]
    }
    save_db(db)
    return jsonify({"success": True, "message": f"✅ تم إنشاء الخادم {name}"})

@app.route('/api/server/action/<folder>/<action>', methods=['POST'])
def server_action(folder, action):
    if "username" not in session:
        return jsonify({"success": False}), 401
    srv = db["servers"].get(folder)
    if not srv or srv["owner"] != session["username"]:
        return jsonify({"success": False, "message": "غير مصرح"})
    if action == "start":
        if srv.get("status") == "Running":
            return jsonify({"success": False, "message": "الخادم يعمل بالفعل"})
        ok, msg = start_server_process(folder)
        return jsonify({"success": ok, "message": msg})
    elif action == "stop":
        stop_server_process(folder)
        return jsonify({"success": True, "message": "🛑 تم الإيقاف"})
    elif action == "restart":
        restart_server(folder)
        return jsonify({"success": True, "message": "🔄 تم إعادة التشغيل"})
    elif action == "delete":
        stop_server_process(folder)
        if os.path.exists(srv["path"]):
            shutil.rmtree(srv["path"], ignore_errors=True)
        del db["servers"][folder]
        save_db(db)
        return jsonify({"success": True, "message": "🗑 تم الحذف"})
    return jsonify({"success": False})

@app.route('/api/server/stats/<folder>')
def get_server_stats(folder):
    if "username" not in session:
        return jsonify({"success": False}), 401
    srv = db["servers"].get(folder)
    if not srv or srv["owner"] != session["username"]:
        return jsonify({"success": False})
    status = srv.get("status", "Stopped")
    logs = "لا توجد مخرجات بعد"
    log_path = os.path.join(srv["path"], "out.log")
    if os.path.exists(log_path):
        try:
            with open(log_path, 'r', encoding='utf-8', errors='ignore') as f:
                lines = f.read().split('\n')
                logs = '\n'.join(lines[-500:])
        except Exception:
            pass
    errors = ""
    error_path = os.path.join(srv["path"], "errors.log")
    if os.path.exists(error_path):
        try:
            with open(error_path, 'r', encoding='utf-8', errors='ignore') as f:
                content = f.read().strip()
                if content:
                    errors = '\n'.join(content.split('\n')[-50:])
        except Exception:
            pass
    mem_info = "0 MB"
    if srv.get("pid") and status == "Running":
        try:
            p = psutil.Process(srv["pid"])
            mem_info = f"{p.memory_info().rss / (1024*1024):.1f} MB"
        except Exception:
            pass
    return jsonify({
        "success": True,
        "status": status,
        "logs": logs,
        "errors": errors,
        "mem": mem_info,
        "uptime": uptime_str(srv.get("start_time")) if status == "Running" else "0 ثانية",
        "port": srv.get("port", "--"),
        "ip": get_public_ip(),
        "type": srv.get("type", "Python")
    })

# ============== الملفات ==============
@app.route('/api/files/list/<folder>')
def list_server_files(folder):
    if "username" not in session:
        return jsonify([]), 401
    srv = db["servers"].get(folder)
    if not srv or srv["owner"] != session["username"]:
        return jsonify([]), 403
    base = os.path.abspath(srv["path"])
    files = []
    try:
        for root, dirs, names in os.walk(base):
            dirs[:] = [d for d in dirs if d not in ['__pycache__', '.git', '.venv', 'venv']]
            rel_root = os.path.relpath(root, base)
            rel_root = '' if rel_root == '.' else rel_root.replace(os.sep, '/')
            for name in dirs + names:
                if name in ['out.log', 'server.log', 'meta.json', 'errors.log']:
                    continue
                full = os.path.join(root, name)
                rel = os.path.join(rel_root, name).replace(os.sep, '/') if rel_root else name
                try:
                    stat = os.stat(full)
                    size_bytes = stat.st_size if os.path.isfile(full) else 0
                    if size_bytes < 1024:
                        size_str = f"{size_bytes} B"
                    elif size_bytes < 1024 * 1024:
                        size_str = f"{size_bytes/1024:.1f} KB"
                    else:
                        size_str = f"{size_bytes/(1024*1024):.1f} MB"
                    files.append({
                        "name": rel,
                        "size": size_str,
                        "is_dir": os.path.isdir(full),
                        "modified": datetime.fromtimestamp(stat.st_mtime).strftime('%Y-%m-%d %H:%M'),
                        "is_zip": rel.lower().endswith('.zip')
                    })
                except OSError:
                    continue
    except Exception as exc:
        return jsonify({"success": False, "message": str(exc)}), 500
    return jsonify(sorted(files, key=lambda x: (x['name'].count('/'), not x['is_dir'], x['name'].lower())))

@app.route('/api/files/download/<folder>/<path:filename>')
def download_user_file(folder, filename):
    if "username" not in session:
        return jsonify({"success": False, "message": "غير مصرح"}), 401
    srv = db["servers"].get(folder)
    if not srv or srv.get("owner") != session["username"]:
        return jsonify({"success": False, "message": "غير مصرح"}), 403
    fpath = safe_relative_path(srv["path"], filename)
    if not fpath or not os.path.isfile(fpath):
        return jsonify({"success": False, "message": "الملف غير موجود"}), 404
    return send_file(fpath, as_attachment=True, download_name=os.path.basename(fpath))

@app.route('/api/files/content/<folder>/<path:filename>')
def get_file_content(folder, filename):
    if "username" not in session:
        return jsonify({"content": ""}), 401
    srv = db["servers"].get(folder)
    if not srv or srv["owner"] != session["username"]:
        return jsonify({"content": ""}), 403
    fpath = safe_relative_path(srv["path"], filename)
    if not fpath or not os.path.isfile(fpath):
        return jsonify({"content": "", "message": "الملف غير موجود"}), 404
    try:
        with open(fpath, 'r', encoding='utf-8', errors='replace') as f:
            return jsonify({"content": f.read()})
    except Exception:
        return jsonify({"content": "[ملف ثنائي]"})

@app.route('/api/files/save/<folder>/<path:filename>', methods=['POST'])
def save_file_content(folder, filename):
    if "username" not in session:
        return jsonify({"success": False, "message": "غير مصرح"}), 401
    srv = db["servers"].get(folder)
    if not srv or srv["owner"] != session["username"]:
        return jsonify({"success": False, "message": "غير مصرح"}), 403
    fpath = safe_relative_path(srv["path"], filename)
    if not fpath or not os.path.isfile(fpath):
        return jsonify({"success": False, "message": "الملف غير موجود"}), 404
    data = request.get_json(silent=True) or {}
    try:
        with open(fpath, 'w', encoding='utf-8') as f:
            f.write(data.get("content", ""))
        return jsonify({"success": True, "message": "✅ تم الحفظ"})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500

@app.route('/api/files/upload/<folder>', methods=['POST'])
def upload_files(folder):
    if "username" not in session:
        return jsonify({"success": False}), 401
    srv = db["servers"].get(folder)
    if not srv or srv["owner"] != session["username"]:
        return jsonify({"success": False, "message": "غير مصرح"}), 403
    os.makedirs(srv["path"], exist_ok=True)
    files = request.files.getlist('files[]')
    if not files:
        return jsonify({"success": False, "message": "لا توجد ملفات"})

    uploaded = 0
    errors_list = []
    detected_type = None

    for f in files:
        try:
            if not f or not f.filename:
                continue
            filename = safe_user_filename(f.filename)
            if not filename:
                continue
            ext = os.path.splitext(filename)[1].lower()
            if ext == '.php':
                detected_type = detected_type or "PHP"
            elif ext == '.js':
                detected_type = detected_type or "Node.js"
            elif ext == '.py':
                detected_type = detected_type or "Python"
            save_path = os.path.join(srv["path"], filename)
            f.save(save_path)
            uploaded += 1
        except Exception as e:
            errors_list.append(str(e))

    if not uploaded:
        return jsonify({"success": False, "message": "فشل الرفع", "errors": errors_list})

    if detected_type:
        srv["type"] = detected_type
    auto_detect_server_type(srv["path"], srv)
    save_db(db)

    log_path = os.path.join(srv["path"], "out.log")
    threading.Thread(
        target=_auto_install_after_upload,
        args=(srv["path"], srv.get("type", "Python"), log_path),
        daemon=True
    ).start()

    msg = f"✅ تم رفع {uploaded} ملف"
    if srv.get("type") == "Python":
        msg += " — يتم إنشاء بيئة Python وتثبيت المكتبات تلقائياً"
    if errors_list:
        msg += f" (⚠️ {len(errors_list)} تحذير)"
    return jsonify({"success": True, "message": msg, "warnings": errors_list})


def _auto_install_after_upload(srv_path: str, server_type: str, log_path: str):
    try:
        with open(log_path, "a", encoding='utf-8') as lf:
            auto_install_deps(srv_path, server_type, lf)
    except Exception as e:
        try:
            with open(log_path, "a", encoding='utf-8') as lf:
                lf.write(f"\n⚠️ {e}\n")
        except Exception:
            pass


def normalize_extracted_project(path):
    """إذا كان ZIP يحتوي مجلد مشروع واحد، نرفع محتواه إلى جذر السيرفر حتى تعمل المسارات."""
    try:
        entries=[e for e in os.listdir(path) if e not in {'out.log','errors.log'}]
        meaningful=[e for e in entries if not e.lower().endswith('.zip')]
        if len(meaningful)==1 and os.path.isdir(os.path.join(path,meaningful[0])):
            nested=os.path.join(path,meaningful[0])
            for item in os.listdir(nested):
                src=os.path.join(nested,item); dst=os.path.join(path,item)
                if os.path.exists(dst):
                    if os.path.isdir(src) and os.path.isdir(dst): shutil.copytree(src,dst,dirs_exist_ok=True); shutil.rmtree(src,ignore_errors=True)
                    else: continue
                else: shutil.move(src,dst)
            shutil.rmtree(nested,ignore_errors=True)
    except Exception:
        pass

@app.route('/api/server/auto-upload', methods=['POST'])
def auto_create_server_from_upload():
    """رفع ملف مباشرة من لوحة المستخدم وإنشاء السيرفر تلقائياً."""
    if "username" not in session:
        return jsonify({"success": False, "message": "غير مصرح"}), 401

    user = db["users"].get(session["username"])
    if not user:
        return jsonify({"success": False, "message": "مستخدم غير موجود"}), 404

    user_srv_count = len([s for s in db["servers"].values() if s.get("owner") == session["username"]])
    if user_srv_count >= user.get("max_servers", 2):
        return jsonify({"success": False, "message": f"وصلت للحد الأقصى ({user.get('max_servers', 2)}) سيرفر."})

    f = request.files.get('file')
    if not f or not f.filename:
        return jsonify({"success": False, "message": "اختر ملفاً أولاً"})

    filename = safe_user_filename(f.filename)
    if not filename:
        return jsonify({"success": False, "message": "اسم الملف غير صالح"})

    ext = os.path.splitext(filename)[1].lower()
    if ext == '.py': server_type='Python'
    elif ext in ('.js','.mjs','.cjs'): server_type='Node.js'
    elif ext == '.php': server_type='PHP'
    elif ext == '.rb': server_type='Ruby'
    elif ext == '.java': server_type='Java'
    elif ext == '.go': server_type='Go'
    elif ext == '.rs': server_type='Rust'
    elif ext in ('.html','.htm'): server_type='Static'
    elif ext == '.zip': server_type='Python'
    else: return jsonify({"success":False,"message":"ارفع مشروع ويب أو ZIP أو Python/Node/PHP/Ruby/Java/Go/Rust/HTML"})

    base_name = os.path.splitext(filename)[0]
    safe_name = re.sub(r'[^a-zA-Z0-9_-]+', '', base_name) or "my-server"
    server_name = base_name[:40] or "سيرفري الجديد"
    folder = f"{session['username']}_{safe_name}_{int(time.time())}"
    path = os.path.join(get_user_servers_dir(session["username"]), folder)
    os.makedirs(path, exist_ok=True)

    plan_id = user.get("plan", "free")
    plan = db["plans"].get(plan_id, db["plans"]["free"])
    assigned_port = get_assigned_port()
    startup_file = filename if ext in {'.py','.js','.mjs','.cjs','.php','.rb','.java','.go','.rs','.html','.htm'} else ""

    try:
        f.save(os.path.join(path, filename))
        if ext == '.zip':
            zip_path = os.path.join(path, filename)
            with zipfile.ZipFile(zip_path, 'r') as zf:
                if zf.testzip():
                    raise ValueError("ملف ZIP تالف")
                zf.extractall(path)
            normalize_extracted_project(path)
            # تحديد نوع المشروع وملف التشغيل من المحتوى بعد فك الضغط.
            server_type = detect_project_type(path)
            startup_file = detect_main_file(path, server_type)

        db["servers"][folder] = {
            "name": server_name,
            "owner": session["username"],
            "path": path,
            "type": server_type,
            "status": "Stopped",
            "created_at": str(datetime.now()),
            "startup_file": startup_file,
            "pid": None,
            "port": assigned_port,
            "plan": plan_id,
            "storage_limit": plan["storage"],
            "ram_limit": plan["ram"],
            "cpu_limit": plan["cpu"]
        }
        save_db(db)

        log_path = os.path.join(path, "out.log")
        def install_and_start():
            try:
                with open(log_path, "a", encoding="utf-8") as lf:
                    auto_install_deps(path, server_type, lf)
                ok, start_msg = start_server_process(folder)
                with open(log_path, "a", encoding="utf-8") as lf:
                    lf.write(f"\n🚀 التشغيل التلقائي: {start_msg}\n")
            except Exception as exc:
                try:
                    with open(log_path, "a", encoding="utf-8") as lf:
                        lf.write(f"\n❌ التشغيل التلقائي: {exc}\n")
                except Exception:
                    pass
        threading.Thread(target=install_and_start, daemon=True).start()
        return jsonify({"success": True, "message": "✅ تم إنشاء السيرفر ورفع الملف — جاري تثبيت المكتبات وتشغيله تلقائياً", "folder": folder, "server_type": server_type})
    except Exception as e:
        shutil.rmtree(path, ignore_errors=True)
        return jsonify({"success": False, "message": f"فشل إنشاء السيرفر: {e}"}), 500

@app.route('/api/files/replace/<folder>/<path:filename>', methods=['POST'])
def replace_file(folder, filename):
    """استبدال ملف موجود مباشرة بدون حذفه أولاً."""
    if "username" not in session:
        return jsonify({"success": False, "message": "غير مصرح"}), 401
    srv = db["servers"].get(folder)
    if not srv or srv["owner"] != session["username"]:
        return jsonify({"success": False, "message": "غير مصرح"}), 403
    if not filename or filename.startswith('/'):
        return jsonify({"success": False, "message": "اسم ملف غير صالح"}), 400
    target = safe_relative_path(srv["path"], filename)
    if not target:
        return jsonify({"success": False, "message": "اسم ملف غير صالح"}), 400
    if os.path.isdir(target):
        return jsonify({"success": False, "message": "لا يمكن استبدال مجلد"}), 400
    if not os.path.exists(target):
        return jsonify({"success": False, "message": "الملف الأصلي غير موجود"}), 404
    new_file = request.files.get('file')
    if not new_file or not new_file.filename:
        return jsonify({"success": False, "message": "اختر الملف الجديد أولاً"}), 400
    try:
        # نكتب إلى ملف مؤقت ثم نستبدل الملف ذرياً، حتى لا يبقى الملف ناقصاً إذا انقطع الرفع.
        temp_path = target + '.replace_tmp'
        new_file.save(temp_path)
        os.replace(temp_path, target)

        # إذا كان الملف المستبدل هو ملف التشغيل، أبقِ startup_file كما هو.
        auto_detect_server_type(srv["path"], srv)
        save_db(db)

        # إعادة تثبيت الاعتمادات عند استبدال ملف Python/Node/PHP، في حال تغيّرت المتطلبات.
        log_path = os.path.join(srv["path"], "out.log")
        threading.Thread(
            target=_auto_install_after_upload,
            args=(srv["path"], srv.get("type", "Python"), log_path),
            daemon=True
        ).start()

        return jsonify({
            "success": True,
            "message": f"✅ تم استبدال {filename} بنجاح"
        })
    except Exception as e:
        try:
            if os.path.exists(temp_path):
                os.remove(temp_path)
        except Exception:
            pass
        return jsonify({"success": False, "message": f"فشل الاستبدال: {e}"}), 500


@app.route('/api/files/rename/<folder>', methods=['POST'])
def rename_file(folder):
    if "username" not in session:
        return jsonify({"success": False}), 401
    srv = db["servers"].get(folder)
    if not srv or srv["owner"] != session["username"]:
        return jsonify({"success": False})
    data = request.get_json() or {}
    old_name = data.get("old_name", "").strip()
    new_name = safe_user_filename(data.get("new_name", "").strip())
    if not old_name or not new_name:
        return jsonify({"success": False, "message": "اسم غير صالح"})
    old_path = safe_relative_path(srv["path"], old_name)
    new_path = safe_relative_path(os.path.dirname(old_path) if old_path else srv["path"], new_name) if old_path else None
    if not old_path or not new_path:
        return jsonify({"success": False, "message": "اسم غير صالح"})
    if not os.path.exists(old_path):
        return jsonify({"success": False, "message": "الملف غير موجود"})
    if os.path.exists(new_path):
        return jsonify({"success": False, "message": "يوجد ملف بهذا الاسم"})
    try:
        os.rename(old_path, new_path)
        if srv.get("startup_file") == old_name:
            srv["startup_file"] = new_name
        save_db(db)
        return jsonify({"success": True, "message": f"✅ تمت إعادة التسمية إلى {new_name}"})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)})

@app.route('/api/files/unzip/<folder>/<path:filename>', methods=['POST'])
def unzip_file(folder, filename):
    if "username" not in session:
        return jsonify({"success": False}), 401
    srv = db["servers"].get(folder)
    if not srv or srv["owner"] != session["username"]:
        return jsonify({"success": False})
    if not filename.lower().endswith('.zip'):
        return jsonify({"success": False, "message": "الملف ليس zip"})
    zip_path = safe_relative_path(srv["path"], filename)
    if not zip_path:
        return jsonify({"success": False, "message": "اسم ملف غير صالح"})
    if not os.path.exists(zip_path):
        return jsonify({"success": False, "message": "الملف غير موجود"})
    try:
        with zipfile.ZipFile(zip_path, 'r') as zf:
            bad = zf.testzip()
            if bad:
                return jsonify({"success": False, "message": f"ملف ZIP تالف: {bad}"})
            base = os.path.abspath(srv["path"])
            for member in zf.infolist():
                member_name = member.filename.replace('\\', '/')
                dest = os.path.abspath(os.path.join(base, member_name))
                if os.path.commonpath([base, dest]) != base:
                    return jsonify({"success": False, "message": "ZIP يحتوي مساراً غير آمن"}), 400
            zf.extractall(base)
        # كشف تلقائي بعد فك الضغط + حفظ
        auto_detect_server_type(srv["path"], srv)
        save_db(db)
        return jsonify({"success": True, "message": f"✅ تم فك ضغط {filename}"})
    except zipfile.BadZipFile:
        return jsonify({"success": False, "message": "ملف ZIP غير صالح"})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)})

@app.route('/api/files/delete/<folder>', methods=['POST'])
def delete_files(folder):
    if "username" not in session:
        return jsonify({"success": False}), 401
    srv = db["servers"].get(folder)
    if not srv or srv["owner"] != session["username"]:
        return jsonify({"success": False})
    data = request.get_json() or {}
    names = data.get("names", data.get("name", []))
    if isinstance(names, str):
        names = [names]
    deleted = 0
    for name in names:
        if not name or '..' in name:
            continue
        fpath = safe_relative_path(srv["path"], name)
        if not fpath:
            continue
        try:
            if os.path.isdir(fpath):
                shutil.rmtree(fpath)
            elif os.path.exists(fpath):
                os.remove(fpath)
            deleted += 1
        except Exception:
            pass
    if deleted > 0:
        # كشف تلقائي بعد الحذف + حفظ قاعدة البيانات
        auto_detect_server_type(srv["path"], srv)
        save_db(db)
        return jsonify({"success": True, "message": f"🗑 تم حذف {deleted} ملف"})
    return jsonify({"success": False, "message": "فشل الحذف"})

@app.route('/api/files/delete-all/<folder>', methods=['POST'])
def delete_all_files(folder):
    if 'username' not in session: return jsonify({'success':False,'message':'غير مصرح'}),401
    srv=db['servers'].get(folder)
    if not srv or srv.get('owner')!=session['username']: return jsonify({'success':False,'message':'غير مصرح'}),403
    base=os.path.abspath(srv.get('path',''))
    if not os.path.isdir(base): return jsonify({'success':False,'message':'مجلد السيرفر غير موجود'}),404
    stop_server_process(folder); deleted=0
    try:
        for name in os.listdir(base):
            target=os.path.join(base,name)
            try:
                if os.path.isdir(target) and not os.path.islink(target): shutil.rmtree(target)
                else: os.remove(target)
                deleted+=1
            except Exception: pass
        srv.update(startup_file='',status='Stopped',pid=None,port=get_assigned_port()); save_db(db)
        return jsonify({'success':True,'message':f'🗑 تم حذف كل الملفات والمجلدات ({deleted})'})
    except Exception as e: return jsonify({'success':False,'message':f'فشل حذف الكل: {e}'}),500

@app.route('/api/files/create-folder/<folder>', methods=['POST'])
def create_folder_api(folder):
    if 'username' not in session: return jsonify({'success':False,'message':'غير مصرح'}),401
    srv=db['servers'].get(folder)
    if not srv or srv.get('owner')!=session['username']: return jsonify({'success':False,'message':'غير مصرح'}),403
    data=request.get_json() or {}; name=safe_relative_path(srv['path'],data.get('filename','').strip())
    if not name: return jsonify({'success':False,'message':'اسم المجلد غير صالح'}),400
    if os.path.exists(name): return jsonify({'success':False,'message':'المجلد موجود مسبقاً'}),409
    try: os.makedirs(name); return jsonify({'success':True,'message':'📁 تم إنشاء المجلد'})
    except Exception as e: return jsonify({'success':False,'message':str(e)}),500

@app.route('/api/files/create/<folder>', methods=['POST'])
def create_file_api(folder):
    if "username" not in session:
        return jsonify({"success": False}), 401
    srv = db["servers"].get(folder)
    if not srv or srv["owner"] != session["username"]:
        return jsonify({"success": False})
    data = request.get_json()
    filename = safe_user_filename(data.get("filename", "").strip())
    if not filename:
        return jsonify({"success": False, "message": "اسم غير صالح"})
    fpath = os.path.join(srv["path"], filename)
    try:
        with open(fpath, 'w', encoding='utf-8') as f:
            f.write(data.get("content", ""))
        # كشف تلقائي بعد الإنشاء + حفظ
        auto_detect_server_type(srv["path"], srv)
        save_db(db)
        return jsonify({"success": True, "message": f"✅ تم إنشاء {filename}"})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)})

@app.route('/api/server/set-startup/<folder>', methods=['POST'])
def set_startup_file(folder):
    if "username" not in session:
        return jsonify({"success": False}), 401
    srv = db["servers"].get(folder)
    if not srv or srv["owner"] != session["username"]:
        return jsonify({"success": False})
    data = request.get_json()
    filename = safe_user_filename(data.get("filename", "").strip())
    if not filename:
        return jsonify({"success": False, "message": "اسم غير صالح"})
    if not os.path.exists(os.path.join(srv["path"], filename)):
        return jsonify({"success": False, "message": "الملف غير موجود"})
    srv["startup_file"] = filename
    save_db(db)
    return jsonify({"success": True, "message": f"✅ تم تعيين {filename} كملف التشغيل"})

@app.route('/api/admin/server-files/<folder>')
def admin_server_files(folder):
    if not _check_admin_access():
        return jsonify({"success": False, "message": "غير مصرح"}), 403
    srv = db["servers"].get(folder)
    if not srv:
        return jsonify({"success": False, "message": "السيرفر غير موجود"}), 404
    files = []
    base = srv.get("path", "")
    if not os.path.isdir(base):
        return jsonify({"success": True, "files": []})
    for root_dir, dirs, names in os.walk(base):
        dirs[:] = [d for d in dirs if d not in {'.venv', '__pycache__'}]
        for name in names:
            if name in {'out.log','errors.log','server.log','meta.json'}:
                continue
            full = os.path.join(root_dir, name)
            rel = os.path.relpath(full, base).replace(os.sep, '/')
            try:
                size = os.path.getsize(full)
            except Exception:
                size = 0
            files.append({"name": rel, "size": size})
    return jsonify({"success": True, "owner": srv.get("owner"), "server": srv.get("name"), "files": sorted(files, key=lambda x: x["name"].lower())})

@app.route('/api/admin/file/download/<folder>/<path:filename>')
def admin_download_file(folder, filename):
    if not _check_admin_access():
        return jsonify({"success": False, "message": "غير مصرح"}), 403
    srv = db["servers"].get(folder)
    if not srv:
        return jsonify({"success": False, "message": "السيرفر غير موجود"}), 404
    rel = os.path.normpath(filename).replace('\\', '/')
    if rel.startswith('../') or rel == '..' or rel.startswith('/'):
        return jsonify({"success": False, "message": "مسار غير صالح"}), 400
    fpath = os.path.abspath(os.path.join(srv["path"], rel))
    base = os.path.abspath(srv["path"])
    if not (fpath == base or fpath.startswith(base + os.sep)) or not os.path.isfile(fpath):
        return jsonify({"success": False, "message": "الملف غير موجود"}), 404
    return send_file(fpath, as_attachment=True, download_name=os.path.basename(fpath))

@app.route('/api/admin/file/delete/<folder>', methods=['POST'])
def admin_delete_file(folder):
    if not _check_admin_access():
        return jsonify({"success": False, "message": "غير مصرح"}), 403
    srv = db["servers"].get(folder)
    if not srv:
        return jsonify({"success": False, "message": "السيرفر غير موجود"}), 404
    data = request.get_json() or {}
    name = data.get("name", "")
    if not name:
        return jsonify({"success": False, "message": "اسم الملف مطلوب"}), 400
    rel = os.path.normpath(name).replace('\\', '/')
    if rel.startswith('../') or rel == '..' or rel.startswith('/'):
        return jsonify({"success": False, "message": "مسار غير صالح"}), 400
    fpath = os.path.abspath(os.path.join(srv["path"], rel))
    base = os.path.abspath(srv["path"])
    if not fpath.startswith(base + os.sep) or not os.path.exists(fpath):
        return jsonify({"success": False, "message": "الملف غير موجود"}), 404
    try:
        if os.path.isdir(fpath):
            shutil.rmtree(fpath)
        else:
            os.remove(fpath)
        save_db(db)
        return jsonify({"success": True, "message": "🗑 تم حذف الملف من السيرفر"})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500

@app.route('/api/admin/server/download-all/<folder>')
def admin_download_server(folder):
    if not _check_admin_access():
        return jsonify({"success": False, "message": "غير مصرح"}), 403
    srv = db["servers"].get(folder)
    if not srv or not os.path.isdir(srv.get("path", "")):
        return jsonify({"success": False, "message": "السيرفر غير موجود"}), 404
    temp_base = os.path.join(tempfile.gettempdir(), f"mazagi_admin_{secrets.token_hex(8)}")
    os.makedirs(temp_base, exist_ok=True)
    archive_base = os.path.join(temp_base, f"{safe_user_filename(srv.get('name','server')) or 'server'}")
    try:
        shutil.make_archive(archive_base, 'zip', srv["path"])
        return send_file(archive_base + '.zip', as_attachment=True, download_name=(safe_user_filename(srv.get('name','server')) or 'server') + '.zip')
    except Exception as e:
        shutil.rmtree(temp_base, ignore_errors=True)
        return jsonify({"success": False, "message": str(e)}), 500

@app.route('/api/server/install/<folder>', methods=['POST'])
def install_requirements(folder):
    if "username" not in session:
        return jsonify({"success": False}), 401
    srv = db["servers"].get(folder)
    if not srv or srv["owner"] != session["username"]:
        return jsonify({"success": False})
    server_type = srv.get("type", "Python")
    log_path = os.path.join(srv["path"], "out.log")
    
    if server_type == "Node.js":
        deps_file = os.path.join(srv["path"], "package.json")
        file_name = "package.json"
        if not os.path.exists(deps_file):
            return jsonify({"success": False, "message": f"{file_name} غير موجود"})
        try:
            with open(log_path, "a", encoding='utf-8') as lf:
                lf.write(f"\n{'='*50}\n📦 تثبيت Node.js...\n{'='*50}\n")
            cmd = ["npm", "install"]
            proc = subprocess.Popen(
                cmd,
                cwd=srv["path"],
                stdout=open(log_path, "a", encoding='utf-8'),
                stderr=subprocess.STDOUT
            )
            def wait_install():
                proc.wait()
                with open(log_path, "a", encoding='utf-8') as lf:
                    lf.write("\n✅ تم!\n" if proc.returncode == 0 else "\n❌ فشل\n")
            threading.Thread(target=wait_install, daemon=True).start()
            return jsonify({"success": True, "message": "📦 بدأ تثبيت Node.js dependencies"})
        except Exception as e:
            return jsonify({"success": False, "message": str(e)})
    
    elif server_type == "PHP":
        deps_file = os.path.join(srv["path"], "composer.json")
        file_name = "composer.json"
        if not os.path.exists(deps_file):
            return jsonify({"success": False, "message": f"{file_name} غير موجود"})
        try:
            with open(log_path, "a", encoding='utf-8') as lf:
                lf.write(f"\n{'='*50}\n📦 تثبيت PHP (composer)...\n{'='*50}\n")
            cmd = ["composer", "install", "--no-dev", "--prefer-dist"]
            proc = subprocess.Popen(
                cmd,
                cwd=srv["path"],
                stdout=open(log_path, "a", encoding='utf-8'),
                stderr=subprocess.STDOUT
            )
            def wait_install():
                proc.wait()
                with open(log_path, "a", encoding='utf-8') as lf:
                    lf.write("\n✅ تم!\n" if proc.returncode == 0 else "\n❌ فشل\n")
            threading.Thread(target=wait_install, daemon=True).start()
            return jsonify({"success": True, "message": "📦 بدأ تثبيت PHP dependencies"})
        except Exception as e:
            return jsonify({"success": False, "message": str(e)})
    
    else:
        deps_file = os.path.join(srv["path"], "requirements.txt")
        file_name = "requirements.txt"
        if not os.path.exists(deps_file):
            return jsonify({"success": False, "message": f"{file_name} غير موجود"})
        try:
            with open(log_path, "a", encoding='utf-8') as lf:
                lf.write(f"\n{'='*50}\n📦 تثبيت Python...\n{'='*50}\n")
            cmd = [sys.executable, "-m", "pip", "install", "-r", "requirements.txt"]
            proc = subprocess.Popen(
                cmd,
                cwd=srv["path"],
                stdout=open(log_path, "a", encoding='utf-8'),
                stderr=subprocess.STDOUT
            )
            def wait_install():
                proc.wait()
                with open(log_path, "a", encoding='utf-8') as lf:
                    lf.write("\n✅ تم!\n" if proc.returncode == 0 else "\n❌ فشل\n")
            threading.Thread(target=wait_install, daemon=True).start()
            return jsonify({"success": True, "message": "📦 بدأ تثبيت Python dependencies"})
        except Exception as e:
            return jsonify({"success": False, "message": str(e)})

# ============== API البوت ==============
@app.route('/api/bot/verify', methods=['POST'])
def bot_verify():
    data = request.get_json()
    api_key = data.get('api_key', '').strip()
    if not api_key:
        return jsonify({"success": False, "message": "API Key مطلوب"})
    username, user = get_user_by_api_key(api_key)
    if not username:
        return jsonify({"success": False, "message": "API Key غير صالح"})
    return jsonify({
        "success": True,
        "username": username,
        "is_admin": is_admin(username),
        "max_servers": user.get("max_servers", 2),
        "expiry_days": user.get("expiry_days", 365)
    })

@app.route('/api/bot/servers', methods=['GET'])
def bot_list_servers():
    api_key = request.args.get('api_key')
    if not api_key:
        return jsonify({"success": False, "message": "API Key مطلوب"}), 401
    username, _ = get_user_by_api_key(api_key)
    if not username:
        return jsonify({"success": False, "message": "API Key غير صالح"}), 401
    user_servers = []
    for folder, srv in db["servers"].items():
        if srv["owner"] == username:
            user_servers.append({
                "folder": folder,
                "title": srv["name"],
                "status": srv.get("status", "Stopped"),
                "uptime": uptime_str(srv.get("start_time")) if srv.get("status") == "Running" else "0 ثانية",
                "port": srv.get("port", "N/A"),
                "plan": srv.get("plan", "free"),
                "type": srv.get("type", "Python"),
                "storage_limit": srv.get("storage_limit", 100),
                "ram_limit": srv.get("ram_limit", 256),
                "cpu_limit": srv.get("cpu_limit", 0.5)
            })
    return jsonify({"success": True, "servers": user_servers})

@app.route('/api/bot/server/action', methods=['POST'])
def bot_server_action():
    data = request.get_json()
    api_key = data.get('api_key')
    folder = data.get('folder')
    action = data.get('action')
    if not all([api_key, folder, action]):
        return jsonify({"success": False, "message": "بيانات ناقصة"}), 400
    username, _ = get_user_by_api_key(api_key)
    if not username:
        return jsonify({"success": False, "message": "API Key غير صالح"}), 401
    srv = db["servers"].get(folder)
    if not srv or srv["owner"] != username:
        return jsonify({"success": False, "message": "غير مصرح"}), 403
    if action == "start":
        if srv.get("status") == "Running":
            return jsonify({"success": False, "message": "السيرفر يعمل بالفعل"})
        ok, msg = start_server_process(folder)
        return jsonify({"success": ok, "message": msg})
    elif action == "stop":
        stop_server_process(folder)
        return jsonify({"success": True, "message": "🛑 تم الإيقاف"})
    elif action == "restart":
        restart_server(folder)
        return jsonify({"success": True, "message": "🔄 تم إعادة التشغيل"})
    elif action == "delete":
        stop_server_process(folder)
        if os.path.exists(srv["path"]):
            shutil.rmtree(srv["path"], ignore_errors=True)
        del db["servers"][folder]
        save_db(db)
        return jsonify({"success": True, "message": "🗑 تم الحذف"})
    return jsonify({"success": False, "message": "إجراء غير معروف"})

@app.route('/api/bot/console', methods=['GET'])
def bot_console():
    api_key = request.args.get('api_key')
    folder = request.args.get('folder')
    if not api_key or not folder:
        return jsonify({"success": False, "message": "بيانات ناقصة"}), 400
    username, _ = get_user_by_api_key(api_key)
    if not username:
        return jsonify({"success": False, "message": "API Key غير صالح"}), 401
    srv = db["servers"].get(folder)
    if not srv or srv["owner"] != username:
        return jsonify({"success": False, "message": "غير مصرح"}), 403
    log_path = os.path.join(srv["path"], "out.log")
    logs = "لا توجد مخرجات بعد"
    if os.path.exists(log_path):
        try:
            with open(log_path, 'r', encoding='utf-8', errors='ignore') as f:
                lines = f.read().split('\n')
                logs = '\n'.join(lines[-500:])
        except Exception:
            pass
    return jsonify({"success": True, "logs": logs})

@app.route('/api/bot/errors', methods=['GET'])
def bot_errors():
    api_key = request.args.get('api_key')
    folder = request.args.get('folder')
    if not api_key or not folder:
        return jsonify({"success": False, "message": "بيانات ناقصة"}), 400
    username, _ = get_user_by_api_key(api_key)
    if not username:
        return jsonify({"success": False, "message": "API Key غير صالح"}), 401
    srv = db["servers"].get(folder)
    if not srv or srv["owner"] != username:
        return jsonify({"success": False, "message": "غير مصرح"}), 403
    errors = "✅ لا توجد أخطاء مسجلة"
    error_path = os.path.join(srv["path"], "errors.log")
    if os.path.exists(error_path):
        try:
            with open(error_path, 'r', encoding='utf-8', errors='ignore') as f:
                content = f.read().strip()
                if content:
                    errors = '\n'.join(content.split('\n')[-300:])
        except Exception:
            pass
    return jsonify({"success": True, "errors": errors})

@app.route('/api/bot/install', methods=['POST'])
def bot_install():
    data = request.get_json()
    api_key = data.get('api_key')
    folder = data.get('folder')
    if not api_key or not folder:
        return jsonify({"success": False, "message": "بيانات ناقصة"}), 400
    username, _ = get_user_by_api_key(api_key)
    if not username:
        return jsonify({"success": False, "message": "API Key غير صالح"}), 401
    srv = db["servers"].get(folder)
    if not srv or srv["owner"] != username:
        return jsonify({"success": False, "message": "غير مصرح"}), 403
    server_type = srv.get("type", "Python")
    log_path = os.path.join(srv["path"], "out.log")
    
    if server_type == "Node.js":
        if not os.path.exists(os.path.join(srv["path"], "package.json")):
            return jsonify({"success": False, "message": "package.json غير موجود"}), 404
    elif server_type == "PHP":
        if not os.path.exists(os.path.join(srv["path"], "composer.json")):
            return jsonify({"success": False, "message": "composer.json غير موجود"}), 404
    else:
        if not os.path.exists(os.path.join(srv["path"], "requirements.txt")):
            return jsonify({"success": False, "message": "requirements.txt غير موجود"}), 404
    
    try:
        with open(log_path, "a", encoding='utf-8') as lf:
            lf.write(f"\n{'='*50}\n📦 بدء تثبيت ({server_type})...\n{'='*50}\n")
        
        if server_type == "Node.js":
            cmd = ["npm", "install"]
        elif server_type == "PHP":
            cmd = ["composer", "install", "--no-dev", "--prefer-dist"]
        else:
            cmd = [sys.executable, "-m", "pip", "install", "-r", "requirements.txt"]
        
        proc = subprocess.Popen(cmd, cwd=srv["path"], stdout=open(log_path, "a", encoding='utf-8'), stderr=subprocess.STDOUT)
        def wait_install():
            proc.wait()
            with open(log_path, "a", encoding='utf-8') as lf:
                lf.write("\n✅ تم التثبيت!\n" if proc.returncode == 0 else "\n❌ فشل التثبيت\n")
        threading.Thread(target=wait_install, daemon=True).start()
        return jsonify({"success": True, "message": f"📦 بدأ تثبيت {server_type} dependencies"})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500

@app.route('/api/bot/create_server', methods=['POST'])
def bot_create_server():
    data = request.get_json()
    api_key = data.get('api_key')
    name = data.get('name', '').strip()
    server_type = data.get('server_type', 'Python')
    if not api_key:
        return jsonify({"success": False, "message": "API Key مطلوب"}), 400
    if not name:
        return jsonify({"success": False, "message": "الرجاء إدخال اسم للسيرفر"}), 400
    username, user = get_user_by_api_key(api_key)
    if not username:
        return jsonify({"success": False, "message": "API Key غير صالح"}), 401
    user_srv_count = len([s for s in db["servers"].values() if s["owner"] == username])
    max_allowed = user.get("max_servers", 2)
    if user_srv_count >= max_allowed:
        return jsonify({"success": False, "message": f"وصلت للحد الأقصى ({max_allowed}) سيرفر"})
    if server_type not in ("Python", "Node.js", "PHP"):
        server_type = "Python"
    
    plan_id = user.get("plan", "free")
    plan = db["plans"].get(plan_id, db["plans"]["free"])
    
    folder = f"{username}_{re.sub(r'[^a-zA-Z0-9]', '', name)}_{int(time.time())}"
    path = os.path.join(get_user_servers_dir(username), folder)
    os.makedirs(path, exist_ok=True)
    assigned_port = get_assigned_port()
    db["servers"][folder] = {
        "name": name,
        "owner": username,
        "path": path,
        "type": server_type,
        "status": "Stopped",
        "created_at": str(datetime.now()),
        "startup_file": "",
        "pid": None,
        "port": assigned_port,
        "plan": plan_id,
        "storage_limit": plan["storage"],
        "ram_limit": plan["ram"],
        "cpu_limit": plan["cpu"]
    }
    save_db(db)
    return jsonify({"success": True, "message": f"✅ تم إنشاء السيرفر {name}", "folder": folder, "port": assigned_port})

@app.route('/api/bot/set_startup', methods=['POST'])
def bot_set_startup():
    data = request.get_json()
    api_key = data.get('api_key')
    folder = data.get('folder')
    filename = data.get('filename')
    if not all([api_key, folder, filename]):
        return jsonify({"success": False, "message": "بيانات ناقصة"}), 400
    username, _ = get_user_by_api_key(api_key)
    if not username:
        return jsonify({"success": False, "message": "API Key غير صالح"}), 401
    srv = db["servers"].get(folder)
    if not srv or srv["owner"] != username:
        return jsonify({"success": False, "message": "غير مصرح"}), 403
    file_path = os.path.join(srv["path"], filename)
    if not os.path.exists(file_path):
        return jsonify({"success": False, "message": "الملف غير موجود"}), 404
    srv["startup_file"] = filename
    save_db(db)
    return jsonify({"success": True, "message": f"✅ تم تعيين {filename} كملف التشغيل"})

# ============== دعم PHP ==============
@app.route('/api/php/run', methods=['POST'])
def run_php_code():
    if 'username' not in session:
        return jsonify({"success": False, "message": "غير مصرح"}), 401
    
    data = request.get_json()
    code = data.get('code', '').strip()
    
    if not code:
        return jsonify({"success": False, "message": "الكود مطلوب"})
    
    try:
        with tempfile.NamedTemporaryFile(mode='w', suffix='.php', delete=False, encoding='utf-8') as f:
            f.write('<?php\n')
            f.write(code)
            f.write('\n?>')
            temp_path = f.name
        
        result = subprocess.run(
            ['php', temp_path],
            capture_output=True,
            text=True,
            timeout=10
        )
        
        try:
            os.unlink(temp_path)
        except Exception:
            pass
        
        return jsonify({
            "success": True,
            "output": result.stdout,
            "error": result.stderr,
            "code": result.returncode
        })
    except subprocess.TimeoutExpired:
        return jsonify({"success": False, "message": "انتهت المهلة (10 ثواني)"})
    except FileNotFoundError:
        return jsonify({"success": False, "message": "PHP غير مثبت على السيرفر. قم بتثبيته باستخدام: sudo apt install php-cli"})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)})

@app.route('/api/php/upload', methods=['POST'])
def upload_php_file():
    if 'username' not in session:
        return jsonify({"success": False, "message": "غير مصرح"}), 401
    
    data = request.get_json()
    filename = data.get('filename', '').strip()
    content = data.get('content', '').strip()
    
    if not filename:
        return jsonify({"success": False, "message": "اسم الملف مطلوب"})
    
    if not filename.endswith('.php'):
        return jsonify({"success": False, "message": "يجب أن يكون الملف بصيغة .php"})
    
    if '..' in filename or '/' in filename or '\\' in filename:
        return jsonify({"success": False, "message": "اسم غير صالح"})
    
    file_path = os.path.join(PHP_DIR, filename)
    
    try:
        with open(file_path, 'w', encoding='utf-8') as f:
            if not content.strip().startswith('<?php'):
                f.write('<?php\n')
            f.write(content)
            if not content.strip().endswith('?>'):
                f.write('\n?>')
        return jsonify({"success": True, "message": f"✅ تم حفظ {filename}"})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)})

@app.route('/api/php/list', methods=['GET'])
def list_php_files():
    if 'username' not in session:
        return jsonify({"success": False, "message": "غير مصرح"}), 401
    
    files = []
    try:
        for f in os.listdir(PHP_DIR):
            if f.endswith('.php'):
                file_path = os.path.join(PHP_DIR, f)
                stat = os.stat(file_path)
                files.append({
                    "name": f,
                    "size": stat.st_size,
                    "modified": datetime.fromtimestamp(stat.st_mtime).strftime('%Y-%m-%d %H:%M')
                })
    except Exception as e:
        return jsonify({"success": False, "message": str(e)})
    
    return jsonify({"success": True, "files": files})

@app.route('/api/php/run-file', methods=['POST'])
def run_php_file():
    if 'username' not in session:
        return jsonify({"success": False, "message": "غير مصرح"}), 401
    
    data = request.get_json()
    filename = data.get('filename', '').strip()
    
    if not filename:
        return jsonify({"success": False, "message": "اسم الملف مطلوب"})
    
    if not filename.endswith('.php'):
        return jsonify({"success": False, "message": "اسم ملف غير صالح"})
    
    if '..' in filename or '/' in filename or '\\' in filename:
        return jsonify({"success": False, "message": "اسم غير صالح"})
    
    file_path = os.path.join(PHP_DIR, filename)
    
    if not os.path.exists(file_path):
        return jsonify({"success": False, "message": "الملف غير موجود"})
    
    try:
        result = subprocess.run(
            ['php', file_path],
            capture_output=True,
            text=True,
            timeout=10
        )
        
        return jsonify({
            "success": True,
            "output": result.stdout,
            "error": result.stderr,
            "code": result.returncode
        })
    except subprocess.TimeoutExpired:
        return jsonify({"success": False, "message": "انتهت المهلة (10 ثواني)"})
    except FileNotFoundError:
        return jsonify({"success": False, "message": "PHP غير مثبت على السيرفر"})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)})

@app.route('/api/php/delete', methods=['POST'])
def delete_php_file():
    if 'username' not in session:
        return jsonify({"success": False, "message": "غير مصرح"}), 401
    
    data = request.get_json()
    filename = data.get('filename', '').strip()
    
    if not filename:
        return jsonify({"success": False, "message": "اسم الملف مطلوب"})
    
    if not filename.endswith('.php'):
        return jsonify({"success": False, "message": "اسم ملف غير صالح"})
    
    if '..' in filename or '/' in filename or '\\' in filename:
        return jsonify({"success": False, "message": "اسم غير صالح"})
    
    file_path = os.path.join(PHP_DIR, filename)
    
    if not os.path.exists(file_path):
        return jsonify({"success": False, "message": "الملف غير موجود"})
    
    try:
        os.remove(file_path)
        return jsonify({"success": True, "message": f"✅ تم حذف {filename}"})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)})

@app.route('/api/php/get-content', methods=['POST'])
def get_php_content():
    if 'username' not in session:
        return jsonify({"success": False, "message": "غير مصرح"}), 401
    
    data = request.get_json()
    filename = data.get('filename', '').strip()
    
    if not filename or not filename.endswith('.php'):
        return jsonify({"success": False, "message": "اسم ملف غير صالح"})
    
    if '..' in filename or '/' in filename or '\\' in filename:
        return jsonify({"success": False, "message": "اسم غير صالح"})
    
    file_path = os.path.join(PHP_DIR, filename)
    
    if not os.path.exists(file_path):
        return jsonify({"success": False, "message": "الملف غير موجود"})
    
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
        return jsonify({"success": True, "content": content})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)})

@app.route('/api/php/update', methods=['POST'])
def update_php_file():
    if 'username' not in session:
        return jsonify({"success": False, "message": "غير مصرح"}), 401
    
    data = request.get_json()
    filename = data.get('filename', '').strip()
    content = data.get('content', '').strip()
    
    if not filename or not filename.endswith('.php'):
        return jsonify({"success": False, "message": "اسم ملف غير صالح"})
    
    if '..' in filename or '/' in filename or '\\' in filename:
        return jsonify({"success": False, "message": "اسم غير صالح"})
    
    file_path = os.path.join(PHP_DIR, filename)
    
    if not os.path.exists(file_path):
        return jsonify({"success": False, "message": "الملف غير موجود"})
    
    try:
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(content)
        return jsonify({"success": True, "message": f"✅ تم تحديث {filename}"})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)})

# ============== التشغيل ==============
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)