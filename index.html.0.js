
    let currentServer = null, polling = null, currentFile = null, editorOriginalContent = '', confirmAction = null, selectedPlan = null;
    let descriptionTargetFile = null, descriptionTargetDefaults = {display_name:'', description:''};

    const showToast = (msg, type='info') => { const t = document.getElementById('toast'); t.innerHTML = `<i class="fas ${type==='success'?'fa-check-circle':type==='error'?'fa-exclamation-circle':'fa-info-circle'}"></i> ${msg}`; t.style.display='block'; setTimeout(()=>t.style.display='none',3000); };
    const showConfirm = (msg, cb) => { document.getElementById('confirmMsg').innerText = msg; confirmAction = cb; document.getElementById('confirmModal').classList.add('active'); };
    const closeConfirm = () => { document.getElementById('confirmModal').classList.remove('active'); confirmAction = null; };
    document.getElementById('confirmYesBtn').onclick = () => { if(confirmAction) { confirmAction(); } closeConfirm(); };

    // القائمة الجانبية (هامبرغر)
    const sidebar = document.getElementById('sidebar'), overlay = document.getElementById('sidebarOverlay');
    document.getElementById('hamburgerBtn').onclick = () => { sidebar.classList.add('open'); overlay.classList.add('active'); };
    const closeSidebar = () => { sidebar.classList.remove('open'); overlay.classList.remove('active'); };
    overlay.onclick = closeSidebar;

    // تبديل التبويبات من القائمة الجانبية
    document.querySelectorAll('.sidebar-nav-item').forEach(btn => {
        btn.onclick = () => {
            if(!currentServer) return;
            const nav = btn.dataset.nav;
            document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
            document.getElementById(`${nav}Pane`).classList.add('active');
            document.querySelectorAll('.sidebar-nav-item').forEach(i => i.classList.remove('active'));
            btn.classList.add('active');
            closeSidebar();
            if(nav === 'files') loadFiles();
            if(nav === 'settings') loadStartupFiles();
            if(nav === 'api') loadApiKey();
        };
    });

    // الخطط
    const plans = {
        free: { name:'🎁 مجاني', storage:512000, ram:256, price:0, max_servers:2, cpu:0.5 },
        '4gb': { name:'💎 4 جيجا', storage:4096000, ram:1024, price:5, max_servers:5, cpu:1 },
        '10gb': { name:'💎 10 جيجا', storage:10240000, ram:2048, price:10, max_servers:10, cpu:2 },
        '40gb': { name:'💎 40 جيجا', storage:40960000, ram:4096, price:25, max_servers:20, cpu:4 }
    };
    
    function showPlansModal() {
        const container = document.getElementById('plansList');
        container.innerHTML = '';
        for (const [id, p] of Object.entries(plans)) {
            const card = document.createElement('div');
            card.className = 'plan-card';
            card.dataset.planId = id;
            card.innerHTML = `<div style="font-weight:700;">${p.name}</div><div>💾 ${(p.storage/1024).toFixed(0)} GB</div><div>🧠 ${p.ram} MB</div><div>🖥 ${p.cpu} نواة</div><div>📦 ${p.max_servers} سيرفر</div><div style="color:#2d7aff;">${p.price===0?'مجاني':p.price+'$'}</div>`;
            card.onclick = () => {
                document.querySelectorAll('.plan-card').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                selectedPlan = { id, ...p };
                if(selectedPlan.price === 0) upgradeToPlan(selectedPlan.id);
                else document.getElementById('paymentMethods').style.display = 'block';
            };
            container.appendChild(card);
        }
        document.getElementById('paymentMethods').style.display = 'none';
        document.getElementById('plansModal').classList.add('active');
    }
    
    function closePlansModal() { document.getElementById('plansModal').classList.remove('active'); selectedPlan=null; }
    
    async function upgradeToPlan(planId) {
        closePlansModal();
        showToast('جاري ترقية الخطة...');
        try {
            const res = await fetch('/api/user/upgrade', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ plan_id: planId })
            });
            const data = await res.json();
            if(data.success) {
                showToast(data.message, 'success');
                loadServers();
                setTimeout(() => location.reload(), 1500);
            } else {
                showToast(data.message || 'فشل الترقية', 'error');
            }
        } catch(e) { showToast('خطأ في الاتصال', 'error'); }
    }
    
    function contactSupport(method) { window.open(`https://t.me/zzmmkj?text=شراء خطة ${selectedPlan.name} بـ ${selectedPlan.price}$ عبر ${method}`, '_blank'); closePlansModal(); }

    // ===== دوال إنشاء السيرفر (Python / PHP) =====
    function showCreateServerModal(type) {
        document.getElementById('createServerName').value = '';
        document.getElementById('createServerType').value = type;
        
        const label = document.getElementById('selectedServerTypeLabel');
        const title = document.getElementById('createServerModalTitle');
        
        if (type === 'Python') {
            label.innerHTML = '🐍 Python';
            title.innerHTML = '<i class="fab fa-python"></i> إنشاء خادم Python';
        } else if (type === 'PHP') {
            label.innerHTML = '🐘 PHP';
            title.innerHTML = '<i class="fab fa-php"></i> إنشاء خادم PHP';
        } else {
            label.innerHTML = '🌐 HTML / CSS / JavaScript';
            title.innerHTML = '<i class="fas fa-code"></i> إنشاء موقع HTML ثابت';
        }
        
        document.getElementById('createServerModal').classList.add('active');
    }

    function closeCreateServerModal() {
        document.getElementById('createServerModal').classList.remove('active');
    }

    function closeCreateProgressModal() {
        document.getElementById('createProgressModal').classList.remove('active');
        document.getElementById('createLoading').style.display = 'block';
        document.getElementById('createSuccess').style.display = 'none';
    }

    async function createServerWithName() {
        const name = document.getElementById('createServerName').value.trim();
        if(!name) {
            showToast('⚠️ الرجاء إدخال اسم للسيرفر', 'error');
            return;
        }
        
        const serverType = document.getElementById('createServerType').value;
        closeCreateServerModal();
        
        const modal = document.getElementById('createProgressModal');
        document.getElementById('createLoading').style.display = 'block';
        document.getElementById('createSuccess').style.display = 'none';
        modal.classList.add('active');
        
        try {
            const res = await fetch('/api/server/add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name, server_type: serverType })
            });
            const data = await res.json();
            
            if(data.success) {
                document.getElementById('createLoading').style.display = 'none';
                document.getElementById('createSuccess').style.display = 'block';
                showToast(`✅ تم إنشاء خادم ${serverType}`, 'success');
                loadServers();
            } else {
                modal.classList.remove('active');
                showToast(data.message || 'فشل الإنشاء', 'error');
            }
        } catch(e) {
            modal.classList.remove('active');
            showToast('خطأ في الاتصال', 'error');
        }
    }

    // ===== رفع ملف وإنشاء سيرفر باسم يختاره المستخدم =====
    let pendingAutoUploadFile = null;
    function autoCreateServer(file) {
        if (!file) return;
        pendingAutoUploadFile = file;
        const baseName = file.name.replace(/\.[^.]+$/, '').slice(0, 60);
        document.getElementById('autoServerName').value = baseName || 'سيرفري الجديد';
        document.getElementById('autoUploadNameModal').classList.add('active');
        setTimeout(() => document.getElementById('autoServerName').focus(), 50);
    }

    function cancelAutoUploadName() {
        document.getElementById('autoUploadNameModal').classList.remove('active');
        pendingAutoUploadFile = null;
        document.getElementById('autoServerUpload').value = '';
    }

    async function confirmAutoCreateServer() {
        if (!pendingAutoUploadFile) return;
        const serverName = document.getElementById('autoServerName').value.trim();
        if (!serverName) {
            showToast('اكتب اسمًا للسيرفر أولًا', 'error');
            document.getElementById('autoServerName').focus();
            return;
        }
        if (serverName.length > 60) {
            showToast('اسم السيرفر يجب ألا يتجاوز 60 حرفًا', 'error');
            return;
        }
        const file = pendingAutoUploadFile;
        const fd = new FormData();
        fd.append('file', file);
        fd.append('server_name', serverName);
        document.getElementById('autoUploadNameModal').classList.remove('active');
        showToast('⏳ جاري رفع الملف وتجهيز المكتبات وتشغيل السيرفر...', 'info');
        try {
            const r = await fetch('/api/server/auto-upload', { method:'POST', body:fd });
            const d = await r.json();
            if (d.success) {
                showToast(d.message || '✅ تم إنشاء السيرفر تلقائيًا', 'success');
                await loadServers();
            } else {
                showToast(d.message || 'فشل إنشاء السيرفر', 'error');
            }
        } catch (e) {
            showToast('تعذر الاتصال بالخادم؛ تحقق من سجل التشغيل', 'error');
        } finally {
            pendingAutoUploadFile = null;
            document.getElementById('autoServerUpload').value = '';
        }
    }

    // ===== التوثيق والتحميل =====
    async function checkAuth() {
        try { 
            const r = await fetch('/api/current_user'); 
            const d = await r.json(); 
            if(!d.success) window.location.href='/login'; 
            else { 
                document.getElementById('username').innerText = d.username;
                if (d.is_admin) document.getElementById('adminPanelBtn').style.display = 'inline-flex'; 
                loadServers(); 
                fetchMetrics(); 
                setInterval(fetchMetrics, 8000); 
            } 
        } catch(e) { 
            console.error('Init error:', e); 
            document.getElementById('serversGrid').innerHTML = '<div style="text-align:center; padding:60px; color:#ff5e7c;"><i class="fas fa-exclamation-triangle"></i> خطأ في الاتصال بالسيرفر</div>'; 
        }
    }

    async function fetchMetrics() {
        try { 
            const r = await fetch('/api/system/metrics'); 
            const d = await r.json(); 
            document.getElementById('ramUsage').innerText = d.memory+'%'; 
            document.getElementById('ramProgress').style.width = d.memory+'%'; 
            document.getElementById('cpuStat').innerText = d.cpu+'%'; 
            document.getElementById('cpuProgress').style.width = d.cpu+'%'; 
        } catch(e) {}
    }

    async function loadServers() {
        try {
            const r = await fetch('/api/servers'); 
            const d = await r.json();
            document.getElementById('usedServers').innerText = `${d.stats.used}/${d.stats.total||2}`;
            document.getElementById('expiryDays').innerText = d.stats.expiry ?? '--';
            const diskTotal = d.stats.disk_total || 512000;
            const diskUsed = d.stats.disk_used || 0;
            document.getElementById('diskUsed').innerText = `${Math.round(diskUsed)}/${Math.round(diskTotal/1024)} GB`;
            document.getElementById('diskProgress').style.width = Math.min((diskUsed/diskTotal)*100, 100)+'%';
            document.getElementById('storageStat').innerText = `${Math.round(diskUsed)}/${Math.round(diskTotal/1024)} GB`;
            document.getElementById('storageProgress').style.width = Math.min((diskUsed/diskTotal)*100, 100)+'%';
            if(document.getElementById('storageLimit')) document.getElementById('storageLimit').innerText = Math.round(diskTotal/1024) + ' GB';
            
            const grid = document.getElementById('serversGrid');
            if(!d.servers || d.servers.length === 0) { 
                grid.innerHTML = '<div style="text-align:center; padding:60px; color:#9ca3cf;">لا توجد خوادم، أنشئ واحداً</div>'; 
                return; 
            }
            
            grid.innerHTML = '';
            
            // تعريف أيقونات وأنواع السيرفرات بشكل صحيح
            const typeIcons = { 'Python': '🐍', 'PHP': '🐘', 'Node.js': '🟨', 'Static': '🌐' };
            const typeNames = { 'Python': 'Python', 'PHP': 'PHP', 'Node.js': 'Node.js', 'Static': 'HTML/CSS/JS' };
            const typeClasses = { 'Python': 'badge-python', 'PHP': 'badge-php', 'Node.js': 'badge-node', 'Static': 'badge-static' };
            
            d.servers.forEach(s => {
                // استخدم s.type مباشرة من الـ API
                const type = s.type || 'Python';
                const icon = typeIcons[type] || '📦';
                const typeClass = typeClasses[type] || 'badge-python';
                
                const card = document.createElement('div');
                card.className = 'server-card';
                card.dataset.serverType = type;
                card.innerHTML = `
                    <div class="server-card-header">
                        <div class="server-icon"><i class="fas fa-cube"></i></div>
                        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                            <span class="badge ${typeClass}">${icon} ${typeNames[type] || type}</span>
                            <div class="server-status-badge ${s.status==='Running'?'status-online':'status-offline'}">
                                <span class="status-dot ${s.status==='Running'?'dot-online':'dot-offline'}"></span>
                                ${s.status==='Running'?'يعمل':'متوقف'}
                            </div>
                        </div>
                    </div>
                    <div class="server-name">${escapeHtml(s.title)}</div>
                    <div class="server-meta">
                        <span class="server-port"><i class="fas fa-plug"></i> المنفذ: ${s.port||'N/A'}</span>
                        <span class="server-plan-badge"><i class="fas fa-tag"></i> ${s.plan==='free'?'مجاني':s.plan}</span>
                    </div>
                    <div class="server-stats">
                        <span><i class="fas fa-hdd"></i> ${Math.round((s.storage_limit||512000)/1024)}GB</span>
                        <span><i class="fas fa-microchip"></i> ${s.cpu_limit||0.5} نواة</span>
                        <span><i class="fas fa-clock"></i> ${s.uptime || '0'}</span>
                    </div>
                    <div class="server-actions">
                        <div class="action-group">
                            <button class="action-btn start" data-action="start" data-folder="${s.folder}"><i class="fas fa-play"></i> تشغيل</button>
                            <button class="action-btn restart" data-action="restart" data-folder="${s.folder}"><i class="fas fa-sync-alt"></i> إعادة</button>
                            <button class="action-btn stop" data-action="stop" data-folder="${s.folder}"><i class="fas fa-stop"></i> إيقاف</button>
                        </div>
                        <div class="action-group">
                            <button class="action-btn open" data-action="open" data-folder="${s.folder}"><i class="fas fa-external-link-alt"></i> فتح</button>
                            <button class="action-btn delete" data-action="delete" data-folder="${s.folder}"><i class="fas fa-trash"></i> حذف</button>
                            <button class="action-btn detail" data-action="detail" data-folder="${s.folder}"><i class="fas fa-chevron-left"></i> تفاصيل</button>
                        </div>
                    </div>
                `;
                
                card.addEventListener('click', (e) => { 
                    if(e.target.closest('.action-btn')) return; 
                    openServer({ folder: s.folder, title: s.title, port: s.port, status: s.status, storage_limit: s.storage_limit, ram_limit: s.ram_limit, plan: s.plan, startup_file: s.startup_file, type: s.type }); 
                });
                
                card.querySelectorAll('.action-btn').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const action = btn.dataset.action;
                        const folder = btn.dataset.folder;
                        if(action === 'detail') {
                            openServer({ folder: s.folder, title: s.title, port: s.port, status: s.status, storage_limit: s.storage_limit, ram_limit: s.ram_limit, plan: s.plan, startup_file: s.startup_file, type: s.type });
                        } else if(action === 'open') {
                            openServerLink(folder);
                        } else {
                            performAction(folder, action);
                        }
                    });
                });
                grid.appendChild(card);
            });
        } catch(e) { 
            console.error('loadServers error:', e);
            const grid = document.getElementById('serversGrid');
            if(grid) grid.innerHTML = '<div style="text-align:center; padding:60px; color:#ff5e7c;"><i class="fas fa-exclamation-triangle"></i> فشل تحميل الخوادم، حاول تحديث الصفحة</div>';
        }
    }

    async function openServerLink(folder) {
        try {
            showToast('جاري تجهيز رابط الفتح...');
            const r = await fetch(`/api/server/open/${encodeURIComponent(folder)}`);
            const d = await r.json();
            if (!r.ok || !d.success || !d.url) {
                throw new Error(d.message || 'تعذر إنشاء رابط الفتح');
            }
            window.open(d.url, '_blank', 'noopener,noreferrer');
            showToast(d.kind === 'telegram' ? 'تم فتح البوت على تيليجرام' : 'تم فتح الموقع', 'success');
        } catch (e) {
            showToast(e.message || 'تعذر فتح السيرفر', 'error');
        }
    }

    async function performAction(folder, action) {
        if(action === 'delete') { if(!confirm('حذف الخادم نهائياً؟')) return; }
        showToast(`جاري ${action}...`);
        try {
            const r = await fetch(`/api/server/action/${folder}/${action}`, { method:'POST' });
            const d = await r.json();
            if(d.success) { 
                showToast(d.message, 'success'); 
                if(action !== 'delete') loadServers(); 
                else { 
                    showToast('🗑️ تم حذف السيرفر', 'success');
                    loadServers(); 
                }
            } else {
                showToast(d.message || 'فشل', 'error');
            }
        } catch(e) { showToast('خطأ', 'error'); }
    }

    function openServer(s) {
        currentServer = s;
        document.getElementById('homeView').style.display = 'none';
        document.getElementById('detailView').classList.add('active');
        document.getElementById('ramLimit').innerText = (s.ram_limit || 256) + ' MB';
        document.getElementById('storageLimit').innerText = Math.round((s.storage_limit || 512000)/1024) + ' GB';
        document.getElementById('planDetails').innerText = s.plan === 'free' ? 'مجاني' : s.plan;
        
        // عرض نوع السيرفر في التفاصيل
        const typeIcons = { 'Python': '🐍', 'PHP': '🐘', 'Node.js': '🟨', 'Static': '🌐' };
        const typeNames = { 'Python': 'Python', 'PHP': 'PHP', 'Node.js': 'Node.js', 'Static': 'HTML/CSS/JS' };
        const typeIcon = typeIcons[s.type] || '📦';
        const typeName = typeNames[s.type] || s.type || 'Python';
        document.getElementById('serverTypeBadge').innerHTML = `${typeIcon} ${typeName} | ${escapeHtml(s.title)}`;
        
        if(polling) clearInterval(polling);
        fetchStats();
        polling = setInterval(fetchStats, 4000);
        loadFiles();
        loadStartupFiles();
        loadApiKey();
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        document.getElementById('consolePane').classList.add('active');
        document.querySelectorAll('.sidebar-nav-item').forEach(i => i.classList.remove('active'));
        document.querySelector('.sidebar-nav-item[data-nav="console"]').classList.add('active');
    }

    async function fetchStats() {
        if(!currentServer) return;
        try {
            const r = await fetch(`/api/server/stats/${currentServer.folder}`);
            const d = await r.json();
            if(!d.success) return;
            const combinedLogs = (d.logs || 'لا توجد مخرجات') + (d.errors ? '\n\n========== أخطاء التشغيل (stderr) ==========\n' + d.errors : '');
            document.getElementById('consoleOut').innerHTML = combinedLogs.split('\n').map(l => `<div>${escapeHtml(l)}</div>`).join('');
            document.getElementById('consoleOut').scrollTop = document.getElementById('consoleOut').scrollHeight;
            const ramLimit = currentServer.ram_limit || 256;
            document.getElementById('ramStat').innerText = `${d.mem || 0} MB / ${ramLimit} MB`;
            const ramPercent = (parseFloat(d.mem||0)/ramLimit)*100;
            document.getElementById('ramDetailProgress').style.width = Math.min(ramPercent,100)+'%';
            document.getElementById('uptimeStat').innerText = d.uptime || '0';
        } catch(e) {}
    }

    async function serverAction(act) {
        if(act === 'delete') { confirmDelete(); return; }
        showToast(`جاري ${act}...`);
        try {
            const r = await fetch(`/api/server/action/${currentServer.folder}/${act}`, { method:'POST' });
            const d = await r.json();
            if(d.success) { 
                showToast(d.message, 'success'); 
                if(act !== 'stop') setTimeout(fetchStats,1000); 
                loadServers(); 
            } else {
                showToast(d.message || 'فشل', 'error');
            }
        } catch(e) { showToast('خطأ', 'error'); }
    }

    function confirmDelete() {
        showConfirm('⚠️ حذف الخادم نهائياً؟ لا يمكن التراجع', async () => {
            const r = await fetch(`/api/server/action/${currentServer.folder}/delete`, { method:'POST' });
            const d = await r.json();
            if(d.success) { 
                showToast('🗑️ تم الحذف', 'success'); 
                if(polling) clearInterval(polling); 
                goHome(); 
            } else {
                showToast(d.message || 'فشل', 'error');
            }
        });
    }

    function goHome() {
        document.getElementById('homeView').style.display = 'block';
        document.getElementById('detailView').classList.remove('active');
        if(polling) clearInterval(polling);
        currentServer = null;
        loadServers();
    }

    // ===== دوال الملفات والإعدادات =====
    async function updateFilesQuotaInfo() {
        if (!currentServer) return;
        const info = document.getElementById('filesQuotaInfo');
        if (!info) return;
        try {
            const r = await fetch(`/api/files/quota/${encodeURIComponent(currentServer.folder)}`);
            const d = await r.json();
            if (!r.ok || !d.success) throw new Error(d.message || 'تعذر قراءة الحد');
            info.innerHTML = `<strong>حد الملفات الفعلي:</strong> ${Number(d.used)} / ${Number(d.limit)} ملفًا · <strong>المتبقي:</strong> ${Number(d.remaining)}. <div style="font-size:.76rem;color:#9ca3cf;margin-top:3px;">هذا حد الملفات داخل المشاريع. حد عدد المشاريع المستقلة يظهر في بطاقة «السيرفرات المستخدمة» ويضبطه المسؤول بشكل منفصل.</div>`;
        } catch (_) {
            info.textContent = 'تعذر قراءة حد الملفات حاليًا.';
        }
    }

    async function loadFiles() {
        if(!currentServer) return;
        const list = document.getElementById('filesList');
        list.innerHTML = '<div style="padding:30px;text-align:center;color:#9ca3cf;">جاري تحميل الملفات...</div>';
        updateFilesQuotaInfo();
        try {
            const r = await fetch(`/api/files/list/${encodeURIComponent(currentServer.folder)}`);
            if(!r.ok) throw new Error('files');
            const files = await r.json();
            if(!files.length) {
                list.innerHTML = '<div style="padding:36px;text-align:center;color:#9ca3cf;border:1px dashed rgba(75,126,255,.2);border-radius:18px;">📁 لا توجد ملفات داخل هذا السيرفر</div>';
                return;
            }
            list.innerHTML = files.map(f => {
                const icon = f.is_dir ? 'fa-folder' : (f.name.toLowerCase().endsWith('.zip') ? 'fa-file-zipper' : 'fa-file-code');
                const safe = escapeHtml(f.name);
                const displayTitle = escapeHtml(f.display_name || f.name.split('/').pop());
                const description = escapeHtml(f.description || 'أضف وصفًا عربيًا لتوضيح وظيفة هذا الملف.');
                return `<div class="file-card" data-file-name="${safe}" data-is-dir="${f.is_dir ? '1' : '0'}" data-display-name="${displayTitle}" data-description="${description}">
                    <div class="file-main">
                        <input type="checkbox" class="file-checkbox file-check" value="${safe}" aria-label="تحديد ${safe}">
                        <div class="file-icon"><i class="fas ${icon}"></i></div>
                        <div class="file-info">
                            <div class="file-name">${displayTitle}</div>
                            <div style="font-size:.8rem;color:#a9b7d9;line-height:1.6;margin-top:4px;overflow-wrap:anywhere;">${description}</div>
                            <div class="file-meta">${f.is_dir ? 'مجلد' : f.size} · الاسم الأصلي: <span dir="ltr" style="overflow-wrap:anywhere;">${safe}</span></div>
                        </div>
                    </div>
                    <div class="file-actions">
                        <button type="button" class="file-btn" style="background:rgba(15,118,110,.24);border-color:rgba(20,184,166,.35);color:#7de8df;" data-file-action="describe"><i class="fas fa-language"></i><span>تعديل الاسم والوصف</span></button>
                        ${!f.is_dir ? `<button type="button" class="file-btn edit" data-file-action="edit"><i class="fas fa-folder-open"></i><span>فتح الملف</span></button>
                        <button type="button" class="file-btn replace" data-file-action="replace"><i class="fas fa-repeat"></i><span>تبديل الملف</span></button>
                        <button type="button" class="file-btn download" data-file-action="download"><i class="fas fa-download"></i><span>تنزيل</span></button>` : ''}
                        <button type="button" class="file-btn rename" data-file-action="rename"><i class="fas fa-i-cursor"></i><span>تغيير الاسم الحقيقي</span></button>
                        ${f.name.toLowerCase().endsWith('.zip') ? `<button type="button" class="file-btn unzip" data-file-action="unzip"><i class="fas fa-file-archive"></i><span>فك الضغط</span></button>` : ''}
                        <button type="button" class="file-btn delete" data-file-action="delete"><i class="fas fa-trash"></i><span>حذف الملف</span></button>
                    </div>
                </div>`;
            }).join('');
        } catch(e) {
            list.innerHTML = '<div style="padding:30px;text-align:center;color:#ff8799;">تعذر تحميل الملفات. أعد فتح قسم الملفات.</div>';
        }
    }

    // ===== إدارة أزرار الملفات: event delegation حتى تعمل الأزرار حتى بعد إعادة رسم القائمة =====
    const filesListElement = document.getElementById('filesList');
    if (filesListElement) {
        filesListElement.addEventListener('click', async (event) => {
            const button = event.target.closest('[data-file-action]');
            if (!button || !filesListElement.contains(button)) return;
            event.preventDefault();
            event.stopPropagation();
            const card = button.closest('.file-card');
            const name = card ? card.dataset.fileName : '';
            const action = button.dataset.fileAction;
            if (!name || !currentServer) return showToast('لم يتم تحديد الملف', 'error');
            button.disabled = true;
            try {
                if (action === 'describe') openFileDescriptionModal(name, card?.dataset.displayName || '', card?.dataset.description || '');
                else if (action === 'edit') await editFile(name);
                else if (action === 'replace') await replaceFile(name);
                else if (action === 'download') downloadFile(name);
                else if (action === 'rename') openRenameModal(name);
                else if (action === 'unzip') await unzipFile(name);
                else if (action === 'delete') await deleteFile(name);
            } catch (e) {
                showToast(e?.message || 'تعذر تنفيذ العملية', 'error');
            } finally {
                button.disabled = false;
            }
        });
    }

    async function apiJson(url, options = {}) {
        const r = await fetch(url, options);
        const text = await r.text();
        let d = {};
        try { d = text ? JSON.parse(text) : {}; } catch (_) { d = {success:false, message:'استجابة غير صالحة من الخادم'}; }
        if (!r.ok || d.success === false) throw new Error(d.message || `فشل الطلب (${r.status})`);
        return d;
    }

    function openFileDescriptionModal(name, displayName, description) {
        descriptionTargetFile = name;
        descriptionTargetDefaults = {display_name: displayName || '', description: description || ''};
        document.getElementById('fileDisplayNameInput').value = displayName || '';
        document.getElementById('fileDescriptionInput').value = description || '';
        document.getElementById('fileDescriptionModal').classList.add('active');
    }
    function closeFileDescriptionModal() {
        document.getElementById('fileDescriptionModal').classList.remove('active');
        descriptionTargetFile = null;
    }
    async function saveFileDescription() {
        if (!currentServer || !descriptionTargetFile) return;
        const display_name = document.getElementById('fileDisplayNameInput').value.trim();
        const description = document.getElementById('fileDescriptionInput').value.trim();
        try {
            const d = await apiJson(`/api/files/metadata/${encodeURIComponent(currentServer.folder)}`, {
                method:'POST', headers:{'Content-Type':'application/json'},
                body:JSON.stringify({name: descriptionTargetFile, display_name, description})
            });
            closeFileDescriptionModal();
            showToast(d.message || 'تم حفظ الوصف', 'success');
            await loadFiles();
        } catch (e) { showToast(e.message || 'تعذر حفظ الوصف', 'error'); }
    }
    async function clearFileDescription() {
        if (!currentServer || !descriptionTargetFile) return;
        try {
            await apiJson(`/api/files/metadata/${encodeURIComponent(currentServer.folder)}`, {
                method:'POST', headers:{'Content-Type':'application/json'},
                body:JSON.stringify({name: descriptionTargetFile, display_name:'', description:''})
            });
            closeFileDescriptionModal();
            showToast('تم إرجاع الاسم والوصف الافتراضيين', 'success');
            await loadFiles();
        } catch (e) { showToast(e.message || 'تعذر إعادة الوصف', 'error'); }
    }
    function exportCurrentServerBackup() {
        if (!currentServer) return showToast('افتح السيرفر أولاً', 'error');
        if (!confirm('سيتم تنزيل ZIP يحتوي ملفات هذا البوت وبياناته الموجودة داخل مجلد المشروع، مع الأوصاف العربية. لن تتضمن النسخة حسابات المنصة العامة. متابعة؟')) return;
        window.location.href = `/api/server/export/${encodeURIComponent(currentServer.folder)}`;
    }

    async function editFile(name) {
        const d = await apiJson(`/api/files/content/${encodeURIComponent(currentServer.folder)}/${encodeURIComponent(name)}`);
        if (d.content === undefined) throw new Error('تعذر قراءة الملف');
        if (d.content === '[ملف ثنائي]') throw new Error('هذا ملف ثنائي ولا يمكن تعديله كمحتوى نصي');
        currentFile = name;
        editorOriginalContent = d.content || '';
        document.getElementById('editorArea').value = editorOriginalContent;
        document.getElementById('editorFileName').textContent = name;
        document.getElementById('editorModal').classList.add('active');
        setTimeout(() => document.getElementById('editorArea').focus(), 50);
    }

    async function saveFile() {
        if (!currentFile || !currentServer) return;
        try {
            const content = document.getElementById('editorArea').value;
            await apiJson(`/api/files/save/${encodeURIComponent(currentServer.folder)}/${encodeURIComponent(currentFile)}`, {
                method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({content})
            });
            editorOriginalContent = content;
            showToast('✅ تم حفظ التغييرات داخل الملف الأصلي', 'success');
            await loadFiles();
        } catch (e) { showToast(e.message || 'فشل حفظ الملف', 'error'); }
    }

    function closeFileEditor() {
        const area = document.getElementById('editorArea');
        if (currentFile && area.value !== editorOriginalContent && !confirm('عندك تعديلات غير محفوظة. تريد الرجوع بدون حفظ؟')) return;
        document.getElementById('editorModal').classList.remove('active');
        currentFile = null;
        editorOriginalContent = '';
    }

    function downloadFile(name) {
        if (!currentServer) return;
        const url = `/api/files/download/${encodeURIComponent(currentServer.folder)}/${encodeURIComponent(name)}`;
        const a = document.createElement('a');
        a.href = url; a.download = name.split('/').pop(); a.rel = 'noopener';
        document.body.appendChild(a); a.click(); a.remove();
        showToast('بدأ تنزيل الملف', 'success');
    }

    async function replaceFile(name) {
        if (!currentServer) return;
        const input = document.createElement('input');
        input.type = 'file'; input.accept = '*/*'; input.style.display = 'none';
        document.body.appendChild(input);
        const picked = new Promise(resolve => { input.onchange = () => resolve(input.files?.[0] || null); });
        input.click();
        const file = await picked;
        input.remove();
        if (!file) return;
        if (!window.confirm(`استبدال الملف "${name}" بالملف "${file.name}"؟`)) return;
        const fd = new FormData(); fd.append('file', file);
        try {
            const d = await apiJson(`/api/files/replace/${encodeURIComponent(currentServer.folder)}/${encodeURIComponent(name)}`, {method:'POST', body:fd});
            showToast(d.message || 'تم استبدال الملف بنجاح', 'success');
            await loadFiles();
        } catch(e) { showToast(e.message || 'فشل استبدال الملف', 'error'); }
    }

    async function deleteFile(name) {
        if (!currentServer) return;
        if (!window.confirm(`حذف الملف "${name}"؟`)) return;
        try {
            const d = await apiJson(`/api/files/delete/${encodeURIComponent(currentServer.folder)}`, {
                method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({names:[name]})
            });
            showToast(d.message || 'تم الحذف', 'success');
            await loadFiles();
        } catch(e) { showToast(e.message || 'فشل حذف الملف', 'error'); }
    }

    async function deleteAllFiles() {
        if (!currentServer) return;
        const ok = window.confirm('⚠️ سيتم إيقاف السيرفر وحذف جميع الملفات والمجلدات داخله نهائياً. قاعدة البيانات والحساب لن تتأثرا. هل أنت متأكد؟');
        if (!ok) return;
        try {
            showToast('جاري حذف كل الملفات...');
            const d = await apiJson(`/api/files/delete-all/${encodeURIComponent(currentServer.folder)}`, { method:'POST' });
            showToast(d.message || 'تم حذف الكل', 'success');
            await loadFiles();
            await loadServers();
        } catch(e) { showToast(e.message || 'فشل حذف الكل', 'error'); }
    }

    async function uploadFiles(files) {
        if(!files.length || !currentServer) return;
        const fd = new FormData();
        for(const f of files) fd.append('files[]', f);
        try {
            const d = await apiJson(`/api/files/upload/${encodeURIComponent(currentServer.folder)}`, {method:'POST', body:fd});
            showToast(d.message || 'تم رفع الملفات', 'success');
            await loadFiles();
        } catch(e) { showToast(e.message || 'فشل رفع الملفات', 'error'); }
    }

    function handleDrop(e) { e.preventDefault(); uploadFiles(e.dataTransfer.files); }

    let renameTarget = null;
    function openRenameModal(name) {
        renameTarget = name;
        document.getElementById('currentFileName').textContent = name;
        document.getElementById('newFileNameInput').value = name.split('/').pop();
        document.getElementById('renameModal').classList.add('active');
        setTimeout(()=>document.getElementById('newFileNameInput').focus(),100);
    }
    function closeRenameModal() { document.getElementById('renameModal').classList.remove('active'); renameTarget = null; }

    async function confirmRename() {
        const newName = document.getElementById('newFileNameInput').value.trim();
        if(!newName || !renameTarget || !currentServer) return;
        try {
            const d = await apiJson(`/api/files/rename/${encodeURIComponent(currentServer.folder)}`, {
                method:'POST', headers:{'Content-Type':'application/json'},
                body:JSON.stringify({old_name: renameTarget, new_name: newName})
            });
            showToast(d.message || 'تم تغيير الاسم', 'success');
            closeRenameModal();
            await loadFiles();
        } catch(e) { showToast(e.message || 'فشل تغيير الاسم', 'error'); }
    }

    async function unzipFile(name) {
        if (!currentServer) return;
        if (!window.confirm(`فك ضغط "${name}"؟`)) return;
        try {
            showToast('جاري فك الضغط...');
            const d = await apiJson(`/api/files/unzip/${encodeURIComponent(currentServer.folder)}/${encodeURIComponent(name)}`, {method:'POST'});
            showToast(d.message || 'تم فك الضغط', 'success');
            await loadFiles();
        } catch(e) { showToast(e.message || 'فشل فك الضغط', 'error'); }
    }

    async function installPackages() { 
        showToast('بدء التثبيت...'); 
        const r = await fetch(`/api/server/install/${currentServer.folder}`, { method:'POST' }); 
        const d = await r.json(); 
        showToast(d.message, d.success?'success':'error'); 
    }

    function closeCreateFileModal(){ document.getElementById('createFileModal').classList.remove('active'); }
    function closeCreateFolderModal(){ document.getElementById('createFolderModal').classList.remove('active'); }

    function showCreateFileModal() { 
        document.getElementById('newFileName').value=''; 
        document.getElementById('newFileContent').value=''; 
        document.getElementById('createFileModal').classList.add('active'); 
    }

    function showCreateFolderModal() { 
        document.getElementById('newFolderName').value=''; 
        document.getElementById('createFolderModal').classList.add('active'); 
    }

    async function createFolder() { 
        const name = document.getElementById('newFolderName').value.trim(); 
        if(!name) return; 
        const r = await fetch(`/api/files/create-folder/${encodeURIComponent(currentServer.folder)}`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({filename:name}) });
        const d = await r.json();
        if(!d.success){ showToast(d.message || 'فشل إنشاء المجلد', 'error'); return; }
        closeCreateFolderModal(); loadFiles(); 
    }

    async function unzipFile(name) { 
        showToast('جاري فك الضغط...'); 
        const r = await fetch(`/api/files/unzip/${encodeURIComponent(currentServer.folder)}/${encodeURIComponent(name)}`, { method:'POST' });
        const d = await r.json().catch(()=>({success:false,message:'فشل فك الضغط'}));
        showToast(d.message || (d.success ? 'تم فك الضغط' : 'فشل فك الضغط'), d.success ? 'success' : 'error');
        loadFiles(); 
    }

    async function createFile() { 
        const name = document.getElementById('newFileName').value.trim(); 
        const content = document.getElementById('newFileContent').value; 
        if(!name) return; 
        const r = await fetch(`/api/files/create/${currentServer.folder}`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({filename:name,content}) });
        const d = await r.json();
        if(!d.success){ showToast(d.message || 'فشل إنشاء الملف', 'error'); return; }
        closeCreateFileModal(); loadFiles(); 
        loadStartupFiles(); 
    }

    async function loadStartupFiles() { 
        if(!currentServer) return; 
        const r = await fetch(`/api/files/list/${currentServer.folder}`); 
        const files = await r.json(); 
        const type = currentServer.type || 'Python';
        // تحديد الامتدادات حسب نوع السيرفر
        const extensions = type === 'Node.js' ? ['.js', '.mjs', '.cjs'] : type === 'PHP' ? ['.php'] : type === 'Static' ? ['.html', '.htm'] : ['.py'];
        const startupFiles = files.filter(f=> extensions.some(ext => f.name.endsWith(ext)) && !f.is_dir); 
        const select = document.getElementById('startupFileSelect'); 
        if(select) select.innerHTML = '<option value="">-- اختر ملف التشغيل --</option>'+startupFiles.map(f=>`<option value="${f.name}" ${currentServer.startup_file===f.name?'selected':''}>${f.name}</option>`).join(''); 
    }

    async function setStartupFile() { 
        const filename = document.getElementById('startupFileSelect').value; 
        if(!filename) return; 
        await fetch(`/api/server/set-startup/${currentServer.folder}`, { 
            method:'POST', 
            headers:{'Content-Type':'application/json'}, 
            body:JSON.stringify({filename}) 
        }); 
        showToast('تم تعيين ملف التشغيل', 'success'); 
    }

    // ===== دوال API =====
    async function loadApiKey() { 
        document.getElementById('currentApiKeyDisplay').innerText = 'لم يتم إنشاء مفتاح بعد. اضغط "إنشاء مفتاح جديد".'; 
    }

    async function generateApiKey() {
        try {
            const res = await fetch('/api/create_api_key', { method: 'POST' });
            const data = await res.json();
            if(data.success) { 
                document.getElementById('currentApiKeyDisplay').innerText = data.api_key; 
                showToast('تم إنشاء مفتاح API جديد', 'success'); 
            } else {
                showToast('فشل إنشاء المفتاح', 'error');
            }
        } catch(e) { showToast('خطأ', 'error'); }
    }

    async function revokeApiKey() { 
        showToast('⚠️ هذه الميزة قيد التطوير', 'error'); 
    }

    async function logout() { 
        await fetch('/api/logout', { method:'POST' }); 
        window.location.href = '/login'; 
    }

    function escapeHtml(s) { 
        return String(s).replace(/[&<>]/g, m=>m==='&'?'&amp;':m==='<'?'&lt;':'&gt;'); 
    }


    // ===== بدء التشغيل =====
    checkAuth();
