#!/usr/bin/env python3
"""
𝙺𝙸𝙽𝙶 𝙼𝙾𝙳 - مشغّل بوت تليجرام
طُوِّر بواسطة: @K_I_G_M
"""

import sys
import logging
from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes

logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "👋 مرحباً! أنا بوت يعمل على 𝙺𝙸𝙽𝙶 𝙼𝙾𝙳𝚃\n\n"
        "الأوامر المتاحة:\n"
        "/start - عرض هذه الرسالة\n"
        "/help - الحصول على المساعدة\n"
        "/info - معلومات البوت\n\n"
        "🛠 طُوِّر بواسطة: @K_I_G_M"
    )

async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "📚 المساعدة:\n\n"
        "هذا البوت يعمل بشكل مستمر على خادم 𝙼𝙴𝚁𝙾 𝙷𝙾𝚂𝚃\n"
        "للاشتراك أو الاستفسار: @K_I_G_M"
    )

async def info_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "ℹ️ معلومات البوت:\n\n"
        "🤖 الخدمة: 𝙺𝙸𝙽𝙶 𝙼𝙾𝙳\n"
        "✅ الحالة: نشط ومستمر\n"
        "🛠 المطور: @K_I_G_M"
    )

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user_message = update.message.text
    await update.message.reply_text(
        f"📨 تم استقبال رسالتك:\n\n{user_message}\n\n"
        "شكراً لاستخدامك 𝙼𝙴𝚁𝙾 𝙷𝙾𝚂𝚃!\n"
        "🛠 @I_tt_6"
    )

async def error_handler(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
    logger.error(msg="Exception while handling an update:", exc_info=context.error)

def run_bot(token: str, bot_name: str) -> None:
    try:
        print("\n" + "═"*60)
        print(f" 🤖 𝙺𝙸𝙽𝙶 𝙼𝙾𝙳 - جاري تشغيل البوت: {bot_name}")
        print(" 🚀 يتم الآن الاتصال بخوادم تليجرام...")
        print("═"*60 + "\n")
        application = Application.builder().token(token).build()
        application.add_handler(CommandHandler("start", start))
        application.add_handler(CommandHandler("help", help_command))
        application.add_handler(CommandHandler("info", info_command))
        application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
        application.add_error_handler(error_handler)
        print(f" ✅ البوت {bot_name} جاهز الآن على 𝙼𝙴𝚁𝙾 𝙷𝙾𝚂𝚃!")
        print(" 📡 الحالة: نشط وينتظر الرسائل...\n")
        application.run_polling()
    except Exception as e:
        logger.error(f"❌ خطأ في تشغيل البوت {bot_name}: {str(e)}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("استخدام: python telegram_bot_runner.py <TOKEN> [BOT_NAME]")
        sys.exit(1)
    token = sys.argv[1]
    bot_name = sys.argv[2] if len(sys.argv) > 2 else "mero_host_bot"
    run_bot(token, bot_name)