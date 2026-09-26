#!/usr/bin/env python3
"""
مزاجي - بوت التحكم الكامل مع دعم PHP و Python و Node.js
طُوِّر بواسطة: ᗴᒪᗰOᗪᗰᗴᑎ | @zzmmkj
"""

import os
import requests
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    Application, CommandHandler, CallbackQueryHandler,
    MessageHandler, filters, ContextTypes, ConversationHandler
)

# ========== إعدادات البوت ==========
BOT_TOKEN = "8107118673:AAG6xUifqFD5qtCWZMy_D9qEmC8HOCx4DBo"
API_BASE_URL = os.environ.get("API_BASE_URL", "https://mero-host.onrender.com")

# إيدي الأدمن على تليجرام
ADMIN_TELEGRAM_IDS = [8394089237]

# معلومات المطور
DEVELOPER_INFO = "🛠 طُوِّر بواسطة: *مزاجي*\n📬 تواصل: @zzmmkj"

# ========== حالات المحادثة ==========
(
    WAITING_FOR_API_KEY,
    WAITING_FOR_NEW_SERVER_NAME,
    WAITING_FOR_SERVER_TYPE,
    WAITING_FOR_DELETE_USERNAME,
    WAITING_FOR_PHP_CODE,
    WAITING_FOR_PHP_FILENAME,
    WAITING_FOR_PHP_CONTENT,
) = range(7)


# ─────────────────────────────────────────────────
#  API Helper
# ─────────────────────────────────────────────────
def api_request(endpoint, method="GET", data=None, params=None, api_key=None):
    url = f"{API_BASE_URL}{endpoint}"
    try:
        if method == "GET":
            p = dict(params or {})
            if api_key:
                p["api_key"] = api_key
            resp = requests.get(url, params=p, timeout=30)
        else:
            d = dict(data or {})
            if api_key and "api_key" not in d:
                d["api_key"] = api_key
            resp = requests.post(url, json=d, timeout=30)
        return resp.json() if resp.ok else {"success": False, "message": f"HTTP {resp.status_code}"}
    except Exception as e:
        return {"success": False, "message": str(e)}


def is_admin_tg(update: Update) -> bool:
    return update.effective_chat.id in ADMIN_TELEGRAM_IDS


# ─────────────────────────────────────────────────
#  القائمة الرئيسية
# ─────────────────────────────────────────────────
async def show_main_menu(update: Update, context: ContextTypes.DEFAULT_TYPE, edit=False):
    api_key = context.user_data.get("api_key")
    username = context.user_data.get("username", "")
    is_adm = is_admin_tg(update)

    keyboard = []

    if api_key:
        keyboard.append([
            InlineKeyboardButton("📁 سيرفراتي", callback_data="my_servers"),
            InlineKeyboardButton("➕ إنشاء سيرفر", callback_data="create_server"),
        ])
        keyboard.append([
            InlineKeyboardButton("🐍 تشغيل PHP", callback_data="run_php"),
            InlineKeyboardButton("📂 ملفات PHP", callback_data="php_files"),
        ])
        keyboard.append([
            InlineKeyboardButton("🔑 تغيير API Key", callback_data="change_api"),
            InlineKeyboardButton("🚪 تسجيل خروج", callback_data="logout"),
        ])
    else:
        keyboard.append([InlineKeyboardButton("🔑 ربط API Key", callback_data="enter_api")])

    if is_adm:
        pending_count = 0
        result = api_request("/api/admin/pending", api_key=api_key)
        if result and result.get("success"):
            pending_count = len(result.get("requests", []))
        bell = f"🔔 إشعارات ({pending_count})" if pending_count > 0 else "🔕 إشعارات"
        keyboard.append([
            InlineKeyboardButton("👑 لوحة الإدارة", callback_data="admin_panel"),
            InlineKeyboardButton(bell, callback_data="admin_notifications"),
        ])

    keyboard.append([InlineKeyboardButton("💬 تواصل مع المطور @zzmmkj", url="https://t.me/zzmmkj")])

    text = (
        "━━━━━━━━━━━━━━━━━━━━\n"
        "      مزاجي 🚀\n"
        "━━━━━━━━━━━━━━━━━━━━\n"
    )
    if username:
        text += f"👤 أهلاً، *{username}*!\n"
    text += "✅ متصل بالنظام\n" if api_key else "⚠️ يجب ربط API Key أولاً\n"
    text += f"\n{DEVELOPER_INFO}"

    markup = InlineKeyboardMarkup(keyboard)
    try:
        if edit and update.callback_query:
            await update.callback_query.edit_message_text(text, parse_mode="Markdown", reply_markup=markup)
        elif update.message:
            await update.message.reply_text(text, parse_mode="Markdown", reply_markup=markup)
        else:
            await update.callback_query.edit_message_text(text, parse_mode="Markdown", reply_markup=markup)
    except Exception:
        pass


# ─────────────────────────────────────────────────
#  عرض السيرفرات
# ─────────────────────────────────────────────────
async def show_servers_list(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    api_key = context.user_data.get("api_key")
    if not api_key:
        await query.edit_message_text("❌ يجب ربط API Key أولاً.")
        return

    result = api_request("/api/bot/servers", api_key=api_key)
    if not result or not result.get("success"):
        await query.edit_message_text(
            "━━━━━━━━━━━━━━━━━━━━\n"
            "❌ فشل جلب السيرفرات\n"
            "━━━━━━━━━━━━━━━━━━━━\n"
            "تحقق من صحة API Key.",
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔙 رجوع", callback_data="main_menu")]]),
        )
        return

    servers = result.get("servers", [])
    if not servers:
        await query.edit_message_text(
            "━━━━━━━━━━━━━━━━━━━━\n"
            "📭 لا توجد سيرفرات\n"
            "━━━━━━━━━━━━━━━━━━━━\n"
            "أنشئ سيرفرك الأول الآن!",
            reply_markup=InlineKeyboardMarkup([
                [InlineKeyboardButton("➕ إنشاء سيرفر", callback_data="create_server")],
                [InlineKeyboardButton("🔙 رجوع", callback_data="main_menu")],
            ]),
        )
        return

    await query.edit_message_text(f"📋 لديك *{len(servers)}* سيرفر:", parse_mode="Markdown")

    for srv in servers:
        status_emoji = "🟢" if srv["status"] == "Running" else "⚫"
        srv_type = srv.get("type", "Python")
        # أيقونات حسب النوع
        if srv_type == "Python":
            type_icon = "🐍"
        elif srv_type == "PHP":
            type_icon = "🐘"
        else:
            type_icon = "🟨"

        text = (
            f"━━━━━━━━━━━━━━━━━━━━\n"
            f"{status_emoji} *{srv['title']}*\n"
            f"━━━━━━━━━━━━━━━━━━━━\n"
            f"{type_icon} النوع: `{srv_type}`\n"
            f"📊 الحالة: `{srv['status']}`\n"
            f"🔌 المنفذ: `{srv['port']}`\n"
            f"⏱ وقت التشغيل: {srv['uptime']}"
        )
        folder = srv["folder"]
        keyboard = [
            [
                InlineKeyboardButton("▶️ تشغيل", callback_data=f"srv_start|{folder}"),
                InlineKeyboardButton("⏹ إيقاف", callback_data=f"srv_stop|{folder}"),
                InlineKeyboardButton("🔄 إعادة", callback_data=f"srv_restart|{folder}"),
            ],
            [
                InlineKeyboardButton("🖥 كونسول", callback_data=f"console|{folder}"),
                InlineKeyboardButton("⚠️ أخطاء", callback_data=f"errors|{folder}"),
                InlineKeyboardButton("🗑 حذف", callback_data=f"srv_delete|{folder}"),
            ],
            [InlineKeyboardButton("📦 تثبيت مكتبات تلقائياً", callback_data=f"install|{folder}")],
        ]
        await query.message.reply_text(text, parse_mode="Markdown", reply_markup=InlineKeyboardMarkup(keyboard))

    await query.message.reply_text(
        "━━━━━━━━━━━━━━━━━━━━",
        reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔙 القائمة الرئيسية", callback_data="main_menu")]]),
    )


# ─────────────────────────────────────────────────
#  لوحة الإدارة
# ─────────────────────────────────────────────────
async def show_admin_panel(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    if not is_admin_tg(update):
        await query.edit_message_text("❌ غير مصرح لك بالدخول.")
        return

    api_key = context.user_data.get("api_key")
    result = api_request("/api/admin/users", api_key=api_key)
    users = result.get("users", []) if result and result.get("success") else []

    pending_result = api_request("/api/admin/pending", api_key=api_key)
    pending_count = len(pending_result.get("requests", [])) if pending_result and pending_result.get("success") else 0

    text = (
        "━━━━━━━━━━━━━━━━━━━━\n"
        "  👑 لوحة إدارة مزاجي\n"
        "━━━━━━━━━━━━━━━━━━━━\n"
        f"👥 المستخدمين: *{len(users)}*\n"
        f"🔔 طلبات معلقة: *{pending_count}*\n"
        "━━━━━━━━━━━━━━━━━━━━\n"
    )
    for u in users[:10]:
        text += f"• `{u['username']}` | {u.get('max_servers', 1)} سيرفر\n"
    if len(users) > 10:
        text += f"... و {len(users) - 10} آخرين\n"

    bell = f"🔔 طلبات ({pending_count})" if pending_count > 0 else "🔕 لا طلبات"
    keyboard = [
        [
            InlineKeyboardButton(bell, callback_data="admin_notifications"),
            InlineKeyboardButton("📊 إحصائيات", callback_data="admin_stats"),
        ],
        [InlineKeyboardButton("🗑 حذف مستخدم", callback_data="admin_delete_user")],
        [InlineKeyboardButton("🔙 رجوع", callback_data="main_menu")],
    ]
    await query.edit_message_text(text, parse_mode="Markdown", reply_markup=InlineKeyboardMarkup(keyboard))


# ─────────────────────────────────────────────────
#  إشعارات الطلبات المعلقة
# ─────────────────────────────────────────────────
async def show_admin_notifications(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    if not is_admin_tg(update):
        await query.edit_message_text("❌ غير مصرح.")
        return

    api_key = context.user_data.get("api_key")
    result = api_request("/api/admin/pending", api_key=api_key)

    if not result or not result.get("success"):
        await query.edit_message_text("❌ فشل جلب الإشعارات.")
        return

    requests_list = result.get("requests", [])

    if not requests_list:
        await query.edit_message_text(
            "━━━━━━━━━━━━━━━━━━━━\n"
            "🔕 لا توجد طلبات معلقة\n"
            "━━━━━━━━━━━━━━━━━━━━",
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔙 رجوع", callback_data="admin_panel")]]),
        )
        return

    await query.edit_message_text(
        f"━━━━━━━━━━━━━━━━━━━━\n"
        f"🔔 طلبات حسابات جديدة ({len(requests_list)})\n"
        f"━━━━━━━━━━━━━━━━━━━━"
    )
    for req in requests_list:
        text = (
            f"👤 المستخدم: `{req['username']}`\n"
            f"📅 التاريخ: {req.get('created_at', '')[:19]}"
        )
        keyboard = [[
            InlineKeyboardButton("✅ قبول", callback_data=f"approve|{req['username']}"),
            InlineKeyboardButton("❌ رفض", callback_data=f"reject|{req['username']}"),
        ]]
        await query.message.reply_text(text, parse_mode="Markdown", reply_markup=InlineKeyboardMarkup(keyboard))

    await query.message.reply_text(
        "━━━━━━━━━━━━━━━━━━━━",
        reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔙 رجوع", callback_data="admin_panel")]]),
    )


# ─────────────────────────────────────────────────
#  /start
# ─────────────────────────────────────────────────
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    api_key = context.user_data.get("api_key")
    if api_key:
        result = api_request("/api/bot/verify", method="POST", data={"api_key": api_key})
        if result and result.get("success"):
            context.user_data["username"] = result.get("username")
            await show_main_menu(update, context)
            return ConversationHandler.END
        context.user_data.clear()

    keyboard = [
        [InlineKeyboardButton("🔑 إدخال API Key", callback_data="enter_api")],
        [InlineKeyboardButton("💬 تواصل مع المطور @zzmmkj", url="https://t.me/zzmmkj")],
    ]
    await update.message.reply_text(
        "━━━━━━━━━━━━━━━━━━━━\n"
        "      مزاجي 🚀\n"
        "━━━━━━━━━━━━━━━━━━━━\n"
        "للاشتراك والحصول على حساب:\n"
        "📬 تواصل مع المطور: @zzmmkj\n\n"
        f"{DEVELOPER_INFO}",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(keyboard),
    )
    return WAITING_FOR_API_KEY


async def handle_api_key(update: Update, context: ContextTypes.DEFAULT_TYPE):
    api_key = update.message.text.strip()
    result = api_request("/api/bot/verify", method="POST", data={"api_key": api_key})
    if not result or not result.get("success"):
        keyboard = [[InlineKeyboardButton("💬 تواصل مع المطور", url="https://t.me/zzmmkj")]]
        await update.message.reply_text(
            "❌ *مفتاح API غير صالح!*\n\n"
            "تحقق من الكود وحاول مرة أخرى\n"
            "أو تواصل مع المطور: @zzmmkj",
            parse_mode="Markdown",
            reply_markup=InlineKeyboardMarkup(keyboard),
        )
        return WAITING_FOR_API_KEY

    context.user_data["api_key"] = api_key
    context.user_data["username"] = result.get("username")
    context.user_data["is_admin"] = result.get("is_admin", False)

    await update.message.reply_text(
        f"✅ *تم الربط بنجاح!*\n"
        f"👤 مرحباً *{result.get('username')}*!",
        parse_mode="Markdown",
    )
    await show_main_menu(update, context)
    return ConversationHandler.END


# ─────────────────────────────────────────────────
#  إنشاء سيرفر (Python / Node.js)
# ─────────────────────────────────────────────────
async def receive_server_name(update: Update, context: ContextTypes.DEFAULT_TYPE):
    name = update.message.text.strip()
    context.user_data["pending_server_name"] = name
    keyboard = [[
        InlineKeyboardButton("🐍 Python", callback_data="server_type_python"),
        InlineKeyboardButton("🟨 Node.js", callback_data="server_type_nodejs"),
        InlineKeyboardButton("🐘 PHP", callback_data="server_type_php"),
    ]]
    await update.message.reply_text(
        f"📦 *اختر نوع السيرفر:*\n\nالاسم: `{name}`",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(keyboard),
    )
    return WAITING_FOR_SERVER_TYPE


async def receive_server_type(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    if query.data == "server_type_python":
        srv_type = "Python"
        type_icon = "🐍"
    elif query.data == "server_type_php":
        srv_type = "PHP"
        type_icon = "🐘"
    else:
        srv_type = "Node.js"
        type_icon = "🟨"
    
    name = context.user_data.get("pending_server_name", "Server")

    result = api_request("/api/bot/create_server", method="POST", data={
        "api_key": context.user_data["api_key"],
        "name": name,
        "server_type": srv_type,
        "plan": "free",
        "storage": 100,
        "ram": 256,
        "cpu": 0.5,
    })

    if result and result.get("success"):
        await query.edit_message_text(
            f"✅ *تم إنشاء السيرفر بنجاح!*\n\n"
            f"📛 الاسم: `{name}`\n"
            f"{type_icon} النوع: `{srv_type}`\n\n"
            f"ارفع ملفاتك عبر الموقع الآن.",
            parse_mode="Markdown",
        )
    else:
        await query.edit_message_text(
            f"❌ *فشل الإنشاء!*\n{result.get('message', 'خطأ غير معروف')}",
            parse_mode="Markdown",
        )

    await show_main_menu(update, context)
    return ConversationHandler.END


# ─────────────────────────────────────────────────
#  كونسول وأخطاء
# ─────────────────────────────────────────────────
async def show_console(update: Update, context: ContextTypes.DEFAULT_TYPE, folder: str):
    query = update.callback_query
    result = api_request("/api/bot/console", params={"folder": folder}, api_key=context.user_data.get("api_key"))
    if result and result.get("success"):
        logs = result.get("logs", "لا توجد مخرجات")
        if len(logs) > 3500:
            logs = "...\n" + logs[-3500:]
        keyboard = [[
            InlineKeyboardButton("🔄 تحديث", callback_data=f"console|{folder}"),
            InlineKeyboardButton("🔙 رجوع", callback_data="my_servers"),
        ]]
        await query.edit_message_text(
            f"🖥 *كونسول السيرفر*\n```\n{logs}\n```",
            parse_mode="Markdown",
            reply_markup=InlineKeyboardMarkup(keyboard),
        )
    else:
        await query.edit_message_text("❌ فشل جلب الكونسول")


async def show_errors(update: Update, context: ContextTypes.DEFAULT_TYPE, folder: str):
    query = update.callback_query
    result = api_request("/api/bot/errors", params={"folder": folder}, api_key=context.user_data.get("api_key"))
    if result and result.get("success"):
        errors = result.get("errors", "✅ لا توجد أخطاء")
        if len(errors) > 3500:
            errors = "...\n" + errors[-3500:]
        keyboard = [[InlineKeyboardButton("🔙 رجوع", callback_data="my_servers")]]
        await query.edit_message_text(
            f"⚠️ *سجل الأخطاء*\n```\n{errors}\n```",
            parse_mode="Markdown",
            reply_markup=InlineKeyboardMarkup(keyboard),
        )
    else:
        await query.edit_message_text("❌ فشل جلب سجل الأخطاء")


# ─────────────────────────────────────────────────
#  إدارة المستخدمين (أدمن)
# ─────────────────────────────────────────────────
async def admin_delete_user_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    if not is_admin_tg(update):
        await query.edit_message_text("❌ غير مصرح.")
        return ConversationHandler.END
    await query.edit_message_text("📝 أرسل اسم المستخدم الذي تريد حذفه:")
    return WAITING_FOR_DELETE_USERNAME


async def admin_delete_user_confirm(update: Update, context: ContextTypes.DEFAULT_TYPE):
    username = update.message.text.strip()
    result = api_request("/api/admin/delete-user", method="POST", data={
        "api_key": context.user_data.get("api_key"),
        "username": username,
    })
    if result and result.get("success"):
        await update.message.reply_text(f"✅ تم حذف المستخدم `{username}`", parse_mode="Markdown")
    else:
        await update.message.reply_text(f"❌ فشل: {result.get('message', 'خطأ')}")
    await show_main_menu(update, context)
    return ConversationHandler.END


async def admin_stats(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    metrics = api_request("/api/system/metrics")
    cpu = metrics.get("cpu", "?") if metrics else "?"
    ram = metrics.get("memory", "?") if metrics else "?"
    disk = metrics.get("disk", "?") if metrics else "?"
    await query.edit_message_text(
        "━━━━━━━━━━━━━━━━━━━━\n"
        "  📊 إحصائيات النظام\n"
        "━━━━━━━━━━━━━━━━━━━━\n"
        f"🖥 CPU:  *{cpu}%*\n"
        f"💾 RAM:  *{ram}%*\n"
        f"💿 Disk: *{disk}%*",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔙 رجوع", callback_data="admin_panel")]]),
    )


# ─────────────────────────────────────────────────
#  ===== دوال PHP =====
# ─────────────────────────────────────────────────

async def run_php_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """بداية تشغيل كود PHP"""
    query = update.callback_query
    await query.answer()
    
    if not context.user_data.get("api_key"):
        await query.edit_message_text("❌ يجب ربط API Key أولاً.")
        return ConversationHandler.END
    
    await query.edit_message_text(
        "🐘 *تشغيل كود PHP*\n\n"
        "📝 أرسل كود PHP الذي تريد تشغيله:\n\n"
        "مثال:\n"
        "```php\n"
        "echo 'Hello World!';\n"
        "$name = 'MERO';\n"
        "echo 'مرحباً ' . $name;\n"
        "```\n\n"
        "🔄 أو استخدم /cancel للإلغاء",
        parse_mode="Markdown"
    )
    return WAITING_FOR_PHP_CODE


async def handle_php_code(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """استقبال كود PHP وتشغيله"""
    code = update.message.text.strip()
    
    if code.startswith('/cancel'):
        await update.message.reply_text("❌ تم الإلغاء.")
        await show_main_menu(update, context)
        return ConversationHandler.END
    
    if not code:
        await update.message.reply_text("⚠️ الرجاء إدخال كود PHP صحيح.")
        return WAITING_FOR_PHP_CODE
    
    await update.message.reply_text("⏳ جاري تشغيل الكود...")
    
    try:
        result = api_request("/api/php/run", method="POST", data={
            "code": code
        }, api_key=context.user_data.get("api_key"))
        
        if result and result.get("success"):
            output = result.get("output", "")
            error = result.get("error", "")
            
            response = "✅ *نتيجة تشغيل PHP:*\n\n"
            if output:
                response += f"📤 *المخرجات:*\n```\n{output[:3000]}\n```\n"
            if error:
                response += f"⚠️ *الأخطاء:*\n```\n{error[:3000]}\n```\n"
            if not output and not error:
                response += "✅ تم التشغيل بنجاح (لا يوجد مخرجات)"
            
            if len(response) > 4000:
                response = response[:3500] + "\n\n... (تم تقطيع النص للطول الكامل)"
            
            await update.message.reply_text(response, parse_mode="Markdown")
        else:
            await update.message.reply_text(
                f"❌ *فشل تشغيل الكود:*\n{result.get('message', 'خطأ غير معروف')}",
                parse_mode="Markdown"
            )
    except Exception as e:
        await update.message.reply_text(f"❌ خطأ: {str(e)}")
    
    await show_main_menu(update, context)
    return ConversationHandler.END


async def php_files_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """عرض ملفات PHP المحفوظة"""
    query = update.callback_query
    await query.answer()
    
    if not context.user_data.get("api_key"):
        await query.edit_message_text("❌ يجب ربط API Key أولاً.")
        return ConversationHandler.END
    
    result = api_request("/api/php/list", api_key=context.user_data.get("api_key"))
    
    if not result or not result.get("success"):
        await query.edit_message_text(
            f"❌ *فشل جلب ملفات PHP:*\n{result.get('message', 'خطأ غير معروف')}",
            parse_mode="Markdown"
        )
        return ConversationHandler.END
    
    files = result.get("files", [])
    
    if not files:
        await query.edit_message_text(
            "📭 *لا توجد ملفات PHP محفوظة*\n\n"
            "استخدم الزر '➕ ملف جديد' لإنشاء ملف جديد",
            parse_mode="Markdown",
            reply_markup=InlineKeyboardMarkup([
                [InlineKeyboardButton("➕ ملف جديد", callback_data="php_new_file")],
                [InlineKeyboardButton("🔙 رجوع", callback_data="main_menu")],
            ])
        )
        return ConversationHandler.END
    
    text = f"📂 *ملفات PHP المحفوظة ({len(files)})*\n\n"
    keyboard = []
    
    for f in files[:20]:
        size_kb = f.get("size", 0) / 1024
        text += f"📄 `{f['name']}` ({size_kb:.1f} KB)\n"
        keyboard.append([
            InlineKeyboardButton(f"▶️ {f['name']}", callback_data=f"php_run_file|{f['name']}"),
            InlineKeyboardButton("🗑", callback_data=f"php_delete_file|{f['name']}"),
        ])
    
    if len(files) > 20:
        text += f"\n... و {len(files) - 20} ملفات أخرى"
    
    keyboard.append([InlineKeyboardButton("➕ ملف جديد", callback_data="php_new_file")])
    keyboard.append([InlineKeyboardButton("🔙 رجوع", callback_data="main_menu")])
    
    await query.edit_message_text(
        text,
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(keyboard)
    )
    return ConversationHandler.END


async def php_run_file(update: Update, context: ContextTypes.DEFAULT_TYPE, filename: str):
    """تشغيل ملف PHP محفوظ"""
    query = update.callback_query
    await query.answer()
    
    await query.edit_message_text(f"⏳ جاري تشغيل ملف `{filename}`...", parse_mode="Markdown")
    
    result = api_request("/api/php/run-file", method="POST", data={
        "filename": filename
    }, api_key=context.user_data.get("api_key"))
    
    if result and result.get("success"):
        output = result.get("output", "")
        error = result.get("error", "")
        
        response = f"✅ *نتيجة تشغيل {filename}:*\n\n"
        if output:
            response += f"📤 *المخرجات:*\n```\n{output[:3000]}\n```\n"
        if error:
            response += f"⚠️ *الأخطاء:*\n```\n{error[:3000]}\n```\n"
        if not output and not error:
            response += "✅ تم التشغيل بنجاح (لا يوجد مخرجات)"
        
        if len(response) > 4000:
            response = response[:3500] + "\n\n... (تم تقطيع النص للطول الكامل)"
        
        await query.edit_message_text(response, parse_mode="Markdown")
    else:
        await query.edit_message_text(
            f"❌ *فشل تشغيل الملف:*\n{result.get('message', 'خطأ غير معروف')}",
            parse_mode="Markdown"
        )
    
    await php_files_start(update, context)


async def php_delete_file(update: Update, context: ContextTypes.DEFAULT_TYPE, filename: str):
    """حذف ملف PHP"""
    query = update.callback_query
    await query.answer()
    
    result = api_request("/api/php/delete", method="POST", data={
        "filename": filename
    }, api_key=context.user_data.get("api_key"))
    
    if result and result.get("success"):
        await query.answer(f"✅ تم حذف {filename}", show_alert=True)
    else:
        await query.answer(f"❌ فشل الحذف: {result.get('message', 'خطأ')}", show_alert=True)
    
    await php_files_start(update, context)


async def php_new_file_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """بداية إنشاء ملف PHP جديد"""
    query = update.callback_query
    await query.answer()
    
    await query.edit_message_text(
        "📝 *إنشاء ملف PHP جديد*\n\n"
        "📤 أرسل اسم الملف (يجب أن ينتهي بـ .php):\n\n"
        "مثال: `test.php`\n\n"
        "🔄 أو استخدم /cancel للإلغاء",
        parse_mode="Markdown"
    )
    return WAITING_FOR_PHP_FILENAME


async def handle_php_filename(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """استقبال اسم الملف"""
    filename = update.message.text.strip()
    
    if filename.startswith('/cancel'):
        await update.message.reply_text("❌ تم الإلغاء.")
        await show_main_menu(update, context)
        return ConversationHandler.END
    
    if not filename.endswith('.php'):
        await update.message.reply_text("⚠️ يجب أن ينتهي اسم الملف بـ .php\nأرسل اسم صحيح:")
        return WAITING_FOR_PHP_FILENAME
    
    if '/' in filename or '\\' in filename or '..' in filename:
        await update.message.reply_text("⚠️ اسم الملف غير صالح (لا يحتوي على / أو \\ أو ..)")
        return WAITING_FOR_PHP_FILENAME
    
    context.user_data["php_filename"] = filename
    
    await update.message.reply_text(
        f"📝 *أدخل محتوى الملف `{filename}`:*\n\n"
        "أرسل كود PHP كامل (بدون <?php و ?>):\n\n"
        "مثال:\n"
        "```php\n"
        "echo 'Hello from MERO!';\n"
        "```\n\n"
        "🔄 أو استخدم /cancel للإلغاء",
        parse_mode="Markdown"
    )
    return WAITING_FOR_PHP_CONTENT


async def handle_php_content(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """استقبال محتوى الملف وحفظه"""
    content = update.message.text.strip()
    
    if content.startswith('/cancel'):
        await update.message.reply_text("❌ تم الإلغاء.")
        await show_main_menu(update, context)
        return ConversationHandler.END
    
    filename = context.user_data.get("php_filename", "file.php")
    
    await update.message.reply_text(f"⏳ جاري حفظ ملف `{filename}`...", parse_mode="Markdown")
    
    result = api_request("/api/php/upload", method="POST", data={
        "filename": filename,
        "content": content
    }, api_key=context.user_data.get("api_key"))
    
    if result and result.get("success"):
        await update.message.reply_text(
            f"✅ *تم حفظ الملف بنجاح!*\n\n"
            f"📄 `{filename}`\n\n"
            f"استخدم /php_run {filename} لتشغيله.",
            parse_mode="Markdown"
        )
    else:
        await update.message.reply_text(
            f"❌ *فشل حفظ الملف:*\n{result.get('message', 'خطأ غير معروف')}",
            parse_mode="Markdown"
        )
    
    context.user_data.pop("php_filename", None)
    await show_main_menu(update, context)
    return ConversationHandler.END


async def php_run_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """الأمر /php_run <filename>"""
    if not context.user_data.get("api_key"):
        await update.message.reply_text("❌ يجب ربط API Key أولاً.")
        return
    
    args = context.args
    if not args:
        await update.message.reply_text(
            "⚠️ استخدم: `/php_run اسم_الملف.php`\n\n"
            "مثال: `/php_run test.php`",
            parse_mode="Markdown"
        )
        return
    
    filename = args[0]
    if not filename.endswith('.php'):
        filename += '.php'
    
    await update.message.reply_text(f"⏳ جاري تشغيل `{filename}`...", parse_mode="Markdown")
    
    result = api_request("/api/php/run-file", method="POST", data={
        "filename": filename
    }, api_key=context.user_data.get("api_key"))
    
    if result and result.get("success"):
        output = result.get("output", "")
        error = result.get("error", "")
        
        response = f"✅ *نتيجة تشغيل {filename}:*\n\n"
        if output:
            response += f"📤 *المخرجات:*\n```\n{output[:3000]}\n```\n"
        if error:
            response += f"⚠️ *الأخطاء:*\n```\n{error[:3000]}\n```\n"
        if not output and not error:
            response += "✅ تم التشغيل بنجاح (لا يوجد مخرجات)"
        
        if len(response) > 4000:
            response = response[:3500] + "\n\n... (تم تقطيع النص للطول الكامل)"
        
        await update.message.reply_text(response, parse_mode="Markdown")
    else:
        await update.message.reply_text(
            f"❌ *فشل تشغيل الملف:*\n{result.get('message', 'خطأ غير معروف')}",
            parse_mode="Markdown"
        )


# ─────────────────────────────────────────────────
#  معالج الأزرار الرئيسي
# ─────────────────────────────────────────────────
async def button_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    data = query.data

    # أزرار بدون "|"
    if data == "main_menu":
        await show_main_menu(update, context, edit=True)
    elif data == "my_servers":
        await show_servers_list(update, context)
    elif data in ("enter_api", "change_api"):
        context.user_data.pop("api_key", None)
        await query.edit_message_text(
            "🔑 *أدخل API Key الخاص بك:*\n\n"
            "يمكنك الحصول عليه من لوحة التحكم في الموقع.",
            parse_mode="Markdown",
        )
        return WAITING_FOR_API_KEY
    elif data == "logout":
        context.user_data.clear()
        await query.edit_message_text("🚪 تم تسجيل الخروج.\nاستخدم /start للدخول مجدداً.")
    elif data == "create_server":
        await query.edit_message_text(
            "➕ *إنشاء سيرفر جديد*\n\n📝 أرسل اسم السيرفر:",
            parse_mode="Markdown",
        )
        return WAITING_FOR_NEW_SERVER_NAME
    elif data == "admin_panel":
        await show_admin_panel(update, context)
    elif data == "admin_notifications":
        await show_admin_notifications(update, context)
    elif data == "admin_delete_user":
        return await admin_delete_user_start(update, context)
    elif data == "admin_stats":
        await admin_stats(update, context)
    
    # ===== أزرار PHP =====
    elif data == "run_php":
        return await run_php_start(update, context)
    elif data == "php_files":
        return await php_files_start(update, context)
    elif data == "php_new_file":
        return await php_new_file_start(update, context)

    # أزرار مع "|" → cmd|value
    elif "|" in data:
        cmd, value = data.split("|", 1)
        api_key = context.user_data.get("api_key")

        # أزرار السيرفرات
        if cmd in ("srv_start", "srv_stop", "srv_restart", "srv_delete"):
            action = cmd.replace("srv_", "")
            result = api_request("/api/bot/server/action", method="POST", data={
                "api_key": api_key, "folder": value, "action": action,
            })
            if result and result.get("success"):
                await query.answer(result.get("message", "✅ تم")[:200], show_alert=True)
            else:
                await query.answer(f"❌ {result.get('message', 'فشل') if result else 'خطأ'}"[:200], show_alert=True)
            await show_servers_list(update, context)

        elif cmd == "console":
            await show_console(update, context, value)

        elif cmd == "errors":
            await show_errors(update, context, value)

        elif cmd == "install":
            result = api_request("/api/bot/install", method="POST", data={
                "api_key": api_key, "folder": value,
            })
            msg = result.get("message", "✅ جاري التثبيت") if result and result.get("success") else f"❌ {result.get('message','فشل') if result else 'خطأ'}"
            await query.edit_message_text(
                f"📦 *تثبيت المكتبات*\n\n{msg}\n\nتابع الكونسول للتفاصيل.",
                parse_mode="Markdown",
                reply_markup=InlineKeyboardMarkup([[
                    InlineKeyboardButton("🖥 كونسول", callback_data=f"console|{value}"),
                    InlineKeyboardButton("🔙 رجوع", callback_data="my_servers"),
                ]]),
            )

        elif cmd == "approve":
            result = api_request("/api/admin/approve", method="POST", data={
                "api_key": api_key, "username": value,
            })
            msg = f"✅ تم قبول حساب {value}" if result and result.get("success") else "❌ فشل القبول"
            await query.answer(msg, show_alert=True)
            await show_admin_notifications(update, context)

        elif cmd == "reject":
            result = api_request("/api/admin/reject", method="POST", data={
                "api_key": api_key, "username": value,
            })
            msg = f"🚫 تم رفض طلب {value}" if result and result.get("success") else "❌ فشل الرفض"
            await query.answer(msg, show_alert=True)
            await show_admin_notifications(update, context)

        # ===== أزرار PHP =====
        elif cmd == "php_run_file":
            return await php_run_file(update, context, value)
        
        elif cmd == "php_delete_file":
            return await php_delete_file(update, context, value)

    return ConversationHandler.END


# ─────────────────────────────────────────────────
#  تشغيل البوت
# ─────────────────────────────────────────────────
def main():
    application = Application.builder().token(BOT_TOKEN).build()

    conv = ConversationHandler(
        entry_points=[
            CommandHandler("start", start),
            CallbackQueryHandler(button_callback),
        ],
        states={
            WAITING_FOR_API_KEY: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, handle_api_key)
            ],
            WAITING_FOR_NEW_SERVER_NAME: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, receive_server_name)
            ],
            WAITING_FOR_SERVER_TYPE: [
                CallbackQueryHandler(receive_server_type, pattern="^server_type_")
            ],
            WAITING_FOR_DELETE_USERNAME: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, admin_delete_user_confirm)
            ],
            WAITING_FOR_PHP_CODE: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, handle_php_code)
            ],
            WAITING_FOR_PHP_FILENAME: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, handle_php_filename)
            ],
            WAITING_FOR_PHP_CONTENT: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, handle_php_content)
            ],
        },
        fallbacks=[CommandHandler("start", start)],
        per_user=True,
        per_chat=True,
    )

    application.add_handler(conv)
    
    # أضف أوامر PHP
    application.add_handler(CommandHandler("php_run", php_run_command))
    
    print("🚀 مزاجي Bot يعمل مع دعم PHP و Python و Node.js...")
    application.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()