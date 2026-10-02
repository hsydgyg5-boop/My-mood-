
    let currentServer = null, polling = null, currentFile = null, confirmAction = null, selectedPlan = null;

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
        } else {
            label.innerHTML = '🐘 PHP';
            title.innerHTML = '<i class="fab fa-php"></i> إنشاء خادم PHP';
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

    // ===== رفع ملف وإنشاء سيرفر تلقائياً =====
    async function autoCreateServer(file) {
        if (!file) return;
        const fd = new FormData();
        fd.append('file', file);
        showToast('⏳ جاري إنشاء السيرفر ورفع الملف وتثبيت المكتبات...', 'info');
        try {
            const r = await fetch('/api/server/auto-upload', { method:'POST', body:fd });
            const d = await r.json();
            if (d.success) {
                showToast(d.message || '✅ تم إنشاء السيرفر تلقائياً', 'success');
                await loadServers();
            } else {
                showToast(d.message || 'فشل إنشاء السيرفر', 'error');
            }
        } catch (e) {
            showToast('خطأ في الاتصال بالسيرفر', 'error');
        } finally {
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
            const typeIcons = { 'Python': '🐍', 'PHP': '🐘', 'Node.js': '🟨' };
            const typeClasses = { 'Python': 'badge-python', 'PHP': 'badge-php', 'Node.js': 'badge-node' };
            
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
                            <span class="badge ${typeClass}">${icon} ${type}</span>
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
                            <button class="action-btn" style="color:#c4b1ff;border-color:#9a72ff" data-action="rename" data-folder="${s.folder}"><i class="fas fa-pen"></i> تعديل الاسم</button>
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
                        } else if(action === 'rename') {
                            renameServer(folder, s.title);
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

    async function renameServer(folder,currentName){
        const name=prompt('اكتب اسم الخادم الجديد:',currentName||''); if(name===null)return;
        if(!name.trim())return showToast('اكتب اسماً صحيحاً','error');
        try{const r=await fetch(`/api/server/rename/${encodeURIComponent(folder)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name.trim()})});const d=await r.json();showToast(d.message||'تم تغيير الاسم',d.success?'success':'error');if(d.success)loadServers();}catch(e){showToast('❌ خطأ في الاتصال','error');}
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
        const typeIcons = { 'Python': '🐍', 'PHP': '🐘', 'Node.js': '🟨' };
        const typeIcon = typeIcons[s.type] || '📦';
        const typeName = s.type || 'Python';
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
            document.getElementById('consoleOut').innerHTML = (d.logs || 'لا توجد مخرجات').split('\n').map(l => `<div>${escapeHtml(l)}</div>`).join('');
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
    function fileActionButton(action, name, label, cls, icon) {
        const safe = escapeHtml(name);
        return `<button type="button" class="file-btn ${cls}" data-file-action="${action}" data-file-name="${safe}" title="${label}">${icon} ${label}</button>`;
    }

    async function apiJson(url, options={}) {
        const r = await fetch(url, options);
        const text = await r.text();
        let d;
        try { d = JSON.parse(text); }
        catch (_) { throw new Error(`HTTP ${r.status}: ${text.slice(0,180)}`); }
        if(!r.ok) throw new Error(d.message || `HTTP ${r.status}`);
        return d;
    }

    async function loadFiles() {
        if(!currentServer) return;
        const tbody=document.getElementById('filesList');
        if(!tbody) return;
        tbody.innerHTML='<tr><td colspan="4" style="text-align:center;padding:28px">⏳ جاري تحميل الملفات...</td></tr>';
        try{
            const files=await apiJson(`/api/files/list/${encodeURIComponent(currentServer.folder)}`);
            if(!Array.isArray(files) || !files.length){tbody.innerHTML='<tr><td colspan="4" style="text-align:center;padding:28px">📂 لا توجد ملفات</td></tr>';return;}
            tbody.innerHTML=files.map(f=>{
                const n=escapeHtml(String(f.name));
                const buttons=f.is_dir
                  ? fileActionButton('rename',f.name,'تغيير الاسم','rename','✏️') + fileActionButton('delete',f.name,'حذف المجلد','delete','🗑️')
                  : (f.is_zip ? fileActionButton('extract',f.name,'فك الضغط','extract','📦') : '')
                    + fileActionButton('replace',f.name,'استبدال الملف','replace','🔄')
                    + fileActionButton('rename',f.name,'تغيير الاسم','rename','✏️')
                    + fileActionButton('download',f.name,'تحميل','download','⬇️')
                    + fileActionButton('edit',f.name,'تعديل','edit','📝')
                    + fileActionButton('delete',f.name,'حذف الملف','delete','🗑️');
                return `<tr><td><input type="checkbox" class="file-checkbox" value="${n}"></td><td class="file-name-cell"><i class="fas ${f.is_dir?'fa-folder':'fa-file'}"></i> ${n}</td><td class="file-size-cell">${escapeHtml(String(f.size||'0 B'))}</td><td class="file-actions">${buttons}</td></tr>`;
            }).join('');
        }catch(e){console.error('loadFiles',e);tbody.innerHTML=`<tr><td colspan="4" style="color:#ff6b87;text-align:center;padding:28px">❌ ${escapeHtml(e.message||'فشل تحميل الملفات')}</td></tr>`;}
    }

    // حدث واحد ثابت لمدير الملفات: يمنع مشكلة inline onclick ويضمن أن الأزرار تبقى فعّالة بعد تحديث القائمة.
    document.addEventListener('click', async (event) => {
        const btn = event.target.closest('[data-file-action]');
        if(!btn) return;
        event.preventDefault();
        event.stopPropagation();
        const action = btn.dataset.fileAction;
        const name = btn.dataset.fileName;
        if(!currentServer || !name) return showToast('اختر خادماً أولاً','error');
        try {
            if(action==='extract') return unzipFile(name);
            if(action==='replace') return replaceFile(name);
            if(action==='rename') return openRenameModal(name);
            if(action==='download') return downloadFile(name);
            if(action==='edit') return editFile(name);
            if(action==='delete') return deleteFile(name);
        } catch(e) { showToast('❌ '+(e.message||'تعذر تنفيذ العملية'),'error'); }
    });

    document.addEventListener('click', (event) => {
        if(event.target.closest('#autoRepairBtn')) autoRepairServer();
        if(event.target.closest('#refreshFilesBtn')) loadFiles();
        if(event.target.closest('#deleteAllFilesBtn')) deleteAllFiles();
    });

    async function editFile(name) { 
        currentFile = name; 
        const d = await apiJson(`/api/files/content/${encodeURIComponent(currentServer.folder)}/${encodeURIComponent(name)}`); 
        document.getElementById('editorArea').value = d.content||''; 
        document.getElementById('editorModal').classList.add('active'); 
    }

    async function saveFile() { 
        if(!currentFile) return; 
        const content = document.getElementById('editorArea').value; 
        await apiJson(`/api/files/save/${encodeURIComponent(currentServer.folder)}/${encodeURIComponent(currentFile)}`, { 
            method:'POST', 
            headers:{'Content-Type':'application/json'}, 
            body:JSON.stringify({content}) 
        }); 
        showToast('تم الحفظ', 'success'); 
        document.getElementById('editorModal').classList.remove('active'); 
        currentFile=null; 
        loadFiles(); 
    }

    function downloadFile(name) {
        if(!currentServer) return;
        const url = `/api/files/download/${encodeURIComponent(currentServer.folder)}/${encodeURIComponent(name)}`;
        window.location.href = url;
    }

    async function replaceFile(name) {
        const input = document.createElement('input');
        input.type = 'file';
        input.style.display = 'none';
        document.body.appendChild(input);
        input.onchange = async () => {
            const file = input.files && input.files[0];
            if(!file) { input.remove(); return; }
            if(!confirm(`استبدال الملف "${name}" بالملف "${file.name}"؟\nلن يتم حذف أي ملف آخر.`)) {
                input.remove();
                return;
            }
            const fd = new FormData();
            fd.append('file', file);
            try {
                const r = await fetch(`/api/files/replace/${encodeURIComponent(currentServer.folder)}/${encodeURIComponent(name)}`, { method:'POST', body:fd });
                const d = await r.json();
                if(d.success) {
                    showToast(d.message || 'تم استبدال الملف بنجاح', 'success');
                    loadFiles();
                } else {
                    showToast(d.message || 'فشل استبدال الملف', 'error');
                }
            } catch(e) {
                showToast('خطأ في الاتصال', 'error');
            } finally {
                input.remove();
            }
        };
        input.click();
    }

    async function deleteFile(name){
        showConfirm(`حذف ${name}؟`,async()=>{try{const r=await fetch(`/api/files/delete/${encodeURIComponent(currentServer.folder)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({names:[name]})});const d=await r.json();showToast(d.message||'تمت العملية',d.success?'success':'error');if(d.success)loadFiles();}catch(e){showToast('❌ خطأ في الاتصال','error');}});
    }
    async function deleteAllFiles(){
        if(!currentServer||!confirm('⚠️ حذف جميع ملفات الخادم؟ ملفات النظام المحمية لن تُحذف.'))return;
        try{const r=await fetch(`/api/files/delete/${encodeURIComponent(currentServer.folder)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({all:true})});const d=await r.json();showToast(d.message||'تم الحذف',d.success?'success':'error');if(d.success)loadFiles();}catch(e){showToast('❌ خطأ في الاتصال','error');}
    }

    async function uploadFiles(files) { 
        if(!files.length) return; 
        const fd = new FormData(); 
        for(let f of files) fd.append('files[]',f); 
        try { const d=await apiJson(`/api/files/upload/${encodeURIComponent(currentServer.folder)}`, { method:'POST', body:fd }); loadFiles(); showToast(d.message||'تم رفع الملفات','success'); } catch(e) { showToast('❌ '+e.message,'error'); } 
    }

    function handleDrop(e) { 
        e.preventDefault(); 
        uploadFiles(e.dataTransfer.files); 
    }

    let renameTarget = null;
    function openRenameModal(name) { 
        renameTarget = name; 
        document.getElementById('currentFileName').textContent = name; 
        document.getElementById('newFileNameInput').value = name; 
        document.getElementById('renameModal').classList.add('active'); 
        setTimeout(()=>document.getElementById('newFileNameInput').focus(),100); 
    }

    function closeRenameModal() { 
        document.getElementById('renameModal').classList.remove('active'); 
        renameTarget = null; 
    }

    async function confirmRename() { 
        const newName = document.getElementById('newFileNameInput').value.trim(); 
        if(!newName || !renameTarget) return; 
        if(newName === renameTarget) { closeRenameModal(); return; } 
        try {
            const r = await fetch(`/api/files/rename/${encodeURIComponent(currentServer.folder)}`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({old_name: renameTarget, new_name: newName}) });
            const d = await r.json();
            if(d.success) showToast(d.message || `تمت إعادة التسمية إلى ${newName}`, 'success');
            else showToast(d.message || 'فشل تغيير الاسم', 'error');
        } catch(e) { showToast('خطأ في الاتصال', 'error'); } 
        closeRenameModal(); 
        loadFiles(); 
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
        const r = await fetch(`/api/files/create/${encodeURIComponent(currentServer.folder)}`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({filename:name, content:'', is_folder:true}) });
        const d = await r.json();
        if(!d.success){ showToast(d.message || 'فشل إنشاء المجلد', 'error'); return; }
        closeCreateFolderModal(); loadFiles(); 
    }

    async function autoRepairServer(){
        if(!currentServer) return;
        showToast('🛠️ جاري فحص وإصلاح الخادم...','info');
        try{
            const r=await fetch(`/api/server/auto-repair/${encodeURIComponent(currentServer.folder)}`,{method:'POST',headers:{'Content-Type':'application/json'}});
            const d=await r.json();
            showToast(d.message||'تم الإصلاح',d.success?'success':'error');
            if(d.success){ loadFiles(); loadStartupFiles(); }
        }catch(e){ showToast('❌ تعذر الاتصال بخدمة الإصلاح','error'); }
    }

    async function unzipFile(name){
        if(!currentServer) return;
        if(!confirm(`فك ضغط "${name}" داخل الخادم؟`)) return;
        showToast('⏳ جاري فك الضغط...','info');
        try{const r=await fetch(`/api/files/unzip/${encodeURIComponent(currentServer.folder)}/${encodeURIComponent(name)}`,{method:'POST'});const d=await r.json();if(d.success){showToast(d.message||'✅ تم فك الضغط','success');loadFiles();loadStartupFiles();}else showToast(d.message||'❌ فشل فك الضغط','error');}catch(e){showToast('❌ خطأ في الاتصال','error');}
    }

    async function createFile() { 
        const name = document.getElementById('newFileName').value.trim(); 
        const content = document.getElementById('newFileContent').value; 
        if(!name) return; 
        const r = await fetch(`/api/files/create/${encodeURIComponent(currentServer.folder)}`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({filename:name,content}) });
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
        const extensions = type === 'Node.js' ? ['.js'] : type === 'PHP' ? ['.php'] : ['.py'];
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
