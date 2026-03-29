-- 博客系统数据库初始化脚本

-- 文章表
CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    content TEXT NOT NULL,
    category TEXT,
    tags TEXT,
    published_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_published BOOLEAN DEFAULT true,
    feature_image TEXT,
    is_draft INTEGER NOT NULL DEFAULT 0,
    is_pinned INTEGER NOT NULL DEFAULT 0
);

-- 评论表
CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    author TEXT NOT NULL,
    email TEXT,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_approved INTEGER DEFAULT 0,
    parent_id TEXT,
    reply_to TEXT
);

-- 图片表
CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_size INTEGER,
    file_type TEXT,
    upload_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 文章图片关联表
CREATE TABLE IF NOT EXISTS post_images (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    image_path TEXT NOT NULL
);

-- 附件表
CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_size INTEGER,
    file_type TEXT,
    upload_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    post_id TEXT,
    download_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 友链表
CREATE TABLE IF NOT EXISTS links (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0
);

-- 设置表
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- IP黑名单表
CREATE TABLE IF NOT EXISTS ip_blacklist (
    id TEXT PRIMARY KEY,
    ip_address TEXT NOT NULL,
    blocked_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 文章阅读量表
CREATE TABLE IF NOT EXISTS post_views (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    view_count INTEGER DEFAULT 0
);

-- 文章阅读量日志表
CREATE TABLE IF NOT EXISTS post_views_log (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    ip_address TEXT,
    viewed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 访问统计数据表
CREATE TABLE IF NOT EXISTS page_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id TEXT,
    page_path TEXT NOT NULL,
    referrer TEXT,
    user_agent TEXT,
    ip_address TEXT,
    view_count INTEGER DEFAULT 1,
    session_id TEXT,
    duration INTEGER DEFAULT 0,
    country TEXT,
    city TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    last_viewed_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 访问来源统计
CREATE TABLE IF NOT EXISTS referral_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    medium TEXT,
    campaign TEXT,
    page_path TEXT,
    count INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source, medium, campaign, page_path)
);

-- 页面性能统计
CREATE TABLE IF NOT EXISTS page_performance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_path TEXT NOT NULL,
    load_time INTEGER,
    dom_content_loaded INTEGER,
    first_paint INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 初始化默认设置
INSERT OR IGNORE INTO settings (key, value) VALUES
('blog_title', '我的博客'),
('subtitle', 'A modern blog built with Cloudflare.'),
('admin_email', 'admin@example.com'),
('posts_per_page', '10'),
('disqus_shortname', ''),
('google_analytics', ''),
('allow_comments', '1'),
('comment_moderation', '1');

-- 初始化默认分类
INSERT OR IGNORE INTO posts (id, title, slug, content, category, is_published, is_draft)
VALUES ('1', '欢迎使用博客系统', 'welcome', '# 欢迎使用博客系统\n\n这是您的第一篇文章，您可以在后台管理系统中编辑或删除它。\n\n## 功能特性\n\n- 文章管理：创建、编辑、删除文章\n- 评论系统：支持评论和回复\n- 分类和标签：组织您的内容\n- 媒体管理：上传图片和附件\n- 访问统计：查看网站访问情况\n- 响应式设计：适配各种设备\n\n## 开始使用\n\n1. 登录后台管理系统\n2. 创建您的第一篇文章\n3. 自定义网站设置\n4. 开始分享您的内容\n\n祝您使用愉快！', '默认分类', 1, 0);
