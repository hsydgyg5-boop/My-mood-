
    // ===== متغيرات عامة =====
    let usersChart = null;
    let serversChart = null;
    let adminServerFilter = 'all';

    const showToast = (msg, type = 'info') => {
        const t = document.getElementById('toast');
        t.innerHTML = `<i class="fas ${type === 'success' ? 'fa-check-circle' : type === 'error' ? 'fa-exclamation-circle' : 'fa-info-circle'}"></i> ${msg}`;
        t.style.display = 'block';
        setTimeout(() => t.style.display = 'none', 3000);
    };

    // ===== تبديل التبويبات =====
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            document.getElementById(tab + 'Tab').classList.add('active');
            if (tab === 'users') loadUsers();
            if (tab === 'servers') loadAllServers();
            if (tab === 'requests') loadPendingRequests();
            if (tab === 'analytics') loadAnalytics();
            if (tab === 'plans') loadPlans();
            if (tab === 'php') loadPHPFiles();
        });
    });

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
        } else if (type === 'Static') {
            label.innerHTML = '🌐 HTML / CSS / JavaScript';
            title.innerHTML = '<i class="fas fa-code"></i> إنشاء موقع HTML ثابت';
        } else {
            label.innerHTML = '🟨 Node.js';
            title.innerHTML = '<i class="fab fa-node-js"></i> إنشاء خادم Node.js';
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
        if (!name) {
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
            
            if (data.success) {
                document.getElementById('createLoading').style.display = 'none';
                document.getElementById('createSuccess').style.display = 'block';
                showToast(`✅ تم إنشاء خادم ${serverType}`, 'success');
                loadAllServers();
                loadDashboard();
            } else {
                modal.classList.remove('active');
                showToast(data.message || 'فشل الإنشاء', 'error');
            }
        } catch(e) {
            modal.classList.remove('active');
            showToast('خطأ في الاتصال', 'error');
        }
    }

    // ===== دوال تحميل البيانات =====
    async function loadDashboard() {
        try {
            const res = await fetch('/api/admin/users');
            const data = await res.json();
            if (data.success) {
                document.getElementById('totalUsers').innerText = data.users.length;
                let totalServers = 0, activeServers = 0, totalDisk = 0;
                for (const user of data.users) {
                    const userServers = await fetch(`/api/admin/user-servers/${encodeURIComponent(user.username)}`).then(r => r.json());
                    if (userServers.servers) {
                        totalServers += userServers.servers.length;
                        activeServers += userServers.servers.filter(s => s.status === 'Running').length;
                        totalDisk += userServers.servers.reduce((sum, server) => sum + (Number(server.disk_used_mb) || 0), 0);
                    }
                }
                document.getElementById('totalServers').innerText = totalServers;
                document.getElementById('activeServers').innerText = activeServers;
                document.getElementById('totalDisk').innerText = (totalDisk / 1024).toFixed(1) + ' GB';
                document.getElementById('lastUpdate').innerText = new Date().toLocaleTimeString('ar-SA');
            }
        } catch (e) { console.log(e); }
    }

    async function loadUsers() {
        try {
            const res = await fetch('/api/admin/users');
            const data = await res.json();
            const list = document.getElementById('usersList');
            const limitSelect = document.getElementById('fileLimitUser');
            if (limitSelect) {
                const previousUser = limitSelect.value;
                limitSelect.innerHTML = data.users.map(u => `<option value="${escapeHtml(u.username)}" data-max-files="${Number(u.max_files || 10)}">${escapeHtml(u.username)}${u.is_admin ? ' (مسؤول)' : ''}</option>`).join('');
                if (data.users.some(u => u.username === previousUser)) limitSelect.value = previousUser;
                const selected = data.users.find(u => u.username === limitSelect.value);
                document.getElementById('fileLimitValue').value = selected ? Number(selected.max_files || 10) : 10;
                limitSelect.onchange = () => {
                    const chosen = data.users.find(u => u.username === limitSelect.value);
                    document.getElementById('fileLimitValue').value = chosen ? Number(chosen.max_files || 10) : 10;
                };
            }
            list.innerHTML = data.users.map(u => `
                <tr>
                    <td><strong>${escapeHtml(u.username)}</strong></td>
                    <td><span class="badge ${u.is_admin ? 'badge-admin' : 'badge-user'}">${u.is_admin ? '👑 مسؤول' : '👤 مستخدم'}</span></td>
                    <td>${u.plan || 'free'}</td>
                    <td style="min-width:170px;">
                        <div style="display:flex;gap:6px;align-items:center;">
                            <input type="number" min="1" max="1000000" value="${Number(u.max_servers || 2)}" aria-label="حد السيرفرات ${escapeHtml(u.username)}" style="width:86px;padding:7px;background:#070b15;border:1px solid rgba(45,122,255,.4);border-radius:10px;color:#fff;" />
                            <button class="btn-success" data-user="${escapeHtml(u.username)}" onclick="updateUserMaxServers(this.dataset.user,this.parentElement.querySelector('input').value)" style="padding:7px 10px;">حفظ</button>
                        </div>
                        <div style="font-size:.7rem;color:#9ca3cf;margin-top:5px;">حد إنشاء/رفع المشاريع</div>
                    </td>
                    <td style="min-width:170px;">
                        <div style="display:flex;gap:6px;align-items:center;">
                            <input type="number" min="1" max="1000000" value="${Number(u.max_files || 10)}" aria-label="حد ملفات ${escapeHtml(u.username)}" style="width:86px;padding:7px;background:#070b15;border:1px solid rgba(45,122,255,.4);border-radius:10px;color:#fff;" />
                            <button class="btn-success" data-user="${escapeHtml(u.username)}" onclick="updateUserMaxFiles(this.dataset.user,this.parentElement.querySelector('input').value)" style="padding:7px 10px;">حفظ</button>
                        </div>
                        <button class="btn-secondary" data-user="${escapeHtml(u.username)}" onclick="openAdminUserServers(this.dataset.user)" style="margin-top:6px;padding:6px 10px;"><i class="fas fa-server"></i> سيرفرات وملفات</button>
                    </td>
                    <td>${u.expiry_days} يوم</td>
                    <td style="font-size:11px;">${(u.created_at || '').substring(0,10)}</td>
                    <td>
                        ${u.username !== 'zzmmkj' ? `<button class="action-btn delete" data-user="${escapeHtml(u.username)}" onclick="deleteUser(this.dataset.user)"><i class="fas fa-trash"></i></button>` : '<span style="color:#9ca3cf;">محمي</span>'}
                    </td>
                </tr>
            `).join('');
            document.getElementById('userSearch').oninput = function() {
                const q = this.value.toLowerCase();
                list.querySelectorAll('tr').forEach(r => {
                    r.style.display = r.textContent.toLowerCase().includes(q) ? '' : 'none';
                });
            };
        } catch(e) { showToast('خطأ في تحميل المستخدمين', 'error'); }
    }

    function filterAdminServers(type) {
        adminServerFilter = type;
        document.querySelectorAll('#serversTab .filter-btn').forEach(b => b.classList.remove('active'));
        document.querySelector(`#serversTab .filter-btn[data-filter="${type}"]`).classList.add('active');
        
        const rows = document.querySelectorAll('#serversList tr');
        rows.forEach(row => {
            if (row.dataset.serverType) {
                if (type === 'all' || row.dataset.serverType === type) {
                    row.style.display = '';
                } else {
                    row.style.display = 'none';
                }
            }
        });
    }

    let adminActiveUserServers = '';
    async function openAdminUserServers(username) {
        adminActiveUserServers = username;
        const modal = document.getElementById('adminUserServersModal');
        const title = document.getElementById('adminUserServersTitle');
        const list = document.getElementById('adminUserServersList');
        title.textContent = `سيرفرات وملفات المستخدم: ${username}`;
        list.innerHTML = '<div style="padding:20px;text-align:center;color:#9ca3cf;">جاري تحميل السيرفرات والملفات...</div>';
        modal.classList.add('active');
        try {
            const r = await fetch(`/api/admin/user-servers/${encodeURIComponent(username)}`);
            const d = await r.json();
            if (!r.ok || !d.success) throw new Error(d.message || 'فشل تحميل السيرفرات');
            if (!d.servers.length) {
                list.innerHTML = '<div style="padding:20px;text-align:center;color:#9ca3cf;">هذا المستخدم لا يملك سيرفرات حاليًا.</div>';
                return;
            }
            list.innerHTML = d.servers.map(s => `<div style="padding:14px;border:1px solid rgba(45,122,255,.18);border-radius:16px;margin-bottom:10px;">
                <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center;">
                    <div><strong>${escapeHtml(s.title)}</strong><div style="color:#9ca3cf;font-size:.75rem;margin-top:5px;">${escapeHtml(s.type)} · ${s.file_count} ملف · ${s.status === 'Running' ? '🟢 يعمل' : '⚫ متوقف'}</div></div>
                    <div style="display:flex;gap:7px;flex-wrap:wrap;">
                        <button class="btn-secondary" data-folder="${escapeHtml(s.folder)}" onclick="adminOpenServer(this.dataset.folder)"><i class="fas fa-external-link-alt"></i> فتح</button>
                        <button class="btn-success" data-folder="${escapeHtml(s.folder)}" data-action="${s.status === 'Running' ? 'stop' : 'start'}" onclick="adminServerAction(this.dataset.folder,this.dataset.action)"><i class="fas fa-${s.status === 'Running' ? 'stop' : 'play'}"></i> ${s.status === 'Running' ? 'إيقاف' : 'تشغيل'}</button>
                        <button class="btn-secondary" data-folder="${escapeHtml(s.folder)}" data-owner="${escapeHtml(username)}" onclick="openAdminFiles(this.dataset.folder,this.dataset.owner)"><i class="fas fa-folder-open"></i> الملفات</button>
                        <button class="btn-secondary" data-folder="${escapeHtml(s.folder)}" onclick="downloadAdminServer(this.dataset.folder)"><i class="fas fa-download"></i> تنزيل الكل</button>
                    </div>
                </div>
            </div>`).join('');
        } catch (e) {
            list.innerHTML = `<div style="padding:20px;color:#ff5e7c;">${escapeHtml(e.message || 'خطأ في الاتصال')}</div>`;
        }
    }
    function closeAdminUserServers() { document.getElementById('adminUserServersModal').classList.remove('active'); adminActiveUserServers = ''; }

    async function adminOpenServer(folder) {
        try {
            const newTab = window.open('about:blank', '_blank');
            const r = await fetch(`/api/admin/server/open/${encodeURIComponent(folder)}`);
            const d = await r.json();
            if (!r.ok || !d.success || !d.url) {
                if (newTab) newTab.close();
                throw new Error(d.message || 'لا يوجد رابط فتح متاح');
            }
            if (newTab) { newTab.opener = null; newTab.location = d.url; }
            else window.location.href = d.url;
        } catch (e) { showToast(e.message || 'تعذر فتح السيرفر', 'error'); }
    }

    function downloadAdminServer(folder) {
        window.location.href = `/api/admin/server/download-all/${encodeURIComponent(folder)}`;
    }

    async function adminServerAction(folder, action) {
        try {
            const r = await fetch(`/api/admin/server-action/${encodeURIComponent(folder)}/${encodeURIComponent(action)}`, {method:'POST'});
            const d = await r.json();
            if (!r.ok || !d.success) throw new Error(d.message || 'فشل تنفيذ الإجراء');
            showToast(d.message || 'تم تنفيذ الإجراء', 'success');
            if (adminActiveUserServers) await openAdminUserServers(adminActiveUserServers);
            await loadAllServers();
        } catch (e) { showToast(e.message || 'خطأ في الاتصال', 'error'); }
    }

    async function loadAllServers() {
        const tbody = document.getElementById('serversList');
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">جاري التحميل...</td></tr>';
        try {
            const res = await fetch('/api/admin/users');
            const data = await res.json();
            let allServers = [];
            for (const user of data.users) {
                const serversRes = await fetch(`/api/admin/user-servers/${encodeURIComponent(user.username)}`);
                const serversData = await serversRes.json();
                if (serversData.servers) {
                    serversData.servers.forEach(s => {
                        allServers.push({ ...s, owner: user.username });
                    });
                }
            }
            if (allServers.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">لا توجد سيرفرات</td></tr>';
                return;
            }
            
            // تعريف أيقونات وأنواع السيرفرات بشكل صحيح
            const typeIcons = { 'Python': '🐍', 'PHP': '🐘', 'Node.js': '🟨', 'Static': '🌐' };
            const typeNames = { 'Python': 'Python', 'PHP': 'PHP', 'Node.js': 'Node.js', 'Static': 'HTML/CSS/JS' };
            const typeColors = { 'Python': 'badge-python', 'PHP': 'badge-php', 'Node.js': 'badge-node', 'Static': 'badge-static' };
            
            tbody.innerHTML = allServers.map(s => {
                const type = s.type || 'Python';
                const icon = typeIcons[type] || '📦';
                const typeClass = typeColors[type] || 'badge-python';
                return `
                    <tr data-server-type="${type}">
                        <td>${escapeHtml(s.title)}</td>
                        <td>${escapeHtml(s.owner)}</td>
                        <td><span class="badge ${typeClass}">${icon} ${typeNames[type] || type}</span></td>
                        <td><span class="badge ${s.status === 'Running' ? 'badge-admin' : ''}" style="${s.status !== 'Running' ? 'background:#555;' : ''}">${s.status === 'Running' ? '🟢 نشط' : '⚫ متوقف'}</span></td>
                        <td style="font-size:11px;">${(s.created_at || '').substring(0,10)}</td>
                        <td style="display:flex;gap:5px;flex-wrap:wrap;align-items:center;">
                          <button class="btn-secondary" data-folder="${escapeHtml(s.folder)}" onclick="adminOpenServer(this.dataset.folder)"><i class="fas fa-external-link-alt"></i> فتح</button>
                          <button class="btn-success" data-folder="${escapeHtml(s.folder)}" data-action="${s.status === 'Running' ? 'stop' : 'start'}" onclick="adminServerAction(this.dataset.folder,this.dataset.action)" style="padding:7px 10px;">${s.status === 'Running' ? 'إيقاف' : 'تشغيل'}</button>
                          <button class="btn-secondary" data-folder="${escapeHtml(s.folder)}" data-owner="${escapeHtml(s.owner)}" onclick="openAdminFiles(this.dataset.folder,this.dataset.owner)"><i class="fas fa-folder-open"></i> الملفات</button>
                          <button class="btn-secondary" data-folder="${escapeHtml(s.folder)}" onclick="downloadAdminServer(this.dataset.folder)"><i class="fas fa-download"></i></button>
                          <button class="action-btn delete" data-folder="${escapeHtml(s.folder)}" onclick="adminServerAction(this.dataset.folder,'delete')"><i class="fas fa-trash"></i></button>
                        </td>
                    </tr>
                `;
            }).join('');
            
            // تطبيق الفلتر الحالي
            filterAdminServers(adminServerFilter);
            
            document.getElementById('serverSearch').oninput = function() {
                const q = this.value.toLowerCase();
                tbody.querySelectorAll('tr').forEach(r => {
                    if (r.dataset.serverType) {
                        r.style.display = r.textContent.toLowerCase().includes(q) ? '' : 'none';
                    }
                });
            };
        } catch(e) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">خطأ في التحميل</td></tr>'; }
    }

    async function loadPendingRequests() {
        try {
            const res = await fetch('/api/admin/pending-users');
            const data = await res.json();
            const tbody = document.getElementById('pendingList');
            const noPending = document.getElementById('noPending');
            
            if (data.success && data.users.length > 0) {
                tbody.innerHTML = data.users.map(u => `
                    <tr>
                        <td><strong>${escapeHtml(u.username)}</strong></td>
                        <td style="font-size:11px;">${(u.created_at || '').substring(0,10)}</td>
                        <td>${u.telegram_id ? '📱 ' + escapeHtml(u.telegram_id) : '❌ غير مرتبط'}</td>
                        <td>
                            <button class="btn-success" style="padding:6px 16px; font-size:0.7rem;" onclick="approveUser('${escapeHtml(u.username)}')">
                                <i class="fas fa-check"></i> قبول
                            </button>
                            <button class="btn-danger" style="padding:6px 16px; font-size:0.7rem;" onclick="rejectUser('${escapeHtml(u.username)}')">
                                <i class="fas fa-times"></i> رفض
                            </button>
                        </td>
                    </tr>
                `).join('');
                tbody.style.display = '';
                noPending.style.display = 'none';
                
                document.getElementById('pendingSearch').oninput = function() {
                    const q = this.value.toLowerCase();
                    tbody.querySelectorAll('tr').forEach(r => {
                        r.style.display = r.textContent.toLowerCase().includes(q) ? '' : 'none';
                    });
                };
            } else {
                tbody.style.display = 'none';
                noPending.style.display = 'block';
            }
        } catch(e) {
            document.getElementById('pendingList').innerHTML = '<tr><td colspan="4" style="text-align:center;color:#ff5e7c;">❌ خطأ في تحميل الطلبات</td></tr>';
        }
    }

    // ===== دوال المستخدمين =====
    async function approveUser(username) {
        if (!confirm(`✅ هل تريد قبول المستخدم "${username}"؟`)) return;
        try {
            const res = await fetch('/api/admin/approve-user', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username })
            });
            const data = await res.json();
            if (data.success) {
                showToast('✅ تم قبول المستخدم ' + username, 'success');
                loadPendingRequests();
                loadUsers();
                loadDashboard();
            } else {
                showToast('❌ ' + (data.message || 'فشل القبول'), 'error');
            }
        } catch(e) {
            showToast('❌ خطأ في الاتصال', 'error');
        }
    }

    async function rejectUser(username) {
        if (!confirm(`❌ هل تريد رفض المستخدم "${username}"؟`)) return;
        try {
            const res = await fetch('/api/admin/reject-user', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username })
            });
            const data = await res.json();
            if (data.success) {
                showToast('❌ تم رفض المستخدم ' + username, 'success');
                loadPendingRequests();
                loadUsers();
                loadDashboard();
            } else {
                showToast('❌ ' + (data.message || 'فشل الرفض'), 'error');
            }
        } catch(e) {
            showToast('❌ خطأ في الاتصال', 'error');
        }
    }

    async function deleteUser(username) {
        if (!confirm(`حذف المستخدم "${username}" نهائياً؟`)) return;
        try {
            const res = await fetch('/api/admin/delete-user', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username })
            });
            const data = await res.json();
            if (data.success) {
                showToast('🗑️ تم حذف المستخدم', 'success');
                loadUsers();
                loadDashboard();
            } else {
                showToast('❌ ' + (data.message || 'فشل الحذف'), 'error');
            }
        } catch(e) { showToast('❌ خطأ', 'error'); }
    }

    async function deleteServer(folder) {
        if (!confirm(`حذف السيرفر نهائياً؟`)) return;
        try {
            const res = await fetch(`/api/server/action/${folder}/delete`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                showToast('🗑️ تم حذف السيرفر', 'success');
                loadAllServers();
                loadDashboard();
            } else {
                showToast('❌ فشل الحذف', 'error');
            }
        } catch(e) { showToast('❌ خطأ', 'error'); }
    }

    async function saveSelectedUserFileLimit() {
        const username = document.getElementById('fileLimitUser').value;
        const value = document.getElementById('fileLimitValue').value;
        if (!username) { showToast('اختر مستخدمًا أولًا', 'error'); return; }
        await updateUserMaxFiles(username, value);
    }

    async function updateUserMaxServers(username, value) {
        const max_servers = Number.parseInt(value, 10);
        if (!Number.isInteger(max_servers) || max_servers < 1 || max_servers > 1000000) {
            showToast('أدخل حدًا صحيحًا بين 1 و1,000,000 مشروع', 'error');
            return;
        }
        try {
            const r = await fetch('/api/admin/update-user', {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({username, max_servers})
            });
            const d = await r.json();
            if (!r.ok || !d.success) throw new Error(d.message || 'تعذر تحديث حد السيرفرات');
            showToast(`تم ضبط حد مشاريع ${username} إلى ${max_servers}`, 'success');
            await loadUsers();
        } catch (e) { showToast(e.message || 'خطأ في الاتصال', 'error'); }
    }

    function downloadFullMazajiBackup() {
        if (!confirm('سيتم تنزيل نسخة حساسة تشمل قاعدة بيانات المنصة وملفات ومشاريع المستخدمين. احتفظ بها في مكان آمن. متابعة؟')) return;
        window.location.href = '/api/admin/backup/full';
    }

    async function updateUserMaxFiles(username, value) {
        const max_files = Number.parseInt(value, 10);
        if (!Number.isInteger(max_files) || max_files < 1 || max_files > 1000000) {
            showToast('أدخل حدًا صحيحًا بين 1 و1,000,000 ملف', 'error');
            return;
        }
        try {
            const r = await fetch('/api/admin/update-user', {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({username, max_files})
            });
            const d = await r.json();
            if (!r.ok || !d.success) throw new Error(d.message || 'تعذر تحديث حد الملفات');
            showToast(`تم ضبط حد ${username} إلى ${max_files} ملف`, 'success');
            loadUsers();
        } catch (e) { showToast(e.message || 'خطأ في الاتصال', 'error'); }
    }

    async function createNewUser() {
        const username = document.getElementById('newUsername').value.trim();
        const password = document.getElementById('newPassword').value.trim();
        const max_servers = parseInt(document.getElementById('maxServers').value) || 2;
        const max_files = parseInt(document.getElementById('newUserMaxFiles').value) || 10;
        const expiry_days = parseInt(document.getElementById('expiryDays').value) || 365;
        if (!username || !password) {
            showToast('⚠️ الرجاء إدخال جميع البيانات', 'error');
            return;
        }
        try {
            const res = await fetch('/api/admin/create-user', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password, max_servers, max_files, expiry_days })
            });
            const data = await res.json();
            if (data.success) {
                showToast('✅ تم إنشاء المستخدم', 'success');
                document.getElementById('newUsername').value = '';
                document.getElementById('newPassword').value = '';
                loadUsers();
                loadDashboard();
            } else {
                showToast('❌ ' + (data.message || 'فشل الإنشاء'), 'error');
            }
        } catch(e) { showToast('❌ خطأ في الاتصال', 'error'); }
    }

    // ===== دوال الخطط =====
    async function loadPlans() {
        try {
            const res = await fetch('/api/plans');
            const data = await res.json();
            if (data.success) {
                const container = document.getElementById('plansList');
                container.innerHTML = '';
                for (const [id, plan] of Object.entries(data.plans)) {
                    const planDiv = document.createElement('div');
                    planDiv.className = 'stat-neo';
                    planDiv.style.cssText = 'background:rgba(15,23,42,0.5); border-radius:20px; padding:16px;';
                    planDiv.innerHTML = `
                        <div style="font-weight:700;">${plan.name}</div>
                        <div>💰 ${plan.price === 0 ? 'مجاني' : plan.price + '$'}</div>
                        <div>💾 ${(plan.storage / 1024).toFixed(0)} GB</div>
                        <div>🧠 ${plan.ram} MB</div>
                        <div>🖥 ${plan.cpu} نواة</div>
                        <div>📦 حد أقصى: ${plan.max_servers} سيرفر</div>
                        ${id !== 'free' ? `<button class="btn-secondary" style="margin-top:8px;" onclick="editPlan('${id}')">تعديل</button>` : ''}
                    `;
                    container.appendChild(planDiv);
                }
            }
        } catch(e) { console.error(e); }
    }

    async function addPlan() {
        const name = document.getElementById('newPlanName').value.trim();
        const price = parseInt(document.getElementById('newPlanPrice').value) || 0;
        const storage = parseInt(document.getElementById('newPlanStorage').value) || 512000;
        const ram = parseInt(document.getElementById('newPlanRam').value) || 256;
        const cpu = parseFloat(document.getElementById('newPlanCpu').value) || 0.5;
        const max_servers = parseInt(document.getElementById('newPlanMaxServers').value) || 2;
        
        if (!name) {
            showToast('⚠️ الرجاء إدخال اسم الخطة', 'error');
            return;
        }
        
        try {
            const res = await fetch('/api/admin/add-plan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, price, storage, ram, cpu, max_servers })
            });
            const data = await res.json();
            if (data.success) {
                showToast('✅ تم إضافة الخطة', 'success');
                loadPlans();
                document.getElementById('newPlanName').value = '';
                document.getElementById('newPlanPrice').value = '';
                document.getElementById('newPlanStorage').value = '';
                document.getElementById('newPlanRam').value = '';
                document.getElementById('newPlanCpu').value = '';
                document.getElementById('newPlanMaxServers').value = '';
            } else {
                showToast('❌ ' + (data.message || 'فشل الإضافة'), 'error');
            }
        } catch(e) { showToast('❌ خطأ', 'error'); }
    }

    function editPlan(id) {
        showToast('⚠️ ميزة التعديل قيد التطوير', 'error');
    }

    function saveSettings() {
        showToast('✅ تم حفظ الإعدادات (محاكاة)', 'success');
    }

    async function updateAdminPassword() {
        const newPass = document.getElementById('newAdminPass').value.trim();
        if (!newPass || newPass.length < 4) {
            showToast('⚠️ كلمة المرور قصيرة جداً', 'error');
            return;
        }
        showToast('⚠️ هذه الميزة قيد التطوير. قم بتغييرها يدوياً في ملف app.py', 'error');
    }

    // ===== دوال التحليلات =====
    async function loadAnalytics() {
        try {
            const metrics = await fetch('/api/system/metrics').then(r => r.json());
            document.getElementById('cpuStat').innerText = metrics.cpu + '%';
            document.getElementById('cpuProgress').style.width = metrics.cpu + '%';
            document.getElementById('ramStat').innerText = metrics.memory + '%';
            document.getElementById('ramProgress').style.width = metrics.memory + '%';
        } catch(e) {}
        
        if (usersChart) usersChart.destroy();
        if (serversChart) serversChart.destroy();
        const ctx1 = document.getElementById('userGrowthChart').getContext('2d');
        const ctx2 = document.getElementById('serversGrowthChart').getContext('2d');
        usersChart = new Chart(ctx1, {
            type: 'line',
            data: { labels: ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو'], datasets: [{ label: 'المستخدمين', data: [2, 4, 7, 10, 15, 20], borderColor: '#2d7aff', backgroundColor: 'rgba(45,122,255,0.1)', fill: true }] },
            options: { responsive: true, maintainAspectRatio: true }
        });
        serversChart = new Chart(ctx2, {
            type: 'bar',
            data: { labels: ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو'], datasets: [{ label: 'السيرفرات', data: [1, 3, 5, 8, 12, 18], backgroundColor: '#2d7aff' }] },
            options: { responsive: true, maintainAspectRatio: true }
        });
    }

    // ===== دوال PHP =====
    async function runPHPCode() {
        const code = document.getElementById('phpCodeInput').value;
        if (!code.trim()) {
            showToast('⚠️ الرجاء إدخال كود PHP', 'error');
            return;
        }
        
        const output = document.getElementById('phpOutput');
        output.textContent = '⏳ جاري تشغيل الكود...';
        output.style.color = '#b0f0b0';
        
        try {
            const res = await fetch('/api/php/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: code })
            });
            const data = await res.json();
            
            if (data.success) {
                let result = '';
                if (data.output) {
                    result += '📤 المخرجات:\n' + data.output;
                }
                if (data.error) {
                    result += '\n\n⚠️ الأخطاء:\n' + data.error;
                }
                if (!data.output && !data.error) {
                    result = '✅ تم التشغيل بنجاح (لا يوجد مخرجات)';
                }
                output.textContent = result;
                output.style.color = data.error ? '#ff5e7c' : '#b0f0b0';
            } else {
                output.textContent = '❌ ' + (data.message || 'فشل التشغيل');
                output.style.color = '#ff5e7c';
            }
        } catch(e) {
            output.textContent = '❌ خطأ في الاتصال: ' + e.message;
            output.style.color = '#ff5e7c';
        }
    }

    function clearPHPOutput() {
        document.getElementById('phpOutput').textContent = '📝 أنتظر كود PHP...';
        document.getElementById('phpOutput').style.color = '#b0f0b0';
    }

    async function savePHPFile() {
        const filename = document.getElementById('newPHPFileName').value.trim();
        const content = document.getElementById('newPHPContent').value;
        
        if (!filename) {
            showToast('⚠️ الرجاء إدخال اسم الملف', 'error');
            return;
        }
        
        if (!filename.endsWith('.php')) {
            showToast('⚠️ يجب أن ينتهي اسم الملف بـ .php', 'error');
            return;
        }
        
        try {
            const res = await fetch('/api/php/upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename, content })
            });
            const data = await res.json();
            
            if (data.success) {
                showToast(data.message, 'success');
                document.getElementById('newPHPFileName').value = '';
                document.getElementById('newPHPContent').value = '';
                loadPHPFiles();
            } else {
                showToast('❌ ' + data.message, 'error');
            }
        } catch(e) {
            showToast('❌ خطأ في الاتصال', 'error');
        }
    }

    async function loadPHPFiles() {
        const tbody = document.getElementById('phpFilesList');
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#9ca3cf;">جاري التحميل...</td></tr>';
        
        try {
            const res = await fetch('/api/php/list');
            const data = await res.json();
            
            if (data.success) {
                if (data.files.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#9ca3cf;">📭 لا توجد ملفات PHP محفوظة</td></tr>';
                    return;
                }
                
                tbody.innerHTML = data.files.map(f => `
                    <tr>
                        <td><i class="fab fa-php" style="color:#777bb4;"></i> ${escapeHtml(f.name)}</td>
                        <td>${(f.size/1024).toFixed(1)} KB</td>
                        <td style="font-size:11px;">${f.modified}</td>
                        <td>
                            <button class="btn-success" style="padding:4px 12px; font-size:0.7rem;" onclick="runPHPFile('${escapeHtml(f.name)}')">
                                <i class="fas fa-play"></i> تشغيل
                            </button>
                            <button class="btn-secondary" style="padding:4px 12px; font-size:0.7rem;" onclick="editPHPFile('${escapeHtml(f.name)}')">
                                <i class="fas fa-edit"></i> تعديل
                            </button>
                            <button class="btn-danger" style="padding:4px 12px; font-size:0.7rem;" onclick="deletePHPFile('${escapeHtml(f.name)}')">
                                <i class="fas fa-trash"></i> حذف
                            </button>
                        </td>
                    </tr>
                `).join('');
            } else {
                tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#ff5e7c;">❌ ' + (data.message || 'فشل التحميل') + '</td></tr>';
            }
        } catch(e) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#ff5e7c;">❌ خطأ في الاتصال</td></tr>';
            console.error('loadPHPFiles error:', e);
        }
    }

    async function runPHPFile(filename) {
        const output = document.getElementById('phpOutput');
        output.textContent = `⏳ تشغيل ملف ${filename}...`;
        output.style.color = '#b0f0b0';
        
        try {
            const res = await fetch('/api/php/run-file', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename })
            });
            const data = await res.json();
            
            if (data.success) {
                let result = '';
                if (data.output) {
                    result += '📤 المخرجات:\n' + data.output;
                }
                if (data.error) {
                    result += '\n\n⚠️ الأخطاء:\n' + data.error;
                }
                if (!data.output && !data.error) {
                    result = '✅ تم تشغيل الملف بنجاح (لا يوجد مخرجات)';
                }
                output.textContent = result;
                output.style.color = data.error ? '#ff5e7c' : '#b0f0b0';
            } else {
                output.textContent = '❌ ' + (data.message || 'فشل تشغيل الملف');
                output.style.color = '#ff5e7c';
            }
        } catch(e) {
            output.textContent = '❌ خطأ: ' + e.message;
            output.style.color = '#ff5e7c';
        }
    }

    async function editPHPFile(filename) {
        try {
            const res = await fetch('/api/php/get-content', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename })
            });
            const data = await res.json();
            
            if (data.success) {
                document.getElementById('newPHPFileName').value = filename;
                document.getElementById('newPHPContent').value = data.content || '';
                showToast('📝 تم تحميل الملف للتعديل', 'info');
            } else {
                showToast('❌ ' + (data.message || 'فشل تحميل الملف'), 'error');
            }
        } catch(e) {
            showToast('❌ خطأ في الاتصال', 'error');
        }
    }

    async function deletePHPFile(filename) {
        if (!confirm(`🗑️ هل تريد حذف ${filename} نهائياً؟`)) return;
        
        try {
            const res = await fetch('/api/php/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename })
            });
            const data = await res.json();
            
            if (data.success) {
                showToast(data.message, 'success');
                loadPHPFiles();
            } else {
                showToast('❌ ' + (data.message || 'فشل الحذف'), 'error');
            }
        } catch(e) {
            showToast('❌ خطأ في الاتصال', 'error');
        }
    }

    // ===== دوال عامة =====
    function logout() {
        fetch('/api/logout', { method: 'POST' }).then(() => window.location.href = '/login');
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>\"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[m]));
    }

    // ===== بدء التشغيل =====
    loadDashboard();
    loadUsers();
    loadAnalytics();
    loadPendingRequests();
    loadPHPFiles();
    setInterval(() => { loadDashboard(); loadAnalytics(); }, 30000);

    let adminFilesFolder = null;
    function openAdminFiles(folder, owner){
        adminFilesFolder = folder;
        document.getElementById('adminFilesTitle').textContent = `ملفات سيرفر ${owner}`;
        document.getElementById('adminFilesModal').classList.add('active');
        loadAdminFiles();
    }
    function closeAdminFiles(){ document.getElementById('adminFilesModal').classList.remove('active'); adminFilesFolder=null; }
    async function loadAdminFiles(){
        const box=document.getElementById('adminFilesList'); box.innerHTML='<div style="padding:20px;text-align:center">جاري تحميل الملفات...</div>';
        try{ const r=await fetch(`/api/admin/server-files/${encodeURIComponent(adminFilesFolder)}`); const d=await r.json(); if(!d.success){box.innerHTML=`<div style="padding:20px;color:#ff5e7c">${escapeHtml(d.message||'فشل')}</div>`;return;} if(!d.files.length){box.innerHTML='<div style="padding:20px;text-align:center;color:#9ca3cf">لا توجد ملفات</div>';return;} box.innerHTML=d.files.map(f=>`<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px;border-bottom:1px solid rgba(255,255,255,.08);flex-wrap:wrap"><span style="word-break:break-all">📄 ${escapeHtml(f.name)}</span><div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn-success" onclick="downloadAdminFile(${JSON.stringify(f.name)})"><i class="fas fa-download"></i> سحب الملف</button><button class="btn-danger" onclick="deleteAdminFile(${JSON.stringify(f.name)})"><i class="fas fa-trash"></i> حذف</button></div></div>`).join(''); }catch(e){box.innerHTML='<div style="padding:20px;color:#ff5e7c">خطأ في الاتصال</div>'; }
    }
    function downloadAdminFile(name){ window.location.href=`/api/admin/file/download/${encodeURIComponent(adminFilesFolder)}/${encodeURIComponent(name)}`; }
    async function deleteAdminFile(name){ if(!confirm(`حذف الملف ${name} نهائياً؟`)) return; try { const r=await fetch(`/api/admin/file/delete/${encodeURIComponent(adminFilesFolder)}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name})}); const d=await r.json(); alert(d.message||"تم"); if(d.success) loadAdminFiles(); } catch(e){ alert("خطأ في الاتصال"); } }
    function downloadAdminAll(){ if(adminFilesFolder) window.location.href=`/api/admin/server/download-all/${encodeURIComponent(adminFilesFolder)}`; }
