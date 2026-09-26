# مزاجي
**طُوِّر بواسطة: @zzmmkj**

## 🚀 منصة استضافة بوتات تيليجرام + Node.js

---

## 📋 معلومات الأدمن
- **اسم المستخدم:** elmodmen
- **كلمة المرور:** AASS1122@@
- **تيليجرام:** @zzmmkj
- **توكن البوت:** 8107118673:AAG6xUifqFD5qtCWZMy_D9qEmC8HOCx4DBo

---

## 🛠 طريقة النشر (Render)

1. ارفع المجلد على GitHub
2. أنشئ Web Service جديد على render.com
3. اربط الـ repo
4. البناء: `pip install -r requirements.txt`
5. التشغيل: `gunicorn app:app --timeout 120`

---

## 📁 هيكل الملفات
```
MY_MOOD/
├── app.py              ← السيرفر الرئيسي (Flask)
├── telegram_bot.py     ← بوت التحكم (python-telegram-bot)
├── telegram_bot_runner.py ← مشغّل بوتات المستخدمين
├── index.html          ← لوحة المستخدم
├── admin_panel.html    ← لوحة الأدمن
├── login.html          ← صفحة الدخول والاشتراك
├── requirements.txt    ← المتطلبات
├── Procfile            ← للنشر على Heroku/Railway
└── render.yaml         ← للنشر على Render
```

---

## ✨ المميزات الرئيسية
- ✅ دعم Python + Node.js
- ✅ نظام طلبات اشتراك مع إشعار تيليجرام فوري
- ✅ لوحة أدمن متكاملة (قبول/رفض طلبات)
- ✅ رفع ملفات ZIP مع زر فك الضغط
- ✅ تغيير أسماء الملفات من الواجهة
- ✅ تنبيه الملف الرئيسي: main.py + requirements.txt
- ✅ بوت تيليجرام للتحكم الكامل
- ✅ مراقبة تلقائية وإعادة تشغيل السيرفرات
- ✅ تثبيت المكتبات تلقائياً عند الرفع
- ✅ سجل أخطاء منفصل (errors.log)

---

## 🤖 تشغيل بوت التحكم
```bash
python telegram_bot.py
```

ملاحظة: البوت يستخدم API Key من الموقع للتحقق من الهوية.