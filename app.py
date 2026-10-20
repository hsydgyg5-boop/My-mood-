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
from pathlib import Path
from flask import Flask, send_from_directory, send_file, request, jsonify, session, redirect, make_response, Response

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# Railway يحقن RAILWAY_VOLUME_MOUNT_PATH عند ربط Volume بالخدمة.
# لا يكفي ربط GitHub وحده للحفظ بين النشرات؛ كل ملفات المستخدمين وقاعدة البيانات تذهب إلى هذا المسار.
RAILWAY_VOLUME_MOUNT_PATH = (os.environ.get("RAILWAY_VOLUME_MOUNT_PATH") or "").strip()
EXPLICIT_DATA_DIR = (os.environ.get("MAZAGI_DATA_DIR") or "").strip()
IS_RAILWAY_RUNTIME = any(os.environ.get(k) for k in (
    "RAILWAY_ENVIRONMENT", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_PROJECT_ID", "RAILWAY_SERVICE_ID", "RAILWAY_VOLUME_MOUNT_PATH"
))
DATA_DIR = EXPLICIT_DATA_DIR or RAILWAY_VOLUME_MOUNT_PATH or ("/data" if IS_RAILWAY_RUNTIME else os.path.join(BASE_DIR, "data"))
try:
    os.makedirs(DATA_DIR, exist_ok=True)
except Exception as exc:
    print(f"❌ تعذر فتح مجلد البيانات {DATA_DIR}: {exc}", flush=True)
    DATA_DIR = os.path.join(BASE_DIR, "data")
    os.makedirs(DATA_DIR, exist_ok=True)
    IS_RAILWAY_RUNTIME = IS_RAILWAY_RUNTIME

# نعد التخزين محفوظاً عبر النشرات في Railway فقط عندما يعلن Railway مسار الـ Volume تلقائياً
# ويطابق المسار المستخدم فعلياً. هذا يمنع اعتبار مجلد الحاوية المؤقت تخزيناً دائماً بالخطأ.
try:
    PERSISTENT_STORAGE_CONFIGURED = (not IS_RAILWAY_RUNTIME) or bool(
        RAILWAY_VOLUME_MOUNT_PATH and os.path.abspath(DATA_DIR) == os.path.abspath(RAILWAY_VOLUME_MOUNT_PATH)
    )
except Exception:
    PERSISTENT_STORAGE_CONFIGURED = not IS_RAILWAY_RUNTIME
if IS_RAILWAY_RUNTIME and not PERSISTENT_STORAGE_CONFIGURED:
    print("⚠️ تنبيه تخزين: لم يتم اكتشاف Railway Volume مربوط بالخدمة. قد تُفقد قاعدة البيانات وملفات المستخدمين عند إعادة النشر. اربط Volume بمسار /data.", flush=True)

USERS_DIR = os.path.join(DATA_DIR, "USERS")
os.makedirs(USERS_DIR, exist_ok=True)

# مجلد PHP داخل التخزين الدائم نفسه.
PHP_DIR = os.path.join(DATA_DIR, "php_files")
os.makedirs(PHP_DIR, exist_ok=True)

def _load_or_create_session_secret():
    """Prefer a deployment secret; otherwise keep a private generated key in DATA_DIR."""
    configured = (os.environ.get("MAZAGI_SECRET_KEY") or os.environ.get("SECRET_KEY") or "").strip()
    if configured:
        return configured
    secret_path = os.path.join(DATA_DIR, ".session_secret")
    try:
        with open(secret_path, "r", encoding="utf-8") as handle:
            existing = handle.read().strip()
        if len(existing) >= 40:
            return existing
    except OSError:
        pass
    generated = secrets.token_urlsafe(48)
    try:
        # O_EXCL avoids two Gunicorn workers overwriting each other's first key.
        fd = os.open(secret_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(generated)
            handle.flush()
            os.fsync(handle.fileno())
        return generated
    except FileExistsError:
        try:
            with open(secret_path, "r", encoding="utf-8") as handle:
                existing = handle.read().strip()
            if len(existing) >= 40:
                return existing
        except OSError:
            pass
    except OSError as exc:
        print(f"⚠️ تعذر حفظ مفتاح الجلسة داخل مجلد البيانات: {exc}", flush=True)
    # Last-resort key; if storage is not writable sessions will reset on process restart.
    return generated


# منع Flask من نشر ملفات جذر المشروع (/static/app.py أو config) تلقائياً.
app = Flask(__name__, static_folder=None)
app.secret_key = _load_or_create_session_secret()
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(days=30)
app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.config['SESSION_COOKIE_SECURE'] = bool(IS_RAILWAY_RUNTIME or os.environ.get('HTTPS', '').lower() == 'on')

# ============== بيانات المسؤول ==============
ADMIN_USERNAME = "zzmmkj"
ADMIN_PASSWORD_OVERRIDE = bool(os.environ.get("MAZAGI_ADMIN_PASSWORD", "").strip())
ADMIN_PASSWORD_RAW = os.environ.get("MAZAGI_ADMIN_PASSWORD", "AASS1122@@").strip()
if not ADMIN_PASSWORD_OVERRIDE:
    print("⚠️ أمان الإدارة: عيّن MAZAGI_ADMIN_PASSWORD في متغيرات الاستضافة لتغيير كلمة المرور الافتراضية.", flush=True)

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
                for existing_name, existing_user in data["users"].items():
                    existing_user.setdefault("max_files", 1000000 if existing_user.get("is_admin") or existing_name == ADMIN_USERNAME else 10)
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
                        "max_files": 1000000,
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
                    # ضمان الصلاحيات؛ إذا ضبط المسؤول كلمة مرور عبر متغير البيئة، حدّث hash الحساب بأمان.
                    data["users"][ADMIN_USERNAME]["is_admin"] = True
                    data["users"][ADMIN_USERNAME].setdefault("status", "approved")
                    if ADMIN_PASSWORD_OVERRIDE:
                        configured_hash = hashlib.sha256(ADMIN_PASSWORD_RAW.encode()).hexdigest()
                        if data["users"][ADMIN_USERNAME].get("password") != configured_hash:
                            data["users"][ADMIN_USERNAME]["password"] = configured_hash
                            save_db(data)
                return data
        except Exception as exc:
            print(f"❌ تعذر قراءة قاعدة البيانات {DB_FILE}: {exc}", flush=True)
            try:
                if os.path.isfile(DB_FILE):
                    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                    corrupt_copy = f"{DB_FILE}.corrupt-{stamp}.json"
                    shutil.copy2(DB_FILE, corrupt_copy)
                    print(f"⚠️ تم الاحتفاظ بنسخة من قاعدة البيانات غير المقروءة: {corrupt_copy}", flush=True)
                # Before creating a fresh DB, try the most recent valid known-good backup.
                backups_dir = os.path.join(DATA_DIR, "backups")
                candidates = []
                if os.path.isdir(backups_dir):
                    candidates = sorted(
                        (os.path.join(backups_dir, n) for n in os.listdir(backups_dir)
                         if n.startswith("db_before_update_") and n.endswith(".json")),
                        reverse=True
                    )
                for candidate in candidates:
                    try:
                        with open(candidate, "r", encoding="utf-8") as backup_file:
                            backup_data = json.load(backup_file)
                        if isinstance(backup_data, dict) and isinstance(backup_data.get("users"), dict) and isinstance(backup_data.get("servers"), dict):
                            shutil.copy2(candidate, DB_FILE)
                            print(f"✅ استُعيدت قاعدة البيانات من النسخة الاحتياطية: {candidate}", flush=True)
                            return load_db()
                    except Exception:
                        continue
            except Exception as backup_exc:
                print(f"⚠️ تعذر حفظ/استعادة نسخة من قاعدة البيانات التالفة: {backup_exc}", flush=True)
    admin_hash = hashlib.sha256(ADMIN_PASSWORD_RAW.encode()).hexdigest()
    default_db = {
        "users": {
            ADMIN_USERNAME: {
                "password": admin_hash,
                "is_admin": True,
                "created_at": str(datetime.now()),
                "max_servers": 999999,
                "max_files": 1000000,
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

_DB_SAVE_LOCK = threading.RLock()

def save_db(db_data):
    """Atomically persist the database and retry a few times if concurrent edits race serialization."""
    tmp_file = None
    try:
        os.makedirs(os.path.dirname(DB_FILE), exist_ok=True)
        with _DB_SAVE_LOCK:
            serialized = None
            last_serialization_error = None
            for attempt in range(3):
                try:
                    serialized = json.dumps(db_data, indent=4, ensure_ascii=False)
                    break
                except RuntimeError as exc:
                    last_serialization_error = exc
                    time.sleep(0.02 * (attempt + 1))
            if serialized is None:
                raise RuntimeError(f"تغيّرت بيانات قاعدة البيانات أثناء الحفظ: {last_serialization_error}")
            tmp_file = f"{DB_FILE}.{os.getpid()}.{threading.get_ident()}.{secrets.token_hex(4)}.tmp"
            with open(tmp_file, 'w', encoding='utf-8') as f:
                f.write(serialized)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_file, DB_FILE)
        return True
    except Exception as e:
        print(f"❌ خطأ في حفظ DB: {e}", flush=True)
        if tmp_file:
            try:
                if os.path.exists(tmp_file):
                    os.remove(tmp_file)
            except OSError:
                pass
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

def has_symlink_component(base, name):
    """Detect symlinks in the user-supplied relative path before resolving it."""
    if not name:
        return True
    raw = unicodedata.normalize('NFC', str(name)).replace('\\', '/')
    parts = [part for part in raw.split('/') if part not in ('', '.')]
    if not parts or any(part == '..' for part in parts) or raw.startswith('/'):
        return True
    current = os.path.abspath(base)
    if os.path.islink(current):
        return True
    for part in parts:
        current = os.path.join(current, part)
        if os.path.islink(current):
            return True
    return False


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
    base_abs = os.path.realpath(os.path.abspath(base))
    path_abs = os.path.realpath(os.path.abspath(os.path.join(base_abs, *parts)))
    try:
        if os.path.commonpath([base_abs, path_abs]) != base_abs:
            return None
    except ValueError:
        return None
    return path_abs

def is_safe_username_component(username):
    """Usernames may be Unicode, but must never be filesystem paths."""
    if not isinstance(username, str) or not username or len(username) > 64:
        return False
    if username in {".", ".."} or "/" in username or "\\" in username or ":" in username:
        return False
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in username):
        return False
    return os.path.basename(username) == username


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
    if not is_safe_username_component(owner) or not is_safe_username_component(folder):
        return None
    base = os.path.realpath(USERS_DIR)
    owner_dir = os.path.abspath(os.path.join(base, owner))
    servers_dir = os.path.abspath(os.path.join(owner_dir, "SERVERS"))
    candidate = os.path.abspath(os.path.join(servers_dir, folder))
    try:
        if (os.path.realpath(owner_dir) != owner_dir
                or os.path.realpath(servers_dir) != servers_dir
                or os.path.realpath(candidate) != candidate
                or os.path.commonpath([servers_dir, candidate]) != servers_dir):
            return None
    except ValueError:
        return None
    return candidate

def _copy_tree_if_needed(src, dst):
    """استعادة غير مدمرة: انسخ الملفات الناقصة فقط، ولا تستبدل أي ملف موجود على الـ Volume."""
    try:
        if not src or not os.path.exists(src):
            return False
        changed = False
        if os.path.isdir(src):
            os.makedirs(dst, exist_ok=True)
            for root, dirs, files in os.walk(src):
                rel = os.path.relpath(root, src)
                target_root = dst if rel == "." else os.path.join(dst, rel)
                os.makedirs(target_root, exist_ok=True)
                for directory in dirs:
                    os.makedirs(os.path.join(target_root, directory), exist_ok=True)
                for filename in files:
                    source_file = os.path.join(root, filename)
                    target_file = os.path.join(target_root, filename)
                    if not os.path.exists(target_file):
                        shutil.copy2(source_file, target_file)
                        changed = True
        elif not os.path.exists(dst):
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
            changed = True
        return changed
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
    """اكتشاف نوع المشروع مع تفضيل تطبيقات الويب الحقيقية والمواقع الثابتة بدقة."""
    if not os.path.isdir(srv_path):
        return False
    try:
        detected = detect_project_type(srv_path)
        old_type = srv.get("type")
        # إذا كشف الفاحص أن الملفات واجهة ثابتة، لا نبقِ نوعاً قديماً مثل Node.js.
        if not old_type or old_type not in SUPPORTED_SERVER_TYPES:
            srv["type"] = detected
        elif old_type == "Static":
            # النوع الذي اختاره المستخدم ثابت؛ رفع CSS/JS قبل index.html لا يحوّله خطأً إلى Python.
            srv["type"] = "Static"
        elif detected == "Static" and old_type in ("Python", "Node.js"):
            current_entry = srv.get("startup_file", "")
            current_path = os.path.join(srv_path, current_entry) if current_entry else ""
            expected = {"Python": (".py",), "Node.js": (".js", ".mjs", ".cjs")}.get(old_type, ())
            if not current_entry or not os.path.isfile(current_path) or os.path.splitext(current_entry)[1].lower() not in expected:
                srv["type"] = "Static"

        server_type = srv.get("type", detected)
        current = srv.get("startup_file", "")
        current_path = os.path.join(srv_path, current) if current else ""
        if server_type == "Static":
            # الموقع الثابت يجب أن يبدأ بصفحة HTML، لا بملف app.py/main.py.
            if not current or os.path.splitext(current)[1].lower() not in (".html", ".htm") or not os.path.isfile(current_path):
                srv["startup_file"] = detect_main_file(srv_path, "Static")
        else:
            expected_exts = {
                "Python": (".py",), "Node.js": (".js", ".mjs", ".cjs"), "PHP": (".php",),
                "Ruby": (".rb", ".ru"), "Java": (".java", ".xml", ".gradle", ".kts"),
                "Go": (".go", ".mod"), "Rust": (".rs", ".toml")
            }.get(server_type, ())
            if (not current or not os.path.isfile(current_path)
                    or (expected_exts and os.path.splitext(current)[1].lower() not in expected_exts)):
                srv["startup_file"] = detect_main_file(srv_path, server_type)
        changed = old_type != srv.get("type") or current != srv.get("startup_file", "")
        if changed:
            save_db(db)
        return changed
    except Exception as e:
        print(f"⚠️ خطأ في الكشف التلقائي: {e}")
        return False

# ============== تصحيح تلقائي لأنواع السيرفرات ==============
def fix_server_types():
    """تصحيح أنواع وملفات بدء التشغيل اعتماداً على محتوى المشروع."""
    updated = False
    for folder, srv in db.get("servers", {}).items():
        srv_path = srv.get("path", "")
        if not os.path.isdir(srv_path):
            continue
        try:
            detected = detect_project_type(srv_path)
            old_type = srv.get("type")
            old_startup = srv.get("startup_file", "")
            # لا نغيّر نوع خوادم المستخدمين الصحيحة تلقائياً عند إقلاع لوحة الاستضافة؛
            # هذا التصحيح خاص بالقيم المفقودة/غير المعروفة ويحافظ على إعداداتهم الحالية.
            if not old_type or old_type not in SUPPORTED_SERVER_TYPES:
                srv["type"] = detected
            typ = srv.get("type", detected)
            startup = srv.get("startup_file", "")
            startup_path = os.path.join(srv_path, startup) if startup else ""
            if typ == "Static":
                if (not startup or os.path.splitext(startup)[1].lower() not in (".html", ".htm")
                        or not os.path.isfile(startup_path)):
                    srv["startup_file"] = detect_main_file(srv_path, "Static")
            else:
                expected_exts = {
                    "Python": (".py",), "Node.js": (".js", ".mjs", ".cjs"), "PHP": (".php",),
                    "Ruby": (".rb", ".ru"), "Java": (".java", ".xml", ".gradle", ".kts"),
                    "Go": (".go", ".mod"), "Rust": (".rs", ".toml")
                }.get(typ, ())
                if (not startup or not os.path.isfile(startup_path)
                        or (expected_exts and os.path.splitext(startup)[1].lower() not in expected_exts)):
                    srv["startup_file"] = detect_main_file(srv_path, typ)
            if old_type != srv.get("type") or old_startup != srv.get("startup_file", ""):
                updated = True
                print(f"✅ تم تصحيح إعدادات {srv.get('name', folder)}: {srv.get('type')} / {srv.get('startup_file')}")
        except Exception as e:
            print(f"⚠️ تعذر تصحيح نوع السيرفر {folder}: {e}")
    if updated:
        save_db(db)
        print("✅ تم حفظ إعدادات التشغيل المصححة")

# ============== تشغيل شامل واكتشاف المنفذ ==============
SUPPORTED_SERVER_TYPES = ("Python", "Node.js", "PHP", "Ruby", "Java", "Go", "Rust", "Static")
COMMON_WEB_PORTS = (3000, 4000, 5000, 5173, 8000, 8001, 8080, 8081, 8088, 8888, 9000)

def detect_project_type(srv_path: str):
    """كشف نوع المشروع دون اعتبار ملفات JavaScript المرفقة بموقع ثابت تطبيق Node.js."""
    try:
        root_files = set(os.listdir(srv_path))
        all_files = set()
        py_files = []
        js_files = []
        for root, dirs, files in os.walk(srv_path):
            depth = os.path.relpath(root, srv_path).count(os.sep)
            if depth > 2:
                dirs[:] = []
                continue
            dirs[:] = [d for d in dirs if d not in {".git", ".venv", "venv", "node_modules", "__pycache__"}]
            all_files.update(n.lower() for n in files)
            for name in files:
                full = os.path.join(root, name)
                low = name.lower()
                if low.endswith(".py"):
                    py_files.append(full)
                if low.endswith((".js", ".mjs", ".cjs")):
                    js_files.append(full)
    except Exception:
        return "Python"

    root_has_html = any(os.path.isfile(os.path.join(srv_path, n)) for n in ("index.html", "index.htm", "home.html"))
    has_html = root_has_html or any(n.endswith((".html", ".htm")) for n in all_files)

    # مشاريع PHP الحقيقية أولوية على قوالب HTML المرفقة معها.
    if "composer.json" in {x.lower() for x in root_files} or any(n.endswith(".php") for n in all_files):
        return "PHP"

    # تمييز تطبيق Python الخلفي من أسماء ملفاته ومتطلبات/كود الخادم، حتى مع وجود index.html.
    python_entry_names = {"main.py", "app.py", "server.py", "run.py", "start.py", "index.py", "wsgi.py", "asgi.py"}
    root_py_names = {n.lower() for n in root_files if n.lower().endswith(".py")}
    likely_python_backend = bool(root_py_names & python_entry_names)
    req_path = os.path.join(srv_path, "requirements.txt")
    pyproject_path = os.path.join(srv_path, "pyproject.toml")
    dependency_text = ""
    for dep_path in (req_path, pyproject_path):
        if os.path.isfile(dep_path):
            try:
                dependency_text += "\n" + open(dep_path, "r", encoding="utf-8", errors="ignore").read().lower()
            except Exception:
                pass
    python_framework_markers = ("flask", "fastapi", "django", "uvicorn", "gunicorn", "starlette", "quart", "http.server")
    has_python_web_dependency = any(marker in dependency_text for marker in python_framework_markers)
    python_web_markers = (
        "flask(", "fastapi(", "django", "uvicorn.run", "app.run(", "httpserver(",
        "threadinghttpserver(", "simplehttprequesthandler", "basehttprequesthandler",
        "socketserver.tcpserver", "http.server", "wsgiref.simple_server", "run_server("
    )
    has_python_web_code = False
    for py_path in py_files[:40]:
        try:
            if os.path.getsize(py_path) > 1_000_000:
                continue
            code = open(py_path, "r", encoding="utf-8", errors="ignore").read().lower()
            if any(marker in code for marker in python_web_markers):
                has_python_web_code = True
                break
        except Exception:
            pass
    if py_files and (has_python_web_dependency or has_python_web_code or (likely_python_backend and not has_html)):
        return "Python"

    # package.json يعني Node.js فقط إذا كان التطبيق فعلاً يعتمد على Node؛ أما
    # حزمة ثابتة مع index.html وملف خادم بسيط بلا dependencies فتُخدم مباشرة من Static.
    package_path = os.path.join(srv_path, "package.json")
    if os.path.isfile(package_path):
        if has_html:
            try:
                pkg = json.load(open(package_path, encoding="utf-8"))
                deps = pkg.get("dependencies", {}) or {}
                dev_deps = pkg.get("devDependencies", {}) or {}
                scripts = pkg.get("scripts", {}) or {}
                js_content = ""
                for candidate in js_files[:10]:
                    try:
                        if os.path.getsize(candidate) < 500_000:
                            js_content += open(candidate, "r", encoding="utf-8", errors="ignore").read().lower() + "\n"
                    except Exception:
                        pass
                node_server_markers = (
                    "express(", "require('express')", 'require("express")', "fastify(", "koa(", "socket.io", "next(",
                    "http.createserver(", "https.createserver(", "createserver(", "server.listen(", "app.listen(",
                    "process.env.port", "bun.serve(", "deno.serve("
                )
                if deps or dev_deps or any(k in scripts for k in ("build", "dev", "test")) or any(m in js_content for m in node_server_markers):
                    return "Node.js"
                return "Static"
            except Exception:
                return "Static"
        return "Node.js"

    # باقي أطر/لغات الخادم ذات الملفات الواضحة.
    if "cargo.toml" in all_files or any(n.endswith(".rs") for n in all_files): return "Rust"
    if "go.mod" in all_files or any(n.endswith(".go") for n in all_files): return "Go"
    if any(n in all_files for n in ("pom.xml", "build.gradle", "build.gradle.kts")) or any(n.endswith(".java") for n in all_files): return "Java"
    if "gemfile" in all_files or any(n.endswith(".rb") for n in all_files): return "Ruby"

    if has_html:
        # إذا لم توجد إشارات واضحة إلى خادم Python، اعتبر HTML الصفحة العامة
        # حتى لو كانت الحزمة تحتوي ملف main.py مساعداً أو غير مستخدم.
        return "Static"
    if py_files: return "Python"
    if js_files: return "Node.js"
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
        for root, dirs, files in os.walk(srv_path):
            dirs[:] = [d for d in dirs if d not in {".git", ".venv", "venv", "node_modules", "__pycache__"}]
            for f in sorted(files):
                if f.lower().endswith(('.html', '.htm')):
                    return os.path.relpath(os.path.join(root, f), srv_path).replace(os.sep, '/')
        return ''
    for c in ['main.py','app.py','server.py','index.py','run.py','start.py','bot.py']:
        if os.path.exists(os.path.join(srv_path,c)): return c
    return next((f for f in os.listdir(srv_path) if f.endswith('.py')),'')

# نفّذ التصحيح بعد تعريف كاشف نوع المشروع وملف البدء.
fix_server_types()

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


def ensure_python_environment(srv_path, log_file=None, strict=True):
    """Create a private venv, infer missing imports, install requirements, and verify imports."""
    def log(message):
        if log_file:
            log_file.write(message + "\n")
            log_file.flush()

    venv_dir = os.path.join(srv_path, ".venv")
    venv_python = os.path.join(venv_dir, "Scripts", "python.exe") if os.name == "nt" else os.path.join(venv_dir, "bin", "python")
    venv_created_or_missing = not os.path.exists(venv_python)
    try:
        if venv_created_or_missing:
            log("\n🧰 إنشاء بيئة Python خاصة بالمشروع...")
            result = subprocess.run([sys.executable, "-m", "venv", venv_dir], cwd=srv_path,
                                    stdout=log_file or subprocess.DEVNULL, stderr=subprocess.STDOUT,
                                    timeout=120, check=False)
            if result.returncode != 0 or not os.path.exists(venv_python):
                raise RuntimeError("تعذر إنشاء البيئة الافتراضية. تحقق من أن الاستضافة تتضمن دعم venv وصلاحية الكتابة.")

        req_file = os.path.join(srv_path, "requirements.txt")
        inferred = detect_python_packages(srv_path)
        python_sources = []
        for root, dirs, files in os.walk(srv_path):
            dirs[:] = [d for d in dirs if d not in FILE_COUNT_EXCLUDED_DIRS]
            for name in files:
                if name.endswith(".py"):
                    try:
                        python_sources.append(Path(os.path.join(root, name)).read_text(encoding="utf-8", errors="ignore").lower())
                    except Exception:
                        pass
        all_python_text = "\n".join(python_sources)
        if "fastapi" in all_python_text and "uvicorn" not in inferred:
            inferred.append("uvicorn")
        if "django.core.management" in all_python_text and not any(x.lower().replace("_", "-").replace(".", "-").startswith("django") for x in inferred):
            inferred.append("Django")

        if not os.path.exists(req_file):
            Path(req_file).write_text("\n".join(inferred) + ("\n" if inferred else ""), encoding="utf-8")
            log(f"📦 تم إنشاء requirements.txt تلقائيًا ({len(inferred)} مكتبة مستنتجة)")
        else:
            original_lines = Path(req_file).read_text(encoding="utf-8", errors="ignore").splitlines()
            present = set()
            for line in original_lines:
                item = line.split("#", 1)[0].strip()
                if not item or item.startswith(("-", "git+", "http://", "https://")):
                    continue
                match = re.match(r"([A-Za-z0-9_.-]+)", item)
                if match:
                    present.add(match.group(1).lower().replace("_", "-").replace(".", "-"))
            added = []
            for package in inferred:
                normalized = re.split(r"[<>=!~\[]", package, maxsplit=1)[0].strip().lower().replace("_", "-").replace(".", "-")
                if normalized and normalized not in present:
                    added.append(package)
                    present.add(normalized)
            if added:
                with open(req_file, "a", encoding="utf-8") as rf:
                    if original_lines and original_lines[-1].strip():
                        rf.write("\n")
                    rf.write("\n".join(added) + "\n")
                log("🧩 أُضيفت مكتبات مكتشفة من imports: " + ", ".join(added))

        requirement_text = Path(req_file).read_text(encoding="utf-8", errors="ignore")
        has_requirements = bool(requirement_text.strip())
        req_hash = hashlib.sha256(requirement_text.encode("utf-8")).hexdigest()
        stamp_path = os.path.join(srv_path, ".mazagi_dependencies_hash")
        try:
            installed_hash = Path(stamp_path).read_text(encoding="utf-8").strip()
        except Exception:
            installed_hash = ""

        if has_requirements:
            if installed_hash != req_hash or venv_created_or_missing:
                log("📦 تثبيت المكتبات المطلوبة داخل بيئة المشروع...")
            else:
                log("🔎 إعادة التحقق من مكتبات requirements.txt وإصلاح أي حزمة مفقودة...")
            cmd = [venv_python, "-m", "pip", "install", "--disable-pip-version-check", "--no-input", "-r", req_file]
            result = subprocess.run(cmd, cwd=srv_path, stdout=log_file or subprocess.DEVNULL,
                                    stderr=subprocess.STDOUT, timeout=600, check=False)
            if result.returncode != 0:
                log("⚠️ فشل التثبيت الأول؛ محاولة تحديث أدوات pip وإعادة المحاولة مرة واحدة...")
                upgrade = subprocess.run([venv_python, "-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel", "--disable-pip-version-check"],
                                         cwd=srv_path, stdout=log_file or subprocess.DEVNULL,
                                         stderr=subprocess.STDOUT, timeout=180, check=False)
                if upgrade.returncode == 0:
                    result = subprocess.run(cmd, cwd=srv_path, stdout=log_file or subprocess.DEVNULL,
                                            stderr=subprocess.STDOUT, timeout=600, check=False)
            if result.returncode != 0:
                log("❌ فشل تثبيت المكتبات. افحص اسم الحزمة وإصدار Python والاتصال بالإنترنت ورسائل pip أعلاه.")
                raise RuntimeError("فشل تثبيت مكتبات Python؛ راجع سجل التثبيت لمعرفة الحزمة والسبب المحدد.")
            Path(stamp_path).write_text(req_hash, encoding="utf-8")
            log("✅ تم تثبيت المكتبات بنجاح")
        else:
            log("ℹ️ لم تُكتشف مكتبات خارجية مطلوبة لهذا المشروع")

        # Confirm pip/venv is usable. Import failures from the app itself remain visible at startup.
        check = subprocess.run([venv_python, "-m", "pip", "--version"], cwd=srv_path,
                               stdout=log_file or subprocess.DEVNULL, stderr=subprocess.STDOUT, timeout=30, check=False)
        if check.returncode != 0:
            raise RuntimeError("بيئة Python أُنشئت لكن pip لا يعمل داخلها")
        if has_requirements:
            consistency = subprocess.run([venv_python, "-m", "pip", "check"], cwd=srv_path,
                                         stdout=log_file or subprocess.DEVNULL, stderr=subprocess.STDOUT,
                                         timeout=60, check=False)
            if consistency.returncode != 0:
                log("❌ فحص توافق المكتبات وجد تعارضًا أو اعتمادًا مفقودًا. راجع مخرجات pip check أعلاه.")
                raise RuntimeError("المكتبات مثبتة لكن فحص التوافق فشل؛ راجع سجل التشغيل للتفاصيل")
            log("✅ اجتاز فحص توافق المكتبات pip check")
        return venv_python
    except Exception as exc:
        log(f"\n❌ تشخيص بيئة Python: {exc}")
        if strict:
            raise
        return sys.executable


def auto_install_deps(srv_path: str, server_type: str, log_file):
    """Install dependencies and raise on failure so the process is not started half-configured."""
    try:
        if server_type == "Node.js":
            pkg = os.path.join(srv_path, "package.json")
            if os.path.exists(pkg):
                if not shutil.which("npm"):
                    raise RuntimeError("الأمر npm غير متوفر في صورة الاستضافة")
                log_file.write("\n📦 تثبيت حزم Node.js عبر npm install...\n"); log_file.flush()
                proc = subprocess.run(["npm", "install", "--no-audit", "--no-fund"], cwd=srv_path,
                                      stdout=log_file, stderr=subprocess.STDOUT, env=os.environ.copy(),
                                      timeout=600, check=False)
                if proc.returncode != 0:
                    raise RuntimeError("فشل npm install؛ راجع السجل لمعرفة الحزمة أو الخطأ")
                log_file.write("✅ اكتمل تثبيت حزم Node.js\n")
        elif server_type == "Python":
            ensure_python_environment(srv_path, log_file, strict=True)
        elif server_type == "PHP":
            composer_json = os.path.join(srv_path, "composer.json")
            if os.path.exists(composer_json):
                if not shutil.which("composer"):
                    raise RuntimeError("composer.json موجود لكن Composer غير مثبت على الاستضافة")
                log_file.write("\n📦 تثبيت مكتبات PHP عبر Composer...\n"); log_file.flush()
                proc = subprocess.run(["composer", "install", "--no-dev", "--prefer-dist", "--no-interaction"], cwd=srv_path,
                                      stdout=log_file, stderr=subprocess.STDOUT, env=os.environ.copy(),
                                      timeout=600, check=False)
                if proc.returncode != 0:
                    raise RuntimeError("فشل Composer install؛ راجع السجل")
                log_file.write("✅ اكتمل تثبيت مكتبات PHP\n")
        elif server_type == "Ruby":
            gemfile = os.path.join(srv_path, "Gemfile")
            if os.path.exists(gemfile):
                if not shutil.which("bundle"):
                    raise RuntimeError("Gemfile موجود لكن Bundler غير متوفر في الاستضافة")
                log_file.write("\n📦 تثبيت حزم Ruby عبر bundle install...\n"); log_file.flush()
                proc = subprocess.run(["bundle", "install"], cwd=srv_path, stdout=log_file, stderr=subprocess.STDOUT,
                                      env=os.environ.copy(), timeout=600, check=False)
                if proc.returncode != 0:
                    raise RuntimeError("فشل bundle install؛ راجع السجل")
                log_file.write("✅ اكتمل تثبيت حزم Ruby\n")
        elif server_type == "Java":
            if os.path.exists(os.path.join(srv_path, "pom.xml")):
                if os.path.isfile(os.path.join(srv_path, "mvnw")):
                    cmd = ["sh", "mvnw", "-B", "-DskipTests", "dependency:resolve"]
                elif shutil.which("mvn"):
                    cmd = ["mvn", "-B", "-DskipTests", "dependency:resolve"]
                else:
                    raise RuntimeError("pom.xml موجود لكن Maven غير متوفر ولا يوجد mvnw")
                log_file.write("\n📦 تنزيل اعتماديات Java عبر Maven...\n"); log_file.flush()
                proc = subprocess.run(cmd, cwd=srv_path, stdout=log_file, stderr=subprocess.STDOUT, env=os.environ.copy(), timeout=600, check=False)
                if proc.returncode != 0:
                    raise RuntimeError("فشل حل اعتماديات Maven؛ راجع السجل")
            elif os.path.exists(os.path.join(srv_path, "build.gradle")) or os.path.exists(os.path.join(srv_path, "build.gradle.kts")):
                if os.path.isfile(os.path.join(srv_path, "gradlew")):
                    cmd = ["sh", "gradlew", "--no-daemon", "dependencies"]
                elif shutil.which("gradle"):
                    cmd = ["gradle", "--no-daemon", "dependencies"]
                else:
                    raise RuntimeError("ملف Gradle موجود لكن Gradle غير متوفر ولا يوجد gradlew")
                log_file.write("\n📦 تنزيل اعتماديات Java عبر Gradle...\n"); log_file.flush()
                proc = subprocess.run(cmd, cwd=srv_path, stdout=log_file, stderr=subprocess.STDOUT, env=os.environ.copy(), timeout=600, check=False)
                if proc.returncode != 0:
                    raise RuntimeError("فشل حل اعتماديات Gradle؛ راجع السجل")
        elif server_type == "Go":
            if os.path.exists(os.path.join(srv_path, "go.mod")):
                if not shutil.which("go"):
                    raise RuntimeError("go.mod موجود لكن Go غير مثبت في الاستضافة")
                log_file.write("\n📦 تنزيل وحدات Go عبر go mod download...\n"); log_file.flush()
                proc = subprocess.run(["go", "mod", "download"], cwd=srv_path, stdout=log_file, stderr=subprocess.STDOUT,
                                      env=os.environ.copy(), timeout=600, check=False)
                if proc.returncode != 0:
                    raise RuntimeError("فشل go mod download؛ راجع السجل")
        elif server_type == "Rust":
            if os.path.exists(os.path.join(srv_path, "Cargo.toml")):
                if not shutil.which("cargo"):
                    raise RuntimeError("Cargo.toml موجود لكن Rust/Cargo غير مثبت في الاستضافة")
                log_file.write("\n📦 تنزيل وبناء اعتماديات Rust...\n"); log_file.flush()
                proc = subprocess.run(["cargo", "build", "--release"], cwd=srv_path, stdout=log_file, stderr=subprocess.STDOUT,
                                      env=os.environ.copy(), timeout=900, check=False)
                if proc.returncode != 0:
                    raise RuntimeError("فشل بناء اعتماديات Rust؛ راجع السجل")
        log_file.flush()
        return True
    except subprocess.TimeoutExpired as exc:
        log_file.write(f"\n❌ انتهت مهلة تثبيت المكتبات: {exc}\n"); log_file.flush()
        raise RuntimeError("استغرق تثبيت المكتبات وقتًا أطول من الحد المسموح") from exc
    except Exception as exc:
        log_file.write(f"\n❌ تعذر تجهيز اعتماديات المشروع: {exc}\n")
        # Add a short diagnostic hint without pretending to know more than the log says.
        msg = str(exc).lower()
        if any(x in msg for x in ("network", "connection", "timed out", "name or service not known", "ssl")):
            log_file.write("🔎 السبب المحتمل حسب الرسالة: مشكلة اتصال أو SSL مع مستودع الحزم.\n")
        elif any(x in msg for x in ("no matching distribution", "requires-python", "unsupported python")):
            log_file.write("🔎 السبب المحتمل حسب الرسالة: إصدار Python غير متوافق أو لا توجد نسخة حزمة مناسبة.\n")
        elif any(x in msg for x in ("gcc", "compiler", "rust", "build wheel")):
            log_file.write("🔎 السبب المحتمل حسب الرسالة: الحزمة تحتاج أدوات بناء غير متاحة في الاستضافة.\n")
        log_file.flush()
        raise

def detect_python_web_app(srv_path: str, main_file: str):
    """Identify common Python web apps whose module exports app but has no app.run() call."""
    if not main_file or not main_file.lower().endswith(".py"):
        return None
    source_path = safe_relative_path(srv_path, main_file)
    if not source_path or not os.path.isfile(source_path):
        return None
    try:
        source = open(source_path, "r", encoding="utf-8", errors="ignore").read()
        tree = ast.parse(source, filename=source_path)
    except Exception:
        return None
    # If the script already launches its own web server, let the script control its startup.
    if re.search(r"(?:\.run|uvicorn\.run|runserver)\s*\(", source, re.I):
        return None
    aliases = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            for alias in node.names:
                aliases[alias.asname or alias.name] = alias.name
        elif isinstance(node, ast.Import):
            for alias in node.names:
                aliases[alias.asname or alias.name.split('.')[0]] = alias.name
    hints = set()
    low = source.lower()
    if "flask" in low:
        hints.add("flask")
    if "fastapi" in low or "starlette" in low:
        hints.add("fastapi")
    for node in tree.body:
        targets = []
        value = None
        if isinstance(node, ast.Assign):
            targets = [t.id for t in node.targets if isinstance(t, ast.Name)]
            value = node.value
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            targets = [node.target.id]
            value = node.value
        if not targets or not isinstance(value, ast.Call):
            continue
        func = value.func
        called = func.id if isinstance(func, ast.Name) else (func.attr if isinstance(func, ast.Attribute) else "")
        actual = aliases.get(called, called).lower()
        framework = None
        if actual == "flask":
            framework = "flask"
        elif actual in ("fastapi", "starlette"):
            framework = "fastapi"
        elif called.lower() == "create_app" and hints:
            framework = "flask" if "flask" in hints else "fastapi"
        if framework:
            return {"framework": framework, "module": os.path.splitext(main_file.replace(os.sep, "/"))[0].replace("/", "."), "app_name": targets[0]}
    # Application factory patterns: app = create_app(), when Flask/FastAPI is imported in the same module.
    for node in tree.body:
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            value = node.value
            targets = ([t.id for t in node.targets if isinstance(t, ast.Name)] if isinstance(node, ast.Assign)
                       else ([node.target.id] if isinstance(node.target, ast.Name) else []))
            if targets and isinstance(value, ast.Call):
                called = value.func.id if isinstance(value.func, ast.Name) else ""
                if called in ("create_app", "make_app", "create_application") and hints:
                    framework = "flask" if "flask" in hints else "fastapi"
                    return {"framework": framework, "module": os.path.splitext(main_file.replace(os.sep, "/"))[0].replace("/", "."), "app_name": targets[0]}
    return None


# ============== تشغيل السيرفر ==============
def start_server_process(folder):
    srv=db['servers'].get(folder)
    if not srv: return False,'السيرفر غير موجود'
    srv_path=srv.get('path','')
    expected_path = _safe_server_dir(srv.get('owner', ''), folder)
    if not expected_path or os.path.abspath(srv_path) != expected_path or os.path.realpath(srv_path) != expected_path:
        return False, 'تم منع التشغيل لأن مسار السيرفر غير آمن أو لا يطابق مجلد المستخدم'
    if not os.path.isdir(srv_path): return False,'مجلد المشروع غير موجود'
    detected=detect_project_type(srv_path)
    current_type=srv.get('type')
    if not current_type or current_type not in SUPPORTED_SERVER_TYPES:
        srv['type']=detected
    elif current_type in ('Python', 'Node.js') and detected == 'Static':
        current_entry=srv.get('startup_file','')
        entry_path=os.path.join(srv_path,current_entry) if current_entry else ''
        expected={'Python':('.py',),'Node.js':('.js','.mjs','.cjs')}.get(current_type,())
        if not current_entry or not os.path.isfile(entry_path) or os.path.splitext(current_entry)[1].lower() not in expected:
            srv['type']='Static'
    # النوع Static المختار صراحةً لا يتغير إلى Python عند كون المجلد فارغاً.
    server_type=srv.get('type','Python')
    main_file=srv.get('startup_file') or detect_main_file(srv_path,server_type)
    srv['startup_file']=main_file
    if server_type=='Static':
        html_main = detect_main_file(srv_path, 'Static')
        if not html_main: return False,'لا يوجد ملف HTML'
        # لا تحتفظ بملف بدء قديم من نوع .py أو .js داخل مشروع HTML ثابت.
        srv['startup_file'] = html_main
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
            with open(log_path,'a',encoding='utf-8') as dep_log:
                python_bin=ensure_python_environment(srv_path, dep_log, strict=True)
            # Let submodules resolve from the uploaded project root.
            old_pythonpath = env.get("PYTHONPATH", "")
            env["PYTHONPATH"] = srv_path + (os.pathsep + old_pythonpath if old_pythonpath else "")
            web_app = detect_python_web_app(srv_path, main_file) if server_type == "Python" else None
            if web_app:
                app_ref = f"{web_app['module']}:{web_app['app_name']}"
                if web_app['framework'] == "flask":
                    env["FLASK_APP"] = app_ref
                    env["FLASK_DEBUG"] = "0"
                    env["FLASK_RUN_HOST"] = "0.0.0.0"
                    env["FLASK_RUN_PORT"] = str(preferred)
                    cmd = [python_bin, "-m", "flask", "run", "--no-reload", "--host", "0.0.0.0", "--port", str(preferred)]
                    with open(log_path, 'a', encoding='utf-8') as lf:
                        lf.write(f"\n🌐 تم اكتشاف تطبيق Flask بدون app.run؛ تشغيل تلقائي عبر {app_ref} على المنفذ {preferred}.\n")
                else:
                    cmd = [python_bin, "-m", "uvicorn", app_ref, "--host", "0.0.0.0", "--port", str(preferred)]
                    with open(log_path, 'a', encoding='utf-8') as lf:
                        lf.write(f"\n🌐 تم اكتشاف تطبيق FastAPI/ASGI بدون uvicorn.run؛ تشغيل تلقائي عبر {app_ref} على المنفذ {preferred}.\n")
            elif os.path.isfile(os.path.join(srv_path, "manage.py")):
                try:
                    django_source = open(os.path.join(srv_path, "manage.py"), "r", encoding="utf-8", errors="ignore").read()
                except Exception:
                    django_source = ""
                if "execute_from_command_line" in django_source and ("django" in django_source.lower() or os.path.exists(os.path.join(srv_path, "settings.py"))):
                    cmd = [python_bin, "manage.py", "runserver", f"0.0.0.0:{preferred}"]
                    with open(log_path, 'a', encoding='utf-8') as lf:
                        lf.write(f"\n🌐 تم اكتشاف مشروع Django؛ تشغيل manage.py runserver على المنفذ {preferred}.\n")
                else:
                    cmd=[python_bin,'-u',main_file]
            else:
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
    return start_server_process(folder)

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

def get_user_directory(username):
    if not is_safe_username_component(username):
        raise ValueError("اسم المستخدم يحتوي أحرفًا غير مسموحة لمسار الملفات")
    base = os.path.realpath(USERS_DIR)
    expected = os.path.abspath(os.path.join(base, username))
    path = os.path.realpath(expected)
    if path != expected or os.path.commonpath([base, path]) != base:
        raise ValueError("مسار المستخدم غير آمن أو يشير إلى مجلد رمزي")
    return path


def get_user_servers_dir(username):
    user_dir = get_user_directory(username)
    expected = os.path.abspath(os.path.join(user_dir, "SERVERS"))
    os.makedirs(expected, exist_ok=True)
    # Reject symlinks so a user directory cannot silently point into another user's storage.
    real_path = os.path.realpath(expected)
    if real_path != expected:
        raise ValueError("مسار سيرفرات المستخدم غير آمن")
    return real_path


FILE_COUNT_EXCLUDED_DIRS = {".venv", "venv", "node_modules", "__pycache__", ".git", ".pytest_cache", ".mypy_cache"}
# These files are owned by the hosting app, not by the uploaded project. Keep their
# special treatment limited to the project root so nested user files still count.
FILE_COUNT_EXCLUDED_NAMES = {"out.log", "errors.log", "server.log", "meta.json", ".mazagi_dependencies_hash"}
RESERVED_ROOT_FILES = {name.casefold() for name in FILE_COUNT_EXCLUDED_NAMES}
RESERVED_TEMP_PREFIXES = (".mazagi-save-", ".mazagi-replace-")


def is_reserved_root_file(name):
    return os.path.basename(str(name or "")).casefold() in RESERVED_ROOT_FILES


def is_reserved_temp_name(name):
    base = os.path.basename(str(name or "")).casefold()
    return base.endswith(".replace_tmp") or any(base.startswith(prefix) for prefix in RESERVED_TEMP_PREFIXES)


def is_reserved_project_path(relative_name):
    """True for app-owned root files or temporary names that users must not overwrite."""
    normalized = str(relative_name or "").replace("\\", "/").strip("/")
    parts = [part for part in normalized.split("/") if part]
    if not parts:
        return True
    if is_reserved_temp_name(parts[-1]):
        return True
    return len(parts) == 1 and is_reserved_root_file(parts[0])


def user_max_files(user_or_username):
    """Maximum number of user project files. New/legacy users default to 10."""
    user = db.get("users", {}).get(user_or_username, {}) if isinstance(user_or_username, str) else (user_or_username or {})
    try:
        return max(1, min(int(user.get("max_files", 10)), 1000000))
    except (TypeError, ValueError):
        return 10


def count_user_files(username):
    """Count stored project files for this user, excluding generated dependency/cache folders and logs."""
    total = 0
    for srv in db.get("servers", {}).values():
        if srv.get("owner") != username:
            continue
        base = srv.get("path") or ""
        if not os.path.isdir(base):
            continue
        for root, dirs, names in os.walk(base, followlinks=False):
            dirs[:] = [d for d in dirs if d not in FILE_COUNT_EXCLUDED_DIRS and not os.path.islink(os.path.join(root, d))]
            rel_root = os.path.relpath(root, base)
            at_root = rel_root == "."
            for name in names:
                if is_reserved_temp_name(name):
                    continue
                if at_root and is_reserved_root_file(name):
                    continue
                full_path = os.path.join(root, name)
                if os.path.islink(full_path):
                    continue
                total += 1
    return total


def file_quota_message(username, adding=1):
    user = db.get("users", {}).get(username, {})
    limit = user_max_files(user)
    used = count_user_files(username)
    if adding > 0 and used + adding > limit:
        return f"وصلت للحد الأقصى للملفات ({used}/{limit}). راجع الإدارة لزيادة الحد."
    return None


def count_zip_files(zip_obj):
    """Count regular archive entries, ignoring directory entries and generated dependency/cache files."""
    count = 0
    for info in zip_obj.infolist():
        name = info.filename.replace("\\", "/")
        parts = [x for x in name.split("/") if x]
        if info.is_dir() or not parts or any(part in FILE_COUNT_EXCLUDED_DIRS for part in parts):
            continue
        if is_reserved_temp_name(parts[-1]):
            continue
        if len(parts) == 1 and is_reserved_root_file(parts[0]):
            continue
        count += 1
    return count

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
@app.route('/healthz')
def healthz():
    return jsonify({"ok": True, "service": "mazagi-host"}), 200

@app.route('/api/persistence/status')
def persistence_status():
    if 'username' not in session or not is_admin(session.get('username', '')):
        return jsonify({"success": False, "message": "غير مصرح"}), 403
    return jsonify({
        "success": True,
        "is_railway": IS_RAILWAY_RUNTIME,
        "volume_detected": bool(RAILWAY_VOLUME_MOUNT_PATH),
        "persistent": PERSISTENT_STORAGE_CONFIGURED,
        "mount_path": RAILWAY_VOLUME_MOUNT_PATH or None,
        "data_dir": DATA_DIR,
        "database_exists": os.path.isfile(DB_FILE),
        "users_dir_exists": os.path.isdir(USERS_DIR),
        "warning": ("لم يتم اكتشاف Railway Volume. ربط GitHub وحده لا يحفظ ملفات الحاوية بين النشرات؛ اربط Volume على /data." if IS_RAILWAY_RUNTIME and not PERSISTENT_STORAGE_CONFIGURED else "")
    })

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
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({"success": False, "message": "بيانات الطلب غير صالحة"}), 400
    username = str(data.get("username", "")).strip()
    password = data.get("password", "").strip()
    telegram_id = data.get("telegram_id", "").strip()

    if not username or not password:
        return jsonify({"success": False, "message": "جميع الحقول مطلوبة"})
    if len(username) < 3:
        return jsonify({"success": False, "message": "اسم المستخدم 3 أحرف على الأقل"})
    if not is_safe_username_component(username):
        return jsonify({"success": False, "message": "اسم المستخدم لا يمكن أن يحتوي فواصل مسارات أو أحرف تحكم"}), 400
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
        "max_files": 10,
        "expiry_days": 365,
        "last_login": None,
        "telegram_id": telegram_id if telegram_id else None,
        "api_key": None,
        "storage_limit": db["plans"]["free"]["storage"],
        "plan": "free",
        "status": "pending"
    }
    save_db(db)

    user_dir = get_user_directory(username)
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
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({"success": False, "message": "بيانات الطلب غير صالحة"}), 400
    username = str(data.get("username", "")).strip()
    password = str(data.get("password", "")).strip()

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
            "max_files": user_max_files(udata),
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
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({"success": False, "message": "بيانات الطلب غير صالحة"}), 400
    username = str(data.get("username", "")).strip()
    password = str(data.get("password", "")).strip()
    try:
        max_servers = max(1, min(int(data.get("max_servers", 2)), 1000000))
        max_files = max(1, min(int(data.get("max_files", 10)), 1000000))
        expiry_days = max(1, min(int(data.get("expiry_days", 365)), 36500))
    except (TypeError, ValueError):
        return jsonify({"success": False, "message": "قيم الحدود والمدة يجب أن تكون أرقامًا صحيحة"}), 400
    if not username or not password:
        return jsonify({"success": False, "message": "جميع الحقول مطلوبة"}), 400
    if not is_safe_username_component(username) or len(username) < 3:
        return jsonify({"success": False, "message": "اسم المستخدم غير صالح"}), 400
    if username in db["users"]:
        return jsonify({"success": False, "message": "المستخدم موجود"})
    db["users"][username] = {
        "password": hashlib.sha256(password.encode()).hexdigest(),
        "is_admin": False,
        "created_at": str(datetime.now()),
        "max_servers": max_servers,
        "max_files": max_files,
        "expiry_days": expiry_days,
        "last_login": None,
        "telegram_id": None,
        "api_key": None,
        "storage_limit": 512000,
        "plan": "free",
        "status": "approved"
    }
    save_db(db)
    user_dir = get_user_directory(username)
    os.makedirs(user_dir, exist_ok=True)
    os.makedirs(os.path.join(user_dir, "SERVERS"), exist_ok=True)
    return jsonify({"success": True, "message": "✅ تم إنشاء الحساب"})

@app.route('/api/admin/delete-user', methods=['POST'])
def admin_delete_user():
    if not _check_admin_access():
        return jsonify({"success": False}), 403
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({"success": False, "message": "بيانات الطلب غير صالحة"}), 400
    username = str(data.get("username", "")).strip()
    if not username or username == ADMIN_USERNAME or (username in db.get("users", {}) and db["users"][username].get("is_admin")):
        return jsonify({"success": False, "message": "لا يمكن حذف حساب الإدارة"}), 400
    if username in db["users"]:
        if not is_safe_username_component(username):
            return jsonify({"success": False, "message": "اسم المستخدم القديم غير آمن لمسار الحذف؛ لم تُحذف أي ملفات"}), 400
        safe_servers_root = os.path.realpath(get_user_servers_dir(username))
        for fid in [fid for fid, srv in db["servers"].items() if srv.get("owner") == username]:
            stop_server_process(fid)
            server_path = os.path.realpath(db["servers"][fid].get("path", ""))
            if os.path.commonpath([safe_servers_root, server_path]) == safe_servers_root and os.path.isdir(server_path):
                shutil.rmtree(server_path, ignore_errors=True)
            else:
                print(f"⚠️ تم منع حذف مسار خارج مجلد المستخدم: {server_path}", flush=True)
            del db["servers"][fid]
        user_dir = get_user_directory(username)
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
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({"success": False, "message": "بيانات الطلب غير صالحة"}), 400
    username = str(data.get("username", "")).strip()
    if username not in db["users"]:
        return jsonify({"success": False, "message": "المستخدم غير موجود"}), 404

    # Validate every numeric value before mutating the user, avoiding half-applied updates.
    updates = {}
    numeric_limits = {
        "max_servers": (1, 1000000, "حد السيرفرات"),
        "max_files": (1, 1000000, "حد الملفات"),
        "expiry_days": (1, 36500, "مدة الحساب"),
        "storage_limit": (0, 10**15, "سعة التخزين"),
    }
    for field, (minimum, maximum, label) in numeric_limits.items():
        if field not in data:
            continue
        try:
            value = int(data[field])
        except (TypeError, ValueError):
            return jsonify({"success": False, "message": f"{label} يجب أن يكون رقمًا صحيحًا"}), 400
        if value < minimum or value > maximum:
            return jsonify({"success": False, "message": f"{label} يجب أن يكون بين {minimum} و{maximum}"}), 400
        updates[field] = value
    if "is_admin" in data:
        if not isinstance(data["is_admin"], bool):
            return jsonify({"success": False, "message": "قيمة صلاحية الإدارة غير صالحة"}), 400
        updates["is_admin"] = data["is_admin"]
    db["users"][username].update(updates)
    if not save_db(db):
        return jsonify({"success": False, "message": "تعذر حفظ التغييرات في قاعدة البيانات"}), 500
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
    # موقع HTML/CSS/JS رابط ويب عام دائماً، حتى لو احتوى ملف JavaScript على نص يشبه BOT_TOKEN.
    if srv.get('type') == 'Static':
        return {'kind':'website','url':f"{request.host_url.rstrip('/')}/site/{quote(folder,safe='')}/",'label':'فتح الموقع'}
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
    # صفحات المواقع المنشورة عامة؛ إدارة الملفات والتشغيل تبقى محمية في مسارات API منفصلة.
    prefix='/site/'+quote(folder,safe='')
    if srv.get('type')=='Static':
        base=os.path.abspath(srv.get('path',''))
        if not subpath:
            # الصفحة الرئيسية دائماً HTML؛ لا نعرض app.py/main.py بسبب قيمة startup_file قديمة.
            html_candidates=['index.html','index.htm','home.html']
            rel=next((name for name in html_candidates if os.path.isfile(os.path.join(base,name))), '')
            if not rel:
                configured=srv.get('startup_file','')
                if configured and os.path.splitext(configured)[1].lower() in ('.html','.htm') and os.path.isfile(os.path.join(base,configured)):
                    rel=configured
            if not rel:
                try:
                    for root,dirs,names in os.walk(base):
                        dirs[:] = [d for d in dirs if d not in {'.git','.venv','venv','node_modules','__pycache__'}]
                        found=next((os.path.relpath(os.path.join(root,n),base).replace(os.sep,'/') for n in sorted(names) if n.lower().endswith(('.html','.htm'))),None)
                        if found:
                            rel=found
                            break
                except Exception:
                    pass
            if not rel:
                return 'لم يتم العثور على صفحة HTML رئيسية (index.html).',404
        else:
            rel=subpath
            # لا تسمح بعرض كود الخادم أو ملفات الإعدادات عبر رابط الموقع العام.
            low_parts=[part.lower() for part in rel.replace('\\','/').split('/')]
            ext=os.path.splitext(rel)[1].lower()
            blocked_names = {
                'procfile','requirements.txt','dockerfile','railway.toml','render.yaml',
                'composer.json','composer.lock','package.json','package-lock.json','pnpm-lock.yaml','yarn.lock',
                'pyproject.toml','setup.py','setup.cfg','poetry.lock','pipfile','pipfile.lock',
                'gemfile','gemfile.lock','cargo.toml','go.mod','service-account.json',
                'credentials.json','secrets.json','token.json','firebase-adminsdk.json'
            }
            blocked_exts = {'.py','.pyc','.pyo','.log','.ini','.toml','.yaml','.yml','.zip','.sqlite','.sqlite3','.db','.pem','.key','.crt','.p12','.bak'}
            if any(part.startswith('.') for part in low_parts) or ext in blocked_exts or os.path.basename(rel).lower() in blocked_names:
                return 'الملف غير متاح للعرض العام',404
        target=safe_relative_path(base,rel)
        if not target or not os.path.isfile(target): return 'الملف غير موجود',404
        try:
            from mimetypes import guess_type
            ctype=guess_type(target)[0] or ''
            if 'text/html' in ctype:
                html=open(target,'r',encoding='utf-8',errors='ignore').read()
                return Response(_rewrite_site_html(html,prefix),content_type='text/html; charset=utf-8')
        except Exception:
            pass
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
                "subtitle": f"{'موقع HTML/CSS/JS' if srv.get('type') == 'Static' else 'سيرفر ' + str(srv.get('type', 'Python'))}",
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
    if server_type not in ("Python", "PHP", "Static", "Node.js"):
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
        expected_path = _safe_server_dir(srv.get("owner", ""), folder)
        recorded_path = os.path.abspath(srv.get("path", ""))
        if not expected_path or recorded_path != expected_path or os.path.realpath(recorded_path) != expected_path:
            return jsonify({"success": False, "message": "تم منع الحذف لأن مسار السيرفر لا يطابق مجلد المستخدم"}), 400
        stop_server_process(folder)
        if os.path.isdir(expected_path):
            shutil.rmtree(expected_path, ignore_errors=True)
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
        for root, dirs, names in os.walk(base, followlinks=False):
            dirs[:] = [d for d in dirs if d not in FILE_COUNT_EXCLUDED_DIRS and not os.path.islink(os.path.join(root, d))]
            rel_root = os.path.relpath(root, base)
            rel_root = '' if rel_root == '.' else rel_root.replace(os.sep, '/')
            for name in dirs + names:
                rel = os.path.join(rel_root, name).replace(os.sep, '/') if rel_root else name
                if is_reserved_project_path(rel) or is_reserved_temp_name(name):
                    continue
                full = os.path.join(root, name)
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
    relative_name = os.path.relpath(fpath, os.path.realpath(srv["path"])).replace(os.sep, "/")
    if is_reserved_project_path(relative_name) or has_symlink_component(srv["path"], filename):
        return jsonify({"content": "", "message": "لا يمكن فتح ملفات النظام أو المسارات الرمزية من المحرر"}), 403
    if os.path.getsize(fpath) > 5 * 1024 * 1024:
        return jsonify({"content": "", "message": "الملف أكبر من حد المحرر (5 ميغابايت). نزّله وعدّله بأداة ملفات ثم أعد رفعه."}), 413
    try:
        with open(fpath, 'rb') as f:
            raw = f.read()
        if b"\x00" in raw[:8192]:
            return jsonify({"content": "[ملف ثنائي]", "is_binary": True})
        try:
            content = raw.decode("utf-8")
        except UnicodeDecodeError:
            return jsonify({"content": "[ملف ثنائي]", "is_binary": True})
        return jsonify({"content": content, "is_binary": False})
    except Exception:
        return jsonify({"content": "", "message": "تعذر قراءة الملف"}), 500

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
    relative_name = os.path.relpath(fpath, os.path.realpath(srv["path"])).replace(os.sep, "/")
    if is_reserved_project_path(relative_name) or has_symlink_component(srv["path"], filename):
        return jsonify({"success": False, "message": "لا يمكن تعديل ملفات النظام أو المسارات الرمزية"}), 403
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({"success": False, "message": "بيانات الطلب غير صالحة"}), 400
    content = data.get("content", "")
    if not isinstance(content, str):
        return jsonify({"success": False, "message": "محتوى الملف غير صالح"}), 400
    if len(content.encode("utf-8")) > 5 * 1024 * 1024:
        return jsonify({"success": False, "message": "المحتوى أكبر من حد المحرر (5 ميغابايت)"}), 413
    temp_path = None
    try:
        parent = os.path.dirname(fpath)
        temp_path = os.path.join(parent, f".mazagi-save-{secrets.token_hex(8)}.tmp")
        with open(temp_path, 'w', encoding='utf-8', newline='') as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp_path, fpath)
        return jsonify({"success": True, "message": "✅ تم الحفظ"})
    except Exception as e:
        if temp_path:
            try:
                if os.path.exists(temp_path): os.remove(temp_path)
            except OSError:
                pass
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

    # Check the full batch before writing anything, so the limit cannot be exceeded by multi-file uploads.
    candidate_names = []
    seen_names = set()
    for item in files:
        if not item or not item.filename:
            continue
        clean_name = safe_user_filename(item.filename)
        if not clean_name:
            errors_list.append(f"اسم ملف غير صالح: {item.filename}")
            continue
        if is_reserved_project_path(clean_name):
            return jsonify({"success": False, "message": f"الاسم {clean_name} محجوز لسجلات النظام، اختر اسمًا آخر."}), 400
        name_key = clean_name.casefold()
        if name_key in seen_names:
            return jsonify({"success": False, "message": f"الملف {clean_name} مكرر في نفس عملية الرفع."}), 400
        seen_names.add(name_key)
        candidate_names.append((item, clean_name))
    if not candidate_names:
        return jsonify({"success": False, "message": "لم يتم اختيار ملفات صالحة للرفع", "warnings": errors_list}), 400
    new_unique_names = {name for _, name in candidate_names if not os.path.exists(os.path.join(srv["path"], name))}
    user_name = session["username"]
    current_count = count_user_files(user_name)
    limit = user_max_files(db["users"].get(user_name, {}))
    if current_count + len(new_unique_names) > limit:
        return jsonify({"success": False, "message": f"رفع مرفوض: حدك {limit} ملفًا والمستخدم حاليًا {current_count}. المتاح {max(0, limit-current_count)} ملف."}), 400

    for f, filename in candidate_names:
        try:
            save_path = os.path.join(srv["path"], filename)
            f.save(save_path)
            uploaded += 1
        except Exception as e:
            errors_list.append(str(e))

    if not uploaded:
        return jsonify({"success": False, "message": "فشل الرفع", "errors": errors_list})

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


def safe_extract_zip(zip_file, destination):
    """Extract ZIP safely: reject path traversal, symlinks, duplicate targets, and app-owned names."""
    base = os.path.realpath(os.path.abspath(destination))
    os.makedirs(base, exist_ok=True)
    seen_targets = set()
    for info in zip_file.infolist():
        raw_name = str(info.filename or "").replace("\\", "/")
        if (not raw_name or raw_name.startswith("/") or re.match(r"^[A-Za-z]:", raw_name)
                or "\x00" in raw_name):
            raise ValueError("أرشيف ZIP يحتوي مساراً غير آمن")
        parts = [part for part in raw_name.split("/") if part not in ("", ".")]
        if not parts or any(part == ".." for part in parts):
            raise ValueError("أرشيف ZIP يحاول الكتابة خارج مجلد المشروع")
        relative_name = "/".join(parts)
        if is_reserved_project_path(relative_name):
            raise ValueError(f"أرشيف ZIP يحتوي اسمًا محجوزًا للنظام: {relative_name}")
        target = os.path.abspath(os.path.join(base, *parts))
        try:
            if os.path.commonpath([base, target]) != base:
                raise ValueError("أرشيف ZIP يحاول الكتابة خارج مجلد المشروع")
        except ValueError:
            raise ValueError("أرشيف ZIP يحاول الكتابة خارج مجلد المشروع")
        target_key = os.path.normcase(target).casefold()
        if target_key in seen_targets:
            raise ValueError(f"أرشيف ZIP يحتوي مسارًا مكررًا: {relative_name}")
        seen_targets.add(target_key)
        unix_mode = (info.external_attr >> 16) & 0xFFFF
        if (unix_mode & 0o170000) == 0o120000:
            raise ValueError("روابط الملفات الرمزية غير مسموحة داخل ZIP")
        # Also reject extraction through an existing symlinked parent directory.
        parent = base
        for part in parts[:-1]:
            parent = os.path.join(parent, part)
            if os.path.islink(parent):
                raise ValueError("أرشيف ZIP يحاول الكتابة عبر مجلد رمزي غير آمن")
    zip_file.extractall(base)

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

    server_name = (request.form.get("server_name") or "").strip()
    if not server_name:
        return jsonify({"success": False, "message": "اكتب اسمًا للسيرفر قبل رفع الملف"}), 400
    if len(server_name) > 60:
        return jsonify({"success": False, "message": "اسم السيرفر يجب ألا يتجاوز 60 حرفًا"}), 400

    f = request.files.get('file')
    if not f or not f.filename:
        return jsonify({"success": False, "message": "اختر ملفاً أولاً"})

    filename = safe_user_filename(f.filename)
    if not filename:
        return jsonify({"success": False, "message": "اسم الملف غير صالح"}), 400
    if is_reserved_project_path(filename):
        return jsonify({"success": False, "message": "هذا الاسم محجوز لسجلات النظام؛ اختر اسمًا آخر للملف."}), 400

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

    current_file_count = count_user_files(session["username"])
    max_file_count = user_max_files(user)
    if current_file_count >= max_file_count:
        return jsonify({"success": False, "message": f"وصلت للحد الأقصى للملفات ({current_file_count}/{max_file_count}). اطلب من الإدارة زيادة الحد."}), 400

    base_name = os.path.splitext(filename)[0]
    safe_name = re.sub(r'[^a-zA-Z0-9_-]+', '', base_name) or "my-server"
    safe_server_slug = re.sub(r'[^a-zA-Z0-9_-]+', '', server_name)[:35] or "server"
    folder = f"{session['username']}_{safe_server_slug}_{int(time.time())}_{secrets.token_hex(3)}"
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
                archive_files = count_zip_files(zf)
                if current_file_count + archive_files > max_file_count:
                    raise ValueError(f"المشروع يحتوي {archive_files} ملفًا، والمتبقي في الحد {max(0, max_file_count-current_file_count)}. زِد الحد من الإدارة أو اختر مشروعًا أصغر.")
                safe_extract_zip(zf, path)
            normalize_extracted_project(path)
            try:
                os.remove(zip_path)  # the archive is only an import container; retain extracted project files
            except OSError:
                pass
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
                # Python's start_server_process calls ensure_python_environment itself;
                # avoid installing the same requirements twice during first startup.
                if server_type != "Python":
                    with open(log_path, "a", encoding="utf-8") as lf:
                        auto_install_deps(path, server_type, lf)
                ok, start_msg = start_server_process(folder)
                with open(log_path, "a", encoding="utf-8") as lf:
                    lf.write(f"\n{'✅' if ok else '❌'} نتيجة التشغيل التلقائي: {start_msg}\n")
                if not ok:
                    db["servers"][folder]["status"] = "Stopped"
                    db["servers"][folder]["last_error"] = str(start_msg)
                    save_db(db)
            except Exception as exc:
                try:
                    with open(log_path, "a", encoding="utf-8") as lf:
                        lf.write(f"\n❌ التثبيت/التشغيل التلقائي: {exc}\n")
                    db["servers"][folder]["status"] = "Stopped"
                    db["servers"][folder]["pid"] = None
                    db["servers"][folder]["last_error"] = str(exc)
                    save_db(db)
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
    relative_name = os.path.relpath(target, os.path.realpath(srv["path"])).replace(os.sep, "/")
    if is_reserved_project_path(relative_name) or has_symlink_component(srv["path"], filename):
        return jsonify({"success": False, "message": "لا يمكن استبدال ملف نظام أو مسار رمزي"}), 400
    if os.path.isdir(target):
        return jsonify({"success": False, "message": "لا يمكن استبدال مجلد"}), 400
    if not os.path.exists(target):
        return jsonify({"success": False, "message": "الملف الأصلي غير موجود"}), 404
    new_file = request.files.get('file')
    if not new_file or not new_file.filename:
        return jsonify({"success": False, "message": "اختر الملف الجديد أولاً"}), 400
    try:
        # نكتب إلى ملف مؤقت عشوائي في نفس المجلد ثم نستبدل الملف ذرياً.
        temp_path = os.path.join(os.path.dirname(target), f".mazagi-replace-{secrets.token_hex(8)}.tmp")
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
    base_real = os.path.realpath(srv["path"])
    old_rel = os.path.relpath(old_path, base_real).replace(os.sep, "/")
    new_rel = os.path.relpath(new_path, base_real).replace(os.sep, "/")
    if is_reserved_project_path(old_rel) or is_reserved_project_path(new_rel) or has_symlink_component(srv["path"], old_name):
        return jsonify({"success": False, "message": "لا يمكن إعادة تسمية ملف نظام أو مسار رمزي"}), 400
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
            archive_count = count_zip_files(zf)
            current_count = count_user_files(session["username"])
            # The ZIP itself is already counted; after extraction it remains, so only count entries not already present.
            projected_count = current_count + archive_count
            max_allowed = user_max_files(db["users"].get(session["username"], {}))
            if projected_count > max_allowed:
                return jsonify({"success": False, "message": f"فك الضغط سيتجاوز حدك ({current_count}/{max_allowed} ملفًا). زِد الحد من الإدارة أولًا."}), 400
            base = os.path.abspath(srv["path"])
            for member in zf.infolist():
                member_name = member.filename.replace('\\', '/')
                dest = os.path.abspath(os.path.join(base, member_name))
                if os.path.commonpath([base, dest]) != base:
                    return jsonify({"success": False, "message": "ZIP يحتوي مساراً غير آمن"}), 400
            safe_extract_zip(zf, base)
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
        relative_name = os.path.relpath(fpath, os.path.realpath(srv["path"])).replace(os.sep, "/")
        if is_reserved_project_path(relative_name) or has_symlink_component(srv["path"], name):
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
    data=request.get_json(silent=True) or {}
    if not isinstance(data, dict): return jsonify({'success':False,'message':'بيانات الطلب غير صالحة'}),400
    raw_name=str(data.get('filename','')).strip()
    name=safe_relative_path(srv['path'],raw_name)
    if not name or is_reserved_project_path(os.path.relpath(name, os.path.realpath(srv['path'])).replace(os.sep,'/')): return jsonify({'success':False,'message':'اسم المجلد غير صالح أو محجوز'}),400
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
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({"success": False, "message": "بيانات الطلب غير صالحة"}), 400
    filename = safe_user_filename(str(data.get("filename", "")).strip())
    if not filename:
        return jsonify({"success": False, "message": "اسم غير صالح"}), 400
    if is_reserved_project_path(filename):
        return jsonify({"success": False, "message": "هذا الاسم محجوز لسجلات النظام"}), 400
    fpath = safe_relative_path(srv["path"], filename)
    if not fpath:
        return jsonify({"success": False, "message": "اسم غير صالح"}), 400
    if os.path.exists(fpath):
        return jsonify({"success": False, "message": "يوجد ملف بهذا الاسم؛ افتحه للتعديل بدل إنشاء ملف جديد"}), 409
    quota_error = file_quota_message(session["username"], 1)
    if quota_error:
        return jsonify({"success": False, "message": quota_error}), 400
    try:
        os.makedirs(os.path.dirname(fpath), exist_ok=True)
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
    startup_path = safe_relative_path(srv["path"], filename)
    if not startup_path or not os.path.isfile(startup_path):
        return jsonify({"success": False, "message": "الملف غير موجود"}), 404
    if srv.get("type") == "Static" and os.path.splitext(filename)[1].lower() not in (".html", ".htm"):
        return jsonify({"success": False, "message": "موقع HTML يحتاج ملف بدء من نوع .html أو .htm"}), 400
    srv["startup_file"] = filename
    save_db(db)
    return jsonify({"success": True, "message": f"✅ تم تعيين {filename} كملف التشغيل"})

@app.route('/api/admin/user-servers/<username>')
def admin_user_servers(username):
    if not _check_admin_access():
        return jsonify({"success": False, "message": "غير مصرح"}), 403
    if username not in db.get("users", {}):
        return jsonify({"success": False, "message": "المستخدم غير موجود"}), 404
    result = []
    for folder, srv in db.get("servers", {}).items():
        if srv.get("owner") != username:
            continue
        file_count = 0
        disk_bytes = 0
        base = srv.get("path", "")
        if os.path.isdir(base):
            for root, dirs, names in os.walk(base, followlinks=False):
                dirs[:] = [d for d in dirs if d not in FILE_COUNT_EXCLUDED_DIRS and not os.path.islink(os.path.join(root, d))]
                at_root = os.path.relpath(root, base) == "."
                for name in names:
                    full_path = os.path.join(root, name)
                    if is_reserved_temp_name(name) or (at_root and is_reserved_root_file(name)) or os.path.islink(full_path):
                        continue
                    file_count += 1
                    try:
                        disk_bytes += os.path.getsize(full_path)
                    except OSError:
                        pass
        result.append({
            "folder": folder,
            "title": srv.get("name", folder),
            "type": srv.get("type", "Python"),
            "status": srv.get("status", "Stopped"),
            "created_at": srv.get("created_at", ""),
            "file_count": file_count,
            "disk_used_mb": round(disk_bytes / (1024 * 1024), 2),
            "open_kind": "telegram" if find_telegram_bot_token(base) else ("website" if srv.get("type") == "Static" else "project")
        })
    return jsonify({"success": True, "username": username, "servers": sorted(result, key=lambda x: x["created_at"], reverse=True)})


@app.route('/api/admin/server/open/<folder>')
def admin_server_open(folder):
    if not _check_admin_access():
        return jsonify({"success": False, "message": "غير مصرح"}), 403
    srv = db.get("servers", {}).get(folder)
    if not srv:
        return jsonify({"success": False, "message": "السيرفر غير موجود"}), 404
    return jsonify({"success": True, **get_server_open_url(folder, srv)})


@app.route('/api/admin/server-action/<folder>/<action>', methods=['POST'])
def admin_server_action(folder, action):
    if not _check_admin_access():
        return jsonify({"success": False, "message": "غير مصرح"}), 403
    srv = db.get("servers", {}).get(folder)
    if not srv:
        return jsonify({"success": False, "message": "السيرفر غير موجود"}), 404
    if action == "start":
        ok, message = start_server_process(folder)
        return jsonify({"success": ok, "message": message}), (200 if ok else 400)
    if action == "stop":
        stop_server_process(folder)
        return jsonify({"success": True, "message": "تم إيقاف السيرفر"})
    if action == "restart":
        ok, message = restart_server(folder)
        if ok is None:
            ok = db.get("servers", {}).get(folder, {}).get("status") in ("Running", "Starting")
        return jsonify({"success": bool(ok), "message": message or "تم إرسال أمر إعادة التشغيل"}), (200 if ok else 400)
    if action == "delete":
        expected_path = _safe_server_dir(srv.get("owner", ""), folder)
        server_path = os.path.abspath(srv.get("path", ""))
        if not expected_path or server_path != expected_path or os.path.realpath(server_path) != expected_path:
            return jsonify({"success": False, "message": "تم منع الحذف لأن مسار السيرفر لا يطابق مجلد المستخدم"}), 400
        stop_server_process(folder)
        if os.path.isdir(expected_path):
            shutil.rmtree(expected_path, ignore_errors=True)
        db.get("servers", {}).pop(folder, None)
        save_db(db)
        return jsonify({"success": True, "message": "تم حذف السيرفر وملفاته"})
    return jsonify({"success": False, "message": "إجراء غير معروف"}), 400


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
    for root_dir, dirs, names in os.walk(base, followlinks=False):
        dirs[:] = [d for d in dirs if d not in FILE_COUNT_EXCLUDED_DIRS and not os.path.islink(os.path.join(root_dir, d))]
        for name in names:
            full = os.path.join(root_dir, name)
            rel = os.path.relpath(full, base).replace(os.sep, '/')
            if is_reserved_project_path(rel) or is_reserved_temp_name(name) or os.path.islink(full):
                continue
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
    fpath = os.path.realpath(os.path.join(srv["path"], rel))
    base = os.path.realpath(srv["path"])
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
    fpath = os.path.realpath(os.path.join(srv["path"], rel))
    base = os.path.realpath(srv["path"])
    if not fpath.startswith(base + os.sep) or not os.path.exists(fpath):
        return jsonify({"success": False, "message": "الملف غير موجود"}), 404
    if is_reserved_project_path(rel) or os.path.islink(os.path.join(srv["path"], rel)):
        return jsonify({"success": False, "message": "لا يمكن حذف ملفات سجلات النظام"}), 400
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
        archive_path = archive_base + '.zip'
        with zipfile.ZipFile(archive_path, 'w', compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
            for root, dirs, names in os.walk(srv["path"], followlinks=False):
                dirs[:] = [d for d in dirs if d not in FILE_COUNT_EXCLUDED_DIRS and not os.path.islink(os.path.join(root, d))]
                at_root = os.path.relpath(root, srv["path"]) == "."
                for name in names:
                    full_path = os.path.join(root, name)
                    rel_path = os.path.relpath(full_path, srv["path"]).replace(os.sep, '/')
                    if is_reserved_project_path(rel_path) or is_reserved_temp_name(name) or os.path.islink(full_path):
                        continue
                    archive.write(full_path, arcname=rel_path)
        return send_file(archive_path, as_attachment=True, download_name=(safe_user_filename(srv.get('name','server')) or 'server') + '.zip')
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
    if server_type == "Static":
        return jsonify({"success": True, "message": "✅ موقع HTML ثابت لا يحتاج تثبيت مكتبات."})
    
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
    if server_type == "Static":
        return jsonify({"success": True, "message": "الموقع الثابت لا يحتاج تثبيت مكتبات."})
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
    if server_type not in ("Python", "PHP", "Static", "Node.js"):
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