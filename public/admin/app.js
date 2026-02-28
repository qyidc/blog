// public/admin/app.js (终极可靠版)

// 将所有代码包裹在一个DOMContentLoaded事件监听器中
// 确保在操作任何HTML元素之前，它们都已存在
document.addEventListener('DOMContentLoaded', () => {

    // --- 1. 全局变量和状态 ---
    const API_BASE = '/api';
    let easyMDE;
    let currentPostId = null;
    let currentLinkId = null;

    // --- 2. DOM 元素缓存 ---
    const pages = {
        posts: document.getElementById('posts-page'),
        categories: document.getElementById('categories-page'),
        tags: document.getElementById('tags-page'),
        links: document.getElementById('links-page'),
        settings: document.getElementById('settings-page'),
        tools: document.getElementById('tools-page'),
        images: document.getElementById('images-page'),
        comments: document.getElementById('comments-page'),
        ipBlacklist: document.getElementById('ip-blacklist-page'),
    };
    const navLinks = document.querySelectorAll('.nav-link');

    // --- 3. 所有函数定义 (使用 function 声明以确保提升) ---

    async function apiRequest(endpoint, method = 'GET', body = null, jsonBody = true) {
        const options = { method, headers: {} };
        if (body) {
            if (jsonBody) {
                options.headers['Content-Type'] = 'application/json';
                options.body = JSON.stringify(body);
            } else {
                // FormData不需要设置Content-Type，浏览器会自动设置带boundary的正确值
                options.body = body;
            }
        }
        const response = await fetch(`${API_BASE}${endpoint}`, options);
        if (!response.ok) {
            const errorText = await response.text();
            try { const errorData = JSON.parse(errorText); throw new Error(errorData.cause || errorData.error || '请求失败'); }
            catch (e) { throw new Error(errorText || '请求失败'); }
        }
        if (response.status === 204 || response.headers.get('content-length') === '0') return null;
        return response.json();
    }
    
    function showPage(pageKey) {
        if (!pageKey || !pages[pageKey]) pageKey = 'posts';
        
        Object.values(pages).forEach(p => p.classList.remove('active'));
        navLinks.forEach(l => l.classList.remove('active'));
        
        pages[pageKey].classList.add('active');
          const activeLink = document.querySelector(`[data-page="${pageKey}-page"]`);
          if (activeLink) activeLink.classList.add('active');
        
        window.location.hash = pageKey;

        if (!pages[pageKey].dataset.loaded) {
            const loader = window.pageLoaders[pageKey];
            if (typeof loader === 'function') {
                loader();
            }
            pages[pageKey].dataset.loaded = 'true';
        }
    }

    let currentPostsPage = 1;
    let postsPagination = null;

    async function loadStatistics() {
        try {
            const result = await apiRequest('/statistics');
            const data = result.data;
            
            document.getElementById('stat-total-posts').textContent = data.total_posts;
            document.getElementById('stat-published').textContent = data.published_posts;
            document.getElementById('stat-drafts').textContent = data.draft_posts;
            document.getElementById('stat-comments').textContent = data.total_comments;
            document.getElementById('stat-pending').textContent = data.pending_comments;
            document.getElementById('stat-views').textContent = data.total_views.toLocaleString();
        } catch (e) {
            console.error('加载统计数据失败:', e);
        }
    }

    async function loadPosts(page = 1) {
        const listEl = document.getElementById('posts-list');
        const paginationEl = document.getElementById('posts-pagination');
        if(!listEl) return;
        listEl.setAttribute('aria-busy', 'true');
        
        // 加载统计数据
        loadStatistics();
        
        try {
            const result = await apiRequest(`/posts?page=${page}&pageSize=10`);
            const posts = result.data;
            postsPagination = result.pagination;
            currentPostsPage = page;
            
            if (posts.length === 0) { 
                listEl.innerHTML = '<p>暂无文章，开始撰写第一篇吧！</p>';
                if (paginationEl) paginationEl.innerHTML = '';
            }
            else { 
                listEl.innerHTML = posts.map(p => `<article><header><strong>${p.title} ${p.is_pinned ? '<span style="color: #f59e0b; font-size: 0.8rem; margin-left: 0.5rem;">置顶</span>' : ''} ${p.is_draft ? '<span style="color: #ef4444; font-size: 0.8rem; margin-left: 0.5rem;">草稿</span>' : ''}</strong></header><small>分类: ${p.category || '无'} | ${p.is_published && !p.is_draft ? '已发布' : p.is_draft ? '草稿' : '未发布'} | ${new Date(p.published_at).toLocaleDateString()}</small><footer><button class="edit-btn" data-id="${p.id}">编辑</button><button class="delete-btn secondary" data-id="${p.id}">删除</button></footer></article>`).join('');
                
                // 生成分页HTML
                if (paginationEl && postsPagination.totalPages > 1) {
                    let paginationHtml = `<div style="display: flex; gap: 0.5rem; justify-content: center; margin-top: 1rem;">
                        <button ${currentPostsPage <= 1 ? 'disabled' : ''} class="secondary" onclick="loadPosts(${currentPostsPage - 1})">上一页</button>
                        <span>第 ${currentPostsPage} / ${postsPagination.totalPages} 页 (共 ${postsPagination.total} 篇)</span>
                        <button ${currentPostsPage >= postsPagination.totalPages ? 'disabled' : ''} onclick="loadPosts(${currentPostsPage + 1})">下一页</button>
                    </div>`;
                    paginationEl.innerHTML = paginationHtml;
                }
            }
        } catch(e) { listEl.innerHTML = `<p style="color:red">加载文章失败: ${e.message}</p>`; }
        finally { listEl.setAttribute('aria-busy', 'false'); }
    }
    // 挂载到全局，方便分页按钮调用
    window.loadPosts = loadPosts;
    async function loadCategories() {
        const container = pages.categories;
        if (!container) return;
        const tableEl = container.querySelector('table');
        if (!tableEl) return;
        tableEl.setAttribute('aria-busy', 'true');
        try {
            const categories = await apiRequest('/categories');
            if (categories.length === 0) {
                container.innerHTML = '<h2>分类管理</h2><p>暂无分类</p>';
                return; // 直接退出，因为tableEl已经被销毁
            }
            tableEl.innerHTML = `<thead><tr><th>分类名</th><th>文章数</th><th style="text-align: right;">操作</th></tr></thead><tbody>${categories.map(c => `<tr><td>${c.name}</td><td>${c.post_count}</td><td style="text-align: right;"><button class="rename-btn" data-name="${c.name}">重命名</button><button class="delete-btn secondary" data-name="${c.name}">删除</button></td></tr>`).join('')}</tbody>`;
        } catch (e) {
            container.innerHTML = `<h2>分类管理</h2><p style="color:red">加载分类失败: ${e.message}</p>`;
        } finally {
            // --- 核心修正 ---
            // 使用 setTimeout 将此操作推迟到下一个事件循环，确保DOM已更新
            setTimeout(() => {
                if (tableEl) tableEl.setAttribute('aria-busy', 'false');
            }, 0);
        }
    }

    async function loadTags() {
        const container = pages.tags;
        if (!container) return;
        const tableEl = container.querySelector('table');
        if (!tableEl) return;
        tableEl.setAttribute('aria-busy', 'true');
        try {
            const tags = await apiRequest('/tags');
            if (tags.length === 0) {
                container.innerHTML = '<h2>标签管理</h2><p>暂无标签</p>';
                return;
            }
            tableEl.innerHTML = `<thead><tr><th>标签名</th><th>文章数</th><th style="text-align: right;">操作</th></tr></thead><tbody>${tags.map(t => `<tr><td>${t.name}</td><td>${t.post_count}</td><td style="text-align: right;"><button class="rename-btn" data-name="${t.name}">重命名</button><button class="delete-btn secondary" data-name="${t.name}">删除</button></td></tr>`).join('')}</tbody>`;
        } catch (e) {
            container.innerHTML = `<h2>标签管理</h2><p style="color:red">加载标签失败: ${e.message}</p>`;
        } finally {
            // --- 核心修正 ---
            setTimeout(() => {
                if (tableEl) tableEl.setAttribute('aria-busy', 'false');
            }, 0);
        }
    }
    async function loadLinks() {
        const listEl = document.getElementById('links-list');
        if(!listEl) return;
        listEl.setAttribute('aria-busy', 'true');
        try {
            const links = await apiRequest('/links');
            if (links.length > 0) { listEl.innerHTML = links.map(l => `<article><header><strong>${l.name}</strong></header><a href="${l.url}" target="_blank">${l.url}</a><footer><button class="edit-link-btn" data-id="${l.id}" data-name="${l.name}" data-url="${l.url}">编辑</button><button class="delete-link-btn secondary" data-id="${l.id}">删除</button></footer></article>`).join(''); }
            else { listEl.innerHTML = `<p>暂无友链</p>`; }
        } catch(e) { listEl.innerHTML = `<p style="color:red">加载友链失败: ${e.message}</p>`; }
        finally { listEl.setAttribute('aria-busy', 'false'); }
    }
    async function loadSettings() {
        const titleInput = document.getElementById('blog_title');
        const urlInput = document.getElementById('site_url');
        const subtitleInput = document.getElementById('subtitle');
        
        if (titleInput && urlInput && subtitleInput) { 
            try { 
                const settings = await apiRequest('/settings'); 
                titleInput.value = settings.blog_title || '';
                urlInput.value = settings.site_url || '';
                subtitleInput.value = settings.subtitle || ''; 
            } catch(e) { alert('加载设置失败'); } 
        }
    }

    let currentImagesPage = 1;
    let imagesPagination = null;

    async function loadImages(page = 1) {
        const listEl = document.getElementById('images-list');
        const paginationEl = document.getElementById('images-pagination');
        const previewModal = document.getElementById('image-preview-modal');
        
        if(!listEl) return;
        listEl.setAttribute('aria-busy', 'true');
        
        try {
            const result = await apiRequest(`/images?page=${page}&pageSize=12`);
            const images = result.data;
            imagesPagination = result.pagination;
            currentImagesPage = page;
            
            if (images.length === 0) {
                listEl.innerHTML = '<p style="grid-column: 1 / -1; text-align: center;">暂无图片，去文章编辑页上传第一张图片吧！</p>';
                if (paginationEl) paginationEl.innerHTML = '';
            } else {
                listEl.innerHTML = images.map(img => `
                    <div class="image-card" style="border: 1px solid #e2e8f0; border-radius: 0.5rem; overflow: hidden;">
                        <div style="position: relative; padding-top: 75%; background: #f8fafc; cursor: pointer;" 
                             onclick="showImagePreview('${img.url}', '${img.file_name}')">
                            <img src="${img.url}" alt="${img.file_name}" 
                                 style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover;">
                        </div>
                        <div style="padding: 0.75rem;">
                                <p style="font-size: 0.875rem; margin-bottom: 0.5rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" 
                                   title="${img.file_name}">${img.file_name}</p>
                                <div style="font-size: 0.75rem; color: #64748b; margin-bottom: 0.5rem;">
                                    <span>${img.file_size_formatted}</span>
                                    <span style="margin: 0 0.5rem;">|</span>
                                    <span>${new Date(img.upload_at).toLocaleString('zh-CN')}</span>
                                </div>
                                ${img.post_title ? 
                                    `<p style="font-size: 0.75rem; color: #0ea5e9; margin-bottom: 0.5rem;">引用文章: ${img.post_title}</p>` : 
                                    `<p style="font-size: 0.75rem; color: #64748b; margin-bottom: 0.5rem;">未被引用</p>`
                                }
                                <!-- Markdown代码显示 -->
                                <div style="background: #f8fafc; padding: 0.25rem; border-radius: 0.25rem; margin-bottom: 0.5rem; font-size: 0.7rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: monospace;" 
                                     title="![${img.file_name}](${img.url})">
                                    ![${img.file_name.length > 10 ? img.file_name.slice(0,10) + '...' : img.file_name}](${img.url})
                                </div>
                                <div style="display: flex; gap: 0.25rem;">
                                    <button class="secondary" style="flex:1; padding: 0.25rem; font-size: 0.75rem;" 
                                            onclick="copyImageMarkdown('${img.url}', '${img.file_name}')">
                                        复制代码
                                    </button>
                                    <button class="delete-btn secondary" style="flex:1; padding: 0.25rem; font-size: 0.75rem;" 
                                            ${img.post_id ? 'disabled title="被文章引用，无法直接删除"' : `onclick="deleteImage('${img.id}', '${img.file_name}')"`}>
                                        ${img.post_id ? '已引用' : '删除'}
                                    </button>
                                </div>
                            </div>
                    </div>
                `).join('');
                
                // 生成分页HTML
                if (paginationEl && imagesPagination.totalPages > 1) {
                    let paginationHtml = `<div style="display: flex; gap: 0.5rem; justify-content: center; margin-top: 1rem;">
                        <button ${currentImagesPage <= 1 ? 'disabled' : ''} class="secondary" onclick="loadImages(${currentImagesPage - 1})">上一页</button>
                        <span>第 ${currentImagesPage} / ${imagesPagination.totalPages} 页 (共 ${imagesPagination.total} 张)</span>
                        <button ${currentImagesPage >= imagesPagination.totalPages ? 'disabled' : ''} onclick="loadImages(${currentImagesPage + 1})">下一页</button>
                    </div>`;
                    paginationEl.innerHTML = paginationHtml;
                }
            }
        } catch(e) { 
            listEl.innerHTML = `<p style="grid-column: 1 / -1; text-align: center; color:red">加载图片失败: ${e.message}</p>`; 
        } finally { 
            listEl.setAttribute('aria-busy', 'false'); 
        }
    }

    // 图片预览函数
    window.showImagePreview = (url, fileName) => {
        const modal = document.getElementById('image-preview-modal');
        const previewImg = document.getElementById('preview-image');
        const previewTitle = document.getElementById('preview-title');
        
        previewImg.src = url;
        previewTitle.textContent = fileName;
        modal.style.display = 'flex';
    };

    // 关闭预览
    window.closeImagePreview = () => {
        document.getElementById('image-preview-modal').style.display = 'none';
    };

    // 复制图片Markdown代码
    window.copyImageMarkdown = async (url, fileName) => {
        const markdown = `![${fileName}](${url})`;
        try {
            await navigator.clipboard.writeText(markdown);
            alert('Markdown代码已复制到剪贴板！');
        } catch (err) {
            // 降级方案
            const textarea = document.createElement('textarea');
            textarea.value = markdown;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            alert('Markdown代码已复制到剪贴板！');
        }
    };

    // 删除图片函数
    window.deleteImage = async (id, fileName) => {
        if (confirm(`确定要删除图片 "${fileName}" 吗？此操作不可恢复！`)) {
            try {
                await apiRequest(`/images/${id}`, 'DELETE');
                alert('图片删除成功！');
                loadImages(currentImagesPage);
            } catch (err) {
                alert(`删除失败: ${err.message}`);
            }
        }
    };

    // 挂载到全局
    window.loadImages = loadImages;

    // 评论管理
    let currentCommentsPage = 1;
    let commentsPagination = null;

    async function loadComments(page = 1) {
        const tableEl = document.getElementById('comments-table');
        if (!tableEl) return;
        tableEl.setAttribute('aria-busy', 'true');
        
        try {
            const result = await apiRequest(`/comments?page=${page}&pageSize=20`);
            const comments = result.data;
            commentsPagination = result.pagination;
            currentCommentsPage = page;
            
            if (comments.length === 0) {
                tableEl.innerHTML = '<tr><td colspan="6" style="text-align: center;">暂无评论</td></tr>';
            } else {
                tableEl.innerHTML = `
                    <thead>
                        <tr>
                            <th>评论者</th>
                            <th>内容</th>
                            <th>所属文章</th>
                            <th>IP地址</th>
                            <th>状态</th>
                            <th>发布时间</th>
                            <th style="text-align: right;">操作</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${comments.map(comment => `
                            <tr style="${comment.is_approved === 0 ? 'opacity: 0.7;' : ''}">
                                <td>${comment.author}</td>
                                <td style="max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${comment.content}">${comment.content}</td>
                                <td>${comment.post_title || '未知文章'}</td>
                                <td>${comment.ip_address}</td>
                                <td>${comment.is_approved === 1 ? '<span style="color: #10b981;">已通过</span>' : '<span style="color: #f59e0b;">待审核</span>'}</td>
                                <td>${new Date(comment.created_at).toLocaleString()}</td>
                                <td style="text-align: right;">
                                    ${comment.is_approved === 0 ? `
                                    <button class="secondary" style="background: #10b981; color: white; padding: 0.25rem 0.5rem; font-size: 0.75rem; border: none; border-radius: 0.25rem; cursor: pointer; margin-left: 0.25rem;"
                                            onclick="approveComment('${comment.id}')">
                                        通过
                                    </button>` : ''}
                                    <button class="delete-btn secondary" style="padding: 0.25rem 0.5rem; font-size: 0.75rem;" 
                                            onclick="deleteComment('${comment.id}', '${comment.author}')">
                                        删除
                                    </button>
                                    <button class="secondary" style="padding: 0.25rem 0.5rem; font-size: 0.75rem; margin-left: 0.25rem;"
                                            onclick="blockIp('${comment.ip_address}')">
                                        拉黑IP
                                    </button>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                `;

                // 分页
                if (commentsPagination.totalPages > 1) {
                    const paginationRow = document.createElement('tr');
                    paginationRow.innerHTML = `
                        <td colspan="6" style="text-align: center; padding: 1rem;">
                            <div style="display: flex; gap: 0.5rem; justify-content: center;">
                                <button ${currentCommentsPage <= 1 ? 'disabled' : ''} class="secondary" onclick="loadComments(${currentCommentsPage - 1})">上一页</button>
                                <span>第 ${currentCommentsPage} / ${commentsPagination.totalPages} 页 (共 ${commentsPagination.total} 条)</span>
                                <button ${currentCommentsPage >= commentsPagination.totalPages ? 'disabled' : ''} onclick="loadComments(${currentCommentsPage + 1})">下一页</button>
                            </div>
                        </td>
                    `;
                    tableEl.appendChild(paginationRow);
                }
            }
        } catch (e) {
            tableEl.innerHTML = `<tr><td colspan="6" style="text-align: center; color:red">加载评论失败: ${e.message}</td></tr>`;
        } finally {
            tableEl.setAttribute('aria-busy', 'false');
        }
    }

    // 删除评论
    window.deleteComment = async (id, author) => {
        if (confirm(`确定要删除 "${author}" 的评论吗？此操作不可恢复！`)) {
            try {
                await apiRequest(`/comments/${id}`, 'DELETE');
                alert('评论删除成功！');
                loadComments(currentCommentsPage);
            } catch (err) {
                alert(`删除失败: ${err.message}`);
            }
        }
    };
    
    // 审核通过评论
    window.approveComment = async (id) => {
        try {
            await apiRequest(`/comments/${id}`, 'PUT', { is_approved: 1 });
            alert('评论审核通过！前台将在重建页面后显示。');
            loadComments(currentCommentsPage);
        } catch (err) {
            alert(`审核失败: ${err.message}`);
        }
    };

    // 拉黑IP
    window.blockIp = async (ip) => {
        const reason = prompt('请输入拉黑原因（可选）:');
        if (reason !== null) { // 取消操作不执行
            try {
                await apiRequest('/ip-blacklist', 'POST', { ip_address: ip, reason: reason || '' });
                alert(`IP ${ip} 已成功加入黑名单！`);
                loadIpBlacklist();
            } catch (err) {
                alert(`拉黑失败: ${err.message}`);
            }
        }
    };

    // IP黑名单管理
    async function loadIpBlacklist() {
        const tableEl = document.getElementById('ip-blacklist-table');
        if (!tableEl) return;
        tableEl.setAttribute('aria-busy', 'true');
        
        try {
            const result = await apiRequest('/ip-blacklist');
            const list = result.data || [];
            
            const htmlParts = [];
            htmlParts.push(`
                <thead>
                    <tr>
                        <th>IP地址</th>
                        <th>拉黑原因</th>
                        <th>拉黑时间</th>
                        <th style="text-align: right;">操作</th>
                    </tr>
                </thead>
                <tbody>
            `);

            if (list.length === 0) {
                htmlParts.push('<tr><td colspan="4" style="text-align: center; padding: 2rem;">黑名单为空</td></tr>');
            } else {
                list.forEach(item => {
                    htmlParts.push(`
                        <tr>
                            <td>${item.ip_address}</td>
                            <td>${item.reason || '无'}</td>
                            <td>${new Date(item.created_at).toLocaleString()}</td>
                            <td style="text-align: right;">
                                <button onclick="removeFromBlacklist('${item.id}', '${item.ip_address}')" style="background: #ef4444; color: white; padding: 0.25rem 0.5rem; font-size: 0.75rem; border: none; border-radius: 0.25rem; cursor: pointer;">
                                    解除拉黑
                                </button>
                            </td>
                        </tr>
                    `);
                });
            }

            // 不管有没有数据，都显示添加表单
            htmlParts.push(`
                <tr>
                    <td colspan="4" style="padding: 1rem;">
                        <form id="add-ip-form" class="grid grid-cols-3 gap-4">
                            <input type="text" id="new-ip" required placeholder="IP地址或IP段（如192.168.1.*）" style="margin: 0; padding: 0.5rem; border: 1px solid #cbd5e1; border-radius: 0.375rem;">
                            <input type="text" id="new-reason" placeholder="拉黑原因（可选）" style="margin: 0; padding: 0.5rem; border: 1px solid #cbd5e1; border-radius: 0.375rem;">
                            <button type="submit" style="margin: 0; background: #0284c7; color: white; padding: 0.5rem 1rem; border: none; border-radius: 0.375rem; cursor: pointer;">添加到黑名单</button>
                        </form>
                    </td>
                </tr>
                </tbody>
            `);

            tableEl.innerHTML = htmlParts.join('');

            // 添加IP表单提交（不管有没有数据都要绑定）
            document.getElementById('add-ip-form').addEventListener('submit', async (e) => {
                e.preventDefault();
                const ip = document.getElementById('new-ip').value.trim();
                const reason = document.getElementById('new-reason').value.trim();
                
                try {
                    await apiRequest('/ip-blacklist', 'POST', { ip_address: ip, reason });
                    alert('IP添加成功！');
                    loadIpBlacklist();
                    document.getElementById('add-ip-form').reset();
                } catch (err) {
                    alert(`添加失败: ${err.message}`);
                }
            });
        } catch (e) {
            tableEl.innerHTML = `<tr><td colspan="4" style="text-align: center; color:red">加载黑名单失败: ${e.message}</td></tr>`;
        } finally {
            tableEl.setAttribute('aria-busy', 'false');
        }
    }

    // 移除IP黑名单
    window.removeFromBlacklist = async (id, ip) => {
        if (confirm(`确定要解除IP ${ip} 的拉黑吗？`)) {
            try {
                await apiRequest(`/ip-blacklist/${id}`, 'DELETE');
                alert('IP已解除拉黑！');
                loadIpBlacklist();
            } catch (err) {
                alert(`解除失败: ${err.message}`);
            }
        }
    };

    // 挂载到全局
    window.loadComments = loadComments;
    window.loadIpBlacklist = loadIpBlacklist;
    async function showPostForm(mode, post = null) {
        document.getElementById('posts-list-section').style.display = 'none';
        document.getElementById('post-form-section').style.display = 'block';
        document.getElementById('post-form').reset();
        if (!easyMDE) { easyMDE = new EasyMDE({ element: document.getElementById('post-content'), spellChecker: false, status: ['lines', 'words'] }); }
        if (mode === 'create') {
            document.getElementById('form-title').textContent = '撰写新文章';
            currentPostId = null; easyMDE.value("");
        } else {
            document.getElementById('form-title').textContent = '编辑文章';
            currentPostId = post.id;
            document.getElementById('post-title').value = post.title;
            easyMDE.value(post.content);
            document.getElementById('post-category').value = post.category || '';
            document.getElementById('post-tags').value = post.tags && JSON.parse(post.tags).length > 0 ? JSON.parse(post.tags).join(',') : '';
            document.getElementById('post-feature_image').value = post.feature_image || '';
            document.getElementById('post-is_published').checked = post.is_published && !post.is_draft;
            document.getElementById('post-is_pinned').checked = post.is_pinned || false;
        }
        try { const categories = await apiRequest('/categories'); document.getElementById('category-list').innerHTML = categories.map(c => `<option value="${c.name}">`).join(''); }
        catch(e) { console.error("Failed to load categories for datalist", e); }
    }
    function hidePostForm() {
        document.getElementById('posts-list-section').style.display = 'block';
        document.getElementById('post-form-section').style.display = 'none';
    }
    async function handlePostSubmit(e) {
        e.preventDefault(); const form = e.target; form.setAttribute('aria-busy', 'true');
        const data = { 
            title: document.getElementById('post-title').value, 
            content: easyMDE.value(), 
            category: document.getElementById('post-category').value, 
            tags: document.getElementById('post-tags').value.split(',').map(t => t.trim()).filter(Boolean), 
            feature_image: document.getElementById('post-feature_image').value, 
            is_published: document.getElementById('post-is_published').checked,
            is_pinned: document.getElementById('post-is_pinned').checked,
            is_draft: 0
        };
        const endpoint = currentPostId ? `/posts/${currentPostId}` : '/posts';
        const method = currentPostId ? 'PUT' : 'POST';
        try { await apiRequest(endpoint, method, data); alert('文章保存成功!'); hidePostForm(); loadPosts(); }
        catch (err) { alert(`保存失败: ${err.message}`); }
        finally { form.setAttribute('aria-busy', 'false'); }
    }
    
    async function handleSaveDraft(e) {
        e.preventDefault(); const form = document.getElementById('post-form'); form.setAttribute('aria-busy', 'true');
        const data = { 
            title: document.getElementById('post-title').value || '未命名草稿', 
            content: easyMDE.value(), 
            category: document.getElementById('post-category').value, 
            tags: document.getElementById('post-tags').value.split(',').map(t => t.trim()).filter(Boolean), 
            feature_image: document.getElementById('post-feature_image').value, 
            is_published: 0,
            is_pinned: 0,
            is_draft: 1
        };
        const endpoint = currentPostId ? `/posts/${currentPostId}` : '/posts';
        const method = currentPostId ? 'PUT' : 'POST';
        try { await apiRequest(endpoint, method, data); alert('草稿保存成功!'); hidePostForm(); loadPosts(); }
        catch (err) { alert(`保存草稿失败: ${err.message}`); }
        finally { form.setAttribute('aria-busy', 'false'); }
    }
    async function handlePostListClick(e) {
        const target = e.target;
        if (target.matches('.edit-btn')) {
            try { const post = await apiRequest(`/posts/${target.dataset.id}`); showPostForm('edit', post); }
            catch(err){ alert(`加载文章失败: ${err.message}`) }
        }
        if (target.matches('.delete-btn')) {
            if (confirm('确认删除?')) {
                try { await apiRequest(`/posts/${target.dataset.id}`, 'DELETE'); alert('删除成功!'); loadPosts(); }
                catch(err) { alert(`删除失败: ${err.message}`); }
            }
        }
    }
    async function handleCategoryListClick(e) {
        const target = e.target; const oldName = target.dataset.name; if (!oldName) return;
        if (target.matches('.rename-btn')) {
            const newName = prompt(`重命名分类 "${oldName}":`, oldName);
            if (newName && newName.trim() && newName !== oldName) {
                try { await apiRequest('/categories/rename', 'PUT', { oldName, newName }); alert('重命名成功！建议稍后手动重建所有静态页面。'); loadCategories(); }
                catch (err) { alert(`错误: ${err.message}`); }
            }
        }
        if (target.matches('.delete-btn')) {
            if (confirm(`确认删除分类 "${oldName}"？所有使用此分类的文章将变为“未分类”。`)) {
                try { await apiRequest(`/categories/${encodeURIComponent(oldName)}`, 'DELETE'); alert('删除成功！建议稍后手动重建所有静态页面。'); loadCategories(); }
                catch (err) { alert(`错误: ${err.message}`); }
            }
        }
    }
    async function handleTagListClick(e) {
        const target = e.target; const oldName = target.dataset.name; if (!oldName) return;
        if (target.matches('.rename-btn')) {
            const newName = prompt(`重命名标签 "${oldName}":`, oldName);
            if (newName && newName.trim() && newName !== oldName) {
                try { await apiRequest('/tags/rename', 'PUT', { oldName, newName }); alert('重命名成功！建议稍后手动重建所有静态页面。'); loadTags(); }
                catch(err) { alert(`错误: ${err.message}`); }
            }
        }
        if (target.matches('.delete-btn')) {
            if (confirm(`确认删除标签 "${oldName}"？它将从所有使用它的文章中被移除。`)) {
                try { await apiRequest(`/tags/${encodeURIComponent(oldName)}`, 'DELETE'); alert('删除成功！建议稍后手动重建所有静态页面。'); loadTags(); }
                catch(err) { alert(`错误: ${err.message}`); }
            }
        }
    }
    async function handleLinkSubmit(e) {
        e.preventDefault(); const form = e.target; form.setAttribute('aria-busy', 'true');
        const data = { name: document.getElementById('link-name').value, url: document.getElementById('link-url').value };
        const endpoint = currentLinkId ? `/links/${currentLinkId}` : '/links';
        const method = currentLinkId ? 'PUT' : 'POST';
        try { await apiRequest(endpoint, method, data); alert('友链保存成功!'); currentLinkId = null; form.reset(); loadLinks(); }
        catch(e) { alert(`保存失败: ${e.message}`); }
        finally { form.setAttribute('aria-busy', 'false'); }
    }
    function handleLinkListClick(e) {
        const target = e.target;
        if (target.matches('.edit-link-btn')) {
            currentLinkId = target.dataset.id;
            document.getElementById('link-name').value = target.dataset.name;
            document.getElementById('link-url').value = target.dataset.url;
            window.scrollTo(0, 0);
        }
        if (target.matches('.delete-link-btn')) {
            if (confirm('确认删除?')) { apiRequest(`/links/${target.dataset.id}`, 'DELETE').then(() => { alert('删除成功!'); loadLinks(); }).catch(err => alert(`删除失败: ${err.message}`)); }
        }
    }
    async function handleSettingsSubmit(e) {
        e.preventDefault(); const form = e.target; form.setAttribute('aria-busy', 'true');
        const data = { 
            blog_title: document.getElementById('blog_title').value,
            site_url: document.getElementById('site_url').value,
            subtitle: document.getElementById('subtitle').value 
        };
        try { 
            await apiRequest('/settings', 'PUT', data); 
            alert('设置保存成功! 网站标题和副标题将在下次手动重建所有页面后生效，域名修改将即时生效于sitemap和robots.txt。'); 
        } catch(e) { 
            alert(`保存失败: ${e.message}`); 
        } finally { 
            form.setAttribute('aria-busy', 'false'); 
        }
    }
    async function handleRebuild(e) {
        const rebuildBtn = document.getElementById('rebuild-all-btn');
        if (rebuildBtn && e.target === rebuildBtn && confirm('确认要重建所有静态页面吗？此操作可能需要几分钟时间。')) {
            rebuildBtn.setAttribute('aria-busy', 'true');
            rebuildBtn.textContent = '重建中...';
            try {
                const result = await apiRequest('/rebuild-all', 'POST');
                alert(result.message || '重建任务已在后台成功启动！您可以安全地关闭此窗口。');
            } catch (err) { alert(`启动重建失败: ${err.message}`); }
            finally { rebuildBtn.setAttribute('aria-busy', 'false'); rebuildBtn.textContent = '开始重建'; }
        }
    }

    // --- 4. 总初始化函数 ---
    function initialize() {
        // 将数据加载器挂载到全局，方便惰性调用
        window.pageLoaders = { posts: loadPosts, categories: loadCategories, tags: loadTags, links: loadLinks, settings: loadSettings, images: loadImages, comments: loadComments, ipBlacklist: loadIpBlacklist };
        
        // 渲染所有UI骨架
        pages.posts.innerHTML = `<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;"><h2>文章管理</h2><button id="show-post-form-btn">撰写新文章</button></div>
<!-- 统计面板 -->
<div id="statistics-panel" style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem; margin-bottom: 1.5rem;">
    <div style="background: #f8fafc; padding: 1rem; border-radius: 0.5rem; border-left: 4px solid #0ea5e9;">
        <div style="font-size: 0.875rem; color: #64748b; margin-bottom: 0.25rem;">总文章数</div>
        <div style="font-size: 1.5rem; font-weight: bold; color: #1e293b;" id="stat-total-posts">0</div>
    </div>
    <div style="background: #f8fafc; padding: 1rem; border-radius: 0.5rem; border-left: 4px solid #10b981;">
        <div style="font-size: 0.875rem; color: #64748b; margin-bottom: 0.25rem;">已发布</div>
        <div style="font-size: 1.5rem; font-weight: bold; color: #1e293b;" id="stat-published">0</div>
    </div>
    <div style="background: #f8fafc; padding: 1rem; border-radius: 0.5rem; border-left: 4px solid #f59e0b;">
        <div style="font-size: 0.875rem; color: #64748b; margin-bottom: 0.25rem;">草稿</div>
        <div style="font-size: 1.5rem; font-weight: bold; color: #1e293b;" id="stat-drafts">0</div>
    </div>
    <div style="background: #f8fafc; padding: 1rem; border-radius: 0.5rem; border-left: 4px solid #8b5cf6;">
        <div style="font-size: 0.875rem; color: #64748b; margin-bottom: 0.25rem;">总评论数</div>
        <div style="font-size: 1.5rem; font-weight: bold; color: #1e293b;" id="stat-comments">0</div>
    </div>
    <div style="background: #f8fafc; padding: 1rem; border-radius: 0.5rem; border-left: 4px solid #ef4444;">
        <div style="font-size: 0.875rem; color: #64748b; margin-bottom: 0.25rem;">待审核评论</div>
        <div style="font-size: 1.5rem; font-weight: bold; color: #1e293b;" id="stat-pending">0</div>
    </div>
    <div style="background: #f8fafc; padding: 1rem; border-radius: 0.5rem; border-left: 4px solid #ec4899;">
        <div style="font-size: 0.875rem; color: #64748b; margin-bottom: 0.25rem;">总阅读量</div>
        <div style="font-size: 1.5rem; font-weight: bold; color: #1e293b;" id="stat-views">0</div>
    </div>
</div>
<div id="posts-list-section"><div id="posts-list" aria-busy="true"></div><div id="posts-pagination"></div></div><div id="post-form-section" style="display: none;"><form id="post-form" aria-busy="false"><h3 id="form-title">撰写新文章</h3><input type="text" id="post-title" placeholder="文章标题" required><div style="margin-bottom: 1rem;"><button type="button" id="upload-image-btn" style="margin-bottom: 0.5rem;">📷 上传图片</button><input type="file" id="image-file-input" accept="image/jpeg,image/jpg,image/png,image/gif,image/webp" style="display: none;"></div><textarea id="post-content"></textarea><label for="post-category">分类</label><input type="text" id="post-category" placeholder="选择或输入新分类" list="category-list"><datalist id="category-list"></datalist><label for="post-tags">标签 (英文逗号分隔)</label><input type="text" id="post-tags" placeholder="例如：cloudflare,d1,r2"><label for="post-feature_image">特色图片链接</label><input type="text" id="post-feature_image" placeholder="https://example.com/image.jpg 或相对路径"><div style="display: flex; gap: 1rem; align-items: center;"><label><input type="checkbox" id="post-is_published" name="is_published" checked>发布</label><label><input type="checkbox" id="post-is_pinned" name="is_pinned">置顶</label></div><div class="grid"><button type="submit">保存文章</button><button type="button" id="save-draft-btn" class="secondary">保存为草稿</button><button type="button" id="cancel-post-form-btn" class="secondary">取消</button></div></form></div>`;
        pages.categories.innerHTML = `<h2>分类管理</h2><div class="table-container"><table id="categories-table" aria-busy="true"></table></div>`;
        pages.tags.innerHTML = `<h2>标签管理</h2><div class="table-container"><table id="tags-table" aria-busy="true"></table></div>`;
        pages.links.innerHTML = `<h2>友链管理</h2><form id="link-form" aria-busy="false"><input type="hidden" id="linkId"><div class="grid"><input type="text" id="link-name" placeholder="网站名称" required><input type="url" id="link-url" placeholder="网站链接 (https://...)" required></div><button type="submit">保存友链</button></form><hr><h3>友链列表</h3><div id="links-list" aria-busy="true"></div>`;
        pages.settings.innerHTML = `<h2>网站设置</h2><form id="settings-form" aria-busy="false"><label for="blog_title">网站主标题</label><input type="text" id="blog_title" name="blog_title" placeholder="例如：我的博客"><label for="site_url">网站域名</label><input type="url" id="site_url" name="site_url" placeholder="例如：https://blog.example.com"><label for="subtitle">博客副标题</label><input type="text" id="subtitle" name="subtitle" placeholder="例如：记录生活与技术"><button type="submit">保存设置</button></form>`;
        pages.tools.innerHTML = `<article><header><strong>重建所有静态页面</strong></header><p>当您进行了批量修改（如重命名分类/标签）或修改了页面模板后，静态页面不会自动更新。请在此处手动触发一次全站重建。</p><footer><button id="rebuild-all-btn" class="contrast" aria-busy="false">开始重建</button></footer></article>`;
        
        pages.images.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
                <h2>图片管理</h2>
            </div>
            <div id="images-list" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 1rem; min-height: 400px;" aria-busy="true"></div>
            <div id="images-pagination"></div>
        `;
        
        // 全局图片预览弹窗
        if (!document.getElementById('image-preview-modal')) {
            const modal = document.createElement('div');
            modal.id = 'image-preview-modal';
            modal.style.cssText = 'display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); z-index: 1000; align-items: center; justify-content: center; padding: 2rem;';
            modal.onclick = closeImagePreview;
            modal.innerHTML = `
                <div style="max-width: 90%; max-height: 90%; position: relative;">
                    <button onclick="closeImagePreview()" style="position: absolute; top: -2rem; right: 0; background: white; color: black; border: none; border-radius: 50%; width: 2rem; height: 2rem; font-size: 1.2rem; cursor: pointer;">&times;</button>
                    <h3 id="preview-title" style="color: white; margin-bottom: 1rem; text-align: center;"></h3>
                    <img id="preview-image" style="max-width: 100%; max-height: calc(90vh - 8rem); border-radius: 0.5rem;" alt="预览图">
                </div>
            `;
            document.body.appendChild(modal);
        }
        
        // 使用事件委托，为整个 body 绑定一次性的、高效的事件监听器
        document.body.addEventListener('submit', (e) => {
            if (e.target.matches('#post-form')) handlePostSubmit(e);
            if (e.target.matches('#link-form')) handleLinkSubmit(e);
            if (e.target.matches('#settings-form')) handleSettingsSubmit(e);
        });
        document.body.addEventListener('click', (e) => {
            const target = e.target;
            if (target.matches('.nav-link')) { e.preventDefault(); showPage(target.dataset.page.replace('-page', '')); }
            if (target.matches('#show-post-form-btn')) showPostForm('create');
            if (target.matches('#cancel-post-form-btn')) hidePostForm();
            if (target.matches('#save-draft-btn')) handleSaveDraft(e);
            if (target.matches('#upload-image-btn')) {
                e.preventDefault();
                document.getElementById('image-file-input').click();
            }
            // 使用 .closest() 来确保即使点击了按钮内部的元素也能正确委托
            if (target.closest('#posts-list')) handlePostListClick(e);
            if (target.closest('#categories-table')) handleCategoryListClick(e);
            if (target.closest('#tags-table')) handleTagListClick(e);
            if (target.closest('#links-list')) handleLinkListClick(e);
            if (target.matches('#rebuild-all-btn')) handleRebuild(e);
        });

        // 图片上传处理
        document.body.addEventListener('change', async (e) => {
            const target = e.target;
            if (target.matches('#image-file-input')) {
                const file = target.files[0];
                if (!file) return;
                
                const uploadBtn = document.getElementById('upload-image-btn');
                const originalText = uploadBtn.textContent;
                uploadBtn.textContent = '上传中...';
                uploadBtn.disabled = true;
                
                try {
                    const formData = new FormData();
                    formData.append('image', file);
                    
                    const response = await apiRequest('/upload-image', 'POST', formData, false);
                    if (response.success && response.url) {
                        // 插入Markdown格式图片到编辑器
                        const imageMarkdown = `![${file.name}](${response.url})`;
                        const editor = easyMDE;
                        const cm = editor.codemirror;
                        const cursor = cm.getCursor();
                        cm.replaceRange(imageMarkdown, cursor);
                        cm.focus();
                        cm.setCursor({ line: cursor.line, ch: cursor.ch + imageMarkdown.length });
                        alert('图片上传成功，已插入到编辑器！');
                    } else {
                        throw new Error(response.error || '上传失败');
                    }
                } catch (err) {
                    alert(`图片上传失败: ${err.message}`);
                } finally {
                    uploadBtn.textContent = originalText;
                    uploadBtn.disabled = false;
                    target.value = ''; // 重置文件输入
                }
            }
        });

        // 加载初始页面
        showPage(window.location.hash.substring(1) || 'posts');
    }
    
    // 启动应用
    initialize();
});