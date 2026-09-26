import os
import json
import subprocess
import re
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
from datetime import datetime, timedelta
from flask import Flask, send_from_directory, request, jsonify, session, redirect, make_response
from werkzeug.utils import secure_filename

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
USERS_DIR = os.path.join(BASE_DIR, "USERS")
os.makedirs(USERS_DIR, exist_ok=True)

# مجلد PHP
PHP_DIR = os.path.join(BASE_DIR, "php_files")
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
BOT_TOKEN = "8669754436:AAG-XGfy4I_-X5FKDMb5DMDzhnowT3-wnSE"
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
DB_FILE = os.path.join(BASE_DIR, "db.json")

def load_db():
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
        with open(DB_FILE, 'w', encoding='utf-8') as f:
            json.dump(db_data, f, indent=4, ensure_ascii=False)
        return True
    except Exception as e:
        print(f"❌ خطأ في حفظ DB: {e}")
        return False

db = load_db()

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
        
        if php_files and srv.get("type") != "PHP":
            srv["type"] = "PHP"
            srv["startup_file"] = php_files[0]
            save_db(db)
            print(f"✅ تم كشف PHP تلقائياً: {php_files[0]}")
            return True
        elif js_files and srv.get("type") != "Node.js":
            srv["type"] = "Node.js"
            srv["startup_file"] = js_files[0]
            save_db(db)
            print(f"✅ تم كشف Node.js تلقائياً: {js_files[0]}")
            return True
        elif py_files and srv.get("type") != "Python":
            srv["type"] = "Python"
            srv["startup_file"] = py_files[0]
            save_db(db)
            print(f"✅ تم كشف Python تلقائياً: {py_files[0]}")
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

# ============== المنافذ ==============
PORT_RANGE_START = 8100
PORT_RANGE_END = 9100

def get_assigned_port():
    used = set()
    for srv in db.get("servers", {}).values():
        if srv.get("port"):
            used.add(srv["port"])
    for port in range(PORT_RANGE_START, PORT_RANGE_END):
        if port not in used:
            try:
                s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                s.settimeout(0.1)
                result = s.connect_ex(('127.0.0.1', port))
                s.close()
                if result != 0:
                    return port
            except Exception:
                return port
    return PORT_RANGE_START

# ============== كشف الملف الرئيسي ==============
def detect_main_file(srv_path: str, server_type: str) -> str:
    if server_type == "Node.js":
        pkg = os.path.join(srv_path, "package.json")
        if os.path.exists(pkg):
            try:
                with open(pkg, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                main = data.get("main", "")
                if main and os.path.exists(os.path.join(srv_path, main)):
                    return main
                scripts = data.get("scripts", {})
                start_cmd = scripts.get("start", "")
                m = re.search(r'node\s+(\S+\.js)', start_cmd)
                if m and os.path.exists(os.path.join(srv_path, m.group(1))):
                    return m.group(1)
            except Exception:
                pass
        for candidate in ["index.js", "bot.js", "app.js", "main.js", "server.js"]:
            if os.path.exists(os.path.join(srv_path, candidate)):
                return candidate
        js_files = [f for f in os.listdir(srv_path) if f.endswith('.js')]
        return js_files[0] if js_files else ""
    elif server_type == "PHP":
        for candidate in ["index.php", "main.php", "bot.php", "app.php", "start.php", "run.php"]:
            if os.path.exists(os.path.join(srv_path, candidate)):
                return candidate
        php_files = [f for f in os.listdir(srv_path) if f.endswith('.php')]
        return php_files[0] if php_files else ""
    else:
        for candidate in ["main.py", "bot.py", "app.py", "index.py", "run.py", "start.py"]:
            if os.path.exists(os.path.join(srv_path, candidate)):
                return candidate
        py_files = [f for f in os.listdir(srv_path) if f.endswith('.py')]
        return py_files[0] if py_files else ""

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
    srv = db["servers"].get(folder)
    if not srv:
        return False, "السيرفر غير موجود"

    # كشف تلقائي قبل التشغيل
    auto_detect_server_type(srv["path"], srv)

    server_type = srv.get("type", "Python")
    main_file = srv.get("startup_file", "")

    if not main_file:
        main_file = detect_main_file(srv["path"], server_type)
        if main_file:
            srv["startup_file"] = main_file
            save_db(db)
        else:
            if server_type == "Python":
                return False, "لا يوجد ملف تشغيل Python (.py)"
            elif server_type == "PHP":
                return False, "لا يوجد ملف تشغيل PHP (.php)"
            else:
                return False, "لا يوجد ملف تشغيل Node.js (.js)"

    file_path = os.path.join(srv["path"], main_file)
    if not os.path.exists(file_path):
        return False, f"الملف '{main_file}' غير موجود"

    port = srv.get("port") or get_assigned_port()
    srv["port"] = port
    save_db(db)

    log_path = os.path.join(srv["path"], "out.log")
    error_path = os.path.join(srv["path"], "errors.log")
    log_file = open(log_path, "a", encoding='utf-8')
    log_file.write(
        f"\n{'='*50}\n🚀 بدء التشغيل - {datetime.now()}\n"
        f"📁 {main_file}\n🔌 المنفذ: {port}\n🏷 النوع: {server_type}\n{'='*50}\n\n"
    )
    log_file.flush()

    try:
        env = os.environ.copy()
        env["PORT"] = str(port)
        env["SERVER_PORT"] = str(port)
        
        if server_type == "Node.js":
            cmd = ["node", main_file]
        elif server_type == "PHP":
            cmd = ["php", "-S", f"0.0.0.0:{port}", "-t", srv["path"]]
        else:
            # قبل تشغيل Python: إنشاء البيئة الخاصة وتثبيت المكتبات تلقائياً.
            with open(log_path, "a", encoding="utf-8") as dep_log:
                python_bin = ensure_python_environment(srv["path"], dep_log)
            cmd = [python_bin, "-u", main_file]
            
        proc = subprocess.Popen(
            cmd,
            cwd=srv["path"],
            stdout=log_file,
            stderr=open(error_path, "a", encoding='utf-8'),
            env=env,
            preexec_fn=os.setsid if hasattr(os, 'setsid') else None
        )
        srv["status"] = "Running"
        srv["pid"] = proc.pid
        srv["start_time"] = time.time()
        save_db(db)
        return True, "✅ تم التشغيل"
    except FileNotFoundError:
        err = f"❌ المشغّل غير موجود: {'node' if server_type == 'Node.js' else 'php' if server_type == 'PHP' else 'python'}"
        log_file.write(err + "\n")
        log_file.close()
        return False, err
    except Exception as e:
        log_file.write(f"\n❌ خطأ: {e}\n")
        log_file.close()
        return False, str(e)

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
                if srv.get("status") == "Running" and srv.get("pid"):
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
                "disk_used": disk_used_mb
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
        return jsonify([])
    path = srv["path"]
    files = []
    try:
        for f in os.listdir(path):
            if f in ['out.log', 'server.log', 'meta.json', 'errors.log']:
                continue
            fpath = os.path.join(path, f)
            stat = os.stat(fpath)
            size_bytes = stat.st_size
            if size_bytes < 1024:
                size_str = f"{size_bytes} B"
            elif size_bytes < 1024 * 1024:
                size_str = f"{size_bytes/1024:.1f} KB"
            else:
                size_str = f"{size_bytes/(1024*1024):.1f} MB"
            files.append({
                "name": f,
                "size": size_str,
                "is_dir": os.path.isdir(fpath),
                "modified": datetime.fromtimestamp(stat.st_mtime).strftime('%Y-%m-%d %H:%M'),
                "is_zip": f.lower().endswith('.zip')
            })
    except Exception:
        pass
    return jsonify(sorted(files, key=lambda x: (not x['is_dir'], x['name'].lower())))

@app.route('/api/files/content/<folder>/<path:filename>')
def get_file_content(folder, filename):
    if "username" not in session:
        return jsonify({"content": ""}), 401
    srv = db["servers"].get(folder)
    if not srv or srv["owner"] != session["username"]:
        return jsonify({"content": ""})
    if '..' in filename:
        return jsonify({"content": ""})
    fpath = os.path.join(srv["path"], filename)
    if not os.path.exists(fpath) or os.path.isdir(fpath):
        return jsonify({"content": ""})
    try:
        with open(fpath, 'r', encoding='utf-8', errors='replace') as f:
            return jsonify({"content": f.read()})
    except Exception:
        return jsonify({"content": "[ملف ثنائي]"})

@app.route('/api/files/save/<folder>/<path:filename>', methods=['POST'])
def save_file_content(folder, filename):
    if "username" not in session:
        return jsonify({"success": False}), 401
    srv = db["servers"].get(folder)
    if not srv or srv["owner"] != session["username"]:
        return jsonify({"success": False})
    if '..' in filename:
        return jsonify({"success": False, "message": "اسم غير صالح"})
    data = request.get_json()
    fpath = os.path.join(srv["path"], filename)
    try:
        with open(fpath, 'w', encoding='utf-8') as f:
            f.write(data.get("content", ""))
        return jsonify({"success": True, "message": "✅ تم الحفظ"})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)})

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
            filename = secure_filename(f.filename)
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

    filename = secure_filename(f.filename)
    if not filename:
        return jsonify({"success": False, "message": "اسم الملف غير صالح"})

    ext = os.path.splitext(filename)[1].lower()
    if ext == '.py':
        server_type = "Python"
    elif ext == '.js':
        server_type = "Node.js"
    elif ext == '.php':
        server_type = "PHP"
    elif ext == '.zip':
        server_type = "Python"
    else:
        return jsonify({"success": False, "message": "ارفع ملف Python أو ZIP أو JavaScript أو PHP"})

    base_name = os.path.splitext(filename)[0]
    safe_name = re.sub(r'[^a-zA-Z0-9_-]+', '', base_name) or "my-server"
    server_name = base_name[:40] or "سيرفري الجديد"
    folder = f"{session['username']}_{safe_name}_{int(time.time())}"
    path = os.path.join(get_user_servers_dir(session["username"]), folder)
    os.makedirs(path, exist_ok=True)

    plan_id = user.get("plan", "free")
    plan = db["plans"].get(plan_id, db["plans"]["free"])
    assigned_port = get_assigned_port()
    startup_file = filename if ext in {'.py', '.js', '.php'} else ""

    try:
        f.save(os.path.join(path, filename))
        if ext == '.zip':
            zip_path = os.path.join(path, filename)
            with zipfile.ZipFile(zip_path, 'r') as zf:
                if zf.testzip():
                    raise ValueError("ملف ZIP تالف")
                zf.extractall(path)
            # تحديد نوع المشروع وملف التشغيل من المحتوى بعد فك الضغط.
            if os.path.exists(os.path.join(path, "package.json")) or any(name.endswith('.js') for name in os.listdir(path)):
                server_type = "Node.js"
            elif any(name.endswith('.php') for name in os.listdir(path)):
                server_type = "PHP"
            else:
                server_type = "Python"
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
    if not filename or '..' in filename or filename.startswith('/'):
        return jsonify({"success": False, "message": "اسم ملف غير صالح"}), 400
    target = os.path.join(srv["path"], filename)
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
    new_name = data.get("new_name", "").strip()
    if not old_name or not new_name or '..' in old_name or '..' in new_name:
        return jsonify({"success": False, "message": "اسم غير صالح"})
    old_path = os.path.join(srv["path"], old_name)
    new_path = os.path.join(srv["path"], new_name)
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
    zip_path = os.path.join(srv["path"], filename)
    if not os.path.exists(zip_path):
        return jsonify({"success": False, "message": "الملف غير موجود"})
    try:
        with zipfile.ZipFile(zip_path, 'r') as zf:
            bad = zf.testzip()
            if bad:
                return jsonify({"success": False, "message": f"ملف ZIP تالف: {bad}"})
            zf.extractall(srv["path"])
        # كشف تلقائي بعد فك الضغط
        auto_detect_server_type(srv["path"], srv)
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
        fpath = os.path.join(srv["path"], name)
        try:
            if os.path.isdir(fpath):
                shutil.rmtree(fpath)
            elif os.path.exists(fpath):
                os.remove(fpath)
            deleted += 1
        except Exception:
            pass
    if deleted > 0:
        # كشف تلقائي بعد الحذف
        auto_detect_server_type(srv["path"], srv)
        return jsonify({"success": True, "message": f"🗑 تم حذف {deleted} ملف"})
    return jsonify({"success": False, "message": "فشل الحذف"})

@app.route('/api/files/create/<folder>', methods=['POST'])
def create_file_api(folder):
    if "username" not in session:
        return jsonify({"success": False}), 401
    srv = db["servers"].get(folder)
    if not srv or srv["owner"] != session["username"]:
        return jsonify({"success": False})
    data = request.get_json()
    filename = data.get("filename", "").strip()
    if not filename or '..' in filename:
        return jsonify({"success": False, "message": "اسم غير صالح"})
    fpath = os.path.join(srv["path"], filename)
    try:
        with open(fpath, 'w', encoding='utf-8') as f:
            f.write(data.get("content", ""))
        # كشف تلقائي بعد الإنشاء
        auto_detect_server_type(srv["path"], srv)
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
    filename = data.get("filename", "").strip()
    if not filename or '..' in filename:
        return jsonify({"success": False, "message": "اسم غير صالح"})
    if not os.path.exists(os.path.join(srv["path"], filename)):
        return jsonify({"success": False, "message": "الملف غير موجود"})
    srv["startup_file"] = filename
    save_db(db)
    return jsonify({"success": True, "message": f"✅ تم تعيين {filename} كملف التشغيل"})

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