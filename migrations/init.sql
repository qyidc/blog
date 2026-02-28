-- 博客系统数据库初始化脚本
-- 包含所有表结构和索引
-- 执行命令: wrangler d1 execute cf_blog-db --file=./migrations/init.sql

-- 文章表
CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    content TEXT,
    category TEXT,
    tags TEXT,
    published_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_published BOOLEAN DEFAULT true,
    is_draft INTEGER NOT NULL DEFAULT 0,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 图片管理表
CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL UNIQUE,
    file_size INTEGER NOT NULL,
    file_type TEXT NOT NULL,
    upload_at TEXT NOT NULL,
    post_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE SET NULL
);

-- 评论表
CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    author TEXT NOT NULL,
    email TEXT,
    content TEXT NOT NULL,
    ip_address TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    is_approved INTEGER NOT NULL DEFAULT 1,
    parent_id TEXT DEFAULT NULL,
    reply_to TEXT DEFAULT NULL,
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

-- 阅读统计表
CREATE TABLE IF NOT EXISTS post_views (
    post_id TEXT PRIMARY KEY,
    view_count INTEGER NOT NULL DEFAULT 0,
    last_viewed_at TEXT NOT NULL,
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

-- 阅读访问日志表
CREATE TABLE IF NOT EXISTS post_views_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id TEXT NOT NULL,
    ip_address TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

-- IP黑名单表
CREATE TABLE IF NOT EXISTS ip_blacklist (
    id TEXT PRIMARY KEY,
    ip_address TEXT NOT NULL UNIQUE,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT
);

-- 设置表
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_posts_slug ON posts(slug);
CREATE INDEX IF NOT EXISTS idx_posts_published ON posts(is_published, is_draft, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_category ON posts(category);
CREATE INDEX IF NOT EXISTS idx_posts_pinned ON posts(is_pinned DESC, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_images_post_id ON images(post_id);
CREATE INDEX IF NOT EXISTS idx_images_upload_at ON images(upload_at DESC);

CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_comments_created_at ON comments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_parent_id ON comments(parent_id);

CREATE INDEX IF NOT EXISTS idx_post_views_log_post_ip ON post_views_log(post_id, ip_address);
CREATE INDEX IF NOT EXISTS idx_post_views_log_created_at ON post_views_log(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ip_blacklist_address ON ip_blacklist(ip_address);

-- 插入默认设置
INSERT OR IGNORE INTO settings (key, value) VALUES ('site_url', 'https://blog.otwx.top');
INSERT OR IGNORE INTO settings (key, value) VALUES ('admin_password', 'admin123');
